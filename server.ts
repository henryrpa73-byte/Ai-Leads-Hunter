import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { type CrmPlatform, mapLeadsToCrmRecords } from './src/lib/crmSync.ts';
import { buildNormalizedLead, normalizeState, type ScoringCriteriaConfig } from './src/lib/leadEngine.ts';
import type { DuplicateRelation, Lead, OllamaSettings } from './src/types/lead.ts';
import {
  DIRECT_PHONE_PORTAL_STATES,
  discoverMunicipalPermits,
  PERMIT_PORTAL_STATES,
} from './server/connectors/permits.ts';
import { discoverUsaSpending } from './server/connectors/usaspending.ts';
import {
  inspectWebsiteContacts,
  lookupCompanyUsaSpendingProject,
  resolvePublicWebsiteAndContacts,
} from './server/connectors/websiteResearch.ts';
import { LeadDatabase } from './server/db.ts';
import { DiscoveryJobManager } from './server/jobManager.ts';
import { analyzeLeadWithLocalAi, getOllamaStatus } from './server/ollama.ts';
import { assertSafeOllamaUrl, assertSafePublicUrl, createRateLimiter, USER_AGENT } from './server/security.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));

  const db = new LeadDatabase();
  const jobManager = new DiscoveryJobManager(db);

  const networkRateLimiter = createRateLimiter(60_000, 45);
  const mutationRateLimiter = createRateLimiter(60_000, 90);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, database: 'sqlite', ai: 'optional-local-ollama' });
  });

  // ---------- Persistent SQLite Lead & Dashboard Endpoints ----------
  app.get('/api/leads', (_req, res) => {
    const leads = db.getLeads();
    const seenMap = db.getSeenContactsMap();
    const stats = db.getStats();
    const scoringConfig = db.getScoringConfig();
    res.json({
      leads,
      stats,
      scoringConfig,
      seenPhonesCount: Object.keys(seenMap.phones).length,
      seenEmailsCount: Object.keys(seenMap.emails).length,
    });
  });

  app.post('/api/leads/import', mutationRateLimiter, (req, res) => {
    try {
      const rawLeads = Array.isArray(req.body?.leads) ? req.body.leads : [];
      if (rawLeads.length > 3000) {
        return res.status(400).json({ error: 'Import batch limited to 3,000 rows per request.' });
      }
      const checkCrossSession = req.body?.checkCrossSession !== false;
      const result = db.upsertLeads(rawLeads as Partial<Lead>[], { checkCrossSession });
      const seenMap = db.getSeenContactsMap();
      return res.json({
        ...result,
        stats: db.getStats(),
        seenPhonesCount: Object.keys(seenMap.phones).length,
        seenEmailsCount: Object.keys(seenMap.emails).length,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Lead import failed' });
    }
  });

  app.patch('/api/leads/:id', mutationRateLimiter, (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Missing lead id.' });
      const patch = (req.body || {}) as Partial<Lead>;
      const updated = db.updateLead(id, patch);
      if (!updated) return res.status(404).json({ error: 'Lead not found.' });
      return res.json({ lead: updated, stats: db.getStats() });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  app.post('/api/leads/rescore', mutationRateLimiter, (req, res) => {
    try {
      const cfg = req.body?.config as ScoringCriteriaConfig | undefined;
      if (!cfg || typeof cfg.warmThreshold !== 'number') {
        return res.status(400).json({ error: 'Valid scoring config is required.' });
      }
      const leads = db.rescoreAll(cfg);
      return res.json({ leads, stats: db.getStats() });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Rescore failed' });
    }
  });

  app.post('/api/leads/clear', mutationRateLimiter, (_req, res) => {
    db.clearAllLeadsKeepSeen();
    const seenMap = db.getSeenContactsMap();
    res.json({
      ok: true,
      stats: db.getStats(),
      seenPhonesCount: Object.keys(seenMap.phones).length,
    });
  });

  app.post('/api/seen/reset', mutationRateLimiter, (_req, res) => {
    db.resetSeenContacts(true);
    const seenMap = db.getSeenContactsMap();
    res.json({
      ok: true,
      seenPhonesCount: Object.keys(seenMap.phones).length,
      seenEmailsCount: Object.keys(seenMap.emails).length,
    });
  });

  app.get('/api/stats', (_req, res) => {
    res.json(db.getStats());
  });

  app.get('/api/duplicates', (_req, res) => {
    res.json({ duplicates: db.getDuplicateRelations(150) });
  });

  app.patch('/api/duplicates/:id', mutationRateLimiter, (req, res) => {
    const id = Number.parseInt(String(req.params.id || ''), 10);
    const status = String(req.body?.resolved_status || '') as DuplicateRelation['resolved_status'];
    if (!Number.isFinite(id) || !['merged', 'pending_review', 'kept_separate'].includes(status)) {
      return res.status(400).json({ error: 'Invalid duplicate resolution request.' });
    }
    db.resolveDuplicateRelation(id, status);
    return res.json({ ok: true });
  });

  app.post('/api/exports/log', mutationRateLimiter, (req, res) => {
    const exportType = String(req.body?.exportType || 'csv').slice(0, 40);
    const rowCount = Math.max(0, Number(req.body?.rowCount || 0));
    const filename = String(req.body?.filename || '').slice(0, 120);
    db.recordExport(exportType, rowCount, filename);
    res.json({ ok: true });
  });

  // ---------- Optional Local Ollama AI Engine ----------
  app.get('/api/ai/ollama/status', async (_req, res) => {
    const settings = db.getOllamaSettings();
    const status = await getOllamaStatus(settings);
    res.json({ ...status, settings });
  });

  app.post('/api/ai/settings', mutationRateLimiter, async (req, res) => {
    try {
      const prev = db.getOllamaSettings();
      const rawUrl = String(req.body?.baseUrl ?? prev.baseUrl).trim();
      const safeBase = assertSafeOllamaUrl(rawUrl);
      const nextSettings: OllamaSettings = {
        enabled: Boolean(req.body?.enabled),
        baseUrl: safeBase.origin,
        model: String(req.body?.model ?? prev.model).trim().slice(0, 120),
        timeoutMs: Math.min(60_000, Math.max(5_000, Number(req.body?.timeoutMs ?? prev.timeoutMs) || 25_000)),
      };
      db.setSetting('ollama_settings', nextSettings);
      const status = await getOllamaStatus(nextSettings);
      res.json({ ok: true, settings: nextSettings, status });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid Ollama settings' });
    }
  });

  app.post('/api/ai/analyze-lead', networkRateLimiter, async (req, res) => {
    try {
      const leadId = String(req.body?.leadId || '').trim();
      const existing = leadId ? db.getLeadById(leadId) : null;
      const targetLead = existing || (req.body?.lead as Partial<Lead> | undefined);
      if (!targetLead || !targetLead.company_name) {
        return res.status(400).json({ error: 'Lead record or leadId is required.' });
      }
      const settings = db.getOllamaSettings();
      const analysis = await analyzeLeadWithLocalAi(targetLead, settings);
      if (existing) {
        const updated = db.updateLead(existing.id, {
          construction_trade: analysis.construction_trade,
          project_type: analysis.project_type,
          service_opportunity: analysis.service_opportunity,
          ai_summary: analysis.ai_summary,
        });
        return res.json({ analysis, lead: updated });
      }
      return res.json({ analysis });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Local AI analysis failed' });
    }
  });

  // ---------- Discovery Job Manager ----------
  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: jobManager.listJobs(15) });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobManager.getJob(String(req.params.id || ''));
    if (!job) return res.status(404).json({ error: 'Discovery job not found.' });
    return res.json({ job });
  });

  app.post('/api/jobs/start', networkRateLimiter, (req, res) => {
    const rawState = String(req.body?.state || '').trim();
    const state = normalizeState(rawState) || rawState.toUpperCase().slice(0, 2);
    const job = jobManager.startJob({
      source: String(req.body?.source || 'all'),
      state,
      trade: String(req.body?.trade || 'ALL'),
      limit: Number.isFinite(Number(req.body?.limit))
        ? Math.max(1, Math.min(350, Number(req.body.limit)))
        : 10,
      page: Number.isFinite(Number(req.body?.page))
        ? Math.max(1, Math.min(50, Number(req.body.page)))
        : 1,
      smsPhonePriority: Boolean(req.body?.smsPhonePriority),
      freshOnly: req.body?.freshOnly !== false,
    });
    res.json({ job });
  });

  app.post('/api/jobs/:id/pause', mutationRateLimiter, (req, res) => {
    const job = jobManager.pauseJob(String(req.params.id || ''));
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    return res.json({ job });
  });

  app.post('/api/jobs/:id/resume', mutationRateLimiter, (req, res) => {
    const job = jobManager.resumeJob(String(req.params.id || ''));
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    return res.json({ job });
  });

  app.post('/api/jobs/:id/stop', mutationRateLimiter, (req, res) => {
    const job = jobManager.stopJob(String(req.params.id || ''));
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    return res.json({ job });
  });

  app.post('/api/jobs/:id/retry', networkRateLimiter, (req, res) => {
    const job = jobManager.retryJob(String(req.params.id || ''));
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    return res.json({ job });
  });

  // ---------- Live Synchronous Discovery (All 50 US States + SQLite Sync) ----------
  app.post('/api/discover/live', networkRateLimiter, async (req, res) => {
    try {
      const source = String(req.body?.source || 'all');
      const rawState = String(req.body?.state || '').trim();
      const state = normalizeState(rawState) || rawState.toUpperCase().slice(0, 2);
      const tradeFilter = String(req.body?.trade || 'ALL');
      const limit = Number.isFinite(Number(req.body?.limit))
        ? Math.max(1, Math.min(350, Number(req.body.limit)))
        : 3;
      const requestedPage = Number.isFinite(Number(req.body?.page))
        ? Math.max(1, Math.min(50, Number(req.body.page)))
        : 1;
      const smsPhonePriority = Boolean(req.body?.smsPhonePriority);
      const freshOnly = req.body?.freshOnly !== false;

      const dbSeen = db.getSeenContactsMap();
      const rawExcludePhones = Array.isArray(req.body?.excludePhones) ? req.body.excludePhones : [];
      const rawExcludeKeys = Array.isArray(req.body?.excludeKeys) ? req.body.excludeKeys : [];
      const seenPhones = new Set<string>([
        ...Object.keys(dbSeen.phones),
        ...rawExcludePhones
          .slice(-40000)
          .map((p: unknown) => String(p || '').replace(/\D/g, '').slice(-10))
          .filter((p: string) => p.length === 10),
      ]);
      const seenKeys = new Set<string>(
        rawExcludeKeys
          .slice(-40000)
          .map((k: unknown) => String(k || '').trim().toLowerCase())
          .filter(Boolean),
      );

      const hasDirectPhonePermitPortal = !state || DIRECT_PHONE_PORTAL_STATES.includes(state);
      const hasAnyPermitPortal = !state || PERMIT_PORTAL_STATES.includes(state);

      const runDiscoveryPass = async (pageNum: number) => {
        const allLeads: Lead[] = [];
        const sourcesRun: string[] = [];
        const warnings: string[] = [];
        const tasks: Array<Promise<void>> = [];

        const shouldRunUsaSpending =
          source === 'usaspending' ||
          (source === 'all' && (!smsPhonePriority || !hasDirectPhonePermitPortal)) ||
          (source === 'permits' && Boolean(state) && !hasAnyPermitPortal);

        if (shouldRunUsaSpending) {
          if ((source === 'all' || source === 'permits') && state && !hasAnyPermitPortal) {
            warnings.push(
              `Pulled ${state} active construction & design projects from USASpending.gov (covers all 50 states + DC).`,
            );
          } else if (source === 'all' && smsPhonePriority && state && !hasDirectPhonePermitPortal) {
            warnings.push(
              `Pulled ${state} active federal projects from USASpending.gov for contact phone lookup.`,
            );
          }
          tasks.push(
            (async () => {
              const usaCap = limit >= 50 ? Math.min(50, Math.ceil(limit / 4)) : Math.min(4, limit);
              const { leads: usaLeads, errors } = await discoverUsaSpending(state, usaCap, pageNum);
              allLeads.push(...usaLeads);
              if (usaLeads.length > 0) sourcesRun.push('USASpending.gov');
              if (errors.length > 0 && usaLeads.length === 0) {
                warnings.push(`USASpending.gov partial warning: ${errors[0]}`);
              }
            })(),
          );
        }

        const shouldRunPermits = (source === 'all' || source === 'permits') && hasAnyPermitPortal;
        if (shouldRunPermits) {
          tasks.push(
            (async () => {
              const portalCap = limit >= 50 ? limit : limit * 4;
              const { leads: permitLeads, portalsUsed, errors } = await discoverMunicipalPermits(
                portalCap,
                pageNum,
                state,
                smsPhonePriority && hasDirectPhonePermitPortal,
              );
              const filtered = state ? permitLeads.filter((l) => !l.state || l.state === state) : permitLeads;
              allLeads.push(...filtered);
              if (portalsUsed.length > 0) {
                sourcesRun.push(`Permits (${portalsUsed.join(', ')})`);
              }
              if (errors.length > 0 && portalsUsed.length === 0) {
                warnings.push(`Permit portal notice: ${errors[0]}`);
              }
            })(),
          );
        }

        await Promise.all(tasks);
        const tradeFiltered =
          tradeFilter && tradeFilter !== 'ALL'
            ? allLeads.filter((l) => l.construction_trade === tradeFilter)
            : allLeads;
        return { allLeads: tradeFiltered, sourcesRun, warnings };
      };

      let currentPage = requestedPage;
      const accumulated: Lead[] = [];
      const sourcesSet = new Set<string>();
      const warningSet = new Set<string>();
      let skippedDuplicates = 0;

      const filterUniqueFresh = (batch: Lead[]): Lead[] => {
        const out: Lead[] = [];
        for (const lead of batch) {
          if (!lead.company_name || lead.normalized_name.length < 2) {
            skippedDuplicates++;
            continue;
          }
          if (lead.phone_digits && lead.phone_digits.length === 10 && seenPhones.has(lead.phone_digits)) {
            skippedDuplicates++;
            continue;
          }
          const compKey = lead.state
            ? `${lead.normalized_name}|${lead.state.toLowerCase()}`
            : lead.normalized_name;
          if (freshOnly && compKey && seenKeys.has(compKey)) {
            skippedDuplicates++;
            continue;
          }
          if (lead.phone_digits && lead.phone_digits.length === 10) {
            seenPhones.add(lead.phone_digits);
          }
          if (compKey) {
            seenKeys.add(compKey);
          }
          out.push(lead);
        }
        return out;
      };

      const maxHops = freshOnly ? 4 : 1;
      const targetMinCount = Math.max(5, Math.min(60, limit * 2));

      for (let hop = 0; hop < maxHops; hop++) {
        const pass = await runDiscoveryPass(currentPage);
        pass.sourcesRun.forEach((s) => sourcesSet.add(s));
        pass.warnings.forEach((w) => warningSet.add(w));

        if (pass.allLeads.length === 0) {
          if (hop === 0 && currentPage > 1) {
            currentPage = 1;
            const retry = await runDiscoveryPass(currentPage);
            retry.sourcesRun.forEach((s) => sourcesSet.add(s));
            retry.warnings.forEach((w) => warningSet.add(w));
            accumulated.push(...filterUniqueFresh(retry.allLeads));
          }
          break;
        }

        const freshBatch = filterUniqueFresh(pass.allLeads);
        accumulated.push(...freshBatch);
        currentPage += 1;

        if (!freshOnly || accumulated.length >= targetMinCount || currentPage > 50) {
          break;
        }
      }

      if (accumulated.length > 0) {
        db.upsertLeads(accumulated, { checkCrossSession: freshOnly });
      }

      res.json({
        leads: accumulated,
        summary: {
          fetched: accumulated.length,
          sourcesRun: Array.from(sourcesSet),
          warnings: Array.from(warningSet),
          nextPage: currentPage > 50 ? 1 : currentPage,
          skippedDuplicates,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Discovery failed' });
    }
  });

  app.post('/api/research/website', networkRateLimiter, async (req, res) => {
    try {
      const rawUrl = String(req.body?.url || '').trim();
      if (!rawUrl) {
        return res.status(400).json({ error: 'Website URL is required.' });
      }
      const data = await inspectWebsiteContacts(rawUrl);
      return res.json(data);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Website research failed' });
    }
  });

  app.post('/api/research/batch-contacts', networkRateLimiter, async (req, res) => {
    try {
      const rawLeads = Array.isArray(req.body?.leads) ? req.body.leads : [];
      const targets = rawLeads.slice(0, 15) as Array<{
        id?: string;
        company_name?: string;
        website?: string;
        city?: string;
        state?: string;
        needs_project?: boolean;
      }>;

      const results: Array<{
        id: string;
        website: string;
        website_status: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown';
        email: string;
        email_status: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown';
        phone: string;
        phone_status: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown';
        contact_person: string;
        job_title: string;
        contact_status: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown';
        contact_source_url: string;
        services: string;
        city: string;
        state: string;
        zip_code: string;
        company_category: string;
        project_name: string;
        project_description: string;
        project_location: string;
        project_status: string;
        project_source_url: string;
        buying_intent_evidence: string;
      }> = [];

      const concurrency = 3;
      for (let i = 0; i < targets.length; i += concurrency) {
        const chunk = targets.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
          chunk.map(async (item) => {
            const id = String(item.id || '');
            const company = String(item.company_name || '').trim();
            let site = String(item.website || '').trim();
            let websiteStatus: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown' = site ? 'Publicly Listed' : 'Unknown';
            let city = String(item.city || '').trim();
            let state = String(item.state || '').trim().toUpperCase().slice(0, 2);
            let zipCode = '';
            let phone = '';
            let phoneStatus: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown' = 'Unknown';
            let email = '';
            let emailStatus: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown' = 'Unknown';
            let contactPerson = '';
            let jobTitle = '';
            let contactStatus: 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown' = 'Unknown';
            let contactSourceUrl = '';
            let services = '';
            let companyCategory = '';
            let projectName = '';
            let projectDescription = '';
            let projectLocation = '';
            let projectStatus = '';
            let projectSourceUrl = '';
            let buyingIntentEvidence = '';

            if (company && (item.needs_project || !city || !state)) {
              const usa = await lookupCompanyUsaSpendingProject(company, state);
              if (usa) {
                projectName = usa.project_name;
                projectDescription = usa.project_description;
                projectLocation = usa.project_location;
                projectStatus = usa.project_status;
                projectSourceUrl = usa.project_source_url;
                buyingIntentEvidence = usa.buying_intent_evidence;
                companyCategory = usa.company_category;
                services = usa.services;
                if (!city && usa.city) city = usa.city;
                if (usa.state && (!state || !item.city)) state = usa.state;
                if (usa.zip_code) zipCode = usa.zip_code;
                if (usa.contact_person) {
                  contactPerson = usa.contact_person;
                  jobTitle = usa.job_title;
                  contactStatus = 'Publicly Listed';
                  contactSourceUrl = usa.project_source_url;
                }
              }
            }

            if (!site && company) {
              const resolved = await resolvePublicWebsiteAndContacts(company, city, state);
              site = resolved.website;
              if (site) websiteStatus = 'Publicly Listed';
              phone = resolved.phone;
              if (phone) phoneStatus = 'Publicly Listed';
              email = resolved.email;
              if (email) emailStatus = 'Publicly Listed';
            }

            if (site) {
              try {
                const scraped = await inspectWebsiteContacts(site);
                site = scraped.website || site;
                websiteStatus = scraped.website_status;
                if (scraped.email) {
                  email = scraped.email;
                  emailStatus = 'Publicly Listed';
                }
                if (scraped.phone) {
                  phone = scraped.phone;
                  phoneStatus = 'Publicly Listed';
                }
                if (scraped.contact_person) {
                  contactPerson = scraped.contact_person;
                  jobTitle = scraped.job_title || jobTitle;
                  contactStatus = 'Publicly Listed';
                }
                if (scraped.contact_source_url) contactSourceUrl = scraped.contact_source_url;
                services = [scraped.services, services].filter(Boolean).join(', ');
              } catch {
                // Keep any directory info found
              }
            }

            return {
              id,
              website: site,
              website_status: websiteStatus,
              email,
              email_status: emailStatus,
              phone,
              phone_status: phoneStatus,
              contact_person: contactPerson,
              job_title: jobTitle,
              contact_status: contactStatus,
              contact_source_url: contactSourceUrl,
              services,
              city,
              state,
              zip_code: zipCode,
              company_category: companyCategory,
              project_name: projectName,
              project_description: projectDescription,
              project_location: projectLocation,
              project_status: projectStatus,
              project_source_url: projectSourceUrl,
              buying_intent_evidence: buyingIntentEvidence,
            };
          }),
        );
        results.push(...chunkResults);
      }

      const websitesFound = results.filter((r) => Boolean(r.website)).length;
      const emailsFound = results.filter((r) => Boolean(r.email)).length;
      const phonesFound = results.filter((r) => Boolean(r.phone)).length;
      const projectsFound = results.filter((r) => Boolean(r.project_name)).length;
      const enriched = results.filter((r) =>
        Boolean(r.website || r.email || r.phone || r.contact_person || r.project_name),
      ).length;

      return res.json({
        results,
        summary: {
          processed: results.length,
          enriched,
          websitesFound,
          emailsFound,
          phonesFound,
          projectsFound,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Batch contact lookup failed' });
    }
  });

  // ---------- CRM Sync ----------
  app.get('/api/crm/status', (_req, res) => {
    res.json({
      configured: {
        hubspot: Boolean(process.env.HUBSPOT_ACCESS_TOKEN?.trim()),
        salesforce: Boolean(
          process.env.SALESFORCE_INSTANCE_URL?.trim() && process.env.SALESFORCE_ACCESS_TOKEN?.trim(),
        ),
        pipedrive: Boolean(process.env.PIPEDRIVE_API_TOKEN?.trim()),
        zoho: Boolean(process.env.ZOHO_CRM_ACCESS_TOKEN?.trim()),
        webhook: Boolean(process.env.CRM_WEBHOOK_URL?.trim()),
      },
    });
  });

  app.post('/api/crm/sync', networkRateLimiter, async (req, res) => {
    try {
      const platform = String(req.body?.platform || '') as CrmPlatform;
      const validPlatforms: CrmPlatform[] = ['hubspot', 'salesforce', 'pipedrive', 'zoho', 'webhook'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ error: 'Unsupported CRM platform.' });
      }

      const rawLeads = Array.isArray(req.body?.leads) ? req.body.leads : [];
      if (rawLeads.length === 0) {
        return res.status(400).json({ error: 'Select at least one lead to sync.' });
      }
      const normalizedLeads = rawLeads.slice(0, 100).map((item: Partial<Lead>) => buildNormalizedLead(item));
      const records = mapLeadsToCrmRecords(normalizedLeads, platform);

      if (platform === 'webhook') {
        const rawUrl = String(req.body?.webhookUrl || process.env.CRM_WEBHOOK_URL || '').trim();
        if (!rawUrl) {
          return res.status(400).json({
            error: 'Provide a public HTTPS webhook URL or set CRM_WEBHOOK_URL in server Secrets.',
          });
        }
        const safeUrl = await assertSafePublicUrl(rawUrl);
        const resp = await fetch(safeUrl.toString(), {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(12000),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({
            source: 'Ai Leads Hunter',
            platform: 'webhook',
            synced_at: new Date().toISOString(),
            count: records.length,
            records,
          }),
        });
        if (!resp.ok) {
          return res.status(502).json({ error: `Webhook endpoint returned HTTP ${resp.status}.` });
        }
        return res.json({
          ok: true,
          platform,
          syncedCount: records.length,
          failedCount: 0,
          message: `Synced ${records.length} lead(s) to ${safeUrl.hostname}.`,
        });
      }

      if (platform === 'hubspot') {
        const token = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
        if (!token) {
          return res.status(400).json({
            error: 'HUBSPOT_ACCESS_TOKEN is not configured in server Secrets. Export HubSpot CSV/JSON or add the secret on the server.',
          });
        }
        const inputs = records.map((rec) => ({
          properties: {
            company: String(rec.company || ''),
            firstname: String(rec.firstname || ''),
            lastname: String(rec.lastname || ''),
            jobtitle: String(rec.jobtitle || ''),
            email: String(rec.email || ''),
            phone: String(rec.phone || ''),
            website: String(rec.website || ''),
            city: String(rec.city || ''),
            state: String(rec.state || ''),
            zip: String(rec.zip || ''),
            hs_lead_status: String(rec.hs_lead_status || 'NEW'),
          },
        }));
        const resp = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/create', {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs }),
        });
        if (!resp.ok) {
          return res.status(502).json({ error: `HubSpot API returned HTTP ${resp.status}.` });
        }
        const data = (await resp.json()) as { results?: unknown[] };
        const synced = Array.isArray(data.results) ? data.results.length : records.length;
        return res.json({
          ok: true,
          platform,
          syncedCount: synced,
          failedCount: Math.max(0, records.length - synced),
          message: `Synced ${synced} contact(s) to HubSpot.`,
        });
      }

      if (platform === 'salesforce') {
        const instanceRaw = process.env.SALESFORCE_INSTANCE_URL?.trim();
        const token = process.env.SALESFORCE_ACCESS_TOKEN?.trim();
        if (!instanceRaw || !token) {
          return res.status(400).json({
            error: 'SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN must be set in server Secrets.',
          });
        }
        const safeInstance = await assertSafePublicUrl(instanceRaw);
        const sfRecords = records.map((rec) => ({
          attributes: { type: 'Lead' },
          ...rec,
        }));
        const resp = await fetch(`${safeInstance.origin}/services/data/v60.0/composite/sobjects`, {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ allOrNone: false, records: sfRecords }),
        });
        if (!resp.ok) {
          return res.status(502).json({ error: `Salesforce API returned HTTP ${resp.status}.` });
        }
        const results = (await resp.json()) as Array<{ success?: boolean }>;
        const synced = Array.isArray(results) ? results.filter((r) => r.success).length : records.length;
        return res.json({
          ok: true,
          platform,
          syncedCount: synced,
          failedCount: Math.max(0, records.length - synced),
          message: `Synced ${synced} Lead record(s) to Salesforce.`,
        });
      }

      if (platform === 'pipedrive') {
        const token = process.env.PIPEDRIVE_API_TOKEN?.trim();
        if (!token) {
          return res.status(400).json({
            error: 'PIPEDRIVE_API_TOKEN is not configured in server Secrets.',
          });
        }
        let synced = 0;
        let failed = 0;
        for (const rec of records.slice(0, 25)) {
          try {
            const orgResp = await fetch(
              `https://api.pipedrive.com/v1/organizations?api_token=${encodeURIComponent(token)}`,
              {
                method: 'POST',
                signal: AbortSignal.timeout(8000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: String(rec.organization_name || 'Contractor'),
                  address: [rec.city, rec.state, rec.zip_code].filter(Boolean).join(', '),
                }),
              },
            );
            const orgJson = (await orgResp.json()) as { data?: { id?: number } };
            const orgId = orgJson?.data?.id;
            if (!orgId) {
              failed += 1;
              continue;
            }
            const leadResp = await fetch(
              `https://api.pipedrive.com/v1/leads?api_token=${encodeURIComponent(token)}`,
              {
                method: 'POST',
                signal: AbortSignal.timeout(8000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title: String(rec.lead_title || rec.organization_name || 'Warm Lead'),
                  organization_id: orgId,
                }),
              },
            );
            if (leadResp.ok) synced += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }
        return res.json({
          ok: synced > 0,
          platform,
          syncedCount: synced,
          failedCount: failed,
          message: `Synced ${synced} lead(s) to Pipedrive${failed ? ` (${failed} skipped)` : ''}.`,
        });
      }

      const zohoToken = process.env.ZOHO_CRM_ACCESS_TOKEN?.trim();
      if (!zohoToken) {
        return res.status(400).json({
          error: 'ZOHO_CRM_ACCESS_TOKEN is not configured in server Secrets.',
        });
      }
      const zohoResp = await fetch('https://www.zohoapis.com/crm/v2/Leads', {
        method: 'POST',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: `Zoho-oauthtoken ${zohoToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: records }),
      });
      if (!zohoResp.ok) {
        return res.status(502).json({ error: `Zoho CRM API returned HTTP ${zohoResp.status}.` });
      }
      return res.json({
        ok: true,
        platform,
        syncedCount: records.length,
        failedCount: 0,
        message: `Synced ${records.length} lead(s) to Zoho CRM.`,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'CRM sync failed' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ai Leads Hunter running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
