import express from 'express';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { buildNormalizedLead, inferServiceOpportunity } from './src/lib/leadEngine.ts';
import type { Lead } from './src/types/lead.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_AGENT = 'ConstructionLeadHunter/1.0 (+public-research)';

const NAICS_TARGETS: Record<string, string> = {
  '236220': 'Commercial and Institutional Building Construction',
  '236118': 'Residential Remodelers',
  '238350': 'Finish Carpentry Contractors',
  '337110': 'Wood Kitchen Cabinet and Countertop Manufacturing',
  '541310': 'Architectural Services',
};

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  const low = ip.toLowerCase();
  return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
}

async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS URLs are supported.');
  }
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) {
    throw new Error('Localhost and internal hostnames are not allowed.');
  }
  const records = await dns.lookup(parsed.hostname, { all: true });
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new Error('Private or loopback IP addresses are not allowed.');
    }
  }
  return parsed;
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from ${new URL(url).hostname}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverUsaSpending(stateFilter: string, limitPerNaics: number): Promise<Lead[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const locationFilter: Record<string, string> = { country: 'USA' };
  if (/^[A-Z]{2}$/.test(stateFilter)) {
    locationFilter.state = stateFilter;
  }

  const leads: Lead[] = [];
  const naicsEntries = Object.entries(NAICS_TARGETS);

  for (const [naics, categoryLabel] of naicsEntries) {
    const body = {
      fields: [
        'Award ID',
        'Recipient Name',
        'Award Amount',
        'Description',
        'Start Date',
        'Awarding Agency',
        'Place of Performance State Code',
        'Place of Performance Zip5',
        'generated_internal_id',
      ],
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        naics_codes: [naics],
        place_of_performance_locations: [locationFilter],
        time_period: [{ start_date: startDate, end_date: endDate }],
      },
      limit: Math.max(1, Math.min(10, limitPerNaics)),
      page: 1,
      sort: 'Award Amount',
      order: 'desc',
    };

    const data = (await fetchJsonWithTimeout('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })) as { results?: Array<Record<string, unknown>> };

    for (const row of data.results || []) {
      const genId = String(row['generated_internal_id'] || '');
      let city = '';
      let state = String(row['Place of Performance State Code'] || '');
      let zip = String(row['Place of Performance Zip5'] || '');
      let recipientName = String(row['Recipient Name'] || '');
      let categories: string[] = [];
      let popLocation = state;
      let contactPerson = '';
      let jobTitle = '';
      let liveStatus = String(row['Start Date'] || '') ? 'Awarded' : 'Active';

      if (genId) {
        try {
          const detail = (await fetchJsonWithTimeout(
            `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(genId)}/`,
            {},
            8000,
          )) as {
            recipient?: {
              recipient_name?: string;
              business_categories?: string[];
              location?: { city_name?: string; state_code?: string; zip5?: string };
            };
            executive_details?: {
              officers?: Array<{ name?: string | null }>;
            };
            period_of_performance?: {
              start_date?: string | null;
              end_date?: string | null;
              potential_end_date?: string | null;
            };
            place_of_performance?: { city_name?: string; state_code?: string };
          };
          const rec = detail.recipient;
          if (rec?.recipient_name) recipientName = rec.recipient_name;
          if (rec?.location?.city_name) city = rec.location.city_name;
          if (rec?.location?.state_code) state = rec.location.state_code;
          if (rec?.location?.zip5) zip = rec.location.zip5;
          if (Array.isArray(rec?.business_categories)) categories = rec.business_categories;
          const popCity = detail.place_of_performance?.city_name || '';
          const popState = detail.place_of_performance?.state_code || state;
          popLocation = [popCity, popState].filter(Boolean).join(', ');

          const officerName = (detail.executive_details?.officers || []).find((o) => o?.name)?.name || '';
          if (officerName) {
            contactPerson = officerName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
            jobTitle = 'Executive Officer';
          }

          const endDt = String(
            detail.period_of_performance?.end_date || detail.period_of_performance?.potential_end_date || '',
          ).slice(0, 10);
          const todayIso = new Date().toISOString().slice(0, 10);
          if (endDt) {
            liveStatus = endDt >= todayIso ? `Live Won Project (ends ${endDt})` : `Completed Award (ended ${endDt})`;
          }
        } catch {
          // Proceed cleanly with search-level fields if individual award detail times out
        }
      }

      const awardId = String(row['Award ID'] || '');
      const amount = typeof row['Award Amount'] === 'number' ? `$${Math.round(row['Award Amount']).toLocaleString('en-US')}` : '';
      const desc = String(row['Description'] || '');
      const agency = String(row['Awarding Agency'] || '');
      const startDt = String(row['Start Date'] || '');
      const sourceUrl = genId
        ? `https://www.usaspending.gov/award/${genId}`
        : 'https://www.usaspending.gov/search';

      leads.push(
        buildNormalizedLead({
          company_name: recipientName,
          contact_person: contactPerson,
          job_title: jobTitle,
          city: city ? city.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '',
          state,
          zip_code: zip,
          company_category: categoryLabel,
          services_offered: categories.slice(0, 4).join(', '),
          service_opportunity: inferServiceOpportunity(`${naics} ${desc}`),
          project_name: awardId ? `Federal Award ${awardId}` : 'Federal Construction Award',
          project_description: desc.slice(0, 450),
          project_location: popLocation,
          project_status: liveStatus,
          project_source_url: sourceUrl,
          company_source_url: sourceUrl,
          buying_intent_evidence: [
            awardId ? `Federal award ${awardId}` : 'Federal award',
            amount ? `Value: ${amount}` : '',
            agency ? `Agency: ${agency}` : '',
            startDt ? `Start: ${startDt}` : '',
            liveStatus,
          ]
            .filter(Boolean)
            .join('; '),
          source_name: 'USASpending.gov',
        }),
      );
    }
  }

  return leads;
}

async function discoverMunicipalPermits(limitPerCity: number): Promise<Lead[]> {
  const leads: Lead[] = [];
  const cap = Math.max(1, Math.min(20, limitPerCity));

  // Austin, TX Open Data Permits
  try {
    const austinUrl = `https://data.austintexas.gov/resource/3syk-w9eu.json?$where=${encodeURIComponent(
      'contractor_company_name IS NOT NULL',
    )}&$order=${encodeURIComponent('issue_date DESC')}&$limit=${cap}`;
    const rows = (await fetchJsonWithTimeout(austinUrl)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const company = String(row.contractor_company_name || '').trim();
      if (!company) continue;
      const permitNum = String(row.permit_number || '').trim();
      const workClass = String(row.work_class || row.permit_type_desc || '').trim();
      const desc = String(row.description || '').trim();
      const issueDate = String(row.issue_date || '').slice(0, 10);
      const expiresDate = String(row.expiresdate || '').slice(0, 10);
      const loc = String(row.permit_location || row.original_address1 || '').trim();
      const rawStatus = String(row.status_current || 'Active').trim();
      const projectStatus = expiresDate
        ? `Live ${rawStatus} Permit (expires ${expiresDate})`
        : `Live ${rawStatus} Permit`;
      const portalUrl = permitNum
        ? `https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=${encodeURIComponent(permitNum)}`
        : 'https://data.austintexas.gov/d/3syk-w9eu';

      leads.push(
        buildNormalizedLead({
          company_name: company,
          business_phone: String(row.contractor_phone || ''),
          contact_person: String(row.contractor_full_name || '').trim(),
          job_title: String(row.contractor_trade || 'Project Contractor').trim(),
          city: String(row.contractor_city || 'Austin'),
          state: String(row.contractor_state || 'TX'),
          zip_code: String(row.contractor_zip || row.original_zip || ''),
          company_category: String(row.permit_class_mapped || 'Building Permit Contractor'),
          service_opportunity: inferServiceOpportunity(`${workClass} ${desc}`),
          project_name: permitNum ? `Austin Permit ${permitNum}` : 'Austin Building Permit',
          project_description: [workClass, desc].filter(Boolean).join(': ').slice(0, 450),
          project_location: [loc, 'Austin, TX'].filter(Boolean).join(', '),
          project_status: projectStatus,
          project_source_url: portalUrl,
          company_source_url: 'https://data.austintexas.gov/d/3syk-w9eu',
          buying_intent_evidence: `Active Austin building permit ${permitNum} issued ${issueDate}`.trim(),
          source_name: 'Austin Open Permits',
        }),
      );
    }
  } catch {
    // Allow Chicago to still succeed if Austin is temporarily unreachable
  }

  // Chicago, IL Building Permits
  try {
    const chicagoUrl = `https://data.cityofchicago.org/resource/ydr8-5enu.json?$where=${encodeURIComponent(
      "contact_1_name IS NOT NULL AND contact_1_type LIKE '%CONTRACTOR%'",
    )}&$order=${encodeURIComponent('issue_date DESC')}&$limit=${cap}`;
    const rows = (await fetchJsonWithTimeout(chicagoUrl)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const company = String(row.contact_1_name || '').trim();
      if (!company) continue;
      const permitNum = String(row.permit_ || row.id || '').trim();
      const desc = String(row.work_description || '').trim();
      const issueDate = String(row.issue_date || '').slice(0, 10);
      const cost = String(row.reported_cost || '').trim();
      const street = [row.street_number, row.street_direction, row.street_name]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join(' ');
      const portalUrl = permitNum
        ? `https://data.cityofchicago.org/resource/ydr8-5enu.json?permit_=${encodeURIComponent(permitNum)}`
        : 'https://data.cityofchicago.org/d/ydr8-5enu';

      leads.push(
        buildNormalizedLead({
          company_name: company,
          city: String(row.contact_1_city || 'Chicago'),
          state: String(row.contact_1_state || 'IL'),
          zip_code: String(row.contact_1_zipcode || ''),
          company_category: String(row.contact_1_type || 'Contractor'),
          service_opportunity: inferServiceOpportunity(desc),
          project_name: permitNum ? `Chicago Permit ${permitNum}` : 'Chicago Building Permit',
          project_description: desc.slice(0, 450),
          project_location: [street, 'Chicago, IL'].filter(Boolean).join(', '),
          project_status: 'Live Issued Permit',
          project_source_url: portalUrl,
          company_source_url: 'https://data.cityofchicago.org/d/ydr8-5enu',
          buying_intent_evidence: `Chicago permit ${permitNum} issued ${issueDate}${cost ? ` (reported cost $${cost})` : ''}`.trim(),
          source_name: 'Chicago Building Permits',
        }),
      );
    }
  } catch {
    // Allow partial results
  }

  return leads;
}

const PRIORITY_EMAIL_PREFIXES = [
  'bids@',
  'estimating@',
  'estimator@',
  'preconstruction@',
  'projects@',
  'quotes@',
  'sales@',
  'info@',
  'contact@',
];

const IGNORED_EMAIL_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'yourdomain.com'];

