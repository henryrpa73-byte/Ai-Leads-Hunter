import type { Lead } from '../types/lead.ts';
import { cleanText, extractProjectValueUsd, normalizePhone } from './leadEngine.ts';

export type CrmPlatform = 'hubspot' | 'salesforce' | 'pipedrive' | 'zoho' | 'webhook';

export interface CrmPlatformMeta {
  id: CrmPlatform;
  name: string;
  tagline: string;
  csvFilePrefix: string;
  envHint: string;
  endpointSummary: string;
}

export const CRM_PLATFORMS: CrmPlatformMeta[] = [
  {
    id: 'hubspot',
    name: 'HubSpot',
    tagline: 'Contacts & Companies batch import',
    csvFilePrefix: 'hubspot_warm_leads',
    envHint: 'HUBSPOT_ACCESS_TOKEN',
    endpointSummary: 'POST api.hubapi.com/crm/v3/objects/contacts/batch/create',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    tagline: 'Lead sObjects & Data Loader CSV',
    csvFilePrefix: 'salesforce_warm_leads',
    envHint: 'SALESFORCE_INSTANCE_URL + SALESFORCE_ACCESS_TOKEN',
    endpointSummary: 'POST /services/data/v60.0/composite/sobjects',
  },
  {
    id: 'pipedrive',
    name: 'Pipedrive',
    tagline: 'Organizations, Persons & Leads',
    csvFilePrefix: 'pipedrive_warm_leads',
    envHint: 'PIPEDRIVE_API_TOKEN',
    endpointSummary: 'POST api.pipedrive.com/v1/organizations + /v1/leads',
  },
  {
    id: 'zoho',
    name: 'Zoho CRM',
    tagline: 'Leads module v2 API & CSV',
    csvFilePrefix: 'zoho_warm_leads',
    envHint: 'ZOHO_CRM_ACCESS_TOKEN',
    endpointSummary: 'POST zohoapis.com/crm/v2/Leads',
  },
  {
    id: 'webhook',
    name: 'Custom JSON API / Webhook',
    tagline: 'Zapier, Make, n8n, or REST endpoint',
    csvFilePrefix: 'crm_webhook_warm_leads',
    envHint: 'CRM_WEBHOOK_URL (or enter public HTTPS URL)',
    endpointSummary: 'POST https://your-crm-endpoint/webhook',
  },
];

function splitContactName(lead: Lead): { firstName: string; lastName: string; fullName: string } {
  const full = cleanText(lead.contact_person);
  if (!full) {
    return { firstName: 'Estimating', lastName: 'Team', fullName: `${lead.company_name} Team` };
  }
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: 'Team', fullName: parts[0] };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
    fullName: full,
  };
}

