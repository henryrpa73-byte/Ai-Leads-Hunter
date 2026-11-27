export type ServiceOpportunity =
  | 'Construction Estimation'
  | 'Architectural Services'
  | 'Millwork Services'
  | '';

export type ConfidenceLevel = 'Verified' | 'High' | 'Medium' | 'Low' | 'Unverified';
export type VerificationStatus = 'Verified' | 'Publicly Listed' | 'Inferred' | 'Unknown';

export type LeadTier = 'Hot' | 'Warm' | 'Potential' | 'Low Priority';

export type OutreachStatus =
  | 'New'
  | 'Ready for Calling'
  | 'Calling'
  | 'No Answer'
  | 'Not Connected'
  | 'Interested'
  | 'Follow-up'
  | 'SMS Sent'
  | 'Replied'
  | 'STOP / Opted Out'
  | 'Qualified'
  | 'Meeting'
  | 'Project Received'
  | 'Won'
  | 'Lost'
  | 'Not Interested';

export const OUTREACH_STATUSES: OutreachStatus[] = [
  'New',
  'Ready for Calling',
  'Calling',
  'No Answer',
  'Not Connected',
  'Interested',
  'Follow-up',
  'SMS Sent',
  'Replied',
  'STOP / Opted Out',
  'Qualified',
  'Meeting',
  'Project Received',
  'Won',
  'Lost',
  'Not Interested',
];

export const SUPPRESSED_OUTREACH_STATUSES = new Set<OutreachStatus>([
  'STOP / Opted Out',
  'Lost',
  'Not Interested',
]);

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
  business_address: string;
  business_email: string;
  business_phone: string;
  phone_digits: string;
  phone_type: string;
  contact_person: string;
  job_title: string;
  contact_source_url: string;
  city: string;
  state: string;
  zip_code: string;
  company_category: string;
  construction_trade: string;
  services_offered: string;
  service_opportunity: ServiceOpportunity | string;
  project_name: string;
  project_description: string;
  project_location: string;
  project_type: string;
  project_owner: string;
  general_contractor: string;
  subcontractor: string;
  project_value: string;
  project_status: string;
  bid_date: string;
  project_source_url: string;
  company_source_url: string;
  website_status: VerificationStatus;
  email_status: VerificationStatus;
  phone_status: VerificationStatus;
  contact_status: VerificationStatus;
  buying_intent_evidence: string;
  qualification_reason: string;
  ai_summary?: string;
  lead_score: number;
  score_breakdown: ScoreFactor[];
  confidence_level: ConfidenceLevel;
  lead_tier: LeadTier;
  source_name: string;
  all_sources: string[];
  all_source_urls?: string[];
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
    nextPage?: number;
    skippedDuplicates?: number;
  };
}

export interface DuplicateRelation {
  id: number;
  primary_lead_id: string;
  primary_company_name: string;
  duplicate_company_name: string;
  duplicate_phone: string;
  duplicate_email: string;
  duplicate_domain: string;
  match_reason: string;
  source_name: string;
  source_url: string;
  resolved_status: 'merged' | 'pending_review' | 'kept_separate';
  detected_at: string;
}

export interface DiscoveryJob {
  id: string;
  source: string;
  state_filter: string;
  trade_filter: string;
  status: 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  total_target: number;
  fetched_count: number;
  added_count: number;
  duplicate_count: number;
  failed_count: number;
  current_step: string;
  warnings: string[];
  errors: string[];
  source_stats: Record<string, { fetched: number; added: number; errors: number }>;
  started_at: string;
  updated_at: string;
  finished_at: string;
}

export interface OllamaSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface DashboardDbStats {
  totalCompanies: number;
  newLeads: number;
  verifiedLeads: number;
  hotLeads: number;
  warmLeads: number;
  potentialLeads: number;
  lowPriorityLeads: number;
  projectOpportunities: number;
  duplicateCount: number;
  failedSourceRequests: number;
  lastSuccessfulRun: string;
  byState: Array<{ state: string; hot: number; warm: number; total: number }>;
  byTrade: Array<{ trade: string; total: number }>;
  bySource: Array<{ source: string; total: number }>;
}
