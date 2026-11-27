import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildNormalizedLead,
  cleanText,
  DEFAULT_SCORING_CONFIG,
  normalizeEmailKey,
  normalizePhone,
  normalizeWebsite,
  safeExternalUrl,
  scoreLead,
  type ScoringCriteriaConfig,
} from '../src/lib/leadEngine.ts';
import type {
  DashboardDbStats,
  DiscoveryJob,
  DuplicateRelation,
  Lead,
  OllamaSettings,
  VerificationStatus,
} from '../src/types/lead.ts';

const DEFAULT_OLLAMA_SETTINGS: OllamaSettings = {
  enabled: false,
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || '',
  timeoutMs: 25000,
};

function strongerVerif(a: VerificationStatus, b: VerificationStatus): VerificationStatus {
  const rank: Record<VerificationStatus, number> = {
    Verified: 4,
    'Publicly Listed': 3,
    Inferred: 2,
    Unknown: 1,
  };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

export class LeadDatabase {
  private db: DatabaseSync;

  constructor(dbPath = path.resolve(process.cwd(), 'data/db/leads_hunter.db')) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        website TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        business_address TEXT NOT NULL DEFAULT '',
        business_email TEXT NOT NULL DEFAULT '',
        business_phone TEXT NOT NULL DEFAULT '',
        phone_digits TEXT NOT NULL DEFAULT '',
        phone_type TEXT NOT NULL DEFAULT '',
        contact_person TEXT NOT NULL DEFAULT '',
        job_title TEXT NOT NULL DEFAULT '',
        contact_source_url TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '',
        zip_code TEXT NOT NULL DEFAULT '',
        company_category TEXT NOT NULL DEFAULT '',
        construction_trade TEXT NOT NULL DEFAULT '',
        services_offered TEXT NOT NULL DEFAULT '',
        service_opportunity TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        project_description TEXT NOT NULL DEFAULT '',
        project_location TEXT NOT NULL DEFAULT '',
        project_type TEXT NOT NULL DEFAULT '',
        project_owner TEXT NOT NULL DEFAULT '',
        general_contractor TEXT NOT NULL DEFAULT '',
        subcontractor TEXT NOT NULL DEFAULT '',
        project_value TEXT NOT NULL DEFAULT '',
        project_status TEXT NOT NULL DEFAULT '',
        bid_date TEXT NOT NULL DEFAULT '',
        project_source_url TEXT NOT NULL DEFAULT '',
        company_source_url TEXT NOT NULL DEFAULT '',
        website_status TEXT NOT NULL DEFAULT 'Unknown',
        email_status TEXT NOT NULL DEFAULT 'Unknown',
        phone_status TEXT NOT NULL DEFAULT 'Unknown',
        contact_status TEXT NOT NULL DEFAULT 'Unknown',
        buying_intent_evidence TEXT NOT NULL DEFAULT '',
        qualification_reason TEXT NOT NULL DEFAULT '',
        ai_summary TEXT NOT NULL DEFAULT '',
        lead_score INTEGER NOT NULL DEFAULT 0,
        score_breakdown_json TEXT NOT NULL DEFAULT '[]',
        confidence_level TEXT NOT NULL DEFAULT 'Unverified',
        lead_tier TEXT NOT NULL DEFAULT 'Low Priority',
        source_name TEXT NOT NULL DEFAULT '',
        all_sources_json TEXT NOT NULL DEFAULT '[]',
        all_source_urls_json TEXT NOT NULL DEFAULT '[]',
        date_discovered TEXT NOT NULL,
        last_verified TEXT NOT NULL,
        outreach_status TEXT NOT NULL DEFAULT 'New',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_digits);
      CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(business_email);
      CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);
      CREATE INDEX IF NOT EXISTS idx_leads_norm_state ON leads(normalized_name, state);
      CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score DESC);

      CREATE TABLE IF NOT EXISTS lead_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        evidence_text TEXT NOT NULL DEFAULT '',
        collected_at TEXT NOT NULL,
        UNIQUE(lead_id, source_name, source_url, evidence_text)
      );

      CREATE TABLE IF NOT EXISTS seen_contacts (
        contact_type TEXT NOT NULL,
        contact_key TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (contact_type, contact_key)
      );

      CREATE TABLE IF NOT EXISTS duplicate_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        primary_lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        primary_company_name TEXT NOT NULL,
        duplicate_company_name TEXT NOT NULL,
        duplicate_phone TEXT NOT NULL DEFAULT '',
        duplicate_email TEXT NOT NULL DEFAULT '',
        duplicate_domain TEXT NOT NULL DEFAULT '',
        match_reason TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        resolved_status TEXT NOT NULL DEFAULT 'merged',
        detected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        state_filter TEXT NOT NULL DEFAULT '',
        trade_filter TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        total_target INTEGER NOT NULL DEFAULT 0,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        added_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        current_step TEXT NOT NULL DEFAULT '',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        source_stats_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS verification_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        old_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        method TEXT NOT NULL,
        verified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scoring_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        score INTEGER NOT NULL,
        tier TEXT NOT NULL,
        scored_by TEXT NOT NULL,
        scored_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS export_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        export_type TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        filename TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private rowToLead(row: Record<string, unknown>): Lead {
    const parseJson = <T>(raw: unknown, fallback: T): T => {
      if (typeof raw !== 'string' || !raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    return {
      id: String(row.id || ''),
      company_name: String(row.company_name || ''),
      normalized_name: String(row.normalized_name || ''),
      website: String(row.website || ''),
      domain: String(row.domain || ''),
      business_address: String(row.business_address || ''),
      business_email: String(row.business_email || ''),
      business_phone: String(row.business_phone || ''),
      phone_digits: String(row.phone_digits || ''),
      phone_type: String(row.phone_type || ''),
      contact_person: String(row.contact_person || ''),
      job_title: String(row.job_title || ''),
      contact_source_url: String(row.contact_source_url || ''),
      city: String(row.city || ''),
      state: String(row.state || ''),
      zip_code: String(row.zip_code || ''),
      company_category: String(row.company_category || ''),
      construction_trade: String(row.construction_trade || ''),
      services_offered: String(row.services_offered || ''),
      service_opportunity: String(row.service_opportunity || ''),
      project_name: String(row.project_name || ''),
      project_description: String(row.project_description || ''),
      project_location: String(row.project_location || ''),
      project_type: String(row.project_type || ''),
      project_owner: String(row.project_owner || ''),
      general_contractor: String(row.general_contractor || ''),
      subcontractor: String(row.subcontractor || ''),
      project_value: String(row.project_value || ''),
      project_status: String(row.project_status || ''),
      bid_date: String(row.bid_date || ''),
      project_source_url: String(row.project_source_url || ''),
      company_source_url: String(row.company_source_url || ''),
      website_status: (row.website_status as VerificationStatus) || 'Unknown',
      email_status: (row.email_status as VerificationStatus) || 'Unknown',
      phone_status: (row.phone_status as VerificationStatus) || 'Unknown',
      contact_status: (row.contact_status as VerificationStatus) || 'Unknown',
      buying_intent_evidence: String(row.buying_intent_evidence || ''),
      qualification_reason: String(row.qualification_reason || ''),
      ai_summary: String(row.ai_summary || ''),
      lead_score: Number(row.lead_score || 0),
      score_breakdown: parseJson(row.score_breakdown_json, []),
      confidence_level: (row.confidence_level as Lead['confidence_level']) || 'Unverified',
      lead_tier: (row.lead_tier as Lead['lead_tier']) || 'Low Priority',
      source_name: String(row.source_name || ''),
      all_sources: parseJson(row.all_sources_json, []),
      all_source_urls: parseJson(row.all_source_urls_json, []),
      date_discovered: String(row.date_discovered || ''),
      last_verified: String(row.last_verified || ''),
      outreach_status: (row.outreach_status as Lead['outreach_status']) || 'New',
      notes: String(row.notes || ''),
    };
  }

  getLeads(): Lead[] {
    const rows = this.db
      .prepare('SELECT * FROM leads ORDER BY lead_score DESC, updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToLead(r));
  }

  getLeadById(id: string): Lead | null {
    const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToLead(row) : null;
  }

  private findDuplicateLead(lead: Lead): { row: Record<string, unknown>; reason: string } | null {
    const phoneDigits = lead.phone_digits || normalizePhone(lead.business_phone).digits;
    if (phoneDigits) {
      const row = this.db
        .prepare('SELECT * FROM leads WHERE phone_digits = ? LIMIT 1')
        .get(phoneDigits) as Record<string, unknown> | undefined;
      if (row) return { row, reason: 'Matched phone number' };
    }

    const email = normalizeEmailKey(lead.business_email);
    if (email) {
      const row = this.db
        .prepare('SELECT * FROM leads WHERE business_email = ? LIMIT 1')
        .get(email) as Record<string, unknown> | undefined;
      if (row) return { row, reason: 'Matched business email' };
    }

    const domain = lead.domain || normalizeWebsite(lead.website).domain;
    if (domain) {
      const row = this.db
        .prepare('SELECT * FROM leads WHERE domain = ? LIMIT 1')
        .get(domain) as Record<string, unknown> | undefined;
      if (row) return { row, reason: 'Matched website domain' };
    }

    if (lead.normalized_name && lead.state) {
      const row = this.db
        .prepare('SELECT * FROM leads WHERE normalized_name = ? AND state = ? LIMIT 1')
        .get(lead.normalized_name, lead.state) as Record<string, unknown> | undefined;
      if (row) return { row, reason: 'Matched company name + state' };
    }

    if (lead.normalized_name && lead.zip_code) {
      const row = this.db
        .prepare('SELECT * FROM leads WHERE normalized_name = ? AND zip_code = ? LIMIT 1')
        .get(lead.normalized_name, lead.zip_code) as Record<string, unknown> | undefined;
      if (row) return { row, reason: 'Matched company name + ZIP' };
    }

    return null;
  }

  private recordSeen(lead: Lead) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO seen_contacts (contact_type, contact_key, first_seen_at) VALUES (?, ?, ?)',
    );
    const phone = lead.phone_digits || normalizePhone(lead.business_phone).digits;
    if (phone && /^\d{10}$/.test(phone)) stmt.run('phone', phone, now);
    const email = normalizeEmailKey(lead.business_email);
    if (email) stmt.run('email', email, now);
  }

  isSeenContact(phoneDigits: string, email: string): boolean {
    if (phoneDigits && /^\d{10}$/.test(phoneDigits)) {
      const found = this.db
        .prepare('SELECT 1 FROM seen_contacts WHERE contact_type = ? AND contact_key = ?')
        .get('phone', phoneDigits);
      if (found) return true;
    }
    const cleanEmail = normalizeEmailKey(email);
    if (cleanEmail) {
      const found = this.db
        .prepare('SELECT 1 FROM seen_contacts WHERE contact_type = ? AND contact_key = ?')
        .get('email', cleanEmail);
      if (found) return true;
    }
    return false;
  }

  getSeenContactsMap(): { phones: Record<string, true>; emails: Record<string, true> } {
    const phones: Record<string, true> = {};
    const emails: Record<string, true> = {};
    const rows = this.db.prepare('SELECT contact_type, contact_key FROM seen_contacts').all() as Array<{
      contact_type: string;
      contact_key: string;
    }>;
    for (const r of rows) {
      if (r.contact_type === 'phone') phones[r.contact_key] = true;
      if (r.contact_type === 'email') emails[r.contact_key] = true;
    }
    return { phones, emails };
  }

  resetSeenContacts(preserveCurrentLeads = true) {
    this.db.exec('DELETE FROM seen_contacts;');
    if (preserveCurrentLeads) {
      const current = this.getLeads();
      for (const l of current) {
        this.recordSeen(l);
      }
    }
  }

  upsertLeads(
    incoming: Partial<Lead>[],
    options: { checkCrossSession?: boolean; scoringConfig?: ScoringCriteriaConfig } = {},
  ): {
    added: number;
    duplicates: number;
    crossSessionBlocked: number;
    leads: Lead[];
  } {
    const checkCrossSession = options.checkCrossSession !== false;
    const config = options.scoringConfig || this.getScoringConfig();
    const now = new Date().toISOString();

    let added = 0;
    let duplicates = 0;
    let crossSessionBlocked = 0;

    const insertStmt = this.db.prepare(`
      INSERT INTO leads (
        id, company_name, normalized_name, website, domain, business_address,
        business_email, business_phone, phone_digits, phone_type, contact_person,
        job_title, contact_source_url, city, state, zip_code, company_category,
        construction_trade, services_offered, service_opportunity, project_name,
        project_description, project_location, project_type, project_owner,
        general_contractor, subcontractor, project_value, project_status, bid_date,
        project_source_url, company_source_url, website_status, email_status,
        phone_status, contact_status, buying_intent_evidence, qualification_reason,
        ai_summary, lead_score, score_breakdown_json, confidence_level, lead_tier,
        source_name, all_sources_json, all_source_urls_json, date_discovered,
        last_verified, outreach_status, notes, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const updateStmt = this.db.prepare(`
      UPDATE leads SET
        website = ?, domain = ?, business_address = ?, business_email = ?,
        business_phone = ?, phone_digits = ?, phone_type = ?, contact_person = ?,
        job_title = ?, contact_source_url = ?, city = ?, state = ?, zip_code = ?,
        company_category = ?, construction_trade = ?, services_offered = ?,
        service_opportunity = ?, project_name = ?, project_description = ?,
        project_location = ?, project_type = ?, project_owner = ?,
        general_contractor = ?, subcontractor = ?, project_value = ?,
        project_status = ?, bid_date = ?, project_source_url = ?,
        company_source_url = ?, website_status = ?, email_status = ?,
        phone_status = ?, contact_status = ?, buying_intent_evidence = ?,
        qualification_reason = ?, ai_summary = ?, lead_score = ?,
        score_breakdown_json = ?, confidence_level = ?, lead_tier = ?,
        all_sources_json = ?, all_source_urls_json = ?, last_verified = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const insertSourceStmt = this.db.prepare(`
      INSERT OR IGNORE INTO lead_sources (lead_id, source_name, source_url, evidence_text, collected_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertDupStmt = this.db.prepare(`
      INSERT INTO duplicate_relations (
        primary_lead_id, primary_company_name, duplicate_company_name,
        duplicate_phone, duplicate_email, duplicate_domain, match_reason,
        source_name, source_url, resolved_status, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'merged', ?)
    `);

    this.db.exec('BEGIN');
    try {
      for (const raw of incoming) {
        const lead = buildNormalizedLead(raw, config);
        if (!lead.company_name || lead.normalized_name.length < 2) continue;

        const existingMatch = this.findDuplicateLead(lead);
        if (!existingMatch) {
          if (checkCrossSession && this.isSeenContact(lead.phone_digits, lead.business_email)) {
            duplicates += 1;
            crossSessionBlocked += 1;
            continue;
          }

          // Guarantee unique primary ID in case of suffix collision
          let finalId = lead.id;
          const clash = this.db.prepare('SELECT 1 FROM leads WHERE id = ?').get(finalId);
          if (clash) finalId = `${lead.id}_${Math.random().toString(36).slice(2, 6)}`;
          lead.id = finalId;

          insertStmt.run(
            lead.id,
            lead.company_name,
            lead.normalized_name,
            lead.website,
            lead.domain,
            lead.business_address,
            lead.business_email,
            lead.business_phone,
            lead.phone_digits,
            lead.phone_type,
            lead.contact_person,
            lead.job_title,
            lead.contact_source_url,
            lead.city,
            lead.state,
            lead.zip_code,
            lead.company_category,
            lead.construction_trade,
            lead.services_offered,
            lead.service_opportunity,
            lead.project_name,
            lead.project_description,
            lead.project_location,
            lead.project_type,
            lead.project_owner,
            lead.general_contractor,
            lead.subcontractor,
            lead.project_value,
            lead.project_status,
            lead.bid_date,
            lead.project_source_url,
            lead.company_source_url,
            lead.website_status,
            lead.email_status,
            lead.phone_status,
            lead.contact_status,
            lead.buying_intent_evidence,
            lead.qualification_reason,
            lead.ai_summary || '',
            lead.lead_score,
            JSON.stringify(lead.score_breakdown),
            lead.confidence_level,
            lead.lead_tier,
            lead.source_name,
            JSON.stringify(lead.all_sources),
            JSON.stringify(lead.all_source_urls || []),
            lead.date_discovered,
            lead.last_verified,
            lead.outreach_status,
            lead.notes,
            now,
            now,
          );

          insertSourceStmt.run(
            lead.id,
            lead.source_name,
            lead.project_source_url || lead.company_source_url || '',
            lead.buying_intent_evidence || '',
            now,
          );
          this.recordSeen(lead);
          added += 1;
          continue;
        }

        const cur = this.rowToLead(existingMatch.row);
        if (
          checkCrossSession &&
          ((lead.phone_digits &&
            lead.phone_digits !== cur.phone_digits &&
            this.isSeenContact(lead.phone_digits, '')) ||
            (lead.business_email &&
              lead.business_email !== cur.business_email &&
              this.isSeenContact('', lead.business_email)))
        ) {
          duplicates += 1;
          crossSessionBlocked += 1;
          continue;
        }

        duplicates += 1;
        const combinedSources = Array.from(new Set([...cur.all_sources, ...lead.all_sources]));
        const combinedUrls = Array.from(
          new Set(
            [
              ...(cur.all_source_urls || []),
              ...(lead.all_source_urls || []),
              cur.project_source_url,
              cur.company_source_url,
              cur.contact_source_url,
              lead.project_source_url,
              lead.company_source_url,
              lead.contact_source_url,
            ].filter(Boolean),
          ),
        );

        const mergedEvidence =
          cur.buying_intent_evidence &&
          lead.buying_intent_evidence &&
          !cur.buying_intent_evidence.includes(lead.buying_intent_evidence)
            ? `${cur.buying_intent_evidence} | ${lead.buying_intent_evidence}`
            : cur.buying_intent_evidence || lead.buying_intent_evidence;

        const mergedLead: Lead = {
          ...cur,
          website: cur.website || lead.website,
          domain: cur.domain || lead.domain,
          business_address: cur.business_address || lead.business_address,
          business_email: cur.business_email || lead.business_email,
          business_phone: cur.business_phone || lead.business_phone,
          phone_digits: cur.phone_digits || lead.phone_digits,
          phone_type: cur.phone_type || lead.phone_type,
          contact_person: cur.contact_person || lead.contact_person,
          job_title: cur.job_title || lead.job_title,
          contact_source_url: cur.contact_source_url || lead.contact_source_url,
          city: cur.city || lead.city,
          state: cur.state || lead.state,
          zip_code: cur.zip_code || lead.zip_code,
          company_category: cur.company_category || lead.company_category,
          construction_trade: cur.construction_trade || lead.construction_trade,
          services_offered: cur.services_offered || lead.services_offered,
          service_opportunity: cur.service_opportunity || lead.service_opportunity,
          project_name: cur.project_name || lead.project_name,
          project_description: cur.project_description || lead.project_description,
          project_location: cur.project_location || lead.project_location,
          project_type: cur.project_type || lead.project_type,
          project_owner: cur.project_owner || lead.project_owner,
          general_contractor: cur.general_contractor || lead.general_contractor,
          subcontractor: cur.subcontractor || lead.subcontractor,
          project_value: cur.project_value || lead.project_value,
          project_status: cur.project_status || lead.project_status,
          bid_date: cur.bid_date || lead.bid_date,
          project_source_url: cur.project_source_url || lead.project_source_url,
          company_source_url: cur.company_source_url || lead.company_source_url,
          website_status: strongerVerif(cur.website_status, lead.website_status),
          email_status: strongerVerif(cur.email_status, lead.email_status),
          phone_status: strongerVerif(cur.phone_status, lead.phone_status),
          contact_status: strongerVerif(cur.contact_status, lead.contact_status),
          buying_intent_evidence: mergedEvidence,
          ai_summary: cur.ai_summary || lead.ai_summary,
          all_sources: combinedSources,
          all_source_urls: combinedUrls,
          last_verified: lead.last_verified || cur.last_verified,
        };

        const rescored = scoreLead(mergedLead, config);
        if (rescored.score >= cur.lead_score) {
          mergedLead.lead_score = rescored.score;
          mergedLead.score_breakdown = rescored.breakdown;
          mergedLead.lead_tier = rescored.tier;
          mergedLead.confidence_level = rescored.confidence;
          mergedLead.qualification_reason = rescored.reason;
        }

        updateStmt.run(
          mergedLead.website,
          mergedLead.domain,
          mergedLead.business_address,
          mergedLead.business_email,
          mergedLead.business_phone,
          mergedLead.phone_digits,
          mergedLead.phone_type,
          mergedLead.contact_person,
          mergedLead.job_title,
          mergedLead.contact_source_url,
          mergedLead.city,
          mergedLead.state,
          mergedLead.zip_code,
          mergedLead.company_category,
          mergedLead.construction_trade,
          mergedLead.services_offered,
          mergedLead.service_opportunity,
          mergedLead.project_name,
          mergedLead.project_description,
          mergedLead.project_location,
          mergedLead.project_type,
          mergedLead.project_owner,
          mergedLead.general_contractor,
          mergedLead.subcontractor,
          mergedLead.project_value,
          mergedLead.project_status,
          mergedLead.bid_date,
          mergedLead.project_source_url,
          mergedLead.company_source_url,
          mergedLead.website_status,
          mergedLead.email_status,
          mergedLead.phone_status,
          mergedLead.contact_status,
          mergedLead.buying_intent_evidence,
          mergedLead.qualification_reason,
          mergedLead.ai_summary || '',
          mergedLead.lead_score,
          JSON.stringify(mergedLead.score_breakdown),
          mergedLead.confidence_level,
          mergedLead.lead_tier,
          JSON.stringify(mergedLead.all_sources),
          JSON.stringify(mergedLead.all_source_urls || []),
          mergedLead.last_verified,
          now,
          cur.id,
        );

        insertSourceStmt.run(
          cur.id,
          lead.source_name,
          lead.project_source_url || lead.company_source_url || '',
          lead.buying_intent_evidence || '',
          now,
        );

        insertDupStmt.run(
          cur.id,
          cur.company_name,
          lead.company_name,
          lead.business_phone,
          lead.business_email,
          lead.domain,
          existingMatch.reason,
          lead.source_name,
          lead.project_source_url || lead.company_source_url || '',
          now,
        );

        this.recordSeen(mergedLead);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { added, duplicates, crossSessionBlocked, leads: this.getLeads() };
  }

  updateLead(id: string, patch: Partial<Lead>): Lead | null {
    const existing = this.getLeadById(id);
    if (!existing) return null;

    const config = this.getScoringConfig();
    const updated = buildNormalizedLead(
      {
        ...existing,
        ...patch,
        id: existing.id,
        // Reset explicit score unless caller manually pinned a score and didn't change contact/project fields
        lead_score: typeof patch.lead_score === 'number' ? patch.lead_score : undefined,
      },
      config,
    );

    const now = new Date().toISOString();
    if (patch.website_status && patch.website_status !== existing.website_status) {
      this.db
        .prepare(
          'INSERT INTO verification_history (lead_id, field_name, old_status, new_status, method, verified_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, 'website_status', existing.website_status, patch.website_status, 'Website Inspection', now);
    }

    this.db
      .prepare(
        `UPDATE leads SET
          website = ?, domain = ?, business_address = ?, business_email = ?,
          business_phone = ?, phone_digits = ?, phone_type = ?, contact_person = ?,
          job_title = ?, contact_source_url = ?, city = ?, state = ?, zip_code = ?,
          company_category = ?, construction_trade = ?, services_offered = ?,
          service_opportunity = ?, project_name = ?, project_description = ?,
          project_location = ?, project_type = ?, project_owner = ?,
          general_contractor = ?, subcontractor = ?, project_value = ?,
          project_status = ?, bid_date = ?, project_source_url = ?,
          company_source_url = ?, website_status = ?, email_status = ?,
          phone_status = ?, contact_status = ?, buying_intent_evidence = ?,
          qualification_reason = ?, ai_summary = ?, lead_score = ?,
          score_breakdown_json = ?, confidence_level = ?, lead_tier = ?,
          all_sources_json = ?, all_source_urls_json = ?, last_verified = ?,
          outreach_status = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        updated.website,
        updated.domain,
        updated.business_address,
        updated.business_email,
        updated.business_phone,
        updated.phone_digits,
        updated.phone_type,
        updated.contact_person,
        updated.job_title,
        updated.contact_source_url,
        updated.city,
        updated.state,
        updated.zip_code,
        updated.company_category,
        updated.construction_trade,
        updated.services_offered,
        updated.service_opportunity,
        updated.project_name,
        updated.project_description,
        updated.project_location,
        updated.project_type,
        updated.project_owner,
        updated.general_contractor,
        updated.subcontractor,
        updated.project_value,
        updated.project_status,
        updated.bid_date,
        updated.project_source_url,
        updated.company_source_url,
        updated.website_status,
        updated.email_status,
        updated.phone_status,
        updated.contact_status,
        updated.buying_intent_evidence,
        updated.qualification_reason,
        updated.ai_summary || '',
        updated.lead_score,
        JSON.stringify(updated.score_breakdown),
        updated.confidence_level,
        updated.lead_tier,
        JSON.stringify(updated.all_sources),
        JSON.stringify(updated.all_source_urls || []),
        updated.last_verified,
        updated.outreach_status,
        updated.notes,
        now,
        id,
      );

    this.recordSeen(updated);
    return this.getLeadById(id);
  }

  rescoreAll(config: ScoringCriteriaConfig): Lead[] {
    this.setSetting('scoring_config', config);
    const all = this.getLeads();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE leads SET lead_score = ?, score_breakdown_json = ?, lead_tier = ?, confidence_level = ?, qualification_reason = ?, updated_at = ? WHERE id = ?`,
    );
    const histStmt = this.db.prepare(
      'INSERT INTO scoring_history (lead_id, score, tier, scored_by, scored_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const lead of all) {
        const s = scoreLead(lead, config);
        stmt.run(s.score, JSON.stringify(s.breakdown), s.tier, s.confidence, s.reason, now, lead.id);
        histStmt.run(lead.id, s.score, s.tier, 'Automated Rule Engine', now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getLeads();
  }

  clearAllLeadsKeepSeen() {
    const all = this.getLeads();
    for (const l of all) this.recordSeen(l);
    this.db.exec('DELETE FROM duplicate_relations; DELETE FROM lead_sources; DELETE FROM leads;');
  }

  getDuplicateRelations(limit = 100): DuplicateRelation[] {
    return this.db
      .prepare('SELECT * FROM duplicate_relations ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as DuplicateRelation[];
  }

  resolveDuplicateRelation(id: number, status: DuplicateRelation['resolved_status']) {
    this.db
      .prepare('UPDATE duplicate_relations SET resolved_status = ? WHERE id = ?')
      .run(status, id);
  }

  recordExport(exportType: string, rowCount: number, filename: string) {
    this.db
      .prepare('INSERT INTO export_history (export_type, row_count, filename, created_at) VALUES (?, ?, ?, ?)')
      .run(exportType, rowCount, filename, new Date().toISOString());
  }

  // ---------- Discovery Jobs ----------
  createJob(job: DiscoveryJob): DiscoveryJob {
    this.db
      .prepare(`
        INSERT INTO discovery_jobs (
          id, source, state_filter, trade_filter, status, total_target,
          fetched_count, added_count, duplicate_count, failed_count,
          current_step, warnings_json, errors_json, source_stats_json,
          started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.source,
        job.state_filter,
        job.trade_filter,
        job.status,
        job.total_target,
        job.fetched_count,
        job.added_count,
        job.duplicate_count,
        job.failed_count,
        job.current_step,
        JSON.stringify(job.warnings),
        JSON.stringify(job.errors),
        JSON.stringify(job.source_stats),
        job.started_at,
        job.updated_at,
        job.finished_at,
      );
    return job;
  }

  updateJob(job: DiscoveryJob) {
    this.db
      .prepare(`
        UPDATE discovery_jobs SET
          status = ?, fetched_count = ?, added_count = ?, duplicate_count = ?,
          failed_count = ?, current_step = ?, warnings_json = ?, errors_json = ?,
          source_stats_json = ?, updated_at = ?, finished_at = ?
        WHERE id = ?
      `)
      .run(
        job.status,
        job.fetched_count,
        job.added_count,
        job.duplicate_count,
        job.failed_count,
        job.current_step,
        JSON.stringify(job.warnings),
        JSON.stringify(job.errors),
        JSON.stringify(job.source_stats),
        job.updated_at,
        job.finished_at,
        job.id,
      );
  }

  private rowToJob(row: Record<string, unknown>): DiscoveryJob {
    const parse = <T>(raw: unknown, fb: T): T => {
      try {
        return typeof raw === 'string' && raw ? (JSON.parse(raw) as T) : fb;
      } catch {
        return fb;
      }
    };
    return {
      id: String(row.id),
      source: String(row.source),
      state_filter: String(row.state_filter || ''),
      trade_filter: String(row.trade_filter || ''),
      status: (row.status as DiscoveryJob['status']) || 'completed',
      total_target: Number(row.total_target || 0),
      fetched_count: Number(row.fetched_count || 0),
      added_count: Number(row.added_count || 0),
      duplicate_count: Number(row.duplicate_count || 0),
      failed_count: Number(row.failed_count || 0),
      current_step: String(row.current_step || ''),
      warnings: parse(row.warnings_json, []),
      errors: parse(row.errors_json, []),
      source_stats: parse(row.source_stats_json, {}),
      started_at: String(row.started_at || ''),
      updated_at: String(row.updated_at || ''),
      finished_at: String(row.finished_at || ''),
    };
  }

  getJob(id: string): DiscoveryJob | null {
    const row = this.db.prepare('SELECT * FROM discovery_jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToJob(row) : null;
  }

  listJobs(limit = 15): DiscoveryJob[] {
    const rows = this.db
      .prepare('SELECT * FROM discovery_jobs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToJob(r));
  }

  // ---------- Settings ----------
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      | { value_json?: string }
      | undefined;
    if (!row?.value_json) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting<T>(key: string, value: T) {
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getOllamaSettings(): OllamaSettings {
    return {
      ...DEFAULT_OLLAMA_SETTINGS,
      ...this.getSetting<Partial<OllamaSettings>>('ollama_settings', {}),
    };
  }

  getScoringConfig(): ScoringCriteriaConfig {
    return {
      ...DEFAULT_SCORING_CONFIG,
      ...this.getSetting<Partial<ScoringCriteriaConfig>>('scoring_config', {}),
    };
  }

  // ---------- Real SQL Dashboard Stats ----------
  getStats(): DashboardDbStats {
    const count = (sql: string) =>
      Number((this.db.prepare(sql).get() as { cnt: number }).cnt || 0);

    const totalCompanies = count('SELECT COUNT(*) AS cnt FROM leads');
    const newLeads = count("SELECT COUNT(*) AS cnt FROM leads WHERE outreach_status = 'New'");
    const verifiedLeads = count(
      "SELECT COUNT(*) AS cnt FROM leads WHERE website_status = 'Verified' OR email_status = 'Verified' OR phone_status = 'Verified' OR confidence_level IN ('Verified', 'High')",
    );
    const hotLeads = count("SELECT COUNT(*) AS cnt FROM leads WHERE lead_tier = 'Hot'");
    const warmLeads = count("SELECT COUNT(*) AS cnt FROM leads WHERE lead_tier = 'Warm'");
    const potentialLeads = count("SELECT COUNT(*) AS cnt FROM leads WHERE lead_tier = 'Potential'");
    const lowPriorityLeads = count("SELECT COUNT(*) AS cnt FROM leads WHERE lead_tier = 'Low Priority'");
    const projectOpportunities = count("SELECT COUNT(*) AS cnt FROM leads WHERE project_name != ''");
    const duplicateCount = count('SELECT COUNT(*) AS cnt FROM duplicate_relations');

    const jobs = this.listJobs(30);
    let failedSourceRequests = 0;
    let lastSuccessfulRun = '';
    for (const j of jobs) {
      failedSourceRequests += j.failed_count + j.errors.length;
      if (!lastSuccessfulRun && j.status === 'completed') {
        lastSuccessfulRun = j.finished_at || j.updated_at;
      }
    }

    const byState = this.db
      .prepare(
        `SELECT CASE WHEN state = '' THEN 'Unspecified' ELSE state END AS state,
                SUM(CASE WHEN lead_tier = 'Hot' THEN 1 ELSE 0 END) AS hot,
                SUM(CASE WHEN lead_tier = 'Warm' THEN 1 ELSE 0 END) AS warm,
                COUNT(*) AS total
         FROM leads
         GROUP BY state
         ORDER BY total DESC
         LIMIT 20`,
      )
      .all() as unknown as Array<{ state: string; hot: number; warm: number; total: number }>;

    const byTrade = this.db
      .prepare(
        `SELECT CASE WHEN construction_trade = '' THEN 'General Contractors' ELSE construction_trade END AS trade,
                COUNT(*) AS total
         FROM leads
         GROUP BY trade
         ORDER BY total DESC
         LIMIT 21`,
      )
      .all() as unknown as Array<{ trade: string; total: number }>;

    const bySource = this.db
      .prepare(
        `SELECT CASE WHEN source_name = '' THEN 'Imported CSV' ELSE source_name END AS source,
                COUNT(*) AS total
         FROM leads
         GROUP BY source
         ORDER BY total DESC`,
      )
      .all() as unknown as Array<{ source: string; total: number }>;

    return {
      totalCompanies,
      newLeads,
      verifiedLeads,
      hotLeads,
      warmLeads,
      potentialLeads,
      lowPriorityLeads,
      projectOpportunities,
      duplicateCount,
      failedSourceRequests,
      lastSuccessfulRun,
      byState,
      byTrade,
      bySource,
    };
  }

  close() {
    this.db.close();
  }
}

export { cleanText, safeExternalUrl };
