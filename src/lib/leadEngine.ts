import {
  type ConfidenceLevel,
  type Lead,
  type LeadTier,
  OUTREACH_STATUSES,
  type OutreachStatus,
  SUPPRESSED_OUTREACH_STATUSES,
  type ScoreFactor,
  type VerificationStatus,
} from '../types/lead.ts';
import {
  classifyCompanyCategory,
  classifyConstructionTrade,
  classifyProjectType,
  inferCostBiddingRelevance,
} from './trades.ts';

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

export function normalizeOutreachStatus(raw: unknown): OutreachStatus {
  const val = cleanText(raw);
  if ((OUTREACH_STATUSES as string[]).includes(val)) return val as OutreachStatus;
  if (val === 'Queued') return 'Ready for Calling';
  if (val === 'Contacted') return 'Calling';
  if (val === 'Closed') return 'Not Interested';
  return 'New';
}

export function isHighIntentTier(tier: LeadTier | string): boolean {
  return tier === 'Hot' || tier === 'Warm';
}

export function inferServiceOpportunity(text: string): string {
  const low = text.toLowerCase();
  if (/(millwork|cabinet|casework|woodwork|finish carpentry|337110|238350)/.test(low)) {
    return 'Millwork Services';
  }
  if (
    /(architect|cad|drafting|permit drawing|permit set|cd set|construction drawing|floor plan|site plan|elevation|3d|rendering|design-build|new construction|remodel|renovation|addition|tenant finish|541310|541330|541340)/.test(
      low,
    )
  ) {
    return 'Architectural Services';
  }
  return 'Construction Estimation';
}

export interface ScoringCriteriaConfig {
  hotThreshold?: number;
  warmThreshold: number;
  projectValueWeight: number;
  companySizeWeight: number;
  serviceMatchWeight: number;
  activityReachWeight: number;
  smsFocus?: boolean;
}

