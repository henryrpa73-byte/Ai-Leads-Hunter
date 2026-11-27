import { assertSafePublicUrl, fetchJsonPublic, safeFetchPublic } from '../security.ts';

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

export function extractTokens(companyName: string): string[] {
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
    (t) =>
      !['construction', 'contractors', 'contractor', 'builders', 'builder', 'architects', 'architectural', 'company'].includes(t),
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
  return (
    titleText.includes(primary) ||
    (tokens.length >= 2 ? tokens.slice(0, 2).every((t) => bodySample.includes(t)) : bodySample.includes(primary))
  );
}

export async function inspectWebsiteContacts(rawUrl: string) {
  const normalizedInput = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const parsed = await assertSafePublicUrl(normalizedInput);

  // Check robots.txt politely with timeout & byte cap before fetching public pages
  try {
    const robotsResp = await safeFetchPublic(`${parsed.origin}/robots.txt`, {
      timeoutMs: 4000,
      maxBytes: 128 * 1024,
      maxRedirects: 2,
    });
    if (robotsResp.ok) {
      const disallowAll = /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/im.test(robotsResp.text);
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
  let lastCheckedPageUrl = parsed.origin;

  const roleRegex =
    /(?:^|[\n•|])\s*([A-Z][a-z]{1,18}\s+[A-Z][a-z]{1,18})\s*(?:[-,|–—]\s*|\n\s*)((?:Chief|Senior|Lead|Head)?\s*(?:Estimator|Project Manager|Preconstruction(?:\s+Manager|\s+Director)?|Director of Estimating|President|Owner|Principal|Architect|Millwork Manager))/g;

  for (const pageUrl of candidateUrls) {
    try {
      const htmlResp = await safeFetchPublic(pageUrl, {
        timeoutMs: 7000,
        maxBytes: 1500 * 1024,
        maxRedirects: 3,
        headers: { Accept: 'text/html' },
      });
      if (!htmlResp.ok) continue;
      pagesChecked += 1;
      lastCheckedPageUrl = htmlResp.finalUrl;
      const html = htmlResp.text;

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
    website_status: 'Verified' as const,
    email: rankedEmails[0] || '',
    email_status: rankedEmails.length > 0 ? ('Publicly Listed' as const) : ('Unknown' as const),
    phone: phonesList[0] || '',
    phone_status: phonesList.length > 0 ? ('Publicly Listed' as const) : ('Unknown' as const),
    contact_person: contactsList[0]?.name || '',
    job_title: contactsList[0]?.title || '',
    contact_status: contactsList.length > 0 ? ('Publicly Listed' as const) : ('Unknown' as const),
    contact_source_url: lastCheckedPageUrl,
    emails: rankedEmails,
    phones: phonesList,
    contacts: contactsList,
    services: Array.from(foundServices).join(', '),
    pages_checked: pagesChecked,
  };
}

export async function resolvePublicWebsiteAndContacts(companyName: string, city: string, state: string): Promise<{
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
      const wdSearch = (await fetchJsonPublic(wdUrl, { timeoutMs: 5000 })) as {
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
        const entData = (await fetchJsonPublic(entUrl, { timeoutMs: 5000 })) as {
          entities?: Record<string, { claims?: { P856?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> } }>;
        };
        const site = entData.entities?.[match.id]?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
        if (site && /^https?:\/\//i.test(site)) {
          foundWebsite = site;
          break;
        }
      }
    } catch {
      // Continue
    }
  }

  // 2) OpenStreetMap Nominatim free business tags
  try {
    const osmQuery = [searchQuery, city, state].filter(Boolean).join(' ');
    const osmUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      osmQuery,
    )}&format=jsonv2&extratags=1&countrycodes=us&limit=3`;
    const osmRows = (await fetchJsonPublic(osmUrl, { timeoutMs: 5000 })) as Array<{
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
    // Continue
  }

  // 3) Verified official domain candidate check
  if (!foundWebsite) {
    const candidates = buildDomainCandidates(companyName);
    for (const cand of candidates) {
      try {
        const resp = await safeFetchPublic(cand, {
          timeoutMs: 5000,
          maxBytes: 512 * 1024,
          maxRedirects: 3,
          headers: { Accept: 'text/html' },
        });
        if (!resp.ok) continue;
        if (pageMatchesCompany(companyName, resp.text)) {
          foundWebsite = new URL(resp.finalUrl).origin;
          break;
        }
      } catch {
        // Candidate invalid
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

export async function lookupCompanyUsaSpendingProject(
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
    const data = (await fetchJsonPublic(
      'https://api.usaspending.gov/api/v2/search/spending_by_award/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 7500,
      },
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
      const detail = (await fetchJsonPublic(
        `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(genId)}/`,
        { timeoutMs: 6500 },
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
      // Keep search-level fields
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
