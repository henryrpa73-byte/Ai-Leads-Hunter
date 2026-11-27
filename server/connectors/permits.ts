import { buildNormalizedLead, inferServiceOpportunity } from '../../src/lib/leadEngine.ts';
import { classifyCompanyCategory, classifyConstructionTrade, classifyProjectType } from '../../src/lib/trades.ts';
import type { Lead } from '../../src/types/lead.ts';
import { fetchJsonPublic } from '../security.ts';

function parseDallasContractorField(raw: string): { company: string; phone: string } {
  const phoneMatch = raw.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
  const phone = phoneMatch ? phoneMatch[0].trim() : '';
  let company = raw;
  if (phoneMatch && typeof phoneMatch.index === 'number') {
    company = raw.slice(0, phoneMatch.index).trim();
  }
  company = company
    .replace(/\s+\b(?:PO\s+BOX|P\.O\.\s+BOX|\d{2,5}\s+[A-Z0-9])/i, ' |SPLIT| ')
    .split('|SPLIT|')[0]
    .replace(/[,.\-\s]+$/, '')
    .trim();
  return { company: company || raw.trim(), phone };
}

export const PERMIT_PORTAL_STATES = ['TX', 'NY', 'IL', 'FL', 'WA', 'OH', 'LA', 'CA'];
export const DIRECT_PHONE_PORTAL_STATES = ['TX', 'NY', 'FL'];

