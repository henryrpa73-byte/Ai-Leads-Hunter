import type { Lead } from '../types/lead.ts';
import {
  clearSeenContactHashMap,
  normalizeEmailKey,
  recordContactsInHashMap,
} from './leadEngine.ts';

export interface SeenHistoryState {
  phones: string[];
  emails: string[];
  keys: string[];
  domains: string[];
  updatedAt: string;
}

const SEEN_HISTORY_STORAGE_KEY = 'ai_leads_hunter_seen_history_v1';
const MAX_STORED_ITEMS = 40000;

export function createEmptySeenHistory(): SeenHistoryState {
  return {
    phones: [],
    emails: [],
    keys: [],
    domains: [],
    updatedAt: new Date().toISOString(),
  };
}

export function getLeadCompanyKey(lead: Pick<Lead, 'normalized_name' | 'state'>): string {
  const name = (lead.normalized_name || '').trim();
  if (!name || name.length < 2) return '';
  const state = (lead.state || '').trim().toUpperCase();
  return state ? `${name}|${state}` : name;
}

export function loadSeenHistory(): SeenHistoryState {
  try {
    const raw = localStorage.getItem(SEEN_HISTORY_STORAGE_KEY);
    if (!raw) return createEmptySeenHistory();
    const parsed = JSON.parse(raw) as Partial<SeenHistoryState>;
    return {
      phones: Array.isArray(parsed.phones) ? parsed.phones.filter((p) => typeof p === 'string' && p.length === 10) : [],
      emails: Array.isArray(parsed.emails)
        ? parsed.emails.map((e) => normalizeEmailKey(e)).filter(Boolean)
        : [],
      keys: Array.isArray(parsed.keys) ? parsed.keys.filter((k) => typeof k === 'string' && k.length > 1) : [],
      domains: Array.isArray(parsed.domains) ? parsed.domains.filter((d) => typeof d === 'string' && d.includes('.')) : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return createEmptySeenHistory();
  }
}

export function saveSeenHistory(state: SeenHistoryState): void {
  try {
    const trimmed: SeenHistoryState = {
      phones: state.phones.slice(-MAX_STORED_ITEMS),
      emails: state.emails.slice(-MAX_STORED_ITEMS),
      keys: state.keys.slice(-MAX_STORED_ITEMS),
      domains: state.domains.slice(-MAX_STORED_ITEMS),
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(SEEN_HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota issues
  }
}

export function clearSeenHistory(preserveLeads: Lead[] = []): SeenHistoryState {
  clearSeenContactHashMap(preserveLeads);
  const empty = createEmptySeenHistory();
  const seeded = recordSeenLeads(empty, preserveLeads);
  saveSeenHistory(seeded);
  return seeded;
}

export function recordSeenLeads(history: SeenHistoryState, leads: Lead[]): SeenHistoryState {
  if (leads.length === 0) return history;
  const phoneSet = new Set(history.phones);
  const emailSet = new Set(history.emails);
  const keySet = new Set(history.keys);
  const domainSet = new Set(history.domains);

  let changed = false;
  for (const lead of leads) {
    if (lead.phone_digits && lead.phone_digits.length === 10 && !phoneSet.has(lead.phone_digits)) {
      phoneSet.add(lead.phone_digits);
      changed = true;
    }
    const email = normalizeEmailKey(lead.business_email);
    if (email && !emailSet.has(email)) {
      emailSet.add(email);
      changed = true;
    }
    const key = getLeadCompanyKey(lead);
    if (key && !keySet.has(key)) {
      keySet.add(key);
      changed = true;
    }
    if (lead.domain && !domainSet.has(lead.domain)) {
      domainSet.add(lead.domain);
      changed = true;
    }
  }

  if (!changed) return history;

  recordContactsInHashMap(leads);

  return {
    phones: Array.from(phoneSet).slice(-MAX_STORED_ITEMS),
    emails: Array.from(emailSet).slice(-MAX_STORED_ITEMS),
    keys: Array.from(keySet).slice(-MAX_STORED_ITEMS),
    domains: Array.from(domainSet).slice(-MAX_STORED_ITEMS),
    updatedAt: new Date().toISOString(),
  };
}

export function filterFreshLeads(
  incoming: Lead[],
  history: SeenHistoryState,
  existingLeads: Lead[],
): { fresh: Lead[]; skippedDuplicates: number } {
  const seenPhones = new Set(history.phones);
  const seenEmails = new Set(history.emails);
  const seenKeys = new Set(history.keys);
  const seenDomains = new Set(history.domains);

  for (const cur of existingLeads) {
    if (cur.phone_digits && cur.phone_digits.length === 10) seenPhones.add(cur.phone_digits);
    const email = normalizeEmailKey(cur.business_email);
    if (email) seenEmails.add(email);
    const k = getLeadCompanyKey(cur);
    if (k) seenKeys.add(k);
    if (cur.domain) seenDomains.add(cur.domain);
  }

  const fresh: Lead[] = [];
  let skippedDuplicates = 0;

  for (const lead of incoming) {
    if (!lead.company_name || lead.normalized_name.length < 2) {
      skippedDuplicates++;
      continue;
    }

    // Strict phone-number and email deduplication: never allow a previously delivered contact again
    if (lead.phone_digits && lead.phone_digits.length === 10) {
      if (seenPhones.has(lead.phone_digits)) {
        skippedDuplicates++;
        continue;
      }
    }

    const email = normalizeEmailKey(lead.business_email);
    if (email && seenEmails.has(email)) {
      skippedDuplicates++;
      continue;
    }

    if (lead.domain && seenDomains.has(lead.domain)) {
      skippedDuplicates++;
      continue;
    }

    const key = getLeadCompanyKey(lead);
    if (key && seenKeys.has(key)) {
      skippedDuplicates++;
      continue;
    }

    if (lead.phone_digits && lead.phone_digits.length === 10) seenPhones.add(lead.phone_digits);
    if (email) seenEmails.add(email);
    if (lead.domain) seenDomains.add(lead.domain);
    if (key) seenKeys.add(key);
    fresh.push(lead);
  }

  return { fresh, skippedDuplicates };
}
