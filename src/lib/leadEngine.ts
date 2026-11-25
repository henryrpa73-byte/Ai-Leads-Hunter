import type { ConfidenceLevel, Lead, LeadTier, OutreachStatus, ScoreFactor } from '../types/lead.ts';

const US_STATES: Record<string, string> = {
  AL: 'AL', ALABAMA: 'AL', AK: 'AK', ALASKA: 'AK', AZ: 'AZ', ARIZONA: 'AZ',
  AR: 'AR', ARKANSAS: 'AR', CA: 'CA', CALIFORNIA: 'CA', CO: 'CO', COLORADO: 'CO',
  CT: 'CT', CONNECTICUT: 'CT', DE: 'DE', DELAWARE: 'DE', FL: 'FL', FLORIDA: 'FL',
  GA: 'GA', GEORGIA: 'GA', HI: 'HI', HAWAII: 'HI', ID: 'ID', IDAHO: 'ID',
  IL: 'IL', ILLINOIS: 'IL', IN: 'IN', INDIANA: 'IN', IA: 'IA', IOWA: 'IA',
  KS: 'KS', KANSAS: 'KS', KY: 'KY', KENTUCKY: 'KY', LA: 'LA', LOUISIANA: 'LA',
  ME: 'ME', MAINE: 'ME', MD: 'MD', MARYLAND: 'MD', MA: 'MA', MASSACHUSETTS: 'MA',
  MI: 'MI', MICHIGAN: 'MI', MN: 'MN', MINNESOTA: 'MN', MS: 'MS', MISSISSIPPI: 'MS',
  MO: 'MO', MISSOURI: 'MO', MT: 'MT', MONTANA: 'MT', NE: 'NE', NEBRASKA: 'NE',
  NV: 'NV', NEVADA: 'NV', NH: 'NH', 'NEW HAMPSHIRE': 'NH', NJ: 'NJ', 'NEW JERSEY': 'NJ',
  NM: 'NM', 'NEW MEXICO': 'NM', NY: 'NY', 'NEW YORK': 'NY', NC: 'NC', 'NORTH CAROLINA': 'NC',
  ND: 'ND', 'NORTH DAKOTA': 'ND', OH: 'OH', OHIO: 'OH', OK: 'OK', OKLAHOMA: 'OK',
  OR: 'OR', OREGON: 'OR', PA: 'PA', PENNSYLVANIA: 'PA', RI: 'RI', 'RHODE ISLAND': 'RI',
  SC: 'SC', 'SOUTH CAROLINA': 'SC', SD: 'SD', 'SOUTH DAKOTA': 'SD', TN: 'TN', TENNESSEE: 'TN',
  TX: 'TX', TEXAS: 'TX', UT: 'UT', UTAH: 'UT', VT: 'VT', VERMONT: 'VT',
  VA: 'VA', VIRGINIA: 'VA', WA: 'WA', WASHINGTON: 'WA', WV: 'WV', 'WEST VIRGINIA': 'WV',
  WI: 'WI', WISCONSIN: 'WI', WY: 'WY', WYOMING: 'WY', DC: 'DC', 'DISTRICT OF COLUMBIA': 'DC',
};

const LEGAL_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'llp', 'lp', 'pc', 'pa', 'pllc', 'dba', 'the',
]);

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  if (['N/A', 'NA', 'NONE', 'NULL', '-', '--'].includes(cleaned.toUpperCase())) return '';
  return cleaned;
}

export function normalizeCompanyName(name: string): string {
  const cleaned = cleanText(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((token) => token && !LEGAL_SUFFIXES.has(token))
    .join(' ');
}

export function normalizePhone(raw: unknown): { formatted: string; digits: string } {
  const s = cleanText(raw).replace(/(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i, '');
  if (!s) return { formatted: '', digits: '' };
  let digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (digits.length === 10 && digits[0] !== '0' && digits[0] !== '1') {
    return {
      formatted: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
      digits,
    };
  }
  return { formatted: s, digits: '' };
}

export function normalizeWebsite(raw: unknown): { url: string; domain: string } {
  const text = cleanText(raw);
  if (!text || text.includes(' ') || !text.includes('.')) return { url: '', domain: '' };
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(candidate);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host || !host.includes('.')) return { url: '', domain: '' };
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return { url: `${parsed.protocol}//${host}${path}`, domain: host };
  } catch {
    return { url: '', domain: '' };
  }
}

