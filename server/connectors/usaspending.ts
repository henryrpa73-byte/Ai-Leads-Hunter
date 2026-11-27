import { buildNormalizedLead, inferServiceOpportunity } from '../../src/lib/leadEngine.ts';
import { classifyCompanyCategory, classifyConstructionTrade, classifyProjectType } from '../../src/lib/trades.ts';
import type { Lead } from '../../src/types/lead.ts';
import { fetchJsonPublic } from '../security.ts';

export const NAICS_TARGETS: Record<string, string> = {
  '236220': 'Commercial and Institutional Building Construction',
  '236118': 'Residential Remodelers',
  '236115': 'New Single-Family Housing Builders',
  '238350': 'Finish Carpentry & Millwork Contractors',
  '337110': 'Wood Kitchen Cabinet and Countertop Manufacturing',
  '541310': 'Architectural Services',
  '541330': 'Engineering & Structural Design',
  '541340': 'Drafting & CAD Services',
  '238160': 'Roofing Contractors',
  '238110': 'Concrete Foundation & Structure Contractors',
  '238210': 'Electrical Contractors',
  '238220': 'Plumbing, Heating, and Air-Conditioning Contractors',
};

export async function discoverUsaSpending(
  stateFilter: string,
  limitPerNaics: number,
  page = 1,
): Promise<{ leads: Lead[]; errors: string[] }> {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const locationFilter: Record<string, string> = { country: 'USA' };
  if (/^[A-Z]{2}$/.test(stateFilter)) {
    locationFilter.state = stateFilter;
  }

  const perNaics = Math.max(1, Math.min(50, limitPerNaics));
  const fetchDetails = perNaics <= 4;
  const naicsEntries = Object.entries(NAICS_TARGETS);
  const errors: string[] = [];

  const naicsResults = await Promise.all(
    naicsEntries.map(async ([naics, categoryLabel]) => {
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
          naics_codes: [naics],
          place_of_performance_locations: [locationFilter],
          time_period: [{ start_date: startDate, end_date: endDate }],
        },
        limit: perNaics,
        page: Math.max(1, page),
        sort: 'Start Date',
        order: 'desc',
      };

      try {
        const data = (await fetchJsonPublic(
          'https://api.usaspending.gov/api/v2/search/spending_by_award/',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            timeoutMs: 11000,
          },
        )) as { results?: Array<Record<string, unknown>> };

        const naicsLeads = await Promise.all(
          (data.results || []).map(async (row) => {
            const genId = String(row['generated_internal_id'] || '');
            let city = '';
            let address = '';
            let state = String(row['Place of Performance State Code'] || '');
            let zip = String(row['Place of Performance Zip5'] || '');
            let recipientName = String(row['Recipient Name'] || '');
            let categories: string[] = [];
            let popLocation = state;
            let contactPerson = '';
            let jobTitle = '';
            const rawEndDt = String(row['End Date'] || '').slice(0, 10);
            const todayIso = new Date().toISOString().slice(0, 10);
            let liveStatus = rawEndDt
              ? rawEndDt >= todayIso
                ? `Live Won Project (ends ${rawEndDt})`
                : `Completed Award (ended ${rawEndDt})`
              : String(row['Start Date'] || '')
                ? 'Awarded'
                : 'Active';

            if (fetchDetails && genId) {
              try {
                const detail = (await fetchJsonPublic(
                  `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(genId)}/`,
                  { timeoutMs: 4500 },
                )) as {
                  recipient?: {
                    recipient_name?: string;
                    business_categories?: string[];
                    location?: {
                      address_line1?: string;
                      city_name?: string;
                      state_code?: string;
                      zip5?: string;
                    };
                  };
                  executive_details?: { officers?: Array<{ name?: string | null }> };
                  period_of_performance?: { end_date?: string | null; potential_end_date?: string | null };
                  place_of_performance?: { city_name?: string; state_code?: string };
                };
                const rec = detail.recipient;
                if (rec?.recipient_name) recipientName = rec.recipient_name;
                if (rec?.location?.address_line1) address = rec.location.address_line1;
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
                if (endDt) {
                  liveStatus = endDt >= todayIso ? `Live Won Project (ends ${endDt})` : `Completed Award (ended ${endDt})`;
                }
              } catch {
                // Keep search-level award fields if detail call times out
              }
            }

            const awardId = String(row['Award ID'] || '');
            const amount =
              typeof row['Award Amount'] === 'number'
                ? `$${Math.round(row['Award Amount']).toLocaleString('en-US')}`
                : '';
            const desc = String(row['Description'] || '');
            const agency = String(row['Awarding Agency'] || '');
            const startDt = String(row['Start Date'] || '').slice(0, 10);
            const sourceUrl = genId
              ? `https://www.usaspending.gov/award/${genId}`
              : 'https://www.usaspending.gov/search';

            const trade = classifyConstructionTrade(`${naics} ${categoryLabel} ${desc} ${recipientName}`);
            const cat = classifyCompanyCategory(`${naics} ${categoryLabel} ${recipientName}`, trade);

            return buildNormalizedLead({
              company_name: recipientName,
              contact_person: contactPerson,
              job_title: jobTitle,
              contact_source_url: contactPerson ? sourceUrl : '',
              contact_status: contactPerson ? 'Publicly Listed' : 'Unknown',
              business_address: address,
              city: city ? city.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '',
              state: stateFilter || state,
              zip_code: zip,
              company_category: cat,
              construction_trade: trade,
              services_offered: categories.slice(0, 4).join(', '),
              service_opportunity: inferServiceOpportunity(`${naics} ${categoryLabel} ${desc}`),
              project_name: awardId ? `Federal Award ${awardId}` : 'Federal Construction Award',
              project_type: classifyProjectType(`${categoryLabel} ${desc} ${agency}`),
              project_owner: agency,
              general_contractor: recipientName,
              project_value: amount,
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
            });
          }),
        );
        return naicsLeads;
      } catch (err) {
        errors.push(`USASpending NAICS ${naics}: ${err instanceof Error ? err.message : 'Request failed'}`);
        return [] as Lead[];
      }
    }),
  );

  return { leads: naicsResults.flat(), errors };
}
