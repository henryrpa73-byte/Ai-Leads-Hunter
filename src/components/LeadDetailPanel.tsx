import { ExternalLink, Globe, Mail, MapPin, Phone, RefreshCw, Search, UserCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  DEFAULT_SCORING_CONFIG,
  normalizePhone,
  normalizeWebsite,
  safeExternalUrl,
  scoreLead,
  type ScoringCriteriaConfig,
} from '../lib/leadEngine.ts';
import type { Lead, OutreachStatus } from '../types/lead.ts';

interface LeadDetailPanelProps {
  lead: Lead | null;
  onClose: () => void;
  onUpdateLead: (id: string, patch: Partial<Lead>) => void;
  onContactLookupComplete?: (stats: { phonesFound: number; emailsFound: number }) => void;
  scoringConfig?: ScoringCriteriaConfig;
}

interface DiscoveredSiteContacts {
  emails: string[];
  phones: string[];
  contacts: Array<{ name: string; title: string }>;
  pages_checked: number;
}

const OUTREACH_OPTIONS: OutreachStatus[] = ['New', 'Queued', 'Contacted', 'Replied', 'Closed'];

export function LeadDetailPanel({
  lead,
  onClose,
  onUpdateLead,
  onContactLookupComplete,
  scoringConfig = DEFAULT_SCORING_CONFIG,
}: LeadDetailPanelProps) {
  const [websiteDraft, setWebsiteDraft] = useState('');
  const [researching, setResearching] = useState(false);
  const [researchMessage, setResearchMessage] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredSiteContacts | null>(null);

  useEffect(() => {
    setWebsiteDraft(lead?.website || '');
    setResearchMessage('');
    setDiscovered(null);
  }, [lead?.id, lead?.website]);

  if (!lead) return null;

  const projectUrl = safeExternalUrl(lead.project_source_url);
  const companyUrl = safeExternalUrl(lead.company_source_url);
  const websiteUrl = safeExternalUrl(lead.website);
  const lookupQuery = encodeURIComponent(
    `"${lead.company_name}" ${lead.city} ${lead.state} estimator OR "project manager" email phone`.trim(),
  );
  const publicLookupUrl = `https://www.google.com/search?q=${lookupQuery}`;

  const applyPatchWithRescore = (patch: Partial<Lead>) => {
    const merged: Lead = { ...lead, ...patch };
    const { url, domain } = normalizeWebsite(merged.website);
    const { formatted, digits } = normalizePhone(merged.business_phone);
    merged.website = url;
    merged.domain = domain;
    merged.business_phone = formatted;
    merged.phone_digits = digits;

    const rescored = scoreLead(merged, scoringConfig);
    onUpdateLead(lead.id, {
      ...patch,
      website: merged.website,
      domain: merged.domain,
      business_phone: merged.business_phone,
      phone_digits: merged.phone_digits,
      lead_score: rescored.score,
      score_breakdown: rescored.breakdown,
      lead_tier: rescored.tier,
      confidence_level: rescored.confidence,
      qualification_reason: rescored.reason,
    });
  };

  const handleResearchWebsite = async () => {
    const targetInput = websiteDraft.trim() || websiteUrl;
    if (!targetInput) return;
    const { url: cleanSite } = normalizeWebsite(targetInput);
    if (!cleanSite) {
      setResearchMessage('Enter a valid company website domain (e.g. company.com).');
      return;
    }

    setResearching(true);
    setResearchMessage('');
    try {
      const resp = await fetch('/api/research/website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanSite }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setResearchMessage(data.error || 'Could not inspect website.');
      } else {
        const patch: Partial<Lead> = {
          website: cleanSite,
          last_verified: new Date().toISOString().slice(0, 19) + 'Z',
        };
        if (data.email && !lead.business_email) patch.business_email = data.email;
        if (data.phone && !lead.business_phone) patch.business_phone = data.phone;
        if (data.contact_person && !lead.contact_person) patch.contact_person = data.contact_person;
        if (data.job_title && !lead.job_title) patch.job_title = data.job_title;
        if (data.services && !lead.services_offered) patch.services_offered = data.services;

        applyPatchWithRescore(patch);
        setDiscovered({
          emails: Array.isArray(data.emails) ? data.emails : [],
          phones: Array.isArray(data.phones) ? data.phones : [],
          contacts: Array.isArray(data.contacts) ? data.contacts : [],
          pages_checked: Number(data.pages_checked || 1),
        });
        setResearchMessage(
          `Checked ${data.pages_checked || 1} public page(s): found ${data.emails?.length || 0} email(s), ${data.phones?.length || 0} phone(s), ${data.contacts?.length || 0} contact(s).`,
        );
        onContactLookupComplete?.({
          phonesFound: data.phones?.length ? 1 : 0,
          emailsFound: data.emails?.length ? 1 : 0,
        });
      }
    } catch {
      setResearchMessage('Network error while checking company website.');
    } finally {
      setResearching(false);
    }
  };

  return (
    <aside
      aria-label="Lead details"
      className="w-full lg:w-[420px] xl:w-[450px] shrink-0 bg-white border border-slate-200 rounded-lg flex flex-col max-h-[calc(100vh-140px)] overflow-y-auto"
    >
      <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span
              className={
                lead.lead_tier === 'Warm'
                  ? 'font-semibold text-amber-700'
                  : lead.lead_tier === 'Potential'
                    ? 'font-semibold text-slate-800'
                    : 'font-medium text-slate-500'
              }
            >
              {lead.lead_tier} Lead
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular font-semibold text-slate-900">
              {lead.lead_score}/100
            </span>
            <span aria-hidden="true">·</span>
            <span>{lead.confidence_level} Confidence</span>
          </div>
          <h2 className="text-base font-semibold text-slate-900 leading-snug">
            {lead.company_name}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {lead.company_category || 'Construction Contractor'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close lead details"
          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-6 text-sm">
        {/* Project Contact & Decision-Maker */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-500">Project Contact & Reachability</h3>
            <a
              href={publicLookupUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
            >
              <Search className="w-3 h-3" />
              Find Website / Estimator
            </a>
          </div>

          <div className="space-y-2 text-xs text-slate-700">
            <div className="flex items-center gap-2">
              <UserCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>
                {lead.contact_person ? (
                  <>
                    <strong className="text-slate-900">{lead.contact_person}</strong>
                    {lead.job_title ? ` · ${lead.job_title}` : ''}
                  </>
                ) : (
                  <span className="text-slate-500">Contact person not listed yet</span>
                )}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>
                {[lead.city, lead.state, lead.zip_code].filter(Boolean).join(', ') || 'Location not listed'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <div>
                <label htmlFor="detail-phone" className="block text-[11px] text-slate-500 mb-1">
                  Phone Number
                </label>
                <div className="relative">
                  <Phone className="w-3 h-3 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="detail-phone"
                    type="text"
                    value={lead.business_phone}
                    onChange={(e) => applyPatchWithRescore({ business_phone: e.target.value })}
                    placeholder="(555) 123-4567"
                    className="w-full h-8 pl-7 pr-2 text-xs font-mono-tabular bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="detail-email" className="block text-[11px] text-slate-500 mb-1">
                  Contact / Estimating Email
                </label>
                <div className="relative">
                  <Mail className="w-3 h-3 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="detail-email"
                    type="email"
                    value={lead.business_email}
                    onChange={(e) => applyPatchWithRescore({ business_email: e.target.value.trim().toLowerCase() })}
                    placeholder="bids@company.com"
                    className="w-full h-8 pl-7 pr-2 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>
            </div>

            {/* Website Input + Multi-Page Contact Extractor */}
            <div className="pt-1">
              <label htmlFor="detail-website" className="block text-[11px] text-slate-500 mb-1">
                Company Website (paste URL to scan /contact, /team & /estimating)
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Globe className="w-3 h-3 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="detail-website"
                    type="text"
                    value={websiteDraft}
                    onChange={(e) => setWebsiteDraft(e.target.value)}
                    onBlur={() => {
                      if (websiteDraft.trim() !== lead.website) {
                        applyPatchWithRescore({ website: websiteDraft.trim() });
                      }
                    }}
                    placeholder="https://company-website.com"
                    className="w-full h-8 pl-7 pr-2 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleResearchWebsite}
                  disabled={researching || !websiteDraft.trim()}
                  className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0 transition-colors disabled:opacity-40"
                >
                  <RefreshCw className={`w-3 h-3 ${researching ? 'animate-spin' : ''}`} />
                  {researching ? 'Scanning...' : 'Find Contacts'}
                </button>
              </div>
            </div>

            {researchMessage && (
              <p className="text-[11px] text-slate-600 pt-0.5">{researchMessage}</p>
            )}

            {/* Quick-Apply Discovered Contacts from Public Pages */}
            {discovered && (discovered.contacts.length > 0 || discovered.emails.length > 0 || discovered.phones.length > 0) && (
              <div className="pt-2 space-y-2 border-t border-slate-100">
                {discovered.contacts.length > 0 && (
                  <div>
                    <div className="text-[11px] font-medium text-slate-500 mb-1">
                      Decision-Makers Found (click to apply):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {discovered.contacts.map((c) => (
                        <button
                          key={`${c.name}-${c.title}`}
                          type="button"
                          onClick={() =>
                            applyPatchWithRescore({ contact_person: c.name, job_title: c.title })
                          }
                          className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-800 rounded text-left"
                        >
                          {c.name} · {c.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {discovered.emails.length > 0 && (
                  <div>
                    <div className="text-[11px] font-medium text-slate-500 mb-1">
                      Public Emails Found (click to apply):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {discovered.emails.map((em) => (
                        <button
                          key={em}
                          type="button"
                          onClick={() => applyPatchWithRescore({ business_email: em })}
                          className="px-2 py-1 text-[11px] font-mono-tabular bg-slate-100 hover:bg-slate-200 text-slate-800 rounded"
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {discovered.phones.length > 0 && (
                  <div>
                    <div className="text-[11px] font-medium text-slate-500 mb-1">
                      Public Phones Found (click to apply):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {discovered.phones.map((ph) => (
                        <button
                          key={ph}
                          type="button"
                          onClick={() => applyPatchWithRescore({ business_phone: ph })}
                          className="px-2 py-1 text-[11px] font-mono-tabular bg-slate-100 hover:bg-slate-200 text-slate-800 rounded"
                        >
                          {ph}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="border-t border-slate-100" />

        {/* Service Match & Live Project Scope */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-500">Live / Won Project & Service Match</h3>
          <div className="text-xs text-slate-700 space-y-1.5">
            <p>
              <span className="text-slate-500">Target Service:</span>{' '}
              <span className="font-semibold text-slate-900">
                {lead.service_opportunity || 'Construction Estimation'}
              </span>
            </p>
            <p>
              <span className="text-slate-500">Project:</span>{' '}
              <span className="font-medium text-slate-900">
                {lead.project_name || 'Company Profile Only'}
              </span>
              {lead.project_status ? ` · ${lead.project_status}` : ''}
            </p>
            {lead.project_location && (
              <p>
                <span className="text-slate-500">Project Site:</span> {lead.project_location}
              </p>
            )}
            {lead.project_description && (
              <p className="text-slate-600 leading-relaxed pt-1">{lead.project_description}</p>
            )}
          </div>
        </section>

        <div className="border-t border-slate-100" />

        {/* Evidence & Source Links */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-500">Buying-Intent Evidence & Sources</h3>
          <p className="text-xs text-slate-700 leading-relaxed">
            {lead.buying_intent_evidence || 'No buying-intent evidence recorded yet.'}
          </p>
          <p className="text-xs text-slate-500">
            Sources: {lead.all_sources.join(' · ')}
          </p>
          <div className="flex flex-wrap items-center gap-4 pt-1 text-xs">
            {projectUrl && (
              <a
                href={projectUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap"
              >
                Project Source <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {companyUrl && companyUrl !== projectUrl && (
              <a
                href={companyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline whitespace-nowrap"
              >
                Company Source <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </section>

        <div className="border-t border-slate-100" />

        {/* Explainable 0-100 Score Breakdown */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-500">Score Breakdown</h3>
            <span className="font-mono-tabular text-xs font-semibold text-slate-900">
              {lead.lead_score} / 100
            </span>
          </div>
          <div className="space-y-2">
            {lead.score_breakdown.map((factor) => {
              const pct = factor.maxPoints > 0 ? Math.round((factor.points / factor.maxPoints) * 100) : 0;
              return (
                <div key={factor.label} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">{factor.label}</span>
                    <span className="font-mono-tabular text-slate-600">
                      {factor.points}/{factor.maxPoints}
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-slate-100 rounded-sm overflow-hidden">
                    <div className="h-full bg-slate-900" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-500">{factor.reason}</p>
                </div>
              );
            })}
          </div>
        </section>

        <div className="border-t border-slate-100" />

        {/* Outreach Status & Notes */}
        <section className="space-y-3">
          <div>
            <label
              htmlFor="lead-outreach-status"
              className="block text-xs font-semibold text-slate-500 mb-1.5"
            >
              Outreach Status
            </label>
            <select
              id="lead-outreach-status"
              value={lead.outreach_status}
              onChange={(e) =>
                onUpdateLead(lead.id, { outreach_status: e.target.value as OutreachStatus })
              }
              className="w-full h-9 px-2.5 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              {OUTREACH_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="lead-notes"
              className="block text-xs font-semibold text-slate-500 mb-1.5"
            >
              Sales Notes
            </label>
            <textarea
              id="lead-notes"
              rows={3}
              value={lead.notes}
              onChange={(e) => onUpdateLead(lead.id, { notes: e.target.value })}
              placeholder="Add bid follow-up dates, estimator contact, or takeoff notes..."
              className="w-full p-2.5 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>
        </section>
      </div>
    </aside>
  );
}