function rankEmails(emails: string[]): string[] {
  return [...emails].sort((a, b) => {
    const ai = PRIORITY_EMAIL_PREFIXES.findIndex((p) => a.startsWith(p));
    const bi = PRIORITY_EMAIL_PREFIXES.findIndex((p) => b.startsWith(p));
    const ar = ai === -1 ? PRIORITY_EMAIL_PREFIXES.length : ai;
    const br = bi === -1 ? PRIORITY_EMAIL_PREFIXES.length : bi;
    return ar - br || a.localeCompare(b);
  });
}

const STOP_WORDS = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'llp',
  'lp', 'pllc', 'the', 'and', 'of', 'group', 'services', 'service', 'solutions',
]);

const PARKED_SIGNALS = [
  'domain is for sale',
  'buy this domain',
  'hugedomains',
  'sedoparking',
  'afternic',
  'dan.com',
  'domain parking',
  'godaddy',
  'this domain may be for sale',
];

function extractTokens(companyName: string): string[] {
  return companyName
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function buildDomainCandidates(companyName: string): string[] {
  const tokens = extractTokens(companyName);
  if (tokens.length === 0) return [];
  const joined = tokens.join('');
  const candidates = new Set<string>();
  if (joined.length >= 4) {
    candidates.add(`https://www.${joined}.com`);
  }
  const core = tokens.filter(
    (t) => !['construction', 'contractors', 'contractor', 'builders', 'builder', 'architects', 'architectural', 'company'].includes(t),
  );
  if (core.length >= 1 && core.join('').length >= 5 && core.join('') !== joined) {
    candidates.add(`https://www.${core.join('')}.com`);
  }
  return Array.from(candidates).slice(0, 2);
}

function pageMatchesCompany(companyName: string, html: string): boolean {
  const low = html.toLowerCase();
  if (PARKED_SIGNALS.some((p) => low.includes(p))) return false;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = (titleMatch ? titleMatch[1] : '').toLowerCase();
  const bodySample = low.slice(0, 12000);
  const tokens = extractTokens(companyName).filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  const primary = tokens[0];
  return titleText.includes(primary) || (tokens.length >= 2 ? tokens.slice(0, 2).every((t) => bodySample.includes(t)) : bodySample.includes(primary));
}

async function inspectWebsiteContacts(rawUrl: string) {
  const normalizedInput = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const parsed = await assertSafePublicUrl(normalizedInput);

  // Check robots.txt politely before fetching public pages
  try {
    const robotsResp = await fetch(`${parsed.origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (robotsResp.ok) {
      const robotsTxt = await robotsResp.text();
      const disallowAll = /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/im.test(robotsTxt);
      if (disallowAll) {
        throw new Error('Site disallows automated crawling in robots.txt.');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('robots.txt')) throw err;
  }

  const candidateUrls = Array.from(
    new Set([
      parsed.toString(),
      `${parsed.origin}/contact`,
      `${parsed.origin}/contact-us`,
      `${parsed.origin}/about`,
      `${parsed.origin}/team`,
      `${parsed.origin}/estimating`,
    ]),
  ).slice(0, 5);

  const foundEmails = new Set<string>();
  const foundPhones = new Set<string>();
  const foundContacts: Array<{ name: string; title: string }> = [];
  const foundServices = new Set<string>();
  let pagesChecked = 0;

  const roleRegex =
    /(?:^|[\n•|])\s*([A-Z][a-z]{1,18}\s+[A-Z][a-z]{1,18})\s*(?:[-,|–—]\s*|\n\s*)((?:Chief|Senior|Lead|Head)?\s*(?:Estimator|Project Manager|Preconstruction(?:\s+Manager|\s+Director)?|Director of Estimating|President|Owner|Principal|Architect|Millwork Manager))/g;

  for (const pageUrl of candidateUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const htmlResp = await fetch(pageUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
      if (!htmlResp.ok) continue;
      pagesChecked += 1;
      const html = await htmlResp.text();

      // Extract mailto: and tel: links before stripping HTML tags
      const mailtoMatches = html.matchAll(/href=["']mailto:([^"'?#\s>]+)/gi);
      for (const m of mailtoMatches) {
        const clean = decodeURIComponent(m[1] || '').trim().toLowerCase();
        if (clean.includes('@') && !IGNORED_EMAIL_DOMAINS.some((d) => clean.endsWith(`@${d}`))) {
          foundEmails.add(clean);
        }
      }
      const telMatches = html.matchAll(/href=["']tel:([^"'#\s>]+)/gi);
      for (const m of telMatches) {
        const digits = (m[1] || '').replace(/\D/g, '');
        const d10 = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
        if (d10.length === 10 && d10[0] !== '0' && d10[0] !== '1') {
          foundPhones.add(`(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`);
        }
      }

      const lineText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|li|h1|h2|h3|h4|tr|br)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
      const flatText = lineText.replace(/\s+/g, ' ');

      const emailMatches = flatText.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g) || [];
      for (const em of emailMatches) {
        const clean = em.toLowerCase();
        if (!IGNORED_EMAIL_DOMAINS.some((d) => clean.endsWith(`@${d}`))) {
          foundEmails.add(clean);
        }
      }

      const phoneMatches = flatText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g) || [];
      for (const ph of phoneMatches) {
        foundPhones.add(ph.trim());
      }

      let roleMatch: RegExpExecArray | null;
      roleRegex.lastIndex = 0;
      while ((roleMatch = roleRegex.exec(lineText)) !== null) {
        const name = roleMatch[1].replace(/\s+/g, ' ').trim();
        const title = roleMatch[2].replace(/\s+/g, ' ').trim();
        if (
          name &&
          title &&
          !/^(Opportunities|Careers|Contact|About|Team|Services|Projects)\b/i.test(name) &&
          !foundContacts.some((c) => c.name === name)
        ) {
          foundContacts.push({ name, title });
        }
      }

      const low = flatText.toLowerCase();
      if (/(general contractor|commercial construction|design-build)/.test(low)) foundServices.add('Commercial Construction');
      if (/(estimating|quantity takeoff|preconstruction|bid)/.test(low)) foundServices.add('Estimating / Bidding');
      if (/(architectural|cad drafting|construction drawings|permit drawings)/.test(low)) foundServices.add('Architectural / CAD');
      if (/(millwork|cabinetry|casework|shop drawings)/.test(low)) foundServices.add('Millwork / Cabinetry');

      if (foundEmails.size > 0 && foundPhones.size > 0 && foundContacts.length > 0) {
        break;
      }
    } catch {
      // Continue to next candidate page
    } finally {
      clearTimeout(timer);
    }
  }

  if (pagesChecked === 0) {
    throw new Error('Could not reach any public pages on this website.');
  }

  const rankedEmails = rankEmails(Array.from(foundEmails)).slice(0, 8);
  const phonesList = Array.from(foundPhones).slice(0, 8);
  const contactsList = foundContacts.slice(0, 6);

  return {
    website: parsed.origin,
    email: rankedEmails[0] || '',
    phone: phonesList[0] || '',
    contact_person: contactsList[0]?.name || '',
    job_title: contactsList[0]?.title || '',
    emails: rankedEmails,
    phones: phonesList,
    contacts: contactsList,
    services: Array.from(foundServices).join(', '),
    pages_checked: pagesChecked,
  };
}

async function resolvePublicWebsiteAndContacts(companyName: string, city: string, state: string): Promise<{
  website: string;
  phone: string;
  email: string;
}> {
  const cleanTokens = extractTokens(companyName);
  const searchQuery = cleanTokens.slice(0, 4).join(' ');
  if (!searchQuery) return { website: '', phone: '', email: '' };

  let foundWebsite = '';
  let foundPhone = '';
  let foundEmail = '';

  // 1) Wikidata official entity search + P856 Official Website
  for (const wdQuery of Array.from(new Set([searchQuery, cleanTokens.slice(0, 2).join(' ')])).filter(Boolean)) {
    try {
      const wdUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
        wdQuery,
      )}&language=en&format=json&limit=2`;
      const wdSearch = (await fetchJsonWithTimeout(wdUrl, {}, 5000)) as {
        search?: Array<{ id?: string; label?: string; description?: string }>;
      };
      const match = (wdSearch.search || []).find((item) => {
        const label = (item.label || '').toLowerCase();
        return cleanTokens[0] && label.includes(cleanTokens[0]);
      });
      if (match?.id) {
        const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(
          match.id,
        )}&props=claims&format=json`;
        const entData = (await fetchJsonWithTimeout(entUrl, {}, 5000)) as {
          entities?: Record<string, { claims?: { P856?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> } }>;
        };
        const site = entData.entities?.[match.id]?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
        if (site && /^https?:\/\//i.test(site)) {
          foundWebsite = site;
          break;
        }
      }
    } catch {
      // Continue to next free public source
    }
  }

  // 2) OpenStreetMap Nominatim free business tags
  try {
    const osmQuery = [searchQuery, city, state].filter(Boolean).join(' ');
    const osmUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      osmQuery,
    )}&format=jsonv2&extratags=1&countrycodes=us&limit=3`;
    const osmRows = (await fetchJsonWithTimeout(osmUrl, {}, 5000)) as Array<{
      name?: string;
      extratags?: Record<string, string> | null;
    }>;
    for (const row of osmRows) {
      const tags = row.extratags || {};
      const rowName = (row.name || '').toLowerCase();
      if (cleanTokens[0] && !rowName.includes(cleanTokens[0])) continue;
      if (!foundWebsite) foundWebsite = tags.website || tags['contact:website'] || '';
      if (!foundPhone) foundPhone = tags.phone || tags['contact:phone'] || '';
      if (!foundEmail) foundEmail = tags.email || tags['contact:email'] || '';
      if (foundWebsite) break;
    }
  } catch {
    // Continue to verified domain candidates
  }

  // 3) Verified official domain candidate check if website is still missing
  if (!foundWebsite) {
    const candidates = buildDomainCandidates(companyName);
    for (const cand of candidates) {
      try {
        const parsed = await assertSafePublicUrl(cand);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const resp = await fetch(parsed.toString(), {
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
          });
          if (!resp.ok) continue;
          const html = await resp.text();
          if (pageMatchesCompany(companyName, html)) {
            foundWebsite = new URL(resp.url || parsed.toString()).origin;
            break;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Candidate invalid or unreachable
      }
    }
  }

  return { website: foundWebsite, phone: foundPhone, email: foundEmail };
}

const GENERIC_CONSTRUCTION_WORDS = new Set([
  'construction', 'contractors', 'contractor', 'builders', 'builder', 'contracting',
  'architects', 'architectural', 'architecture', 'design', 'build', 'millwork',
  'cabinet', 'cabinets', 'cabinetry', 'carpentry', 'woodwork', 'general', 'commercial',
  'residential', 'custom', 'enterprises', 'enterprise', 'associates', 'partners',
  'industries', 'industrial', 'development', 'properties', 'homes', 'usa', 'america',
]);

async function lookupCompanyUsaSpendingProject(
  companyName: string,
  stateFilter: string,
): Promise<{
  project_name: string;
  project_description: string;
  project_location: string;
  project_status: string;
  project_source_url: string;
  buying_intent_evidence: string;
  company_category: string;
  services: string;
  city: string;
  state: string;
  zip_code: string;
  contact_person: string;
  job_title: string;
} | null> {
  const allTokens = extractTokens(companyName);
  const distinctiveTokens = allTokens.filter((t) => !GENERIC_CONSTRUCTION_WORDS.has(t));
  const matchTokens = (distinctiveTokens.length > 0 ? distinctiveTokens : allTokens).slice(0, 3);
  const searchName = allTokens.slice(0, 5).join(' ').toUpperCase();
  if (!searchName || matchTokens.length === 0) return null;

  const end = new Date();
  const start = new Date(end.getTime() - 730 * 24 * 60 * 60 * 1000);
  const locationFilter: Record<string, string> = { country: 'USA' };
  if (/^[A-Z]{2}$/.test(stateFilter)) {
    locationFilter.state = stateFilter;
  }

  const runSearch = async (useState: boolean) => {
    const body = {
      fields: [
        'Award ID',
        'Recipient Name',
        'Award Amount',
        'Description',
        'Start Date',
        'End Date',
        'Awarding Agency',
        'Place of Performance State Code',
        'Place of Performance Zip5',
        'generated_internal_id',
      ],
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        recipient_search_text: [searchName],
        place_of_performance_locations: [useState ? locationFilter : { country: 'USA' }],
        time_period: [{ start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }],
      },
      limit: 5,
      page: 1,
      sort: 'Award Amount',
      order: 'desc',
    };
    const data = (await fetchJsonWithTimeout(
      'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      7500,
    )) as { results?: Array<Record<string, unknown>> };
    return data.results || [];
  };

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await runSearch(Boolean(locationFilter.state));
    if (rows.length === 0 && locationFilter.state) {
      rows = await runSearch(false);
    }
  } catch {
    return null;
  }

  const matchedRow = rows.find((row) => {
    const recTokens = extractTokens(String(row['Recipient Name'] || ''));
    if (recTokens.length === 0) return false;
    return matchTokens.every((tok) => recTokens.some((rt) => rt === tok || (tok.length >= 4 && rt.startsWith(tok))));
  });

  if (!matchedRow) return null;

  const genId = String(matchedRow['generated_internal_id'] || '');
  const awardId = String(matchedRow['Award ID'] || '');
  const desc = String(matchedRow['Description'] || '');
  const agency = String(matchedRow['Awarding Agency'] || '');
  const startDt = String(matchedRow['Start Date'] || '').slice(0, 10);
  let endDt = String(matchedRow['End Date'] || '').slice(0, 10);
  const rawAmount = typeof matchedRow['Award Amount'] === 'number' ? matchedRow['Award Amount'] : null;
  const amountText = rawAmount && rawAmount > 0 ? `$${Math.round(rawAmount).toLocaleString('en-US')}` : '';

  let city = '';
  let state = String(matchedRow['Place of Performance State Code'] || '');
  let zip = String(matchedRow['Place of Performance Zip5'] || '');
  let popLocation = state;
  let contactPerson = '';
  let jobTitle = '';
  let categories: string[] = [];

  if (genId) {
    try {
      const detail = (await fetchJsonWithTimeout(
        `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(genId)}/`,
        {},
        6500,
      )) as {
        recipient?: {
          business_categories?: string[];
          location?: { city_name?: string; state_code?: string; zip5?: string };
        };
        executive_details?: { officers?: Array<{ name?: string | null }> };
        period_of_performance?: { end_date?: string | null; potential_end_date?: string | null };
        place_of_performance?: { city_name?: string; state_code?: string };
      };
      const rec = detail.recipient;
      if (rec?.location?.city_name) {
        city = rec.location.city_name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (rec?.location?.state_code) state = rec.location.state_code;
      if (rec?.location?.zip5) zip = rec.location.zip5;
      if (Array.isArray(rec?.business_categories)) categories = rec.business_categories;
      const popCity = detail.place_of_performance?.city_name || '';
      const popState = detail.place_of_performance?.state_code || state;
      popLocation = [popCity, popState].filter(Boolean).join(', ');
      const officerName = (detail.executive_details?.officers || []).find((o) => o?.name)?.name || '';
      if (officerName) {
        contactPerson = officerName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
        jobTitle = 'Executive Officer';
      }
      const detEnd = String(
        detail.period_of_performance?.end_date || detail.period_of_performance?.potential_end_date || '',
      ).slice(0, 10);
      if (detEnd) endDt = detEnd;
    } catch {
      // Fall back to search-level fields if award detail times out
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const projectStatus = endDt
    ? endDt >= todayIso
      ? `Live Won Project (ends ${endDt})`
      : `Awarded Federal Contract (ended ${endDt})`
    : startDt
      ? 'Awarded'
      : 'Active';

  return {
    project_name: awardId ? `Federal Award ${awardId}` : 'Federal Contract Award',
    project_description: desc.slice(0, 450),
    project_location: popLocation,
    project_status: projectStatus,
    project_source_url: genId
      ? `https://www.usaspending.gov/award/${genId}`
      : 'https://www.usaspending.gov/search',
    buying_intent_evidence: [
      awardId ? `Federal award ${awardId}` : 'Federal award',
      amountText ? `Value: ${amountText}` : '',
      agency ? `Agency: ${agency}` : '',
      startDt ? `Start: ${startDt}` : '',
      projectStatus,
    ]
      .filter(Boolean)
      .join('; '),
    company_category: categories[0] || '',
    services: categories.slice(0, 4).join(', '),
    city,
    state,
    zip_code: zip,
    contact_person: contactPerson,
    job_title: jobTitle,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/discover/live', async (req, res) => {
    try {
      const source = String(req.body?.source || 'all');
      const state = String(req.body?.state || '').trim().toUpperCase().slice(0, 2);
      const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(1, Math.min(15, Number(req.body.limit))) : 3;

      const allLeads: Lead[] = [];
      const sourcesRun: string[] = [];
      const warnings: string[] = [];

      if (source === 'all' || source === 'usaspending') {
        try {
          const usaLeads = await discoverUsaSpending(state, Math.min(5, limit));
          allLeads.push(...usaLeads);
          sourcesRun.push('USASpending.gov');
        } catch (err) {
          warnings.push(`USASpending.gov unavailable: ${err instanceof Error ? err.message : 'Network error'}`);
        }
      }

      if (source === 'all' || source === 'permits') {
        try {
          const permitLeads = await discoverMunicipalPermits(limit * 2);
          const filtered = state ? permitLeads.filter((l) => !l.state || l.state === state) : permitLeads;
          allLeads.push(...filtered);
          sourcesRun.push('Municipal Permits (Austin & Chicago)');
        } catch (err) {
          warnings.push(`Municipal Permits unavailable: ${err instanceof Error ? err.message : 'Network error'}`);
        }
      }

      res.json({
        leads: allLeads,
        summary: {
          fetched: allLeads.length,
          sourcesRun,
          warnings,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Discovery failed' });
    }
  });

  app.post('/api/research/website', async (req, res) => {
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

  app.post('/api/research/batch-contacts', async (req, res) => {
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
        email: string;
        phone: string;
        contact_person: string;
        job_title: string;
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
            let city = String(item.city || '').trim();
            let state = String(item.state || '').trim().toUpperCase().slice(0, 2);
            let zipCode = '';
            let phone = '';
            let email = '';
            let contactPerson = '';
            let jobTitle = '';
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
                }
              }
            }

            if (!site && company) {
              const resolved = await resolvePublicWebsiteAndContacts(company, city, state);
              site = resolved.website;
              phone = resolved.phone;
              email = resolved.email;
            }

            if (site) {
              try {
                const scraped = await inspectWebsiteContacts(site);
                site = scraped.website || site;
                email = scraped.email || email;
                phone = scraped.phone || phone;
                if (scraped.contact_person) {
                  contactPerson = scraped.contact_person;
                  jobTitle = scraped.job_title || jobTitle;
                }
                services = [scraped.services, services].filter(Boolean).join(', ');
              } catch {
                // Keep any directory website/phone/email/project found without failing batch
              }
            }

            return {
              id,
              website: site,
              email,
              phone,
              contact_person: contactPerson,
              job_title: jobTitle,
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