export const DEFAULT_SCORING_CONFIG: ScoringCriteriaConfig = {
  hotThreshold: 80,
  warmThreshold: 60,
  projectValueWeight: 25,
  companySizeWeight: 20,
  serviceMatchWeight: 25,
  activityReachWeight: 30,
  smsFocus: false,
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
  const evidence = `${input.project_value || ''} ${input.buying_intent_evidence || ''} ${input.project_description || ''}`;
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

const VALID_VERIF_STATUSES = new Set<VerificationStatus>([
  'Verified',
  'Publicly Listed',
  'Inferred',
  'Unknown',
]);

export function computeVerificationStatuses(input: Partial<Lead>): {
  website_status: VerificationStatus;
  email_status: VerificationStatus;
  phone_status: VerificationStatus;
  contact_status: VerificationStatus;
} {
  const pickStatus = (raw: unknown, fallback: VerificationStatus): VerificationStatus => {
    if (typeof raw === 'string' && VALID_VERIF_STATUSES.has(raw as VerificationStatus)) {
      return raw as VerificationStatus;
    }
    return fallback;
  };

  const hasWebsite = Boolean(input.domain || input.website);
  const hasEmail = Boolean(cleanText(input.business_email).includes('@'));
  const hasPhone = Boolean(input.phone_digits && input.phone_digits.length === 10);
  const hasContactPerson = Boolean(cleanText(input.contact_person));
  const hasContactSource = Boolean(
    safeExternalUrl(input.contact_source_url || '') ||
      safeExternalUrl(input.project_source_url || '') ||
      safeExternalUrl(input.company_source_url || ''),
  );

  const website_status = pickStatus(
    input.website_status,
    hasWebsite ? (hasContactSource ? 'Publicly Listed' : 'Inferred') : 'Unknown',
  );
  const email_status = pickStatus(
    input.email_status,
    hasEmail ? 'Publicly Listed' : 'Unknown',
  );
  const phone_status = pickStatus(
    input.phone_status,
    hasPhone ? 'Publicly Listed' : 'Unknown',
  );
  const contact_status = pickStatus(
    input.contact_status,
    hasContactPerson ? (hasContactSource ? 'Publicly Listed' : 'Inferred') : 'Unknown',
  );

  return { website_status, email_status, phone_status, contact_status };
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
  const hotThreshold = config.hotThreshold ?? 80;
  const warmThreshold = config.warmThreshold ?? 60;

  // Use the Cost Bidding 6-factor 0-100 rubric (20 + 20 + 20 + 15 + 15 + 10 = 100),
  // scaled if custom weight sliders diverge from default.
  const isDefaultWeights =
    config.projectValueWeight === DEFAULT_SCORING_CONFIG.projectValueWeight &&
    config.companySizeWeight === DEFAULT_SCORING_CONFIG.companySizeWeight &&
    config.serviceMatchWeight === DEFAULT_SCORING_CONFIG.serviceMatchWeight &&
    config.activityReachWeight === DEFAULT_SCORING_CONFIG.activityReachWeight;

  const combined = `${input.company_name || ''} ${input.company_category || ''} ${input.construction_trade || ''} ${input.services_offered || ''} ${input.service_opportunity || ''} ${input.project_name || ''} ${input.project_description || ''} ${input.buying_intent_evidence || ''}`.toLowerCase();
  const valueUsd = extractProjectValueUsd(`${input.project_value || ''} ${input.buying_intent_evidence || ''} ${input.project_description || ''}`);
  const hasProject = Boolean(input.project_name || input.project_status);
  const verif = computeVerificationStatuses(input);

  // Factor 1: Construction Company Relevance (20 pts)
  const sizeProfile = inferCompanySizeProfile(input);
  let relevancePts = 0;
  let relevanceReason = 'Insufficient construction business evidence';
  const isConstructionEntity = /(construction|contractor|builder|architect|engineering|millwork|cabinet|roofing|electrical|plumbing|hvac|concrete|framing|drywall|flooring|painting|masonry|excavation|civil|steel|glass|design-build|remodel|carpentry)/.test(
    combined,
  );
  if (isConstructionEntity) {
    relevancePts = sizeProfile.tier === 'Enterprise / Prime GC' ? 20 : sizeProfile.tier === 'Mid-Market Contractor' ? 18 : 15;
    relevanceReason = `${sizeProfile.tier} verified in construction/design sector`;
  } else if (cleanText(input.company_name)) {
    relevancePts = 6;
    relevanceReason = 'Company name listed without explicit construction trade classification';
  }

  // Factor 2: Trade & Cost Bidding Service Match (20 pts)
  let tradePts = 0;
  let tradeReason = 'No specific estimating, takeoff, or design trade evidence';
  const strongFit = /(millwork|cabinet|casework|takeoff|estimat|cad|drafting|architect|tenant|fitout|remodel|interior|commercial building|new construction|build out|buildout|general contractor|design-build|roofing|concrete|steel|framing|hvac|electrical|plumbing|civil)/.test(
    combined,
  );
  if (strongFit) {
    tradePts = 20;
    tradeReason = `Direct Cost Bidding fit (${input.construction_trade || input.service_opportunity || 'Construction Estimating'})`;
  } else if (/(contractor|builder|subcontractor|construction|renovation)/.test(combined)) {
    tradePts = 13;
    tradeReason = `General contractor fit for ${input.service_opportunity || 'Construction Estimation'}`;
  }

  // Factor 3: Evidence of Active Projects (20 pts)
  let projectPts = 0;
  let projectReason = 'No active project or contract evidence recorded';
  if (hasProject && valueUsd !== null) {
    if (valueUsd >= 1_000_000) {
      projectPts = 20;
      projectReason = `Active project (${formatProjectValue(valueUsd)}) with strong estimating margin`;
    } else if (valueUsd >= 250_000) {
      projectPts = 17;
      projectReason = `Active mid-to-large scope (${formatProjectValue(valueUsd)})`;
    } else if (valueUsd >= 50_000) {
      projectPts = 14;
      projectReason = `Active qualified project (${formatProjectValue(valueUsd)})`;
    } else {
      projectPts = 9;
      projectReason = `Smaller active permit (${formatProjectValue(valueUsd)})`;
    }
  } else if (hasProject && input.project_description) {
    projectPts = 14;
    projectReason = `Active project recorded (${input.project_status || 'Permit / Contract'})`;
  } else if (hasProject) {
    projectPts = 9;
    projectReason = 'Project title recorded without full scope details';
  }

  // Factor 4: Publicly Identified Decision-Maker (15 pts)
  let dmPts = 0;
  let dmReason = 'No publicly identified decision-maker yet';
  if (cleanText(input.contact_person)) {
    const titleLow = (input.job_title || '').toLowerCase();
    const isDecisionMakerTitle = /(owner|president|principal|partner|director|chief|estimator|preconstruction|project manager|officer|vp|architect|licensed)/.test(
      titleLow,
    );
    dmPts = isDecisionMakerTitle ? 15 : 10;
    dmReason = `${input.contact_person}${input.job_title ? ` (${input.job_title})` : ''} · ${verif.contact_status}`;
  }

  // Factor 5: Verified / Publicly Listed Contact Info (15 pts)
  let contactPts = 0;
  const contactChannels: string[] = [];
  if (input.phone_digits && input.phone_digits.length === 10) {
    contactPts += verif.phone_status === 'Verified' ? 8 : config.smsFocus ? 7 : 6;
    contactChannels.push(`phone (${verif.phone_status})`);
  }
  if (cleanText(input.business_email).includes('@')) {
    contactPts += verif.email_status === 'Verified' ? 6 : 5;
    contactChannels.push(`email (${verif.email_status})`);
  }
  if (input.domain) {
    contactPts += verif.website_status === 'Verified' ? 4 : 3;
    contactChannels.push(`website (${verif.website_status})`);
  }
  contactPts = Math.min(15, contactPts);
  const contactReason = contactChannels.length
    ? `Available: ${contactChannels.join(', ')}`
    : 'No direct phone, email, or website listed';

  // Factor 6: Recent & Credible Source Evidence (10 pts)
  const hasDirectUrl = Boolean(safeExternalUrl(input.project_source_url || ''));
  const hasAnyUrl = hasDirectUrl || Boolean(safeExternalUrl(input.company_source_url || ''));
  const hasEvidenceText = Boolean(cleanText(input.buying_intent_evidence));
  let sourcePts = 0;
  let sourceReason = 'No primary source URL recorded';
  if (hasDirectUrl && hasEvidenceText) {
    sourcePts = 10;
    sourceReason = `Primary evidence URL recorded (${input.source_name || 'Public Registry'})`;
  } else if (hasAnyUrl) {
    sourcePts = 6;
    sourceReason = `Source URL recorded (${input.source_name || 'Directory / Import'})`;
  } else if (hasEvidenceText) {
    sourcePts = 3;
    sourceReason = 'Evidence text present without URL link';
  }

  let total = relevancePts + tradePts + projectPts + dmPts + contactPts + sourcePts;

  // Honor custom AutomatedScoringEngine weights cleanly when modified from default
  if (!isDefaultWeights) {
    const totalWeight = Math.max(
      1,
      config.projectValueWeight +
        config.companySizeWeight +
        config.serviceMatchWeight +
        config.activityReachWeight,
    );
    const wVal = Math.round((config.projectValueWeight / totalWeight) * 100);
    const wSize = Math.round((config.companySizeWeight / totalWeight) * 100);
    const wSvc = Math.round((config.serviceMatchWeight / totalWeight) * 100);
    const wAct = Math.max(1, 100 - wVal - wSize - wSvc);
    const customTotal = Math.round(
      wVal * (projectPts / 20) +
        wSize * (relevancePts / 20) +
        wSvc * (tradePts / 20) +
        wAct * ((dmPts + contactPts + sourcePts) / 40),
    );
    total = Math.max(0, Math.min(100, customTotal));
  } else {
    total = Math.max(0, Math.min(100, total));
  }

  const breakdown: ScoreFactor[] = [
    { label: 'Company Relevance', points: relevancePts, maxPoints: 20, reason: relevanceReason },
    { label: 'Trade & Service Fit', points: tradePts, maxPoints: 20, reason: tradeReason },
    { label: 'Active Project Evidence', points: projectPts, maxPoints: 20, reason: projectReason },
    { label: 'Decision-Maker Identified', points: dmPts, maxPoints: 15, reason: dmReason },
    { label: 'Contact Reachability', points: contactPts, maxPoints: 15, reason: contactReason },
    { label: 'Source Credibility', points: sourcePts, maxPoints: 10, reason: sourceReason },
  ];

  const tier: LeadTier =
    total >= hotThreshold && (hasProject || tradePts >= 15)
      ? 'Hot'
      : total >= warmThreshold
        ? 'Warm'
        : total >= 40
          ? 'Potential'
          : 'Low Priority';

  const hasVerifiedChannel =
    verif.website_status === 'Verified' ||
    verif.email_status === 'Verified' ||
    verif.phone_status === 'Verified';

  const confidence: ConfidenceLevel = hasVerifiedChannel && hasDirectUrl
    ? 'Verified'
    : hasDirectUrl && hasProject
      ? 'High'
      : hasAnyUrl
        ? 'Medium'
        : contactChannels.length > 0
          ? 'Low'
          : 'Unverified';

  const reason = `${tier} (${total}/100): ${relevanceReason}. ${projectReason}. ${contactReason}.`;
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

  const fullContext = `${companyName} ${raw.company_category || ''} ${raw.construction_trade || ''} ${raw.services_offered || ''} ${raw.project_description || ''} ${raw.project_name || ''}`;
  const constructionTrade = cleanText(raw.construction_trade) || classifyConstructionTrade(fullContext);
  const companyCategory = cleanText(raw.company_category) || classifyCompanyCategory(fullContext, constructionTrade);
  const projectType = cleanText(raw.project_type) || classifyProjectType(`${raw.project_name || ''} ${raw.project_description || ''} ${companyCategory}`);
  const relevance = inferCostBiddingRelevance(fullContext, constructionTrade);
  const serviceOpp = cleanText(raw.service_opportunity) || relevance.serviceOpportunity;

  const extractedVal = extractProjectValueUsd(`${raw.project_value || ''} ${raw.buying_intent_evidence || ''} ${raw.project_description || ''}`);
  const projectValue = cleanText(raw.project_value) || (extractedVal ? formatProjectValue(extractedVal) : '');

  const projectSrc = safeExternalUrl(raw.project_source_url || '');
  const companySrc = safeExternalUrl(raw.company_source_url || '');
  const contactSrc = safeExternalUrl(raw.contact_source_url || '') || (website || companySrc || projectSrc);
  const allUrls = Array.from(
    new Set([
      ...(Array.isArray(raw.all_source_urls) ? raw.all_source_urls.map((u) => safeExternalUrl(u)).filter(Boolean) : []),
      projectSrc,
      companySrc,
      contactSrc,
    ].filter(Boolean)),
  );

  const verif = computeVerificationStatuses({
    ...raw,
    website,
    domain,
    phone_digits: phoneDigits,
    project_source_url: projectSrc,
    company_source_url: companySrc,
    contact_source_url: contactSrc,
  });

  const base: Partial<Lead> = {
    ...raw,
    company_name: companyName,
    normalized_name: normalizedName,
    website,
    domain,
    business_address: cleanText(raw.business_address),
    business_phone: phone,
    phone_digits: phoneDigits,
    state,
    company_category: companyCategory,
    construction_trade: constructionTrade,
    project_type: projectType,
    project_value: projectValue,
    service_opportunity: serviceOpp,
    project_source_url: projectSrc,
    company_source_url: companySrc,
    contact_source_url: contactSrc,
    ...verif,
    date_discovered: cleanText(raw.date_discovered) || now,
    last_verified: cleanText(raw.last_verified) || now,
  };

  const scored = scoreLead(base, config);
  const hasExplicitScore = typeof raw.lead_score === 'number' && raw.lead_score > 0;
  const finalScore = hasExplicitScore ? Math.max(0, Math.min(100, raw.lead_score!)) : scored.score;
  const sourceName = cleanText(raw.source_name) || 'Imported CSV';

  const validTiers = new Set<LeadTier>(['Hot', 'Warm', 'Potential', 'Low Priority']);
  const finalTier =
    raw.lead_tier && validTiers.has(raw.lead_tier)
      ? raw.lead_tier
      : scored.tier;

  return {
    id: raw.id || `${normalizedName || 'lead'}_${state || domain || phoneDigits || Math.random().toString(36).slice(2, 8)}`,
    company_name: companyName,
    normalized_name: normalizedName,
    website,
    domain,
    business_address: cleanText(raw.business_address),
    business_email: cleanText(raw.business_email).toLowerCase(),
    business_phone: phone,
    phone_digits: phoneDigits,
    phone_type: cleanText(raw.phone_type).toLowerCase(),
    contact_person: cleanText(raw.contact_person),
    job_title: cleanText(raw.job_title),
    contact_source_url: contactSrc,
    city: cleanText(raw.city),
    state,
    zip_code: cleanText(raw.zip_code).match(/\b(\d{5})/)?.[1] || '',
    company_category: companyCategory,
    construction_trade: constructionTrade,
    services_offered: cleanText(raw.services_offered),
    service_opportunity: serviceOpp,
    project_name: cleanText(raw.project_name),
    project_description: cleanText(raw.project_description),
    project_location: cleanText(raw.project_location),
    project_type: projectType,
    project_owner: cleanText(raw.project_owner),
    general_contractor: cleanText(raw.general_contractor) || (companyCategory.includes('Builder') || companyCategory.includes('General Contractor') ? companyName : ''),
    subcontractor: cleanText(raw.subcontractor) || (companyCategory.includes('Subcontractor') ? companyName : ''),
    project_value: projectValue,
    project_status: cleanText(raw.project_status),
    bid_date: cleanText(raw.bid_date),
    project_source_url: projectSrc,
    company_source_url: companySrc,
    website_status: verif.website_status,
    email_status: verif.email_status,
    phone_status: verif.phone_status,
    contact_status: verif.contact_status,
    buying_intent_evidence: cleanText(raw.buying_intent_evidence),
    qualification_reason: cleanText(raw.qualification_reason) || scored.reason,
    ai_summary: cleanText(raw.ai_summary),
    lead_score: finalScore,
    score_breakdown: scored.breakdown,
    confidence_level: (raw.confidence_level as ConfidenceLevel) || scored.confidence,
    lead_tier: finalTier,
    source_name: sourceName,
    all_sources: raw.all_sources?.length ? raw.all_sources : [sourceName],
    all_source_urls: allUrls,
    date_discovered: cleanText(raw.date_discovered) || now,
    last_verified: cleanText(raw.last_verified) || now,
    outreach_status: normalizeOutreachStatus(raw.outreach_status),
    notes: cleanText(raw.notes),
  };
}

export const SEEN_CONTACTS_HASH_STORAGE_KEY = 'ai_leads_hunter_seen_contacts_hashmap_v1';
const LEGACY_SEEN_HISTORY_STORAGE_KEY = 'ai_leads_hunter_seen_history_v1';
const MAX_HASH_MAP_ENTRIES = 50000;

export interface SeenContactHashMap {
  phones: Record<string, true>;
  emails: Record<string, true>;
}

export interface MergeLeadsOptions {
  checkCrossSession?: boolean;
  persistSeenContacts?: boolean;
  seenContactsMap?: SeenContactHashMap;
}

export function normalizeEmailKey(raw: unknown): string {
  const email = cleanText(raw).toLowerCase();
  if (!email || !email.includes('@') || !email.includes('.')) return '';
  return email;
}

function getNormalizedLeadPhoneDigits(lead: Partial<Lead>): string {
  if (lead.phone_digits && /^\d{10}$/.test(lead.phone_digits)) {
    return lead.phone_digits;
  }
  return normalizePhone(lead.business_phone).digits;
}

function trimHashRecord(record: Record<string, true>, limit = MAX_HASH_MAP_ENTRIES): Record<string, true> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  const trimmed: Record<string, true> = {};
  for (const k of keys.slice(-limit)) {
    trimmed[k] = true;
  }
  return trimmed;
}

