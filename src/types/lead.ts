export type ServiceOpportunity =
  | 'Construction Estimation'
  | 'Architectural Services'
  | 'Millwork Services'
  | '';

export type ConfidenceLevel = 'Verified' | 'High' | 'Medium' | 'Low' | 'Unverified';
export type LeadTier = 'Warm' | 'Potential' | 'Unqualified';
export type OutreachStatus = 'New' | 'Queued' | 'Contacted' | 'Replied' | 'Closed';

export interface ScoreFactor {
  label: string;
  points: number;
  maxPoints: number;
  reason: string;
}

export interface Lead {
  id: string;
  company_name: string;
  normalized_name: string;
  website: string;
  domain: string;
  business_email: string;
  business_phone: string;
  phone_digits: string;
  phone_type: string;
  contact_person: string;
  job_title: string;
  city: string;
  state: string;
  zip_code: string;
  company_category: string;
  services_offered: string;
  service_opportunity: ServiceOpportunity | string;
  project_name: string;
  project_description: string;
  project_location: string;
  project_status: string;
  project_source_url: string;
  company_source_url: string;
  buying_intent_evidence: string;
  qualification_reason: string;
  lead_score: number;
  score_breakdown: ScoreFactor[];
  confidence_level: ConfidenceLevel;
  lead_tier: LeadTier;
  source_name: string;
  all_sources: string[];
  date_discovered: string;
  last_verified: string;
  outreach_status: OutreachStatus;
  notes: string;
}

export interface DiscoveryResponse {
  leads: Lead[];
  summary: {
    fetched: number;
    sourcesRun: string[];
    warnings: string[];
  };
}