function buildLeadNote(lead: Lead): string {
  return [
    `Score: ${lead.lead_score}/100 (${lead.lead_tier})`,
    lead.service_opportunity ? `Target Service: ${lead.service_opportunity}` : '',
    lead.project_name ? `Project: ${lead.project_name}` : '',
    lead.project_status ? `Status: ${lead.project_status}` : '',
    lead.project_location ? `Site: ${lead.project_location}` : '',
    lead.buying_intent_evidence ? `Evidence: ${lead.buying_intent_evidence}` : '',
    lead.project_description ? `Scope: ${lead.project_description}` : '',
    lead.project_source_url ? `Source: ${lead.project_source_url}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatE164Phone(lead: Lead): string {
  const digits = lead.phone_digits || normalizePhone(lead.business_phone).digits;
  if (digits.length === 10) return `+1${digits}`;
  return cleanText(lead.business_phone);
}

export function mapLeadsToCrmRecords(leads: Lead[], platform: CrmPlatform): Array<Record<string, unknown>> {
  return leads.map((lead) => {
    const { firstName, lastName, fullName } = splitContactName(lead);
    const phone = formatE164Phone(lead);
    const note = buildLeadNote(lead);
    const valueUsd = extractProjectValueUsd(`${lead.buying_intent_evidence} ${lead.project_description}`);

    switch (platform) {
      case 'hubspot':
        return {
          company: lead.company_name,
          firstname: firstName,
          lastname: lastName,
          jobtitle: lead.job_title || 'Project / Estimating Contact',
          email: lead.business_email,
          phone,
          website: lead.website,
          city: lead.city,
          state: lead.state,
          zip: lead.zip_code,
          hs_lead_status: lead.lead_tier === 'Warm' ? 'OPEN_DEAL' : 'NEW',
          lead_score: lead.lead_score,
          service_opportunity: lead.service_opportunity,
          project_name: lead.project_name,
          description: note,
        };

      case 'salesforce':
        return {
          Company: lead.company_name,
          FirstName: firstName,
          LastName: lastName,
          Title: lead.job_title || 'Project Contact',
          Email: lead.business_email,
          Phone: phone,
          Website: lead.website,
          City: lead.city,
          State: lead.state,
          PostalCode: lead.zip_code,
          LeadSource: lead.source_name || 'Ai Leads Hunter',
          Rating: lead.lead_tier === 'Warm' ? 'Hot' : 'Warm',
          Status: 'Open - Not Contacted',
          Description: note,
        };

      case 'pipedrive':
        return {
          organization_name: lead.company_name,
          person_name: fullName,
          person_email: lead.business_email,
          person_phone: phone,
          website: lead.website,
          city: lead.city,
          state: lead.state,
          zip_code: lead.zip_code,
          lead_title: `${lead.company_name} — ${lead.service_opportunity || 'Design & Estimation'}`,
          lead_value_usd: valueUsd ?? 0,
          source: lead.source_name || 'Ai Leads Hunter',
          note,
        };

      case 'zoho':
        return {
          Company: lead.company_name,
          First_Name: firstName,
          Last_Name: lastName,
          Designation: lead.job_title || 'Project Contact',
          Email: lead.business_email,
          Phone: phone,
          Website: lead.website,
          City: lead.city,
          State: lead.state,
          Zip_Code: lead.zip_code,
          Lead_Source: lead.source_name || 'Ai Leads Hunter',
          Lead_Status: lead.lead_tier === 'Warm' ? 'Hot Lead' : 'Pre-Qualified',
          Rating: lead.lead_tier === 'Warm' ? 'Active' : 'Acquired',
          Description: note,
        };

      case 'webhook':
      default:
        return {
          id: lead.id,
          company_name: lead.company_name,
          contact_person: fullName,
          job_title: lead.job_title,
          business_phone: lead.business_phone,
          phone_e164: phone,
          business_email: lead.business_email,
          website: lead.website,
          city: lead.city,
          state: lead.state,
          zip_code: lead.zip_code,
          service_opportunity: lead.service_opportunity,
          lead_tier: lead.lead_tier,
          lead_score: lead.lead_score,
          project_name: lead.project_name,
          project_status: lead.project_status,
          project_location: lead.project_location,
          project_value_usd: valueUsd,
          buying_intent_evidence: lead.buying_intent_evidence,
          project_source_url: lead.project_source_url,
          source_name: lead.source_name,
        };
    }
  });
}

function escapeCsvCell(val: unknown): string {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function leadsToCrmCsv(leads: Lead[], platform: CrmPlatform): string {
  const records = mapLeadsToCrmRecords(leads, platform);
  if (records.length === 0) return '';
  const headers = Object.keys(records[0]);
  const lines = [headers.join(',')];
  for (const rec of records) {
    lines.push(headers.map((h) => escapeCsvCell(rec[h])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

export function leadsToCrmJson(leads: Lead[], platform: CrmPlatform): string {
  const records = mapLeadsToCrmRecords(leads, platform);
  return JSON.stringify(
    {
      source: 'Ai Leads Hunter',
      platform,
      exported_at: new Date().toISOString(),
      count: records.length,
      records,
    },
    null,
    2,
  );
}