export function loadSeenContactHashMap(): SeenContactHashMap {
  const map: SeenContactHashMap = { phones: {}, emails: {} };
  if (typeof localStorage === 'undefined') return map;

  try {
    const raw = localStorage.getItem(SEEN_CONTACTS_HASH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SeenContactHashMap>;
      if (parsed.phones && typeof parsed.phones === 'object') {
        for (const key of Object.keys(parsed.phones)) {
          if (/^\d{10}$/.test(key) && parsed.phones[key]) {
            map.phones[key] = true;
          }
        }
      }
      if (parsed.emails && typeof parsed.emails === 'object') {
        for (const key of Object.keys(parsed.emails)) {
          const norm = normalizeEmailKey(key);
          if (norm && parsed.emails[key]) {
            map.emails[norm] = true;
          }
        }
      }
    } else {
      const legacyRaw = localStorage.getItem(LEGACY_SEEN_HISTORY_STORAGE_KEY);
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as { phones?: unknown; emails?: unknown };
        if (Array.isArray(legacy.phones)) {
          for (const p of legacy.phones) {
            if (typeof p === 'string' && /^\d{10}$/.test(p)) map.phones[p] = true;
          }
        }
        if (Array.isArray(legacy.emails)) {
          for (const e of legacy.emails) {
            const norm = normalizeEmailKey(e);
            if (norm) map.emails[norm] = true;
          }
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }

  return map;
}

export function saveSeenContactHashMap(map: SeenContactHashMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: SeenContactHashMap = {
      phones: trimHashRecord(map.phones),
      emails: trimHashRecord(map.emails),
    };
    localStorage.setItem(SEEN_CONTACTS_HASH_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota warnings
  }
}

export function recordContactsInHashMap(
  leads: Array<Partial<Lead>>,
  targetMap?: SeenContactHashMap,
): SeenContactHashMap {
  const map = targetMap || loadSeenContactHashMap();
  let changed = false;

  for (const lead of leads) {
    const phone = getNormalizedLeadPhoneDigits(lead);
    if (phone && !map.phones[phone]) {
      map.phones[phone] = true;
      changed = true;
    }
    const email = normalizeEmailKey(lead.business_email);
    if (email && !map.emails[email]) {
      map.emails[email] = true;
      changed = true;
    }
  }

  if (changed && !targetMap) {
    saveSeenContactHashMap(map);
  }
  return map;
}

export function clearSeenContactHashMap(preserveLeads: Array<Partial<Lead>> = []): SeenContactHashMap {
  const fresh: SeenContactHashMap = { phones: {}, emails: {} };
  for (const lead of preserveLeads) {
    const phone = getNormalizedLeadPhoneDigits(lead);
    if (phone) fresh.phones[phone] = true;
    const email = normalizeEmailKey(lead.business_email);
    if (email) fresh.emails[email] = true;
  }
  saveSeenContactHashMap(fresh);
  return fresh;
}

function strongerVerif(a: VerificationStatus, b: VerificationStatus): VerificationStatus {
  const rank: Record<VerificationStatus, number> = {
    Verified: 4,
    'Publicly Listed': 3,
    Inferred: 2,
    Unknown: 1,
  };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

export function mergeLeadsDeduplicated(
  existing: Lead[],
  incoming: Lead[],
  options: MergeLeadsOptions = {},
): {
  merged: Lead[];
  addedCount: number;
  duplicateCount: number;
  crossSessionBlockedCount: number;
} {
  const checkCrossSession = options.checkCrossSession !== false;
  const persistSeenContacts = options.persistSeenContacts !== false;
  const externalMapSupplied = Boolean(options.seenContactsMap);
  const seenMap: SeenContactHashMap = options.seenContactsMap || loadSeenContactHashMap();
  let hashMapChanged = false;

  const result: Lead[] = existing.map((l) => ({
    ...l,
    all_sources: [...(l.all_sources || [])],
    all_source_urls: [...(l.all_source_urls || [])],
  }));
  const phoneIndex = new Map<string, number>();
  const emailIndex = new Map<string, number>();
  const domainIndex = new Map<string, number>();
  const nameStateIndex = new Map<string, number>();

  const indexLeadAt = (lead: Lead, idx: number) => {
    const phone = getNormalizedLeadPhoneDigits(lead);
    if (phone && !phoneIndex.has(phone)) phoneIndex.set(phone, idx);
    const email = normalizeEmailKey(lead.business_email);
    if (email && !emailIndex.has(email)) emailIndex.set(email, idx);
    if (lead.domain && !domainIndex.has(lead.domain)) domainIndex.set(lead.domain, idx);
    if (lead.normalized_name) {
      const nameKey = lead.state ? `${lead.normalized_name}|${lead.state}` : lead.normalized_name;
      if (!nameStateIndex.has(nameKey)) nameStateIndex.set(nameKey, idx);
      if (!nameStateIndex.has(lead.normalized_name)) nameStateIndex.set(lead.normalized_name, idx);
    }
    if (phone && !seenMap.phones[phone]) {
      seenMap.phones[phone] = true;
      hashMapChanged = true;
    }
    if (email && !seenMap.emails[email]) {
      seenMap.emails[email] = true;
      hashMapChanged = true;
    }
  };

  result.forEach((cur, idx) => indexLeadAt(cur, idx));

  let addedCount = 0;
  let duplicateCount = 0;
  let crossSessionBlockedCount = 0;

  for (const item of incoming) {
    if (!item.company_name || item.normalized_name.length < 2) continue;

    const itemPhone = getNormalizedLeadPhoneDigits(item);
    const itemEmail = normalizeEmailKey(item.business_email);
    const itemDomain = item.domain || normalizeWebsite(item.website).domain;
    const itemNameStateKey = item.state
      ? `${item.normalized_name}|${item.state}`
      : item.normalized_name;

    let matchIndex = -1;
    if (itemPhone && phoneIndex.has(itemPhone)) {
      matchIndex = phoneIndex.get(itemPhone)!;
    } else if (itemEmail && emailIndex.has(itemEmail)) {
      matchIndex = emailIndex.get(itemEmail)!;
    } else if (itemDomain && domainIndex.has(itemDomain)) {
      matchIndex = domainIndex.get(itemDomain)!;
    } else if (nameStateIndex.has(itemNameStateKey)) {
      const candidateIdx = nameStateIndex.get(itemNameStateKey)!;
      const candidate = result[candidateIdx];
      if (!item.state || !candidate.state || item.state === candidate.state) {
        matchIndex = candidateIdx;
      }
    } else if (!item.state && nameStateIndex.has(item.normalized_name)) {
      matchIndex = nameStateIndex.get(item.normalized_name)!;
    }

    if (matchIndex === -1) {
      if (
        checkCrossSession &&
        ((itemPhone && seenMap.phones[itemPhone] === true) ||
          (itemEmail && seenMap.emails[itemEmail] === true))
      ) {
        duplicateCount++;
        crossSessionBlockedCount++;
        continue;
      }

      const newIdx = result.length;
      result.push(item);
      indexLeadAt(item, newIdx);
      addedCount++;
      continue;
    }

    const cur = result[matchIndex];
    const curPhone = getNormalizedLeadPhoneDigits(cur);
    const curEmail = normalizeEmailKey(cur.business_email);

    if (
      checkCrossSession &&
      ((itemPhone && itemPhone !== curPhone && seenMap.phones[itemPhone] === true) ||
        (itemEmail && itemEmail !== curEmail && seenMap.emails[itemEmail] === true))
    ) {
      duplicateCount++;
      crossSessionBlockedCount++;
      continue;
    }

    duplicateCount++;
    const combinedSources = Array.from(new Set([...(cur.all_sources || []), ...(item.all_sources || [])]));
    const combinedSourceUrls = Array.from(
      new Set(
        [
          ...(cur.all_source_urls || []),
          ...(item.all_source_urls || []),
          cur.project_source_url,
          cur.company_source_url,
          cur.contact_source_url,
          item.project_source_url,
          item.company_source_url,
          item.contact_source_url,
        ].filter(Boolean),
      ),
    );
    const updated: Lead = {
      ...cur,
      website: cur.website || item.website,
      domain: cur.domain || itemDomain,
      business_address: cur.business_address || item.business_address,
      business_email: cur.business_email || itemEmail || item.business_email,
      business_phone: cur.business_phone || item.business_phone,
      phone_digits: cur.phone_digits || itemPhone,
      phone_type: cur.phone_type || item.phone_type,
      contact_person: cur.contact_person || item.contact_person,
      job_title: cur.job_title || item.job_title,
      contact_source_url: cur.contact_source_url || item.contact_source_url,
      city: cur.city || item.city,
      state: cur.state || item.state,
      zip_code: cur.zip_code || item.zip_code,
      company_category: cur.company_category || item.company_category,
      construction_trade: cur.construction_trade || item.construction_trade,
      services_offered: cur.services_offered || item.services_offered,
      service_opportunity: cur.service_opportunity || item.service_opportunity,
      project_name: cur.project_name || item.project_name,
      project_description: cur.project_description || item.project_description,
      project_location: cur.project_location || item.project_location,
      project_type: cur.project_type || item.project_type,
      project_owner: cur.project_owner || item.project_owner,
      general_contractor: cur.general_contractor || item.general_contractor,
      subcontractor: cur.subcontractor || item.subcontractor,
      project_value: cur.project_value || item.project_value,
      project_status: cur.project_status || item.project_status,
      bid_date: cur.bid_date || item.bid_date,
      project_source_url: cur.project_source_url || item.project_source_url,
      company_source_url: cur.company_source_url || item.company_source_url,
      website_status: strongerVerif(cur.website_status || 'Unknown', item.website_status || 'Unknown'),
      email_status: strongerVerif(cur.email_status || 'Unknown', item.email_status || 'Unknown'),
      phone_status: strongerVerif(cur.phone_status || 'Unknown', item.phone_status || 'Unknown'),
      contact_status: strongerVerif(cur.contact_status || 'Unknown', item.contact_status || 'Unknown'),
      buying_intent_evidence:
        cur.buying_intent_evidence && item.buying_intent_evidence && !cur.buying_intent_evidence.includes(item.buying_intent_evidence)
          ? `${cur.buying_intent_evidence} | ${item.buying_intent_evidence}`
          : cur.buying_intent_evidence || item.buying_intent_evidence,
      all_sources: combinedSources,
      all_source_urls: combinedSourceUrls,
      ai_summary: cur.ai_summary || item.ai_summary,
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
    indexLeadAt(updated, matchIndex);
  }

  if (persistSeenContacts && hashMapChanged && !externalMapSupplied) {
    saveSeenContactHashMap(seenMap);
  }

  result.sort((a, b) => b.lead_score - a.lead_score);
  return { merged: result, addedCount, duplicateCount, crossSessionBlockedCount };
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
    'construction_trade',
    'service_opportunity',
    'confidence_level',
    'business_phone',
    'phone_type',
    'phone_status',
    'business_email',
    'email_status',
    'website',
    'website_status',
    'contact_person',
    'job_title',
    'business_address',
    'city',
    'state',
    'zip_code',
    'company_category',
    'project_name',
    'project_type',
    'project_value',
    'project_status',
    'bid_date',
    'project_owner',
    'general_contractor',
    'subcontractor',
    'project_location',
    'project_description',
    'buying_intent_evidence',
    'qualification_reason',
    'project_source_url',
    'company_source_url',
    'contact_source_url',
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

export const DEFAULT_ZOOM_SMS_TEMPLATE =
  'Need design support? We handle floor plans, site plans, elevations, permit sets, CD sets and 3D renderings. Reply YES for samples. Reply STOP to opt out.';

export function getSmsReadyLeads(leads: Lead[]): Lead[] {
  const seenPhones = new Set<string>();
  const out: Lead[] = [];
  for (const lead of leads) {
    if (SUPPRESSED_OUTREACH_STATUSES.has(lead.outreach_status)) continue;
    const digits = lead.phone_digits || normalizePhone(lead.business_phone).digits;
    if (digits.length !== 10 || seenPhones.has(digits)) continue;
    seenPhones.add(digits);
    out.push(lead);
  }
  return out;
}

export function leadsToZoomSmsCsv(
  leads: Lead[],
  smsTemplate = DEFAULT_ZOOM_SMS_TEMPLATE,
): string {
  const smsLeads = getSmsReadyLeads(leads);
  const headers = [
    'First Name',
    'Last Name',
    'Phone Number',
    'Company',
    'Email',
    'City',
    'State',
    'Zip Code',
    'Trade',
    'Service Match',
    'Project',
    'Lead Tier',
    'Lead Score',
    'SMS Message',
  ];

  const escapeCell = (val: unknown) => {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(',')];
  for (const lead of smsLeads) {
    const digits = lead.phone_digits || normalizePhone(lead.business_phone).digits;
    const e164 = `+1${digits}`;
    const nameParts = cleanText(lead.contact_person).split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || 'Team';
    const lastName = nameParts.slice(1).join(' ');
    const message = smsTemplate
      .replace(/\{company\}/gi, lead.company_name || 'your team')
      .replace(/\{city\}/gi, lead.city || 'your area')
      .replace(/\{name\}/gi, firstName);

    const row = [
      firstName,
      lastName,
      e164,
      lead.company_name,
      lead.business_email,
      lead.city,
      lead.state,
      lead.zip_code,
      lead.construction_trade,
      lead.service_opportunity,
      lead.project_name,
      lead.lead_tier,
      lead.lead_score,
      message,
    ];
    lines.push(row.map(escapeCell).join(','));
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
    business_address: pick(['business_address', 'business address', 'address', 'street']),
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
    company_category: pick(['company_category', 'company category', 'category', 'industry']),
    construction_trade: pick(['construction_trade', 'construction trade', 'trade']),
    services_offered: pick(['services_offered', 'services offered', 'services']),
    service_opportunity: pick(['service_opportunity', 'service opportunity', 'recommended service']),
    project_name: pick(['project_name', 'project name', 'project']),
    project_type: pick(['project_type', 'project type']),
    project_value: pick(['project_value', 'project value', 'value', 'amount']),
    project_owner: pick(['project_owner', 'project owner', 'owner', 'agency']),
    bid_date: pick(['bid_date', 'bid date', 'due date']),
    project_description: pick(['project_description', 'project description', 'description']),
    project_location: pick(['project_location', 'project location']),
    project_status: pick(['project_status', 'project status', 'status']),
    project_source_url: pick(['project_source_url', 'project source url', 'project url']),
    company_source_url: pick(['company_source_url', 'company source url', 'source url', 'source']),
    contact_source_url: pick(['contact_source_url', 'contact source url']),
    buying_intent_evidence: pick(['buying_intent_evidence', 'buying intent evidence', 'evidence']),
    qualification_reason: pick(['qualification_reason', 'qualification reason', 'reason']),
    lead_score: Number.isFinite(scoreNum) ? scoreNum : undefined,
    confidence_level: (pick(['confidence_level', 'confidence level', 'confidence']) as ConfidenceLevel) || undefined,
    lead_tier: (pick(['lead_tier', 'lead tier', 'tier']) as LeadTier) || undefined,
    outreach_status: normalizeOutreachStatus(pick(['outreach_status', 'outreach status'])),
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
    { header: 'lead_tier', key: 'lead_tier', width: 14 },
    { header: 'lead_score', key: 'lead_score', width: 12 },
    { header: 'construction_trade', key: 'construction_trade', width: 26 },
    { header: 'service_opportunity', key: 'service_opportunity', width: 24 },
    { header: 'confidence_level', key: 'confidence_level', width: 14 },
    { header: 'contact_person', key: 'contact_person', width: 24 },
    { header: 'job_title', key: 'job_title', width: 20 },
    { header: 'business_phone', key: 'business_phone', width: 18 },
    { header: 'phone_status', key: 'phone_status', width: 16 },
    { header: 'phone_type', key: 'phone_type', width: 12 },
    { header: 'business_email', key: 'business_email', width: 28 },
    { header: 'email_status', key: 'email_status', width: 16 },
    { header: 'website', key: 'website', width: 28 },
    { header: 'website_status', key: 'website_status', width: 16 },
    { header: 'business_address', key: 'business_address', width: 28 },
    { header: 'city', key: 'city', width: 16 },
    { header: 'state', key: 'state', width: 8 },
    { header: 'zip_code', key: 'zip_code', width: 10 },
    { header: 'company_category', key: 'company_category', width: 28 },
    { header: 'project_name', key: 'project_name', width: 28 },
    { header: 'project_type', key: 'project_type', width: 20 },
    { header: 'project_value', key: 'project_value', width: 16 },
    { header: 'project_status', key: 'project_status', width: 26 },
    { header: 'bid_date', key: 'bid_date', width: 14 },
    { header: 'project_owner', key: 'project_owner', width: 24 },
    { header: 'general_contractor', key: 'general_contractor', width: 26 },
    { header: 'project_location', key: 'project_location', width: 26 },
    { header: 'project_description', key: 'project_description', width: 42 },
    { header: 'buying_intent_evidence', key: 'buying_intent_evidence', width: 40 },
    { header: 'qualification_reason', key: 'qualification_reason', width: 40 },
    { header: 'project_source_url', key: 'project_source_url', width: 36 },
    { header: 'company_source_url', key: 'company_source_url', width: 36 },
    { header: 'contact_source_url', key: 'contact_source_url', width: 36 },
    { header: 'source_name', key: 'source_name', width: 22 },
    { header: 'outreach_status', key: 'outreach_status', width: 18 },
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

  return await workbook.xlsx.writeBuffer();
}
