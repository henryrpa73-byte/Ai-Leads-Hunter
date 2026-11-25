export interface DailyQuotaState {
  date: string;
  discoveryLeadsToday: number;
  usaspendingLeadsToday: number;
  permitLeadsToday: number;
  discoveryLimit: number;
  contactChecksToday: number;
  contactLimit: number;
  phonesFoundToday: number;
  emailsFoundToday: number;
  runsToday: number;
}

const QUOTA_STORAGE_KEY = 'ai_leads_hunter_daily_quota_v1';

export function getTodayDateKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createDefaultQuota(discoveryLimit = 150, contactLimit = 150): DailyQuotaState {
  return {
    date: getTodayDateKey(),
    discoveryLeadsToday: 0,
    usaspendingLeadsToday: 0,
    permitLeadsToday: 0,
    discoveryLimit,
    contactChecksToday: 0,
    contactLimit,
    phonesFoundToday: 0,
    emailsFoundToday: 0,
    runsToday: 0,
  };
}

export function loadDailyQuota(): DailyQuotaState {
  const today = getTodayDateKey();
  try {
    const raw = localStorage.getItem(QUOTA_STORAGE_KEY);
    if (!raw) return createDefaultQuota();
    const parsed = JSON.parse(raw) as Partial<DailyQuotaState>;
    const dLimit = typeof parsed.discoveryLimit === 'number' && parsed.discoveryLimit > 0 ? parsed.discoveryLimit : 150;
    const cLimit = typeof parsed.contactLimit === 'number' && parsed.contactLimit > 0 ? parsed.contactLimit : 150;

    if (parsed.date !== today) {
      return createDefaultQuota(dLimit, cLimit);
    }

    return {
      date: today,
      discoveryLeadsToday: Math.max(0, Number(parsed.discoveryLeadsToday || 0)),
      usaspendingLeadsToday: Math.max(0, Number(parsed.usaspendingLeadsToday || 0)),
      permitLeadsToday: Math.max(0, Number(parsed.permitLeadsToday || 0)),
      discoveryLimit: dLimit,
      contactChecksToday: Math.max(0, Number(parsed.contactChecksToday || 0)),
      contactLimit: cLimit,
      phonesFoundToday: Math.max(0, Number(parsed.phonesFoundToday || 0)),
      emailsFoundToday: Math.max(0, Number(parsed.emailsFoundToday || 0)),
      runsToday: Math.max(0, Number(parsed.runsToday || 0)),
    };
  } catch {
    return createDefaultQuota();
  }
}

export function saveDailyQuota(state: DailyQuotaState): void {
  try {
    localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota warnings
  }
}

export function getEstimatedLeadsPerRun(source: 'all' | 'usaspending' | 'permits', batchLimit: number): number {
  const usaPerRun = Math.min(5, batchLimit) * 5;
  const permitsPerRun = Math.min(20, batchLimit * 2) * 2;
  if (source === 'usaspending') return usaPerRun;
  if (source === 'permits') return permitsPerRun;
  return usaPerRun + permitsPerRun;
}