const AREA_CODE_GROUPS: Record<string, string[]> = {
  AL: ['205', '251', '256', '334', '938'],
  AK: ['907'],
  AZ: ['480', '520', '602', '623', '928'],
  AR: ['479', '501', '870'],
  CA: ['209', '213', '279', '310', '323', '341', '408', '415', '424', '442', '510', '530', '559', '562', '619', '626', '628', '650', '657', '661', '669', '707', '714', '747', '760', '805', '818', '820', '831', '858', '909', '916', '925', '949', '951'],
  CO: ['303', '719', '720', '970', '983'],
  CT: ['203', '475', '860', '959'],
  DE: ['302'],
  DC: ['202'],
  FL: ['239', '305', '321', '352', '386', '407', '448', '561', '656', '689', '727', '728', '754', '772', '786', '813', '850', '863', '904', '941', '954'],
  GA: ['229', '404', '470', '478', '678', '706', '762', '770', '912', '943'],
  HI: ['808'],
  ID: ['208', '986'],
  IL: ['217', '224', '309', '312', '331', '447', '464', '618', '630', '708', '773', '779', '815', '847', '872'],
  IN: ['219', '260', '317', '463', '574', '765', '812', '930'],
  IA: ['319', '515', '563', '641', '712'],
  KS: ['316', '620', '785', '913'],
  KY: ['270', '364', '502', '606', '859'],
  LA: ['225', '318', '337', '504', '985'],
  ME: ['207'],
  MD: ['240', '301', '410', '443', '667'],
  MA: ['339', '351', '413', '508', '617', '774', '781', '857', '978'],
  MI: ['231', '248', '269', '313', '517', '586', '616', '734', '810', '906', '947', '989'],
  MN: ['218', '320', '507', '612', '651', '763', '952'],
  MS: ['228', '601', '662', '769'],
  MO: ['314', '417', '557', '573', '636', '660', '816', '975'],
  MT: ['406'],
  NE: ['308', '402', '531'],
  NV: ['702', '725', '775'],
  NH: ['603'],
  NJ: ['201', '551', '609', '640', '732', '848', '856', '862', '908', '973'],
  NM: ['505', '575'],
  NY: ['212', '315', '329', '332', '347', '516', '518', '585', '607', '631', '646', '680', '716', '718', '838', '845', '914', '917', '929', '934'],
  NC: ['252', '336', '472', '704', '743', '828', '910', '919', '980', '984'],
  ND: ['701'],
  OH: ['216', '220', '234', '283', '326', '330', '380', '419', '440', '513', '567', '614', '740', '937'],
  OK: ['405', '539', '580', '918'],
  OR: ['458', '503', '541', '971'],
  PA: ['215', '223', '267', '272', '412', '445', '484', '570', '582', '610', '717', '724', '814', '835', '878'],
  RI: ['401'],
  SC: ['803', '839', '843', '854', '864'],
  SD: ['605'],
  TN: ['423', '615', '629', '731', '865', '901', '931'],
  TX: ['210', '214', '254', '281', '325', '346', '361', '409', '430', '432', '469', '512', '682', '713', '726', '737', '806', '817', '830', '832', '903', '915', '936', '940', '945', '956', '972', '979'],
  UT: ['385', '435', '801'],
  VT: ['802'],
  VA: ['276', '434', '540', '571', '703', '757', '804', '826', '948'],
  WA: ['206', '253', '360', '425', '509', '564'],
  WV: ['304', '681'],
  WI: ['262', '274', '414', '534', '608', '715', '920'],
  WY: ['307'],
};

const AREA_CODE_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(AREA_CODE_GROUPS).flatMap(([state, codes]) => codes.map((code) => [code, state])),
);

export function inferStateFromPhoneDigits(digits: string): string {
  if (!digits || digits.length < 3) return '';
  return AREA_CODE_TO_STATE[digits.slice(0, 3)] || '';
}

