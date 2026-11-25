import {
  BarChart3,
  Building2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Flame,
  FolderUp,
  PhoneCall,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AutomatedScoringEngine } from './components/AutomatedScoringEngine.tsx';
import { DailyQuotaTracker } from './components/DailyQuotaTracker.tsx';
import { DailyReportView } from './components/DailyReportView.tsx';
import { LeadDetailPanel } from './components/LeadDetailPanel.tsx';
import {
  createDefaultQuota,
  type DailyQuotaState,
  getTodayDateKey,
  loadDailyQuota,
  saveDailyQuota,
} from './lib/dailyQuota.ts';
import {
  buildNormalizedLead,
  DEFAULT_SCORING_CONFIG,
  leadsToCsv,
  leadsToExcelBuffer,
  mergeLeadsDeduplicated,
  parseCsvToLeads,
  parseExcelToLeads,
  rescoreAllLeads,
  safeExternalUrl,
  type ScoringCriteriaConfig,
} from './lib/leadEngine.ts';
import type { DiscoveryResponse, Lead } from './types/lead.ts';

type NavTab = 'pipeline' | 'warm' | 'report';
type SourceOption = 'all' | 'usaspending' | 'permits';

const STORAGE_KEY = 'ai_leads_hunter_records_v1';
const SCORING_CONFIG_KEY = 'ai_leads_hunter_scoring_config_v1';