export async function discoverMunicipalPermits(
  limitPerPortal: number,
  page = 1,
  stateFilter = '',
  smsPhonePriority = false,
): Promise<{
  leads: Lead[];
  portalsUsed: string[];
  errors: string[];
  portalStats: Record<string, { fetched: number; errors: number }>;
}> {
  const cap = Math.max(1, Math.min(350, limitPerPortal));
  const offset = Math.max(0, (Math.max(1, page) - 1) * cap);
  const portalsUsed: string[] = [];
  const errors: string[] = [];
  const portalStats: Record<string, { fetched: number; errors: number }> = {};

  const runPortal = async (
    portalLabel: string,
    fn: () => Promise<Lead[]>,
  ): Promise<Lead[]> => {
    try {
      const rows = await fn();
      portalStats[portalLabel] = { fetched: rows.length, errors: 0 };
      if (rows.length > 0) portalsUsed.push(portalLabel);
      return rows;
    } catch (err) {
      portalStats[portalLabel] = { fetched: 0, errors: 1 };
      errors.push(`${portalLabel}: ${err instanceof Error ? err.message : 'Unavailable'}`);
      return [];
    }
  };

  const tasks: Array<Promise<Lead[]>> = [];

  // 1. Austin, TX Open Data Permits
  if (!stateFilter || stateFilter === 'TX') {
    tasks.push(
      runPortal('Austin TX', async () => {
        const whereClause = smsPhonePriority
          ? "contractor_company_name IS NOT NULL AND contractor_phone IS NOT NULL AND permittype='BP'"
          : 'contractor_company_name IS NOT NULL';
        const url = `https://data.austintexas.gov/resource/3syk-w9eu.json?$where=${encodeURIComponent(
          whereClause,
        )}&$order=${encodeURIComponent('issue_date DESC')}&$limit=${cap}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.contractor_company_name || '').trim();
          if (!company) continue;
          const permitNum = String(row.permit_number || '').trim();
          const workClass = String(row.work_class || row.permit_type_desc || '').trim();
          const desc = String(row.description || '').trim();
          const issueDate = String(row.issue_date || '').slice(0, 10);
          const expiresDate = String(row.expiresdate || '').slice(0, 10);
          const loc = String(row.permit_location || row.original_address1 || '').trim();
          const valuation = Number.parseFloat(String(row.total_job_valuation || '0'));
          const valText = Number.isFinite(valuation) && valuation > 100 ? `$${Math.round(valuation).toLocaleString('en-US')}` : '';
          const rawStatus = String(row.status_current || 'Active').trim();
          const projectStatus = expiresDate ? `Live ${rawStatus} Permit (expires ${expiresDate})` : `Live ${rawStatus} Permit`;
          const portalUrl = permitNum
            ? `https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=${encodeURIComponent(permitNum)}`
            : 'https://data.austintexas.gov/d/3syk-w9eu';
          const trade = classifyConstructionTrade(`${row.contractor_trade || ''} ${workClass} ${desc} ${company}`);
          const contact = String(row.contractor_full_name || row.applicant_full_name || '').trim();

          out.push(
            buildNormalizedLead({
              company_name: company,
              business_phone: String(row.contractor_phone || row.applicant_phone || ''),
              phone_status: row.contractor_phone || row.applicant_phone ? 'Publicly Listed' : 'Unknown',
              contact_person: contact,
              job_title: String(row.contractor_trade || 'Project Contractor').trim(),
              contact_source_url: portalUrl,
              contact_status: contact ? 'Publicly Listed' : 'Unknown',
              business_address: String(row.contractor_address1 || ''),
              city: String(row.contractor_city || 'Austin'),
              state: String(row.contractor_state || 'TX'),
              zip_code: String(row.contractor_zip || row.original_zip || ''),
              company_category: classifyCompanyCategory(`${row.permit_class_mapped || ''} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${workClass} ${desc}`),
              project_name: permitNum ? `Austin Permit ${permitNum}` : 'Austin Building Permit',
              project_type: classifyProjectType(`${row.permit_class_mapped || ''} ${workClass} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: [workClass, desc].filter(Boolean).join(': ').slice(0, 450),
              project_location: [loc, 'Austin, TX'].filter(Boolean).join(', '),
              project_status: projectStatus,
              project_source_url: portalUrl,
              company_source_url: 'https://data.austintexas.gov/d/3syk-w9eu',
              buying_intent_evidence: `Active Austin permit ${permitNum} issued ${issueDate}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'Austin Open Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 2. NYC DOB Issued Permits
  if (!stateFilter || stateFilter === 'NY') {
    tasks.push(
      runPortal('NYC DOB', async () => {
        const whereClause = 'permittee_s_business_name IS NOT NULL AND permittee_s_phone__ IS NOT NULL';
        const url = `https://data.cityofnewyork.us/resource/ipu4-2q9a.json?$where=${encodeURIComponent(
          whereClause,
        )}&$order=${encodeURIComponent('issuance_date DESC')}&$limit=${cap}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.permittee_s_business_name || '').trim();
          if (!company || company === 'N/A' || company === 'NONE') continue;
          const jobNum = String(row.job__ || row.permit_si_no || '').trim();
          const jobType = String(row.job_type || '').trim();
          const workType = String(row.work_type || '').trim();
          const borough = String(row.borough || row.city || 'New York').trim();
          const street = [row.house__, row.street_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
          const fullName = [row.permittee_s_first_name, row.permittee_s_last_name]
            .map((v) => String(v || '').trim())
            .filter(Boolean)
            .join(' ');
          const licType = String(row.permittee_s_license_type || 'GC').trim();
          const expDate = String(row.expiration_date || '').trim();
          const issDate = String(row.issuance_date || '').trim();
          const status = String(row.permit_status || 'ISSUED').trim();
          const portalUrl = jobNum
            ? `https://data.cityofnewyork.us/resource/ipu4-2q9a.json?job__=${encodeURIComponent(jobNum)}`
            : 'https://data.cityofnewyork.us/d/ipu4-2q9a';
          const contactName = fullName ? fullName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '';
          const trade = classifyConstructionTrade(`${licType} ${workType} ${jobType} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              business_phone: String(row.permittee_s_phone__ || ''),
              phone_status: row.permittee_s_phone__ ? 'Publicly Listed' : 'Unknown',
              contact_person: contactName,
              job_title: licType === 'GC' ? 'Licensed General Contractor' : `Permittee (${licType})`,
              contact_source_url: portalUrl,
              contact_status: contactName ? 'Publicly Listed' : 'Unknown',
              city: borough ? borough.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'New York',
              state: 'NY',
              zip_code: String(row.zip_code || row.owner_s_zip_code || ''),
              company_category: licType === 'GC' ? 'Commercial Builder' : 'Specialty Subcontractor',
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`architectural permit drawings ${jobType} ${workType} ${licType}`),
              project_name: jobNum ? `NYC DOB Job ${jobNum}` : 'NYC DOB Building Permit',
              project_type: classifyProjectType(`${jobType} ${workType}`),
              general_contractor: company,
              project_description: `NYC DOB ${jobType || 'Alteration'} (${workType || 'General'}) permit at ${street || borough}`,
              project_location: [street, borough, 'NY'].filter(Boolean).join(', '),
              project_status: expDate ? `Live ${status} Permit (exp ${expDate})` : `Live ${status} Permit`,
              project_source_url: portalUrl,
              company_source_url: 'https://data.cityofnewyork.us/d/ipu4-2q9a',
              buying_intent_evidence: `NYC DOB permit ${jobNum} issued ${issDate} (${licType})`.trim(),
              source_name: 'NYC DOB Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 3. Dallas, TX Building Permits
  if (!stateFilter || stateFilter === 'TX') {
    tasks.push(
      runPortal('Dallas TX', async () => {
        const url = `https://www.dallasopendata.com/resource/e7gq-4sah.json?$where=${encodeURIComponent(
          'contractor IS NOT NULL',
        )}&$order=${encodeURIComponent('issued_date DESC')}&$limit=${cap}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const rawContractor = String(row.contractor || '').trim();
          if (!rawContractor) continue;
          const { company, phone } = parseDallasContractorField(rawContractor);
          if (!company || company.length < 3) continue;
          if (smsPhonePriority && !phone) continue;

          const permitNum = String(row.permit_number || '').trim();
          const permitType = String(row.permit_type || '').trim();
          const desc = String(row.work_description || '').trim();
          const issued = String(row.issued_date || '').trim();
          const valNum = Number.parseFloat(String(row.value || '0').replace(/,/g, ''));
          const valText = Number.isFinite(valNum) && valNum > 0 ? `$${Math.round(valNum).toLocaleString('en-US')}` : '';
          const portalUrl = permitNum
            ? `https://www.dallasopendata.com/resource/e7gq-4sah.json?permit_number=${encodeURIComponent(permitNum)}`
            : 'https://www.dallasopendata.com/d/e7gq-4sah';
          const trade = classifyConstructionTrade(`${permitType} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              business_phone: phone,
              phone_status: phone ? 'Publicly Listed' : 'Unknown',
              city: 'Dallas',
              state: 'TX',
              zip_code: String(row.zip_code || ''),
              company_category: classifyCompanyCategory(`${permitType} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${permitType} ${desc}`),
              project_name: permitNum ? `Dallas Permit ${permitNum}` : 'Dallas Building Permit',
              project_type: classifyProjectType(`${permitType} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: [permitType, desc].filter(Boolean).join(': ').slice(0, 450),
              project_location: String(row.street_address || 'Dallas, TX'),
              project_status: 'Live Issued Permit',
              project_source_url: portalUrl,
              company_source_url: 'https://www.dallasopendata.com/d/e7gq-4sah',
              buying_intent_evidence: `Dallas permit ${permitNum} issued ${issued}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'Dallas Building Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 4. NYC DOB NOW Approved
  if ((!stateFilter || stateFilter === 'NY') && !smsPhonePriority) {
    tasks.push(
      runPortal('NYC DOB NOW', async () => {
        const url = `https://data.cityofnewyork.us/resource/rbx6-tga4.json?$where=${encodeURIComponent(
          'applicant_business_name IS NOT NULL',
        )}&$order=${encodeURIComponent('approved_date DESC')}&$limit=${Math.min(150, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.applicant_business_name || '').trim();
          if (!company) continue;
          const jobNum = String(row.tracking_number || row.job_filing_number || '').trim();
          const desc = String(row.job_description || '').trim();
          const workType = String(row.work_type || '').trim();
          const costNum = Number.parseFloat(String(row.estimated_job_costs || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const borough = String(row.borough || 'New York').trim();
          const contact = [row.applicant_first_name, row.applicant_last_name]
            .map((v) => String(v || '').trim())
            .filter(Boolean)
            .join(' ');
          const contactName = contact ? contact.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '';
          const street = [row.house_no, row.street_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
          const trade = classifyConstructionTrade(`${workType} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              contact_person: contactName,
              job_title: String(row.permittee_s_license_type || 'Applicant / GC'),
              contact_source_url: 'https://data.cityofnewyork.us/d/rbx6-tga4',
              contact_status: contactName ? 'Publicly Listed' : 'Unknown',
              city: borough,
              state: 'NY',
              zip_code: String(row.zip_code || ''),
              company_category: classifyCompanyCategory(`${workType} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`architectural permit set ${workType} ${desc}`),
              project_name: jobNum ? `NYC DOB NOW ${jobNum}` : 'NYC DOB NOW Permit',
              project_type: classifyProjectType(`${workType} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: [workType, desc].filter(Boolean).join(': ').slice(0, 450),
              project_location: [street, borough, 'NY'].filter(Boolean).join(', '),
              project_status: `Live ${String(row.permit_status || 'Approved')}`,
              project_source_url: 'https://data.cityofnewyork.us/d/rbx6-tga4',
              company_source_url: 'https://data.cityofnewyork.us/d/rbx6-tga4',
              buying_intent_evidence: `NYC DOB NOW filing ${jobNum} (${String(row.approved_date || '').slice(0, 10)})${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'NYC DOB NOW',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 5. Chicago, IL Building Permits
  if ((!stateFilter || stateFilter === 'IL') && !smsPhonePriority) {
    tasks.push(
      runPortal('Chicago IL', async () => {
        const url = `https://data.cityofchicago.org/resource/ydr8-5enu.json?$where=${encodeURIComponent(
          "contact_1_name IS NOT NULL AND (contact_1_type LIKE '%CONTRACTOR%' OR contact_1_type LIKE '%ARCHITECT%')",
        )}&$order=${encodeURIComponent('issue_date DESC')}&$limit=${Math.min(200, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.contact_1_name || '').trim();
          if (!company) continue;
          const permitNum = String(row.permit_ || row.id || '').trim();
          const desc = String(row.work_description || '').trim();
          const issueDate = String(row.issue_date || '').slice(0, 10);
          const costNum = Number.parseFloat(String(row.reported_cost || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const street = [row.street_number, row.street_direction, row.street_name]
            .map((v) => String(v || '').trim())
            .filter(Boolean)
            .join(' ');
          const portalUrl = permitNum
            ? `https://data.cityofchicago.org/resource/ydr8-5enu.json?permit_=${encodeURIComponent(permitNum)}`
            : 'https://data.cityofchicago.org/d/ydr8-5enu';
          const contactType = String(row.contact_1_type || 'Contractor');
          const trade = classifyConstructionTrade(`${contactType} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              city: String(row.contact_1_city || 'Chicago'),
              state: String(row.contact_1_state || 'IL'),
              zip_code: String(row.contact_1_zipcode || ''),
              company_category: classifyCompanyCategory(`${contactType} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${contactType} ${desc}`),
              project_name: permitNum ? `Chicago Permit ${permitNum}` : 'Chicago Building Permit',
              project_type: classifyProjectType(desc),
              project_value: valText,
              general_contractor: company,
              project_description: desc.slice(0, 450),
              project_location: [street, 'Chicago, IL'].filter(Boolean).join(', '),
              project_status: 'Live Issued Permit',
              project_source_url: portalUrl,
              company_source_url: 'https://data.cityofchicago.org/d/ydr8-5enu',
              buying_intent_evidence: `Chicago permit ${permitNum} issued ${issueDate}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'Chicago Building Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 6. Orlando, FL Building Permits
  if (!stateFilter || stateFilter === 'FL') {
    tasks.push(
      runPortal('Orlando FL', async () => {
        const whereClause = smsPhonePriority
          ? 'contractor_name IS NOT NULL AND contractor_phone_number IS NOT NULL'
          : 'contractor_name IS NOT NULL';
        const url = `https://data.cityoforlando.net/resource/ryhf-m453.json?$where=${encodeURIComponent(
          whereClause,
        )}&$order=${encodeURIComponent('processed_date DESC')}&$limit=${Math.min(250, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.contractor_name || row.contractor || '').trim();
          if (!company || company === 'N/A') continue;
          const permitNum = String(row.permit_number || '').trim();
          const appType = String(row.application_type || '').trim();
          const workType = String(row.worktype || '').trim();
          const addr = String(row.permit_address || '').trim();
          const processed = String(row.processed_date || '').slice(0, 10);
          const costNum = Number.parseFloat(String(row.estimated_cost || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const portalUrl = permitNum
            ? `https://data.cityoforlando.net/resource/ryhf-m453.json?permit_number=${encodeURIComponent(permitNum)}`
            : 'https://data.cityoforlando.net/d/ryhf-m453';
          const contact = String(row.contractor || '').trim();
          const trade = classifyConstructionTrade(`${appType} ${workType} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              business_phone: String(row.contractor_phone_number || ''),
              phone_status: row.contractor_phone_number ? 'Publicly Listed' : 'Unknown',
              contact_person: contact,
              job_title: 'Licensed Contractor',
              contact_source_url: portalUrl,
              contact_status: contact ? 'Publicly Listed' : 'Unknown',
              city: 'Orlando',
              state: 'FL',
              company_category: classifyCompanyCategory(`${appType} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${appType} ${workType} ${row.plan_review_type || ''}`),
              project_name: permitNum ? `Orlando Permit ${permitNum}` : 'Orlando Building Permit',
              project_type: classifyProjectType(`${appType} ${workType}`),
              project_value: valText,
              general_contractor: company,
              project_description: [appType, workType, String(row.plan_review_type || '').trim()].filter(Boolean).join(': ').slice(0, 450),
              project_location: [addr, 'Orlando, FL'].filter(Boolean).join(', '),
              project_status: `Live ${String(row.application_status || 'Open')} Permit`,
              project_source_url: portalUrl,
              company_source_url: 'https://data.cityoforlando.net/d/ryhf-m453',
              buying_intent_evidence: `Orlando permit ${permitNum} (${processed})${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'Orlando Building Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 7. Seattle, WA Building Permits
  if ((!stateFilter || stateFilter === 'WA') && !smsPhonePriority) {
    tasks.push(
      runPortal('Seattle WA', async () => {
        const url = `https://data.seattle.gov/resource/76t5-zqzr.json?$where=${encodeURIComponent(
          'contractorcompanyname IS NOT NULL',
        )}&$order=${encodeURIComponent('issueddate DESC')}&$limit=${Math.min(200, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.contractorcompanyname || '').trim();
          if (!company) continue;
          const permitNum = String(row.permitnum || '').trim();
          const desc = String(row.description || '').trim();
          const costNum = Number.parseFloat(String(row.estprojectcost || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const linkObj = row.link as { url?: string } | undefined;
          const portalUrl = linkObj?.url || 'https://data.seattle.gov/d/76t5-zqzr';
          const trade = classifyConstructionTrade(`${row.permittypedesc || ''} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              city: String(row.originalcity || 'Seattle'),
              state: String(row.originalstate || 'WA'),
              zip_code: String(row.originalzip || ''),
              company_category: classifyCompanyCategory(`${row.permitclass || ''} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${row.permittypedesc || ''} ${desc}`),
              project_name: permitNum ? `Seattle Permit ${permitNum}` : 'Seattle Building Permit',
              project_type: classifyProjectType(`${row.permitclass || ''} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: [row.permittypedesc, desc].filter(Boolean).join(': ').slice(0, 450),
              project_location: [row.originaladdress1, 'Seattle, WA'].filter(Boolean).join(', '),
              project_status: `Live ${String(row.statuscurrent || 'Active')} Permit`,
              project_source_url: portalUrl,
              company_source_url: 'https://data.seattle.gov/d/76t5-zqzr',
              buying_intent_evidence: `Seattle permit ${permitNum}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'Seattle Building Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 8. Cincinnati, OH Building Permits
  if ((!stateFilter || stateFilter === 'OH') && !smsPhonePriority) {
    tasks.push(
      runPortal('Cincinnati OH', async () => {
        const url = `https://data.cincinnati-oh.gov/resource/uhjb-xac9.json?$where=${encodeURIComponent(
          'companyname IS NOT NULL',
        )}&$order=${encodeURIComponent('issueddate DESC')}&$limit=${Math.min(200, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.companyname || '').replace(/^"+|"+$/g, '').trim();
          if (!company) continue;
          const permitNum = String(row.permitnum || '').trim();
          const desc = String(row.description || '').trim();
          const costNum = Number.parseFloat(String(row.estprojectcostdec || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const trade = classifyConstructionTrade(`${row.permittypemapped || ''} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              city: String(row.originalcity || 'Cincinnati'),
              state: String(row.originalstate || 'OH'),
              zip_code: String(row.originalzip || ''),
              company_category: classifyCompanyCategory(`${row.permittypemapped || ''} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${row.permittypemapped || ''} ${desc}`),
              project_name: permitNum ? `Cincinnati Permit ${permitNum}` : 'Cincinnati Building Permit',
              project_type: classifyProjectType(`${row.permittypemapped || ''} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: desc.slice(0, 450),
              project_location: [row.originaladdress1, 'Cincinnati, OH'].filter(Boolean).join(', '),
              project_status: `Live ${String(row.statuscurrentmapped || 'Active')} Permit`,
              project_source_url: String(row.link || 'https://data.cincinnati-oh.gov/d/uhjb-xac9'),
              company_source_url: 'https://data.cincinnati-oh.gov/d/uhjb-xac9',
              buying_intent_evidence: `Cincinnati permit ${permitNum}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'Cincinnati Building Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 9. New Orleans, LA Building Permits
  if ((!stateFilter || stateFilter === 'LA') && !smsPhonePriority) {
    tasks.push(
      runPortal('New Orleans LA', async () => {
        const url = `https://data.nola.gov/resource/rcm3-fn58.json?$where=${encodeURIComponent(
          'contractors IS NOT NULL',
        )}&$order=${encodeURIComponent('issuedate DESC')}&$limit=${Math.min(200, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const company = String(row.contractors || '').trim();
          if (!company || company.toUpperCase() === 'OWNER') continue;
          const permitNum = String(row.numstring || '').trim();
          const desc = String(row.description || '').trim();
          const costNum = Number.parseFloat(String(row.constrval || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const portalUrl = permitNum
            ? `https://data.nola.gov/resource/rcm3-fn58.json?numstring=${encodeURIComponent(permitNum)}`
            : 'https://data.nola.gov/d/rcm3-fn58';
          const applicant = String(row.applicant || '').trim();
          const trade = classifyConstructionTrade(`${row.type || ''} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              contact_person: applicant,
              contact_source_url: applicant ? portalUrl : '',
              contact_status: applicant ? 'Publicly Listed' : 'Unknown',
              city: 'New Orleans',
              state: 'LA',
              company_category: classifyCompanyCategory(`${row.landuse || row.type || ''} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${row.type || ''} ${desc}`),
              project_name: permitNum ? `NOLA Permit ${permitNum}` : 'New Orleans Building Permit',
              project_type: classifyProjectType(`${row.landuse || row.type || ''} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: [row.type, desc].filter(Boolean).join(': ').slice(0, 450),
              project_location: [row.address, 'New Orleans, LA'].filter(Boolean).join(', '),
              project_status: `Live ${String(row.currentstatus || 'Issued')} Permit`,
              project_source_url: portalUrl,
              company_source_url: 'https://data.nola.gov/d/rcm3-fn58',
              buying_intent_evidence: `New Orleans permit ${permitNum}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'New Orleans Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  // 10. San Francisco, CA Building Permits (Socrata Open Data)
  if ((!stateFilter || stateFilter === 'CA') && !smsPhonePriority) {
    tasks.push(
      runPortal('San Francisco CA', async () => {
        const url = `https://data.sfgov.org/resource/i98e-djp9.json?$where=${encodeURIComponent(
          'description IS NOT NULL AND permit_type_definition IS NOT NULL',
        )}&$order=${encodeURIComponent('filed_date DESC')}&$limit=${Math.min(150, cap)}&$offset=${offset}`;
        const rows = (await fetchJsonPublic(url, { timeoutMs: 12000 })) as Array<Record<string, unknown>>;
        const out: Lead[] = [];
        for (const row of rows) {
          const permitNum = String(row.permit_number || '').trim();
          const desc = String(row.description || '').trim();
          const def = String(row.permit_type_definition || '').trim();
          const company = String(row.company_name || row.contractor_name || '').trim();
          if (!company) continue;
          const costNum = Number.parseFloat(String(row.estimated_cost || row.revised_cost || '0'));
          const valText = Number.isFinite(costNum) && costNum > 0 ? `$${Math.round(costNum).toLocaleString('en-US')}` : '';
          const street = [row.street_number, row.street_name, row.street_suffix]
            .map((v) => String(v || '').trim())
            .filter(Boolean)
            .join(' ');
          const trade = classifyConstructionTrade(`${def} ${desc} ${company}`);

          out.push(
            buildNormalizedLead({
              company_name: company,
              city: 'San Francisco',
              state: 'CA',
              zip_code: String(row.zipcode || ''),
              company_category: classifyCompanyCategory(`${def} ${company}`, trade),
              construction_trade: trade,
              service_opportunity: inferServiceOpportunity(`${def} ${desc}`),
              project_name: permitNum ? `SF Permit ${permitNum}` : 'San Francisco Building Permit',
              project_type: classifyProjectType(`${def} ${desc}`),
              project_value: valText,
              general_contractor: company,
              project_description: [def, desc].filter(Boolean).join(': ').slice(0, 450),
              project_location: [street, 'San Francisco, CA'].filter(Boolean).join(', '),
              project_status: `Live ${String(row.status || 'Filed')} Permit`,
              project_source_url: 'https://data.sfgov.org/d/i98e-djp9',
              company_source_url: 'https://data.sfgov.org/d/i98e-djp9',
              buying_intent_evidence: `SF permit ${permitNum}${valText ? ` · Value: ${valText}` : ''}`.trim(),
              source_name: 'San Francisco Permits',
            }),
          );
        }
        return out;
      }),
    );
  }

  const settled = await Promise.all(tasks);
  return { leads: settled.flat(), portalsUsed, errors, portalStats };
}