export function normalizeState(raw: unknown): string {
  const upper = cleanText(raw).toUpperCase();
  if (!upper) return '';
  return US_STATES[upper] ?? (/^[A-Z]{2}$/.test(upper) ? upper : '');
}

export function safeExternalUrl(raw: string): string {
  const text = cleanText(raw);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export function inferServiceOpportunity(text: string): string {
  const low = text.toLowerCase();
  if (/(millwork|cabinet|casework|woodwork|finish carpentry|337110|238350)/.test(low)) {
    return 'Millwork Services';
  }
  if (/(architect|cad|drafting|permit drawing|construction drawing|design-build|541310|tenant finish)/.test(low)) {
    return 'Architectural Services';
  }
  return 'Construction Estimation';
}

export interface ScoringCriteriaConfig {
  warmThreshold: number;
  projectValueWeight: number;
  companySizeWeight: number;
  serviceMatchWeight: number;
  activityReachWeight: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringCriteriaConfig = {
  warmThreshold: 70,
  projectValueWeight: 30,
  companySizeWeight: 20,
  serviceMatchWeight: 30,
  activityReachWeight: 20,
};

export function extractProjectValueUsd(text: string): number | null {
  if (!text) return null;
  const millionMatch = text.match(/\$\s*([\d,.]+)\s*(?:m|million)\b/i);
  if (millionMatch) {
    const num = Number.parseFloat(millionMatch[1].replace(/,/g, ''));
    if (Number.isFinite(num) && num > 0) return Math.round(num * 1_000_000);
  }

  const thousandMatch = text.match(/\$\s*([\d,.]+)\s*k\b/i);
  if (thousandMatch) {
    const num = Number.parseFloat(thousandMatch[1].replace(/,/g, ''));
    if (Number.isFinite(num) && num > 0) return Math.round(num * 1_000);
  }

  const matches = Array.from(text.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g));
  let maxVal = 0;
  for (const m of matches) {
    const val = Number.parseFloat(m[1].replace(/,/g, ''));
    if (Number.isFinite(val) && val > maxVal) {
      maxVal = val;
    }
  }
  return maxVal > 0 ? Math.round(maxVal) : null;
}

export function formatProjectValue(usd: number | null): string {
  if (!usd || usd <= 0) return 'Undisclosed';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd.toLocaleString('en-US')}`;
}

export type CompanySizeTier =
  | 'Enterprise / Prime GC'
  | 'Mid-Market Contractor'
  | 'Small / Specialty Trade'
  | 'Owner / Unclassified';

export function inferCompanySizeProfile(input: Partial<Lead>): {
  tier: CompanySizeTier;
  ratio: number;
  reason: string;
} {
  const company = (input.company_name || '').toLowerCase();
  const cat = (input.company_category || '').toLowerCase();
  const services = (input.services_offered || '').toLowerCase();
  const evidence = `${input.buying_intent_evidence || ''} ${input.project_description || ''}`;
  const valueUsd = extractProjectValueUsd(evidence);
  const multiSource = (input.all_sources?.length || 0) > 1;

  if (
    /(llp|national|global|group|holdings)/.test(company) ||
    /(for profit organization|corporate entity|other than small)/.test(services) ||
    (valueUsd !== null && valueUsd >= 1_000_000)
  ) {
    return {
      tier: 'Enterprise / Prime GC',
      ratio: 1,
      reason: valueUsd && valueUsd >= 1_000_000
        ? `Prime contractor handling ${formatProjectValue(valueUsd)} project scale`
        : 'Multi-project prime contractor or architectural firm',
    };
  }

  if (
    /(commercial|general contractor|institutional|architectural|architects|builders|construction|design-build)/.test(
      `${company} ${cat}`,
    ) ||
    multiSource ||
    (valueUsd !== null && valueUsd >= 250_000)
  ) {
    return {
      tier: 'Mid-Market Contractor',
      ratio: 0.8,
      reason: multiSource
        ? 'Verified commercial/general contractor across multiple sources'
        : 'Established commercial builder or design-build contractor',
    };
  }

  if (
    /(\bllc\b|\binc\b|\bcorp\b|\blp\b|electrical|electric|plumbing|mechanical|hvac|millwork|cabinet|carpentry|remodel|small business)/.test(
      `${company} ${cat} ${services}`,
    )
  ) {
    return {
      tier: 'Small / Specialty Trade',
      ratio: 0.6,
      reason: 'Licensed specialty trade or small contracting business',
    };
  }

  return {
    tier: 'Owner / Unclassified',
    ratio: 0.35,
    reason: 'Individual owner-builder or company scale unverified',
  };
}

export function scoreLead(
  input: Partial<Lead>,
  config: ScoringCriteriaConfig = DEFAULT_SCORING_CONFIG,
): {
  score: number;
  breakdown: ScoreFactor[];
  tier: LeadTier;
  confidence: ConfidenceLevel;
  reason: string;
} {
  const totalWeight = Math.max(
    1,
    config.projectValueWeight +
      config.companySizeWeight +
      config.serviceMatchWeight +
      config.activityReachWeight,
  );
  const normWeight = (w: number) => Math.round((w / totalWeight) * 100);
  const wValue = normWeight(config.projectValueWeight);
  const wSize = normWeight(config.companySizeWeight);
  const wService = normWeight(config.serviceMatchWeight);
  const wActivity = Math.max(1, 100 - wValue - wSize - wService);

  const combined = `${input.company_category || ''} ${input.services_offered || ''} ${input.service_opportunity || ''} ${input.project_name || ''} ${input.project_description || ''} ${input.buying_intent_evidence || ''}`.toLowerCase();
  const valueUsd = extractProjectValueUsd(`${input.buying_intent_evidence || ''} ${input.project_description || ''}`);
  const hasProject = Boolean(input.project_name || input.project_status);

  // 1. Project Value (evaluated from award/permit cost or active scope)
  let valueRatio = 0;
  let valueReason = 'No active project or dollar value recorded';
  if (valueUsd !== null) {
    if (valueUsd >= 1_000_000) {
      valueRatio = 1;
      valueReason = `High-value project (${formatProjectValue(valueUsd)}) with strong B2B margin`;
    } else if (valueUsd >= 250_000) {
      valueRatio = 0.85;
      valueReason = `Mid-to-large construction scope (${formatProjectValue(valueUsd)})`;
    } else if (valueUsd >= 50_000) {
      valueRatio = 0.65;
      valueReason = `Qualified project value (${formatProjectValue(valueUsd)})`;
    } else {
      valueRatio = 0.35;
      valueReason = `Smaller permit scope (${formatProjectValue(valueUsd)})`;
    }
  } else if (hasProject && input.project_description) {
    valueRatio = 0.6;
    valueReason = 'Active permitted scope (value undisclosed in portal)';
  } else if (hasProject) {
    valueRatio = 0.4;
    valueReason = 'Active project listed without disclosed cost';
  }
  const valuePts = Math.round(wValue * valueRatio);

  // 2. Company Size
  const sizeProfile = inferCompanySizeProfile(input);
  const sizePts = Math.round(wSize * sizeProfile.ratio);

  // 3. Service Match (Estimation / Architecture / Millwork)
  let serviceRatio = 0.25;
  let serviceReason = 'General construction profile';
  const isMinorMepOrSign =
    /(signage|channel letters|plumbing|electrical|water heater|irrigation)/.test(combined) &&
    !/(general contractor|architectural|millwork|cabinet|casework|full remodel|new construction|tenant finish)/.test(combined);
  if (
    !isMinorMepOrSign &&
    /(millwork|cabinet|casework|takeoff|estimat|cad|drafting|architect|tenant|fitout|remodel|interior|commercial building|new construction|build out|buildout|general contractor)/.test(
      combined,
    )
  ) {
    serviceRatio = 1;
    serviceReason = `Strong scope alignment for ${input.service_opportunity || 'core services'}`;
  } else if (/(contractor|builder|construction|carpentry|renovation|design|commercial|electrical|plumbing|mechanical)/.test(combined)) {
    serviceRatio = 0.7;
    serviceReason = `Relevant contractor fit for ${input.service_opportunity || 'core services'}`;
  }
  const servicePts = Math.round(wService * serviceRatio);

  // 4. Project Activity, Source URL & Contact Reachability
  let actRatio = 0;
  const actNotes: string[] = [];
  if (hasProject && input.project_description) {
    actRatio += 0.35;
    actNotes.push(input.project_status || 'Active project');
  } else if (hasProject) {
    actRatio += 0.2;
    actNotes.push('Project listed');
  }
  const hasDirectUrl = Boolean(safeExternalUrl(input.project_source_url || ''));
  const hasAnyUrl = hasDirectUrl || Boolean(safeExternalUrl(input.company_source_url || ''));
  if (hasDirectUrl) {
    actRatio += 0.25;
    actNotes.push('verified source URL');
  } else if (hasAnyUrl) {
    actRatio += 0.12;
  }
  if (input.phone_digits) {
    actRatio += 0.15;
    actNotes.push('phone');
  }
  if (input.business_email) {
    actRatio += 0.15;
    actNotes.push('email');
  }
  if (input.domain) {
    actRatio += 0.1;
    actNotes.push('website');
  }
  const activityPts = Math.min(wActivity, Math.round(wActivity * actRatio));
  const activityReason = actNotes.length
    ? `Verified: ${actNotes.join(', ')}`
    : 'Needs active project & contact enrichment';

  const total = Math.max(0, Math.min(100, valuePts + sizePts + servicePts + activityPts));
  const breakdown: ScoreFactor[] = [
    { label: 'Project Value', points: valuePts, maxPoints: wValue, reason: valueReason },
    { label: 'Company Size', points: sizePts, maxPoints: wSize, reason: `${sizeProfile.tier} · ${sizeProfile.reason}` },
    { label: 'Service Match', points: servicePts, maxPoints: wService, reason: serviceReason },
    { label: 'Activity & Contact', points: activityPts, maxPoints: wActivity, reason: activityReason },
  ];

  const tier: LeadTier =
    total >= config.warmThreshold && (hasProject || serviceRatio >= 0.7)
      ? 'Warm'
      : total >= 35
        ? 'Potential'
        : 'Unqualified';
  const confidence: ConfidenceLevel =
    hasDirectUrl && hasProject ? 'High' : hasAnyUrl ? 'Medium' : 'Low';

  const reason = `${tier} lead (${total}/100): ${valueReason}. ${sizeProfile.tier}. ${serviceReason}.`;
  return { score: total, breakdown, tier, confidence, reason };
}

export function rescoreAllLeads(leads: Lead[], config: ScoringCriteriaConfig): Lead[] {
  return leads
    .map((lead) => {
      const scored = scoreLead(lead, config);
      return {
        ...lead,
        lead_score: scored.score,
        score_breakdown: scored.breakdown,
        lead_tier: scored.tier,
        confidence_level: scored.confidence,
        qualification_reason: scored.reason,
      };
    })
    .sort((a, b) => b.lead_score - a.lead_score);
}

export function buildNormalizedLead(
  raw: Partial<Lead>,
  config: ScoringCriteriaConfig = DEFAULT_SCORING_CONFIG,
): Lead {
  const companyName = cleanText(raw.company_name);
  const normalizedName = normalizeCompanyName(companyName);
  const { url: website, domain } = normalizeWebsite(raw.website);
  const { formatted: phone, digits: phoneDigits } = normalizePhone(raw.business_phone);
  const state = normalizeState(raw.state) || inferStateFromPhoneDigits(phoneDigits);
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const serviceOpp =
    cleanText(raw.service_opportunity) ||
    inferServiceOpportunity(`${raw.company_category || ''} ${raw.project_description || ''} ${raw.services_offered || ''}`);

  const base: Partial<Lead> = {
    ...raw,
    company_name: companyName,
    normalized_name: normalizedName,
    website,
    domain,
    business_phone: phone,
    phone_digits: phoneDigits,
    state,
    service_opportunity: serviceOpp,
    project_source_url: safeExternalUrl(raw.project_source_url || ''),
    company_source_url: safeExternalUrl(raw.company_source_url || ''),
    date_discovered: cleanText(raw.date_discovered) || now,
    last_verified: cleanText(raw.last_verified) || now,
  };

  const scored = scoreLead(base, config);
  const hasExplicitScore = typeof raw.lead_score === 'number' && raw.lead_score > 0;
  const finalScore = hasExplicitScore ? Math.max(0, Math.min(100, raw.lead_score!)) : scored.score;
  const sourceName = cleanText(raw.source_name) || 'Imported CSV';

  return {
    id: raw.id || `${normalizedName || 'lead'}_${state || domain || phoneDigits || Math.random().toString(36).slice(2, 8)}`,
    company_name: companyName,
    normalized_name: normalizedName,
    website,
    domain,
    business_email: cleanText(raw.business_email).toLowerCase(),
    business_phone: phone,
    phone_digits: phoneDigits,
    phone_type: cleanText(raw.phone_type).toLowerCase(),
    contact_person: cleanText(raw.contact_person),
    job_title: cleanText(raw.job_title),
    city: cleanText(raw.city),
    state,
    zip_code: cleanText(raw.zip_code).match(/\b(\d{5})/)?.[1] || '',
    company_category: cleanText(raw.company_category),
    services_offered: cleanText(raw.services_offered),
    service_opportunity: serviceOpp,
    project_name: cleanText(raw.project_name),
    project_description: cleanText(raw.project_description),
    project_location: cleanText(raw.project_location),
    project_status: cleanText(raw.project_status),
    project_source_url: safeExternalUrl(raw.project_source_url || ''),
    company_source_url: safeExternalUrl(raw.company_source_url || ''),
    buying_intent_evidence: cleanText(raw.buying_intent_evidence),
    qualification_reason: cleanText(raw.qualification_reason) || scored.reason,
    lead_score: finalScore,
    score_breakdown: scored.breakdown,
    confidence_level: (raw.confidence_level as ConfidenceLevel) || scored.confidence,
    lead_tier: (raw.lead_tier as LeadTier) || scored.tier,
    source_name: sourceName,
    all_sources: raw.all_sources?.length ? raw.all_sources : [sourceName],
    date_discovered: cleanText(raw.date_discovered) || now,
    last_verified: cleanText(raw.last_verified) || now,
    outreach_status: (raw.outreach_status as OutreachStatus) || 'New',
    notes: cleanText(raw.notes),
  };
}

export function mergeLeadsDeduplicated(existing: Lead[], incoming: Lead[]): {
  merged: Lead[];
  addedCount: number;
  duplicateCount: number;
} {
  const result = existing.map((l) => ({ ...l, all_sources: [...l.all_sources] }));
  let addedCount = 0;
  let duplicateCount = 0;

  for (const item of incoming) {
    if (!item.company_name || item.normalized_name.length < 2) continue;

    const matchIndex = result.findIndex((cur) => {
      if (item.domain && cur.domain && item.domain === cur.domain) return true;
      if (item.phone_digits && cur.phone_digits && item.phone_digits === cur.phone_digits) return true;
      if (item.normalized_name && cur.normalized_name && item.normalized_name === cur.normalized_name) {
        if (item.state && cur.state) return item.state === cur.state;
        return true;
      }
      return false;
    });

    if (matchIndex === -1) {
      result.push(item);
      addedCount++;
      continue;
    }

    duplicateCount++;
    const cur = result[matchIndex];
    const combinedSources = Array.from(new Set([...cur.all_sources, ...item.all_sources]));
    const updated: Lead = {
      ...cur,
      website: cur.website || item.website,
      domain: cur.domain || item.domain,
      business_email: cur.business_email || item.business_email,
      business_phone: cur.business_phone || item.business_phone,
      phone_digits: cur.phone_digits || item.phone_digits,
      phone_type: cur.phone_type || item.phone_type,
      contact_person: cur.contact_person || item.contact_person,
      job_title: cur.job_title || item.job_title,
      city: cur.city || item.city,
      state: cur.state || item.state,
      zip_code: cur.zip_code || item.zip_code,
      company_category: cur.company_category || item.company_category,
      services_offered: cur.services_offered || item.services_offered,
      service_opportunity: cur.service_opportunity || item.service_opportunity,
      project_name: cur.project_name || item.project_name,
      project_description: cur.project_description || item.project_description,
      project_location: cur.project_location || item.project_location,
      project_status: cur.project_status || item.project_status,
      project_source_url: cur.project_source_url || item.project_source_url,
      company_source_url: cur.company_source_url || item.company_source_url,
      buying_intent_evidence:
        cur.buying_intent_evidence && item.buying_intent_evidence && !cur.buying_intent_evidence.includes(item.buying_intent_evidence)
          ? `${cur.buying_intent_evidence} | ${item.buying_intent_evidence}`
          : cur.buying_intent_evidence || item.buying_intent_evidence,
      all_sources: combinedSources,
      last_verified: item.last_verified || cur.last_verified,
    };

    const reScored = scoreLead(updated);
    if (reScored.score >= cur.lead_score) {
      updated.lead_score = reScored.score;
      updated.score_breakdown = reScored.breakdown;
      updated.lead_tier = reScored.tier;
      updated.confidence_level = reScored.confidence;
      updated.qualification_reason = reScored.reason;
    }
    result[matchIndex] = updated;
  }

  result.sort((a, b) => b.lead_score - a.lead_score);
  return { merged: result, addedCount, duplicateCount };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function parseCsvToLeads(csvText: string, sourceLabel = 'Uploaded CSV'): Lead[] {
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: Lead[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) row[h] = (vals[idx] || '').trim();
    });
    const lead = rowObjectToLead(row, sourceLabel);
    if (lead) out.push(lead);
  }
  return out;
}

export function leadsToCsv(leads: Lead[]): string {
  const columns: (keyof Lead)[] = [
    'company_name',
    'lead_tier',
    'lead_score',
    'service_opportunity',
    'confidence_level',
    'business_phone',
    'phone_type',
    'business_email',
    'website',
    'contact_person',
    'city',
    'state',
    'zip_code',
    'company_category',
    'project_name',
    'project_status',
    'project_location',
    'project_description',
    'buying_intent_evidence',
    'qualification_reason',
    'project_source_url',
    'company_source_url',
    'source_name',
    'outreach_status',
    'date_discovered',
    'last_verified',
    'notes',
  ];

  const escapeCell = (val: unknown) => {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [columns.join(',')];
  for (const lead of leads) {
    lines.push(columns.map((col) => escapeCell(lead[col])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function rowObjectToLead(row: Record<string, string>, sourceLabel: string): Lead | null {
  const pick = (keys: string[]) => {
    for (const key of keys) {
      if (row[key]) return row[key];
    }
    return '';
  };

  const companyName = pick([
    'company_name',
    'company name',
    'company',
    'business name',
    'business_name',
    'contractor',
    'contractor name',
    'firm',
    'organization',
    'org',
    'vendor',
    'name',
  ]);
  if (!companyName) return null;

  const scoreNum = Number.parseInt(pick(['lead_score', 'lead score', 'score']), 10);
  return buildNormalizedLead({
    company_name: companyName,
    website: pick(['website', 'web', 'url', 'company website', 'site']),
    business_email: pick(['business_email', 'business email', 'email', 'e-mail', 'contact email']),
    business_phone: pick([
      'business_phone',
      'business phone',
      'phone number',
      'phone_number',
      'phone no',
      'phone no.',
      'phones',
      'phone',
      'nmbs',
      'nmb',
      'numbers',
      'number',
      'num',
      'contact no',
      'contact number',
      'contact numbers',
      'mobile',
      'mobile no',
      'cell',
      'telephone',
      'tel',
      'no',
      'no.',
      'nos',
    ]),
    phone_type: pick(['phone_type', 'phone type', 'type']),
    contact_person: pick(['contact_person', 'contact person', 'contact name', 'contact', 'owner']),
    job_title: pick(['job_title', 'job title', 'title', 'role']),
    city: pick(['city', 'town']),
    state: pick(['state', 'st']),
    zip_code: pick(['zip_code', 'zip code', 'zip', 'postal code']),
    company_category: pick(['company_category', 'company category', 'category', 'trade', 'industry']),
    services_offered: pick(['services_offered', 'services offered', 'services']),
    service_opportunity: pick(['service_opportunity', 'service opportunity', 'recommended service']),
    project_name: pick(['project_name', 'project name', 'project']),
    project_description: pick(['project_description', 'project description', 'description']),
    project_location: pick(['project_location', 'project location']),
    project_status: pick(['project_status', 'project status', 'status']),
    project_source_url: pick(['project_source_url', 'project source url', 'project url']),
    company_source_url: pick(['company_source_url', 'company source url', 'source url', 'source']),
    buying_intent_evidence: pick(['buying_intent_evidence', 'buying intent evidence', 'evidence']),
    qualification_reason: pick(['qualification_reason', 'qualification reason', 'reason']),
    lead_score: Number.isFinite(scoreNum) ? scoreNum : undefined,
    confidence_level: (pick(['confidence_level', 'confidence level', 'confidence']) as ConfidenceLevel) || undefined,
    lead_tier: (pick(['lead_tier', 'lead tier', 'tier']) as LeadTier) || undefined,
    outreach_status: (pick(['outreach_status', 'outreach status']) as OutreachStatus) || 'New',
    notes: pick(['notes', 'note']),
    source_name: sourceLabel,
  });
}

export async function parseExcelToLeads(buffer: ArrayBuffer, sourceLabel = 'Uploaded Excel'): Promise<Lead[]> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headers: string[] = [];
  const out: Lead[] = [];

  sheet.eachRow((excelRow, rowNumber) => {
    if (rowNumber === 1) {
      excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber] = cleanText(cell.text || cell.value).toLowerCase();
      });
      return;
    }

    const rowObj: Record<string, string> = {};
    let hasValue = false;
    excelRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const h = headers[colNumber];
      if (!h) return;
      const val = cleanText(cell.text || cell.value);
      if (val) {
        rowObj[h] = val;
        hasValue = true;
      }
    });
    if (!hasValue) return;
    const lead = rowObjectToLead(rowObj, sourceLabel);
    if (lead) out.push(lead);
  });

  return out;
}

export async function leadsToExcelBuffer(leads: Lead[]): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Ai Leads Hunter';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Qualified Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const columns: { header: string; key: keyof Lead; width: number }[] = [
    { header: 'company_name', key: 'company_name', width: 32 },
    { header: 'lead_tier', key: 'lead_tier', width: 12 },
    { header: 'lead_score', key: 'lead_score', width: 12 },
    { header: 'service_opportunity', key: 'service_opportunity', width: 24 },
    { header: 'confidence_level', key: 'confidence_level', width: 14 },
    { header: 'contact_person', key: 'contact_person', width: 24 },
    { header: 'job_title', key: 'job_title', width: 20 },
    { header: 'business_phone', key: 'business_phone', width: 18 },
    { header: 'phone_type', key: 'phone_type', width: 12 },
    { header: 'business_email', key: 'business_email', width: 28 },
    { header: 'website', key: 'website', width: 28 },
    { header: 'city', key: 'city', width: 16 },
    { header: 'state', key: 'state', width: 8 },
    { header: 'zip_code', key: 'zip_code', width: 10 },
    { header: 'company_category', key: 'company_category', width: 28 },
    { header: 'project_name', key: 'project_name', width: 28 },
    { header: 'project_status', key: 'project_status', width: 26 },
    { header: 'project_location', key: 'project_location', width: 26 },
    { header: 'project_description', key: 'project_description', width: 42 },
    { header: 'buying_intent_evidence', key: 'buying_intent_evidence', width: 40 },
    { header: 'qualification_reason', key: 'qualification_reason', width: 40 },
    { header: 'project_source_url', key: 'project_source_url', width: 36 },
    { header: 'company_source_url', key: 'company_source_url', width: 36 },
    { header: 'source_name', key: 'source_name', width: 22 },
    { header: 'outreach_status', key: 'outreach_status', width: 14 },
    { header: 'date_discovered', key: 'date_discovered', width: 22 },
    { header: 'last_verified', key: 'last_verified', width: 22 },
    { header: 'notes', key: 'notes', width: 28 },
  ];

  sheet.columns = columns;
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F172A' },
  };

  for (const lead of leads) {
    const rowData: Record<string, unknown> = {};
    for (const col of columns) {
      rowData[col.key] = lead[col.key] ?? '';
    }
    sheet.addRow(rowData);
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