export default function App() {
  const [leads, setLeads] = useState<Lead[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? (JSON.parse(saved) as Lead[]) : [];
    } catch {
      return [];
    }
  });

  const [activeTab, setActiveTab] = useState<NavTab>('pipeline');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<'ALL' | 'Warm' | 'Potential' | 'Unqualified'>('ALL');
  const [serviceFilter, setServiceFilter] = useState<string>('ALL');
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const [minScore, setMinScore] = useState<number>(0);
  const [liveProjectsOnly, setLiveProjectsOnly] = useState(false);
  const [hasContactOnly, setHasContactOnly] = useState(false);

  // Live discovery controls
  const [huntSource, setHuntSource] = useState<SourceOption>('all');
  const [huntState, setHuntState] = useState('');
  const [huntLimit, setHuntLimit] = useState<number>(3);
  const [autoFindContacts, setAutoFindContacts] = useState<boolean>(true);
  const [hunting, setHunting] = useState(false);
  const [enrichingContacts, setEnrichingContacts] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{ type: 'info' | 'error'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [dailyQuota, setDailyQuota] = useState<DailyQuotaState>(() => loadDailyQuota());
  const [scoringConfig, setScoringConfig] = useState<ScoringCriteriaConfig>(() => {
    try {
      const saved = localStorage.getItem(SCORING_CONFIG_KEY);
      return saved ? { ...DEFAULT_SCORING_CONFIG, ...(JSON.parse(saved) as Partial<ScoringCriteriaConfig>) } : DEFAULT_SCORING_CONFIG;
    } catch {
      return DEFAULT_SCORING_CONFIG;
    }
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(leads));
    } catch {
      // Ignore storage quota warnings
    }
  }, [leads]);

  useEffect(() => {
    saveDailyQuota(dailyQuota);
  }, [dailyQuota]);

  useEffect(() => {
    try {
      localStorage.setItem(SCORING_CONFIG_KEY, JSON.stringify(scoringConfig));
    } catch {
      // Ignore storage quota warnings
    }
  }, [scoringConfig]);

  const handleApplyScoring = (nextConfig: ScoringCriteriaConfig) => {
    setScoringConfig(nextConfig);
    setLeads((prev) => {
      const rescored = rescoreAllLeads(prev, nextConfig);
      const warmCount = rescored.filter((l) => l.lead_tier === 'Warm').length;
      const potentialCount = rescored.filter((l) => l.lead_tier === 'Potential').length;
      setBannerMessage({
        type: 'info',
        text: `Auto-scored ${rescored.length} leads on Project Value, Company Size & Service Match: ${warmCount} Warm (${nextConfig.warmThreshold}+), ${potentialCount} Potential.`,
      });
      return rescored;
    });
  };

  const recordDiscoveryUsage = (discoveredLeads: Lead[]) => {
    const today = getTodayDateKey();
    const usaCount = discoveredLeads.filter((l) => l.source_name === 'USASpending.gov').length;
    const permitCount = discoveredLeads.length - usaCount;

    setDailyQuota((prev) => {
      const base = prev.date === today ? prev : createDefaultQuota(prev.discoveryLimit, prev.contactLimit);
      return {
        ...base,
        discoveryLeadsToday: base.discoveryLeadsToday + discoveredLeads.length,
        usaspendingLeadsToday: base.usaspendingLeadsToday + usaCount,
        permitLeadsToday: base.permitLeadsToday + permitCount,
        runsToday: base.runsToday + 1,
      };
    });
  };

  const recordContactUsage = (checks: number, phonesFound: number, emailsFound: number) => {
    const today = getTodayDateKey();
    setDailyQuota((prev) => {
      const base = prev.date === today ? prev : createDefaultQuota(prev.discoveryLimit, prev.contactLimit);
      return {
        ...base,
        contactChecksToday: base.contactChecksToday + checks,
        phonesFoundToday: base.phonesFoundToday + phonesFound,
        emailsFoundToday: base.emailsFoundToday + emailsFound,
      };
    });
  };

  const availableStates = useMemo(() => {
    const set = new Set<string>();
    leads.forEach((l) => {
      if (l.state) set.add(l.state);
    });
    return Array.from(set).sort();
  }, [leads]);

  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return leads.filter((lead) => {
      if (activeTab === 'warm' && lead.lead_tier !== 'Warm') return false;
      if (activeTab === 'pipeline' && tierFilter !== 'ALL' && lead.lead_tier !== tierFilter) return false;
      if (serviceFilter !== 'ALL' && lead.service_opportunity !== serviceFilter) return false;
      if (stateFilter !== 'ALL' && lead.state !== stateFilter) return false;
      if (lead.lead_score < minScore) return false;
      if (liveProjectsOnly) {
        const st = `${lead.project_status} ${lead.project_name}`.toLowerCase();
        if (!/(live|won|active|issued|awarded|solicitation)/.test(st)) return false;
      }
      if (hasContactOnly && !lead.business_phone && !lead.business_email) {
        return false;
      }
      if (!q) return true;
      return (
        lead.company_name.toLowerCase().includes(q) ||
        lead.contact_person.toLowerCase().includes(q) ||
        lead.business_phone.toLowerCase().includes(q) ||
        lead.business_email.toLowerCase().includes(q) ||
        lead.city.toLowerCase().includes(q) ||
        lead.state.toLowerCase().includes(q) ||
        lead.project_name.toLowerCase().includes(q) ||
        lead.project_description.toLowerCase().includes(q) ||
        lead.buying_intent_evidence.toLowerCase().includes(q)
      );
    });
  }, [leads, activeTab, tierFilter, serviceFilter, stateFilter, minScore, liveProjectsOnly, hasContactOnly, searchQuery]);

  const selectedLead = useMemo(
    () => leads.find((l) => l.id === selectedLeadId) || null,
    [leads, selectedLeadId],
  );

  const stats = useMemo(() => {
    const warm = leads.filter((l) => l.lead_tier === 'Warm').length;
    const potential = leads.filter((l) => l.lead_tier === 'Potential').length;
    const avgScore = leads.length
      ? Math.round(leads.reduce((sum, l) => sum + l.lead_score, 0) / leads.length)
      : 0;
    return { total: leads.length, warm, potential, avgScore };
  }, [leads]);

  const enrichLeadsContacts = async (targetLeads: Lead[], prefixMessage = '') => {
    const candidates = targetLeads.filter(
      (l) => !l.business_email || !l.business_phone || !l.website || !l.project_name || !l.city,
    );
    if (candidates.length === 0) return { enriched: 0, phones: 0, emails: 0, websites: 0, projects: 0 };

    setEnrichingContacts(true);
    let totalEnriched = 0;
    let totalPhones = 0;
    let totalEmails = 0;
    let totalWebsites = 0;
    let totalProjects = 0;
    const chunkSize = 8;

    try {
      for (let i = 0; i < candidates.length; i += chunkSize) {
        const chunk = candidates.slice(i, i + chunkSize);
        setBannerMessage({
          type: 'info',
          text: `${prefixMessage}Finding websites, emails & live projects (${Math.min(i + chunk.length, candidates.length)}/${candidates.length} leads)...`,
        });

        const resp = await fetch('/api/research/batch-contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leads: chunk.map((l) => ({
              id: l.id,
              company_name: l.company_name,
              website: l.website,
              city: l.city,
              state: l.state,
              needs_project: !l.project_name,
            })),
          }),
        });
        if (!resp.ok) continue;

        const payload = (await resp.json()) as {
          results?: Array<{
            id: string;
            website: string;
            email: string;
            phone: string;
            contact_person: string;
            job_title: string;
            services: string;
            city?: string;
            state?: string;
            zip_code?: string;
            company_category?: string;
            project_name?: string;
            project_description?: string;
            project_location?: string;
            project_status?: string;
            project_source_url?: string;
            buying_intent_evidence?: string;
          }>;
        };

        const byId = new Map((payload.results || []).map((r) => [r.id, r]));
        setLeads((prev) =>
          prev
            .map((lead) => {
              const patch = byId.get(lead.id);
              if (!patch) return lead;
              const hasNew =
                (!lead.website && patch.website) ||
                (!lead.business_email && patch.email) ||
                (!lead.business_phone && patch.phone) ||
                (!lead.contact_person && patch.contact_person) ||
                (!lead.city && patch.city) ||
                (!lead.project_name && patch.project_name) ||
                (!lead.services_offered && patch.services);
              if (!hasNew) return lead;

              return buildNormalizedLead(
                {
                  ...lead,
                  website: lead.website || patch.website,
                  business_email: lead.business_email || patch.email,
                  business_phone: lead.business_phone || patch.phone,
                  contact_person: lead.contact_person || patch.contact_person,
                  job_title: lead.job_title || patch.job_title,
                  city: lead.city || patch.city || '',
                  state: (!lead.city && patch.state) ? patch.state : lead.state || patch.state || '',
                  zip_code: lead.zip_code || patch.zip_code || '',
                  company_category: lead.company_category || patch.company_category || '',
                  services_offered: lead.services_offered || patch.services,
                  project_name: lead.project_name || patch.project_name || '',
                  project_description: lead.project_description || patch.project_description || '',
                  project_location: lead.project_location || patch.project_location || '',
                  project_status: lead.project_status || patch.project_status || '',
                  project_source_url: lead.project_source_url || patch.project_source_url || '',
                  company_source_url: lead.company_source_url || patch.project_source_url || '',
                  buying_intent_evidence: lead.buying_intent_evidence || patch.buying_intent_evidence || '',
                  lead_score: 0,
                  lead_tier: undefined,
                  qualification_reason: '',
                  confidence_level: undefined,
                  last_verified: new Date().toISOString().slice(0, 19) + 'Z',
                },
                scoringConfig,
              );
            })
            .sort((a, b) => b.lead_score - a.lead_score),
        );

        let chunkPhones = 0;
        let chunkEmails = 0;
        for (const r of payload.results || []) {
          if (r.website || r.email || r.phone || r.contact_person || r.project_name || r.city) {
            totalEnriched += 1;
          }
          if (r.website) totalWebsites += 1;
          if (r.project_name) totalProjects += 1;
          if (r.phone) {
            totalPhones += 1;
            chunkPhones += 1;
          }
          if (r.email) {
            totalEmails += 1;
            chunkEmails += 1;
          }
        }
        recordContactUsage(chunk.length, chunkPhones, chunkEmails);
      }
    } finally {
      setEnrichingContacts(false);
    }

    return {
      enriched: totalEnriched,
      phones: totalPhones,
      emails: totalEmails,
      websites: totalWebsites,
      projects: totalProjects,
    };
  };

  const handleHuntLive = async () => {
    setHunting(true);
    setBannerMessage({ type: 'info', text: 'Step 1/2: Discovering live, awarded & winning US projects...' });
    try {
      const resp = await fetch('/api/discover/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: huntSource,
          state: huntState.trim().toUpperCase(),
          limit: huntLimit,
        }),
      });
      const data = (await resp.json()) as DiscoveryResponse & { error?: string };
      if (!resp.ok) {
        setBannerMessage({ type: 'error', text: data.error || 'Live lead discovery failed.' });
        return;
      }

      const discovered = rescoreAllLeads(data.leads || [], scoringConfig);
      recordDiscoveryUsage(discovered);
      const { merged, addedCount, duplicateCount } = mergeLeadsDeduplicated(leads, discovered);
      setLeads(merged);
      if (!selectedLeadId && merged.length > 0) {
        setSelectedLeadId(merged[0].id);
      }

      const warnText = data.summary.warnings.length ? ` (${data.summary.warnings.join('; ')})` : '';
      const step1Summary = `Found ${data.summary.fetched} live/awarded projects (${addedCount} new, ${duplicateCount} merged).`;

      if (autoFindContacts && discovered.length > 0) {
        setHunting(false);
        const contactRes = await enrichLeadsContacts(discovered, `Step 2/2: ${step1Summary} `);
        setBannerMessage({
          type: 'info',
          text: `${step1Summary} Auto-contact scan complete: ${contactRes.enriched} leads enriched (${contactRes.phones} phones, ${contactRes.emails} emails). Ready to export CSV or Excel.${warnText}`,
        });
      } else {
        setBannerMessage({
          type: 'info',
          text: `${step1Summary}${warnText}`,
        });
      }
    } catch {
      setBannerMessage({
        type: 'error',
        text: 'Could not reach the local discovery server. Try again in a moment.',
      });
    } finally {
      setHunting(false);
    }
  };

  const handleEnrichMissingContacts = async () => {
    const missing = filteredLeads.filter(
      (l) => !l.business_email || !l.business_phone || !l.website || !l.project_name || !l.city,
    );
    if (missing.length === 0) {
      setBannerMessage({ type: 'info', text: 'All visible leads already have website, contact, and project details.' });
      return;
    }
    const res = await enrichLeadsContacts(missing.slice(0, 100), 'Batch enrichment: ');
    setBannerMessage({
      type: 'info',
      text: `Enrichment finished: updated ${res.enriched} leads (${res.websites} websites, ${res.emails} emails, ${res.phones} phones, ${res.projects} live/won projects). Ready for CSV or Excel export.`,
    });
  };

  const handleCsvUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const lowerName = file.name.toLowerCase();
      let parsed: Lead[] = [];
      if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xlsm')) {
        const buffer = await file.arrayBuffer();
        parsed = await parseExcelToLeads(buffer, file.name);
      } else {
        const text = await file.text();
        parsed = parseCsvToLeads(text, file.name);
      }

      if (parsed.length === 0) {
        setBannerMessage({
          type: 'error',
          text: `No valid company rows found in ${file.name}. Ensure it has a Company Name header (and optional Nmbs/Phone column).`,
        });
      } else {
        const rescoredParsed = rescoreAllLeads(parsed, scoringConfig);
        const { merged, addedCount, duplicateCount } = mergeLeadsDeduplicated(leads, rescoredParsed);
        setLeads(merged);
        if (!selectedLeadId && merged.length > 0) {
          setSelectedLeadId(merged[0].id);
        }

        const importedKeys = new Set(rescoredParsed.map((p) => p.normalized_name));
        const toEnrich = merged.filter(
          (l) =>
            importedKeys.has(l.normalized_name) &&
            (!l.business_email || !l.business_phone || !l.website || !l.project_name || !l.city),
        );

        const importSummary = `Imported ${file.name}: ${addedCount} new leads added (${duplicateCount} duplicates merged).`;
        if (autoFindContacts && toEnrich.length > 0) {
          const cap = Math.min(100, toEnrich.length);
          const res = await enrichLeadsContacts(
            toEnrich.slice(0, cap),
            `${importSummary} Auto-enriching info: `,
          );
          setBannerMessage({
            type: 'info',
            text: `${importSummary} Auto-enriched ${res.enriched} companies (${res.websites} websites, ${res.emails} emails, ${res.phones} phones, ${res.projects} USASpending projects) and auto-scored into Warm/Potential.`,
          });
        } else {
          setBannerMessage({
            type: 'info',
            text: `${importSummary} Click "Find Missing Contacts" to enrich websites, emails & projects.`,
          });
        }
      }
    } catch {
      setBannerMessage({ type: 'error', text: `Failed to read ${file.name}.` });
    } finally {
      e.target.value = '';
    }
  };

  const handleUpdateLead = (id: string, patch: Partial<Lead>) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const handleExportCsv = (rows: Lead[], filename: string) => {
    const csvContent = leadsToCsv(rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportExcel = async (rows: Lead[], filename: string) => {
    const buffer = await leadsToExcelBuffer(rows);
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleClearAll = () => {
    setLeads([]);
    setSelectedLeadId(null);
    setConfirmClear(false);
    setBannerMessage({ type: 'info', text: 'Local lead pipeline cleared.' });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Left Sidebar */}
      <aside className="hidden md:flex w-[248px] shrink-0 bg-white border-r border-slate-200 flex-col justify-between p-4">
        <div className="space-y-6">
          <div className="px-2 pt-1">
            <div className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
              Ai Leads Hunter
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              US Construction B2B Intelligence
            </div>
          </div>

          <nav aria-label="Primary" className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveTab('pipeline')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'pipeline'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Building2 className="w-4 h-4 shrink-0" />
                Lead Pipeline
              </span>
              <span className="font-mono-tabular text-xs opacity-80">{stats.total}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('warm')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'warm'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Flame className="w-4 h-4 shrink-0" />
                Warm Leads
              </span>
              <span className="font-mono-tabular text-xs opacity-80">{stats.warm}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('report')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'report'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <BarChart3 className="w-4 h-4 shrink-0" />
                Daily Report
              </span>
            </button>
          </nav>

          <div className="border-t border-slate-200 pt-4 px-2 space-y-2.5">
            <div className="text-xs font-semibold text-slate-500">Target B2B Services</div>
            <ul className="space-y-1.5 text-xs text-slate-700">
              <li className="flex items-center justify-between">
                <span>Estimation & Takeoffs</span>
                <span className="font-mono-tabular text-slate-500">
                  {leads.filter((l) => l.service_opportunity === 'Construction Estimation').length}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>Architectural / CAD</span>
                <span className="font-mono-tabular text-slate-500">
                  {leads.filter((l) => l.service_opportunity === 'Architectural Services').length}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>Millwork Shop Drawings</span>
                <span className="font-mono-tabular text-slate-500">
                  {leads.filter((l) => l.service_opportunity === 'Millwork Services').length}
                </span>
              </li>
            </ul>
          </div>
        </div>

        <div className="px-2 pt-4 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">Free Public Sources Active</div>
          <div>USASpending.gov · Austin & Chicago Permits · CSV Imports</div>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
          <div className="flex items-center gap-4 min-w-0">
            <span className="md:hidden text-base font-bold text-slate-900 whitespace-nowrap shrink-0">
              Ai Leads Hunter
            </span>
            <div className="hidden md:flex items-center gap-2 text-sm text-slate-500 whitespace-nowrap">
              <span className="font-semibold text-slate-900">Ai Leads Hunter</span>
              <span aria-hidden="true">/</span>
              <span>
                {activeTab === 'pipeline'
                  ? 'All Discovered Leads'
                  : activeTab === 'warm'
                    ? 'Warm High-Intent Leads'
                    : 'Daily Summary Report'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xlsm"
              onChange={handleCsvUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <FolderUp className="w-3.5 h-3.5" />
              Import CSV / Excel
            </button>
            <button
              type="button"
              onClick={() => handleExportCsv(filteredLeads, `leads_filtered_${new Date().toISOString().slice(0, 10)}.csv`)}
              disabled={filteredLeads.length === 0}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => handleExportExcel(filteredLeads, `leads_filtered_${new Date().toISOString().slice(0, 10)}.xlsx`)}
              disabled={filteredLeads.length === 0}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Export Excel (.xlsx)
            </button>
          </div>
        </header>

        {/* Mobile Tab Switcher */}
        <div className="md:hidden bg-white border-b border-slate-200 px-4 py-2 flex items-center gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('pipeline')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'pipeline' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Pipeline ({stats.total})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('warm')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'warm' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Warm ({stats.warm})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('report')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'report' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Daily Report
          </button>
        </div>

        {/* Workspace Content */}
        <main className="flex-1 p-6 space-y-5 max-w-[1600px] w-full mx-auto">
          {/* Live Discovery Bar */}
          <section className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="hunt-source" className="block text-xs font-medium text-slate-600 mb-1">
                  Public Data Source
                </label>
                <select
                  id="hunt-source"
                  value={huntSource}
                  onChange={(e) => setHuntSource(e.target.value as SourceOption)}
                  className="h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="all">All Free US Sources (USASpending + Permits)</option>
                  <option value="usaspending">USASpending.gov Federal Awards</option>
                  <option value="permits">City Building Permits (Austin & Chicago)</option>
                </select>
              </div>

              <div>
                <label htmlFor="hunt-state" className="block text-xs font-medium text-slate-600 mb-1">
                  US State (Optional)
                </label>
                <input
                  id="hunt-state"
                  type="text"
                  maxLength={2}
                  value={huntState}
                  onChange={(e) => setHuntState(e.target.value.toUpperCase())}
                  placeholder="All (e.g. TX)"
                  className="w-28 h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 uppercase focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div>
                <label htmlFor="hunt-limit" className="block text-xs font-medium text-slate-600 mb-1">
                  Batch Size
                </label>
                <select
                  id="hunt-limit"
                  value={huntLimit}
                  onChange={(e) => setHuntLimit(Number(e.target.value))}
                  className="h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value={2}>Small (2 / category)</option>
                  <option value={3}>Standard (3 / category)</option>
                  <option value={5}>Deep (5 / category)</option>
                </select>
              </div>
              <label className="h-9 px-2.5 inline-flex items-center gap-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={autoFindContacts}
                  onChange={(e) => setAutoFindContacts(e.target.checked)}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-600"
                />
                Auto-find phones &amp; emails
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {leads.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleEnrichMissingContacts}
                    disabled={hunting || enrichingContacts}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50 whitespace-nowrap"
                  >
                    <PhoneCall className="w-3.5 h-3.5" />
                    {enrichingContacts ? 'Finding Contacts...' : 'Find Missing Contacts'}
                  </button>
                  {confirmClear ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleClearAll}
                        className="px-3 py-2 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 whitespace-nowrap"
                      >
                        Confirm Clear
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClear(false)}
                        className="px-2.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClear(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={handleHuntLive}
                disabled={hunting || enrichingContacts}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {hunting
                  ? 'Finding Projects...'
                  : enrichingContacts
                    ? 'Finding Contacts...'
                    : 'Hunt Projects + Contacts'}
              </button>
            </div>
          </section>

          {bannerMessage && (
            <div
              role="status"
              className={`px-4 py-2.5 text-xs rounded-md border flex items-center justify-between gap-4 ${
                bannerMessage.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-white border-slate-200 text-slate-700'
              }`}
            >
              <span>{bannerMessage.text}</span>
              <button
                type="button"
                onClick={() => setBannerMessage(null)}
                className="text-slate-500 hover:text-slate-900 font-medium whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'report' ? (
            <DailyReportView leads={leads} onExportCsv={handleExportCsv} onExportExcel={handleExportExcel} />
          ) : (
            <>
              <DailyQuotaTracker
                quota={dailyQuota}
                huntSource={huntSource}
                huntLimit={huntLimit}
                onChangeDailyTier={(limit) =>
                  setDailyQuota((prev) => ({
                    ...prev,
                    discoveryLimit: limit,
                    contactLimit: limit,
                  }))
                }
                onResetToday={() =>
                  setDailyQuota((prev) => createDefaultQuota(prev.discoveryLimit, prev.contactLimit))
                }
              />

              <AutomatedScoringEngine
                leads={leads}
                config={scoringConfig}
                onApplyScoring={handleApplyScoring}
              />

              {/* KPI Strip */}
              <section className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
                <div className="p-4">
                  <div className="text-xs text-slate-500">Total Qualified & Discovered</div>
                  <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">
                    {stats.total}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Warm Leads (Score 70+)</div>
                  <div className="text-2xl font-semibold text-amber-700 font-mono-tabular mt-1">
                    {stats.warm}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Potential Leads</div>
                  <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">
                    {stats.potential}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Average Lead Score</div>
                  <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">
                    {stats.avgScore}/100
                  </div>
                </div>
              </section>

              {/* Main Table + Inspector Split */}
              <div className="flex flex-col lg:flex-row gap-5 items-start">
                <div className="flex-1 min-w-0 w-full bg-white border border-slate-200 rounded-lg overflow-hidden">
                  {/* Search & Filter Toolbar */}
                  <div className="p-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search company, project, city, or buying-intent signal..."
                        className="w-full h-9 pl-8 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {activeTab === 'pipeline' && (
                        <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
                          {(['ALL', 'Warm', 'Potential'] as const).map((tier) => (
                            <button
                              key={tier}
                              type="button"
                              onClick={() => setTierFilter(tier)}
                              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                                tierFilter === tier
                                  ? 'bg-white text-slate-900 shadow-xs'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              {tier === 'ALL' ? 'All Tiers' : tier}
                            </button>
                          ))}
                        </div>
                      )}

                      <select
                        aria-label="Filter by target service"
                        value={serviceFilter}
                        onChange={(e) => setServiceFilter(e.target.value)}
                        className="h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                      >
                        <option value="ALL">All Services</option>
                        <option value="Construction Estimation">Estimation</option>
                        <option value="Architectural Services">Architectural</option>
                        <option value="Millwork Services">Millwork</option>
                      </select>

                      <select
                        aria-label="Filter by US state"
                        value={stateFilter}
                        onChange={(e) => setStateFilter(e.target.value)}
                        className="h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                      >
                        <option value="ALL">All States</option>
                        {availableStates.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>

                      <select
                        aria-label="Minimum lead score"
                        value={minScore}
                        onChange={(e) => setMinScore(Number(e.target.value))}
                        className="h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                      >
                        <option value={0}>Score 0+</option>
                        <option value={50}>Score 50+</option>
                        <option value={70}>Score 70+ (Warm)</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => setLiveProjectsOnly((v) => !v)}
                        className={`h-8 px-2.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                          liveProjectsOnly
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        Live / Won Projects
                      </button>

                      <button
                        type="button"
                        onClick={() => setHasContactOnly((v) => !v)}
                        className={`h-8 px-2.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                          hasContactOnly
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        Has Phone / Email
                      </button>
                    </div>
                  </div>

                  {/* Empty State or Populated Data Grid */}
                  {leads.length === 0 ? (
                    <div className="p-12 text-center space-y-3">
                      <h2 className="text-base font-semibold text-slate-900">
                        Ready to hunt real US construction leads
                      </h2>
                      <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                        Click <strong>Hunt Projects + Contacts</strong> above to pull active US contractors, or import an Excel/CSV file with <strong>Nmbs + Company Name</strong> to automatically find websites, emails, live projects, and score Warm/Potential leads.
                      </p>
                      <div className="pt-2 flex items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={handleHuntLive}
                          disabled={hunting}
                          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors whitespace-nowrap"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          {hunting ? 'Hunting Live Leads...' : 'Hunt Projects + Contacts'}
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
                        >
                          <FolderUp className="w-3.5 h-3.5" />
                          Import Excel / CSV
                        </button>
                      </div>
                    </div>
                  ) : filteredLeads.length === 0 ? (
                    <div className="p-10 text-center text-xs text-slate-500">
                      No leads match your current search or filter settings.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                            <th className="py-2.5 px-4 font-medium">Company & Live Project</th>
                            <th className="py-2.5 px-3 font-medium">Project Contact</th>
                            <th className="py-2.5 px-3 font-medium">Location</th>
                            <th className="py-2.5 px-3 font-medium">Service Match</th>
                            <th className="py-2.5 px-3 font-medium">Tier & Status</th>
                            <th className="py-2.5 px-4 font-medium text-right">Score</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredLeads.map((lead) => {
                            const isSelected = lead.id === selectedLead?.id;
                            const srcUrl = safeExternalUrl(lead.project_source_url || lead.company_source_url);
                            return (
                              <tr
                                key={lead.id}
                                onClick={() => setSelectedLeadId(lead.id)}
                                className={`cursor-pointer transition-colors ${
                                  isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'
                                }`}
                              >
                                <td className="py-2.5 px-4 max-w-[300px]">
                                  <div className="font-semibold text-slate-900 truncate">
                                    {lead.company_name}
                                  </div>
                                  <div className="text-[11px] text-slate-500 truncate mt-0.5 flex items-center gap-1.5">
                                    <span className="truncate">
                                      {lead.project_name || lead.company_category || lead.source_name}
                                      {lead.project_status ? ` · ${lead.project_status}` : ''}
                                    </span>
                                    {srcUrl && (
                                      <a
                                        href={srcUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        aria-label={`Open source for ${lead.company_name}`}
                                        className="text-blue-700 hover:text-blue-900 shrink-0"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 max-w-[200px]">
                                  <div className="text-slate-900 font-medium truncate">
                                    {lead.contact_person || '—'}
                                  </div>
                                  <div className="text-[11px] font-mono-tabular text-slate-500 truncate">
                                    {lead.business_phone || lead.business_email || 'Needs site check'}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 whitespace-nowrap text-slate-700">
                                  {[lead.city, lead.state].filter(Boolean).join(', ') || '—'}
                                </td>
                                <td className="py-2.5 px-3 whitespace-nowrap text-slate-700">
                                  {lead.service_opportunity || 'Estimation'}
                                </td>
                                <td className="py-2.5 px-3 whitespace-nowrap">
                                  <span
                                    className={
                                      lead.lead_tier === 'Warm'
                                        ? 'font-semibold text-amber-700'
                                        : lead.lead_tier === 'Potential'
                                          ? 'font-medium text-slate-800'
                                          : 'text-slate-500'
                                    }
                                  >
                                    {lead.lead_tier}
                                  </span>
                                  <span className="text-slate-400 mx-1.5">·</span>
                                  <span className="text-slate-600">{lead.outreach_status}</span>
                                </td>
                                <td className="py-2.5 px-4 text-right font-mono-tabular font-semibold text-slate-900">
                                  {lead.lead_score}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Detail Inspector */}
                {selectedLead && (
                  <LeadDetailPanel
                    lead={selectedLead}
                    onClose={() => setSelectedLeadId(null)}
                    onUpdateLead={handleUpdateLead}
                    scoringConfig={scoringConfig}
                    onContactLookupComplete={({ phonesFound, emailsFound }) =>
                      recordContactUsage(1, phonesFound, emailsFound)
                    }
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
