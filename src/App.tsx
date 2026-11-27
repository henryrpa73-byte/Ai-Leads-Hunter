import {
  BarChart3,
  Bot,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Flame,
  FolderUp,
  GitMerge,
  MessageSquare,
  PhoneCall,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutomatedScoringEngine } from './components/AutomatedScoringEngine.tsx';
import { CrmSyncModal } from './components/CrmSyncModal.tsx';
import { DailyQuotaTracker } from './components/DailyQuotaTracker.tsx';
import { DailyReportView } from './components/DailyReportView.tsx';
import { DiscoveryJobsPanel } from './components/DiscoveryJobsPanel.tsx';
import { DuplicatesReviewView } from './components/DuplicatesReviewView.tsx';
import { LeadDetailPanel } from './components/LeadDetailPanel.tsx';
import { OllamaSettingsModal } from './components/OllamaSettingsModal.tsx';
import {
  createDefaultQuota,
  type DailyQuotaState,
  getTodayDateKey,
  loadDailyQuota,
  saveDailyQuota,
} from './lib/dailyQuota.ts';
import {
  buildNormalizedLead,
  DEFAULT_SCORING_CONFIG,
  DEFAULT_ZOOM_SMS_TEMPLATE,
  getSmsReadyLeads,
  isHighIntentTier,
  leadsToCsv,
  leadsToExcelBuffer,
  leadsToZoomSmsCsv,
  mergeLeadsDeduplicated,
  normalizePhone,
  parseCsvToLeads,
  parseExcelToLeads,
  rescoreAllLeads,
  safeExternalUrl,
  type ScoringCriteriaConfig,
} from './lib/leadEngine.ts';
import {
  clearSeenHistory,
  filterFreshLeads,
  loadSeenHistory,
  recordSeenLeads,
  saveSeenHistory,
  type SeenHistoryState,
} from './lib/seenHistory.ts';
import { COMPANY_CATEGORIES, CONSTRUCTION_TRADES, PROJECT_TYPES } from './lib/trades.ts';
import {
  type DashboardDbStats,
  type DiscoveryResponse,
  type Lead,
  type LeadTier,
  OUTREACH_STATUSES,
  SUPPRESSED_OUTREACH_STATUSES,
} from './types/lead.ts';

type NavTab = 'pipeline' | 'warm' | 'duplicates' | 'report';
type SourceOption = 'all' | 'usaspending' | 'permits';

const STORAGE_KEY = 'ai_leads_hunter_records_v1';
const SCORING_CONFIG_KEY = 'ai_leads_hunter_scoring_config_v1';
const SMS_TEMPLATE_KEY = 'ai_leads_hunter_sms_template_v1';

const US_STATE_OPTIONS: Array<[string, string]> = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
];

export default function App() {
  const [leads, setLeads] = useState<Lead[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? (JSON.parse(saved) as Lead[]) : [];
    } catch {
      return [];
    }
  });
  const [dbStats, setDbStats] = useState<DashboardDbStats | null>(null);
  const [dbSeenPhonesCount, setDbSeenPhonesCount] = useState<number>(0);

  const [activeTab, setActiveTab] = useState<NavTab>('pipeline');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set());
  const [crmModalOpen, setCrmModalOpen] = useState(false);
  const [ollamaModalOpen, setOllamaModalOpen] = useState(false);
  const [ollamaStatusLabel, setOllamaStatusLabel] = useState<string>('Local Rules');

  // Primary & Advanced Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [tierFilter, setTierFilter] = useState<'ALL' | LeadTier>('ALL');
  const [serviceFilter, setServiceFilter] = useState<string>('ALL');
  const [tradeFilter, setTradeFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [projectTypeFilter, setProjectTypeFilter] = useState<string>('ALL');
  const [outreachFilter, setOutreachFilter] = useState<string>('ALL');
  const [sourceFilter, setSourceFilter] = useState<string>('ALL');
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const [cityFilter, setCityFilter] = useState('');
  const [zipFilter, setZipFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [minScore, setMinScore] = useState<number>(0);
  const [liveProjectsOnly, setLiveProjectsOnly] = useState(false);
  const [hasContactOnly, setHasContactOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  // Pagination
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Live discovery controls
  const [huntSource, setHuntSource] = useState<SourceOption>('all');
  const [huntState, setHuntState] = useState('');
  const [huntLimit, setHuntLimit] = useState<number>(3);
  const [huntPage, setHuntPage] = useState<number>(1);
  const [smsPhonePriority, setSmsPhonePriority] = useState<boolean>(false);
  const [autoFindContacts, setAutoFindContacts] = useState<boolean>(true);
  const [freshOnly, setFreshOnly] = useState<boolean>(true);
  const [hunting, setHunting] = useState(false);
  const [enrichingContacts, setEnrichingContacts] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{ type: 'info' | 'error'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmResetSeen, setConfirmResetSeen] = useState(false);
  const [dailyQuota, setDailyQuota] = useState<DailyQuotaState>(() => loadDailyQuota());
  const [seenHistory, setSeenHistory] = useState<SeenHistoryState>(() =>
    recordSeenLeads(loadSeenHistory(), leads),
  );
  const [smsTemplate, setSmsTemplate] = useState<string>(() => {
    try {
      return localStorage.getItem(SMS_TEMPLATE_KEY) || DEFAULT_ZOOM_SMS_TEMPLATE;
    } catch {
      return DEFAULT_ZOOM_SMS_TEMPLATE;
    }
  });
  const [copiedSms, setCopiedSms] = useState(false);
  const [scoringConfig, setScoringConfig] = useState<ScoringCriteriaConfig>(() => {
    try {
      const saved = localStorage.getItem(SCORING_CONFIG_KEY);
      return saved ? { ...DEFAULT_SCORING_CONFIG, ...(JSON.parse(saved) as Partial<ScoringCriteriaConfig>) } : DEFAULT_SCORING_CONFIG;
    } catch {
      return DEFAULT_SCORING_CONFIG;
    }
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hydratedRef = useRef(false);

  const refreshFromDb = useCallback(async () => {
    try {
      const resp = await fetch('/api/leads');
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        leads?: Lead[];
        stats?: DashboardDbStats;
        scoringConfig?: ScoringCriteriaConfig;
        seenPhonesCount?: number;
      };
      if (Array.isArray(data.leads) && data.leads.length > 0) {
        setLeads(data.leads);
        setSeenHistory((prev) => recordSeenLeads(prev, data.leads!));
      }
      if (data.stats) setDbStats(data.stats);
      if (typeof data.seenPhonesCount === 'number') setDbSeenPhonesCount(data.seenPhonesCount);
      if (data.scoringConfig) setScoringConfig((prev) => ({ ...prev, ...data.scoringConfig }));
    } catch {
      // Offline fallback keeps local state intact
    }
  }, []);

  // Hydrate persistent SQLite database + Ollama status on mount
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    (async () => {
      try {
        const resp = await fetch('/api/leads');
        if (resp.ok) {
          const data = (await resp.json()) as {
            leads?: Lead[];
            stats?: DashboardDbStats;
            scoringConfig?: ScoringCriteriaConfig;
            seenPhonesCount?: number;
          };
          const dbLeads = Array.isArray(data.leads) ? data.leads : [];
          if (dbLeads.length > 0) {
            setLeads(dbLeads);
            setSeenHistory((prev) => recordSeenLeads(prev, dbLeads));
            if (data.stats) setDbStats(data.stats);
            if (typeof data.seenPhonesCount === 'number') setDbSeenPhonesCount(data.seenPhonesCount);
            if (data.scoringConfig) setScoringConfig((prev) => ({ ...prev, ...data.scoringConfig }));
          } else {
            // Migrate any pre-existing browser leads once into SQLite
            let localSeed: Lead[] = [];
            try {
              const saved = localStorage.getItem(STORAGE_KEY);
              localSeed = saved ? (JSON.parse(saved) as Lead[]) : [];
            } catch {
              localSeed = [];
            }
            if (localSeed.length > 0) {
              const imp = await fetch('/api/leads/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leads: localSeed, checkCrossSession: false }),
              });
              if (imp.ok) {
                await refreshFromDb();
              }
            } else {
              if (data.stats) setDbStats(data.stats);
              if (typeof data.seenPhonesCount === 'number') setDbSeenPhonesCount(data.seenPhonesCount);
            }
          }
        }
      } catch {
        // Keep localStorage cache if backend unreachable
      }

      try {
        const aiResp = await fetch('/api/ai/ollama/status');
        if (aiResp.ok) {
          const aiData = await aiResp.json();
          if (aiData.settings?.enabled && aiData.reachable) {
            setOllamaStatusLabel(`Ollama: ${aiData.settings.model || 'Ready'}`);
          } else if (aiData.settings?.enabled) {
            setOllamaStatusLabel('Ollama: Offline');
          } else {
            setOllamaStatusLabel('Local Rules');
          }
        }
      } catch {
        // Ignore
      }
    })();
  }, [refreshFromDb]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(leads));
    } catch {
      // Ignore storage quota warnings
    }
  }, [leads]);

  useEffect(() => {
    saveDailyQuota(dailyQuota);
  }, [dailyQuota]);

  useEffect(() => {
    saveSeenHistory(seenHistory);
  }, [seenHistory]);

  useEffect(() => {
    try {
      localStorage.setItem(SMS_TEMPLATE_KEY, smsTemplate);
    } catch {
      // Ignore storage quota warnings
    }
  }, [smsTemplate]);

  useEffect(() => {
    try {
      localStorage.setItem(SCORING_CONFIG_KEY, JSON.stringify(scoringConfig));
    } catch {
      // Ignore storage quota warnings
    }
  }, [scoringConfig]);

  const blockedPhoneCount = Math.max(dbSeenPhonesCount, seenHistory.phones.length);

  const handleApplyScoring = async (nextConfig: ScoringCriteriaConfig) => {
    setScoringConfig(nextConfig);
    const rescored = rescoreAllLeads(leads, nextConfig);
    setLeads(rescored);

    const hotCount = rescored.filter((l) => l.lead_tier === 'Hot').length;
    const warmCount = rescored.filter((l) => l.lead_tier === 'Warm').length;
    const potentialCount = rescored.filter((l) => l.lead_tier === 'Potential').length;
    setBannerMessage({
      type: 'info',
      text: `Auto-scored ${rescored.length} leads: ${hotCount} Hot (${nextConfig.hotThreshold ?? 80}+), ${warmCount} Warm (${nextConfig.warmThreshold}+), ${potentialCount} Potential.`,
    });

    try {
      const resp = await fetch('/api/leads/rescore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: nextConfig }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.stats) setDbStats(data.stats);
      }
    } catch {
      // Local rescore already applied
    }
  };

  const recordDiscoveryUsage = (discoveredLeads: Lead[]) => {
    const today = getTodayDateKey();
    const usaCount = discoveredLeads.filter((l) => l.source_name === 'USASpending.gov').length;
    const permitCount = discoveredLeads.length - usaCount;

    setDailyQuota((prev) => {
      const base = prev.date === today ? prev : createDefaultQuota(prev.discoveryLimit, prev.contactLimit);
      return {
        ...base,
        discoveryLeadsToday: base.discoveryLeadsToday + discoveredLeads.length,
        usaspendingLeadsToday: base.usaspendingLeadsToday + usaCount,
        permitLeadsToday: base.permitLeadsToday + permitCount,
        runsToday: base.runsToday + 1,
      };
    });
  };

  const recordContactUsage = (checks: number, phonesFound: number, emailsFound: number) => {
    const today = getTodayDateKey();
    setDailyQuota((prev) => {
      const base = prev.date === today ? prev : createDefaultQuota(prev.discoveryLimit, prev.contactLimit);
      return {
        ...base,
        contactChecksToday: base.contactChecksToday + checks,
        phonesFoundToday: base.phonesFoundToday + phonesFound,
        emailsFoundToday: base.emailsFoundToday + emailsFound,
      };
    });
  };

  const availableStates = useMemo(() => {
    const set = new Set<string>();
    leads.forEach((l) => {
      if (l.state) set.add(l.state);
    });
    return Array.from(set).sort();
  }, [leads]);

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    leads.forEach((l) => {
      if (l.source_name) set.add(l.source_name);
      l.all_sources?.forEach((s) => {
        if (s) set.add(s);
      });
    });
    return Array.from(set).sort();
  }, [leads]);

  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const cFilter = cityFilter.trim().toLowerCase();
    const zFilter = zipFilter.trim().toLowerCase();
    const dFilter = dateFilter.trim();

    return leads.filter((lead) => {
      if (activeTab === 'warm' && !isHighIntentTier(lead.lead_tier)) return false;
      if (activeTab === 'pipeline' && tierFilter !== 'ALL' && lead.lead_tier !== tierFilter) return false;
      if (serviceFilter !== 'ALL' && lead.service_opportunity !== serviceFilter) return false;
      if (tradeFilter !== 'ALL' && lead.construction_trade !== tradeFilter) return false;
      if (categoryFilter !== 'ALL' && lead.company_category !== categoryFilter) return false;
      if (projectTypeFilter !== 'ALL' && lead.project_type !== projectTypeFilter) return false;
      if (outreachFilter !== 'ALL' && lead.outreach_status !== outreachFilter) return false;
      if (
        sourceFilter !== 'ALL' &&
        lead.source_name !== sourceFilter &&
        !(lead.all_sources || []).includes(sourceFilter)
      ) {
        return false;
      }
      if (stateFilter !== 'ALL' && lead.state !== stateFilter) return false;
      if (cFilter && !lead.city.toLowerCase().includes(cFilter)) return false;
      if (zFilter && !lead.zip_code.toLowerCase().includes(zFilter)) return false;
      if (dFilter && !lead.date_discovered.startsWith(dFilter)) return false;
      if (lead.lead_score < minScore) return false;
      if (liveProjectsOnly) {
        const st = `${lead.project_status} ${lead.project_name}`.toLowerCase();
        if (!/(live|won|active|issued|awarded|solicitation|open)/.test(st)) return false;
      }
      if (hasContactOnly && !lead.business_phone && !lead.business_email) {
        return false;
      }
      if (
        verifiedOnly &&
        lead.website_status !== 'Verified' &&
        lead.confidence_level !== 'Verified' &&
        lead.confidence_level !== 'High'
      ) {
        return false;
      }
      if (!q) return true;
      return (
        lead.company_name.toLowerCase().includes(q) ||
        lead.construction_trade.toLowerCase().includes(q) ||
        lead.contact_person.toLowerCase().includes(q) ||
        lead.business_phone.toLowerCase().includes(q) ||
        lead.business_email.toLowerCase().includes(q) ||
        lead.city.toLowerCase().includes(q) ||
        lead.state.toLowerCase().includes(q) ||
        lead.zip_code.toLowerCase().includes(q) ||
        lead.project_name.toLowerCase().includes(q) ||
        lead.project_description.toLowerCase().includes(q) ||
        lead.buying_intent_evidence.toLowerCase().includes(q)
      );
    });
  }, [
    leads,
    activeTab,
    tierFilter,
    serviceFilter,
    tradeFilter,
    categoryFilter,
    projectTypeFilter,
    outreachFilter,
    sourceFilter,
    stateFilter,
    cityFilter,
    zipFilter,
    dateFilter,
    minScore,
    liveProjectsOnly,
    hasContactOnly,
    verifiedOnly,
    searchQuery,
  ]);

  // Reset pagination when filters change
  useEffect(() => {
    setPage(1);
  }, [
    activeTab,
    searchQuery,
    tierFilter,
    serviceFilter,
    tradeFilter,
    categoryFilter,
    projectTypeFilter,
    outreachFilter,
    sourceFilter,
    stateFilter,
    cityFilter,
    zipFilter,
    dateFilter,
    minScore,
    liveProjectsOnly,
    hasContactOnly,
    verifiedOnly,
    pageSize,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedLeads = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredLeads.slice(start, start + pageSize);
  }, [filteredLeads, safePage, pageSize]);

  const selectedLead = useMemo(
    () => leads.find((l) => l.id === selectedLeadId) || null,
    [leads, selectedLeadId],
  );

  const stats = useMemo(() => {
    const hot = leads.filter((l) => l.lead_tier === 'Hot').length;
    const warm = leads.filter((l) => l.lead_tier === 'Warm').length;
    const potential = leads.filter((l) => l.lead_tier === 'Potential').length;
    const verified = leads.filter(
      (l) => l.website_status === 'Verified' || l.confidence_level === 'Verified',
    ).length;
    const avgScore = leads.length
      ? Math.round(leads.reduce((sum, l) => sum + l.lead_score, 0) / leads.length)
      : 0;
    return {
      total: leads.length,
      hot,
      warm,
      highIntent: hot + warm,
      potential,
      verified,
      avgScore,
      duplicates: dbStats?.duplicateCount ?? 0,
    };
  }, [leads, dbStats]);

  const smsReadyFiltered = useMemo(() => getSmsReadyLeads(filteredLeads), [filteredLeads]);
  const suppressedFilteredCount = useMemo(
    () =>
      filteredLeads.filter(
        (l) => l.phone_digits.length === 10 && SUPPRESSED_OUTREACH_STATUSES.has(l.outreach_status),
      ).length,
    [filteredLeads],
  );

  const highIntentLeadsFiltered = useMemo(
    () => filteredLeads.filter((l) => isHighIntentTier(l.lead_tier)),
    [filteredLeads],
  );

  const selectedLeadsForCrm = useMemo(
    () => leads.filter((l) => selectedLeadIds.has(l.id)),
    [leads, selectedLeadIds],
  );

  const allPageSelected = useMemo(
    () => paginatedLeads.length > 0 && paginatedLeads.every((l) => selectedLeadIds.has(l.id)),
    [paginatedLeads, selectedLeadIds],
  );

  const crmSyncCount =
    selectedLeadsForCrm.length > 0 ? selectedLeadsForCrm.length : highIntentLeadsFiltered.length;

  const enrichLeadsContacts = async (targetLeads: Lead[], prefixMessage = '') => {
    const candidates = targetLeads.filter(
      (l) => !l.business_email || !l.business_phone || !l.website || !l.project_name || !l.city,
    );
    if (candidates.length === 0) return { enriched: 0, phones: 0, emails: 0, websites: 0, projects: 0 };

    setEnrichingContacts(true);
    let totalEnriched = 0;
    let totalPhones = 0;
    let totalEmails = 0;
    let totalWebsites = 0;
    let totalProjects = 0;
    const chunkSize = 8;

    try {
      for (let i = 0; i < candidates.length; i += chunkSize) {
        const chunk = candidates.slice(i, i + chunkSize);
        setBannerMessage({
          type: 'info',
          text: `${prefixMessage}Finding websites, emails & live projects (${Math.min(i + chunk.length, candidates.length)}/${candidates.length} leads)...`,
        });

        const resp = await fetch('/api/research/batch-contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leads: chunk.map((l) => ({
              id: l.id,
              company_name: l.company_name,
              website: l.website,
              city: l.city,
              state: l.state,
              needs_project: !l.project_name,
            })),
          }),
        });
        if (!resp.ok) continue;

        const payload = (await resp.json()) as {
          results?: Array<{
            id: string;
            website: string;
            website_status?: Lead['website_status'];
            email: string;
            email_status?: Lead['email_status'];
            phone: string;
            phone_status?: Lead['phone_status'];
            contact_person: string;
            job_title: string;
            contact_status?: Lead['contact_status'];
            contact_source_url?: string;
            services: string;
            city?: string;
            state?: string;
            zip_code?: string;
            company_category?: string;
            project_name?: string;
            project_description?: string;
            project_location?: string;
            project_status?: string;
            project_source_url?: string;
            buying_intent_evidence?: string;
          }>;
        };

        const byId = new Map((payload.results || []).map((r) => [r.id, r]));
        const updatedLeadsToPersist: Lead[] = [];

        setLeads((prev) =>
          prev
            .map((lead) => {
              const patch = byId.get(lead.id);
              if (!patch) return lead;
              const hasNew =
                (!lead.website && patch.website) ||
                (!lead.business_email && patch.email) ||
                (!lead.business_phone && patch.phone) ||
                (!lead.contact_person && patch.contact_person) ||
                (!lead.city && patch.city) ||
                (!lead.project_name && patch.project_name) ||
                (!lead.services_offered && patch.services);
              if (!hasNew) return lead;

              const updated = buildNormalizedLead(
                {
                  ...lead,
                  website: lead.website || patch.website,
                  website_status: patch.website_status || lead.website_status,
                  business_email: lead.business_email || patch.email,
                  email_status: patch.email ? patch.email_status || 'Publicly Listed' : lead.email_status,
                  business_phone: lead.business_phone || patch.phone,
                  phone_status: patch.phone ? patch.phone_status || 'Publicly Listed' : lead.phone_status,
                  contact_person: lead.contact_person || patch.contact_person,
                  job_title: lead.job_title || patch.job_title,
                  contact_status: patch.contact_person
                    ? patch.contact_status || 'Publicly Listed'
                    : lead.contact_status,
                  contact_source_url: lead.contact_source_url || patch.contact_source_url || '',
                  city: lead.city || patch.city || '',
                  state: (!lead.city && patch.state) ? patch.state : lead.state || patch.state || '',
                  zip_code: lead.zip_code || patch.zip_code || '',
                  company_category: lead.company_category || patch.company_category || '',
                  services_offered: lead.services_offered || patch.services,
                  project_name: lead.project_name || patch.project_name || '',
                  project_description: lead.project_description || patch.project_description || '',
                  project_location: lead.project_location || patch.project_location || '',
                  project_status: lead.project_status || patch.project_status || '',
                  project_source_url: lead.project_source_url || patch.project_source_url || '',
                  company_source_url: lead.company_source_url || patch.project_source_url || '',
                  buying_intent_evidence: lead.buying_intent_evidence || patch.buying_intent_evidence || '',
                  lead_score: 0,
                  lead_tier: undefined,
                  qualification_reason: '',
                  confidence_level: undefined,
                  last_verified: new Date().toISOString().slice(0, 19) + 'Z',
                },
                scoringConfig,
              );
              updatedLeadsToPersist.push(updated);
              return updated;
            })
            .sort((a, b) => b.lead_score - a.lead_score),
        );

        if (updatedLeadsToPersist.length > 0) {
          fetch('/api/leads/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leads: updatedLeadsToPersist, checkCrossSession: false }),
          }).catch(() => {});
        }

        let chunkPhones = 0;
        let chunkEmails = 0;
        const enrichedForHistory: Lead[] = [];
        for (const r of payload.results || []) {
          if (r.website || r.email || r.phone || r.contact_person || r.project_name || r.city) {
            totalEnriched += 1;
          }
          if (r.website) totalWebsites += 1;
          if (r.project_name) totalProjects += 1;
          if (r.phone || r.email) {
            const orig = chunk.find((c) => c.id === r.id);
            const norm = r.phone ? normalizePhone(r.phone) : { digits: '' };
            if (r.phone) {
              totalPhones += 1;
              chunkPhones += 1;
            }
            if (r.email) {
              totalEmails += 1;
              chunkEmails += 1;
            }
            if (orig && (norm.digits || r.email)) {
              enrichedForHistory.push({
                ...orig,
                phone_digits: norm.digits || orig.phone_digits,
                business_email: r.email || orig.business_email,
              });
            }
          }
        }
        if (enrichedForHistory.length > 0) {
          setSeenHistory((prev) => recordSeenLeads(prev, enrichedForHistory));
        }
        recordContactUsage(chunk.length, chunkPhones, chunkEmails);
      }
    } finally {
      setEnrichingContacts(false);
    }

    return {
      enriched: totalEnriched,
      phones: totalPhones,
      emails: totalEmails,
      websites: totalWebsites,
      projects: totalProjects,
    };
  };

  const handleHuntLive = async () => {
    setHunting(true);
    setBannerMessage({
      type: 'info',
      text: `Step 1/2: Discovering US construction & design projects (page ${huntPage})...`,
    });
    try {
      const resp = await fetch('/api/discover/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: huntSource,
          state: huntState.trim().toUpperCase(),
          trade: tradeFilter,
          limit: huntLimit,
          page: huntPage,
          smsPhonePriority,
          freshOnly,
          excludePhones: freshOnly ? seenHistory.phones : [],
          excludeKeys: freshOnly ? [...seenHistory.keys, ...seenHistory.domains] : [],
        }),
      });
      const data = (await resp.json()) as DiscoveryResponse & { error?: string };
      if (!resp.ok) {
        setBannerMessage({ type: 'error', text: data.error || 'Live lead discovery failed.' });
        return;
      }

      const rawDiscovered = rescoreAllLeads(data.leads || [], scoringConfig);
      const { fresh: freshLeads, skippedDuplicates: clientSkipped } = freshOnly
        ? filterFreshLeads(rawDiscovered, seenHistory, leads)
        : { fresh: rawDiscovered, skippedDuplicates: 0 };
      const totalSkipped = (data.summary.skippedDuplicates || 0) + clientSkipped;

      if (typeof data.summary.nextPage === 'number' && data.summary.nextPage > 0) {
        setHuntPage(data.summary.nextPage);
      } else {
        setHuntPage((p) => p + 1);
      }

      if (freshLeads.length === 0) {
        const warnDetails = data.summary.warnings.length
          ? data.summary.warnings.join(' ')
          : totalSkipped > 0
            ? `All ${totalSkipped} returned records matched phones or companies already delivered to you. Switch US State or source to pull new territories.`
            : 'No matching projects were returned for those filters. Try switching US State or Public Data Source.';
        if (totalSkipped === 0) setHuntPage(1);
        setBannerMessage({
          type: 'error',
          text: warnDetails,
        });
        return;
      }

      const { merged, addedCount, duplicateCount, crossSessionBlockedCount } = mergeLeadsDeduplicated(
        leads,
        freshLeads,
        { checkCrossSession: freshOnly },
      );
      recordDiscoveryUsage(freshLeads);
      setSeenHistory((prev) => recordSeenLeads(prev, freshLeads));
      setLeads(merged);
      if (!selectedLeadId && merged.length > 0) {
        setSelectedLeadId(merged[0].id);
      }

      const smsInBatch = getSmsReadyLeads(freshLeads).length;
      const warnText = data.summary.warnings.length ? ` (${data.summary.warnings.join('; ')})` : '';
      const allSkipped = totalSkipped + crossSessionBlockedCount;
      const skippedText = allSkipped > 0 ? `, ${allSkipped} repeat phones/emails skipped` : '';
      const step1Summary = `Found ${addedCount} fresh leads (${duplicateCount} merged${skippedText}, ${smsInBatch} SMS-ready phones).`;

      if (autoFindContacts && freshLeads.length > 0) {
        setHunting(false);
        const enrichBatch =
          freshLeads.length > 40
            ? freshLeads.filter((l) => !l.phone_digits).slice(0, 24)
            : freshLeads;
        const contactRes = await enrichLeadsContacts(enrichBatch, `Step 2/2: ${step1Summary} `);
        setBannerMessage({
          type: 'info',
          text: `${step1Summary} Enriched ${contactRes.enriched} extra leads (${contactRes.phones} phones, ${contactRes.emails} emails). Saved to SQLite & ready for export.${warnText}`,
        });
      } else {
        setBannerMessage({
          type: 'info',
          text: `${step1Summary} Saved to SQLite & ready for Zoom SMS CSV or Excel export.${warnText}`,
        });
      }
      await refreshFromDb();
    } catch {
      setBannerMessage({
        type: 'error',
        text: 'Could not reach the local discovery server. Try again in a moment.',
      });
    } finally {
      setHunting(false);
    }
  };

  const handleEnrichMissingContacts = async () => {
    const missing = filteredLeads.filter(
      (l) => !l.business_email || !l.business_phone || !l.website || !l.project_name || !l.city,
    );
    if (missing.length === 0) {
      setBannerMessage({ type: 'info', text: 'All visible leads already have website, contact, and project details.' });
      return;
    }
    const res = await enrichLeadsContacts(missing.slice(0, 100), 'Batch enrichment: ');
    await refreshFromDb();
    setBannerMessage({
      type: 'info',
      text: `Enrichment finished: updated ${res.enriched} leads (${res.websites} websites, ${res.emails} emails, ${res.phones} phones, ${res.projects} live/won projects).`,
    });
  };

  const handleCsvUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const lowerName = file.name.toLowerCase();
      let parsed: Lead[] = [];
      if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xlsm')) {
        const buffer = await file.arrayBuffer();
        parsed = await parseExcelToLeads(buffer, file.name);
      } else {
        const text = await file.text();
        parsed = parseCsvToLeads(text, file.name);
      }

      if (parsed.length === 0) {
        setBannerMessage({
          type: 'error',
          text: `No valid company rows found in ${file.name}. Ensure it has a Company Name header (and optional Nmbs/Phone column).`,
        });
      } else {
        const rescoredParsed = rescoreAllLeads(parsed, scoringConfig);
        const { merged, addedCount, duplicateCount, crossSessionBlockedCount } = mergeLeadsDeduplicated(
          leads,
          rescoredParsed,
          { checkCrossSession: freshOnly },
        );
        setSeenHistory((prev) => recordSeenLeads(prev, rescoredParsed));
        setLeads(merged);
        if (!selectedLeadId && merged.length > 0) {
          setSelectedLeadId(merged[0].id);
        }

        // Persist imported batch to SQLite
        fetch('/api/leads/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: rescoredParsed, checkCrossSession: freshOnly }),
        })
          .then(() => refreshFromDb())
          .catch(() => {});

        const importedKeys = new Set(rescoredParsed.map((p) => p.normalized_name));
        const toEnrich = merged.filter(
          (l) =>
            importedKeys.has(l.normalized_name) &&
            (!l.business_email || !l.business_phone || !l.website || !l.project_name || !l.city),
        );

        const blockedNote =
          crossSessionBlockedCount > 0 ? `, ${crossSessionBlockedCount} previously delivered skipped` : '';
        const importSummary = `Imported ${file.name}: ${addedCount} new leads added (${duplicateCount} duplicates merged${blockedNote}).`;
        if (autoFindContacts && toEnrich.length > 0) {
          const cap = Math.min(100, toEnrich.length);
          const res = await enrichLeadsContacts(
            toEnrich.slice(0, cap),
            `${importSummary} Auto-enriching info: `,
          );
          setBannerMessage({
            type: 'info',
            text: `${importSummary} Auto-enriched ${res.enriched} companies (${res.websites} websites, ${res.emails} emails, ${res.phones} phones, ${res.projects} USASpending projects).`,
          });
        } else {
          setBannerMessage({
            type: 'info',
            text: `${importSummary} Click "Find Missing Contacts" to enrich websites, emails & projects.`,
          });
        }
      }
    } catch {
      setBannerMessage({ type: 'error', text: `Failed to read ${file.name}.` });
    } finally {
      e.target.value = '';
    }
  };

  const handleUpdateLead = (id: string, patch: Partial<Lead>) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.stats) setDbStats(data.stats);
      })
      .catch(() => {});
  };

  const logExportEvent = (exportType: string, rowCount: number, filename: string) => {
    fetch('/api/exports/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportType, rowCount, filename }),
    }).catch(() => {});
  };

  const handleExportCsv = (rows: Lead[], filename: string) => {
    const csvContent = leadsToCsv(rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    logExportEvent('csv', rows.length, filename);
  };

  const handleExportZoomSms = (rows: Lead[], filename: string) => {
    const readyCount = getSmsReadyLeads(rows).length;
    const csvContent = leadsToZoomSmsCsv(rows, smsTemplate);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    logExportEvent('zoom_sms_csv', readyCount, filename);
    if (suppressedFilteredCount > 0) {
      setBannerMessage({
        type: 'info',
        text: `Exported ${readyCount} Zoom SMS numbers (${suppressedFilteredCount} opted-out/suppressed leads excluded automatically).`,
      });
    }
  };

  const handleCopySmsTemplate = async () => {
    try {
      await navigator.clipboard.writeText(smsTemplate);
      setCopiedSms(true);
      setTimeout(() => setCopiedSms(false), 1800);
    } catch {
      // Clipboard blocked fallback
    }
  };

  const handleExportExcel = async (rows: Lead[], filename: string) => {
    const buffer = await leadsToExcelBuffer(rows);
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    logExportEvent('xlsx', rows.length, filename);
  };

  const handleClearAll = async () => {
    const blockedSnapshot = recordSeenLeads(seenHistory, leads);
    setSeenHistory(blockedSnapshot);
    setLeads([]);
    setSelectedLeadId(null);
    setSelectedLeadIds(new Set());
    setConfirmClear(false);

    try {
      const resp = await fetch('/api/leads/clear', { method: 'POST' });
      if (resp.ok) {
        const data = await resp.json();
        if (data.stats) setDbStats(data.stats);
        if (typeof data.seenPhonesCount === 'number') setDbSeenPhonesCount(data.seenPhonesCount);
      }
    } catch {
      // Keep local clear
    }

    setBannerMessage({
      type: 'info',
      text: `Pipeline table cleared. ${Math.max(blockedPhoneCount, blockedSnapshot.phones.length).toLocaleString()} delivered phone number(s) stay blocked in SQLite so future runs only deliver fresh leads.`,
    });
  };

  const handleResetSeenHistory = async () => {
    setSeenHistory(clearSeenHistory(leads));
    setConfirmResetSeen(false);
    setHuntPage(1);
    try {
      const resp = await fetch('/api/seen/reset', { method: 'POST' });
      if (resp.ok) {
        const data = await resp.json();
        setDbSeenPhonesCount(Number(data.seenPhonesCount || 0));
      }
    } catch {
      // Keep local reset
    }
    setBannerMessage({
      type: 'info',
      text: 'Cleared past delivery history (phones and emails currently in your active table remain protected).',
    });
  };

  const toggleSelectLead = (id: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAllPage = () => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        paginatedLeads.forEach((l) => next.delete(l.id));
      } else {
        paginatedLeads.forEach((l) => next.add(l.id));
      }
      return next;
    });
  };

  const handleSelectHighIntentVisible = () => {
    setSelectedLeadIds(new Set(highIntentLeadsFiltered.map((l) => l.id)));
  };

  const handleCrmSyncComplete = (
    leadIds: string[],
    summaryText: string,
    markQueued: boolean,
  ) => {
    if (markQueued && leadIds.length > 0) {
      const idSet = new Set(leadIds);
      const today = getTodayDateKey();
      setLeads((prev) =>
        prev.map((l) =>
          idSet.has(l.id) ? { ...l, outreach_status: 'Ready for Calling', last_verified: today } : l,
        ),
      );
      for (const id of leadIds) {
        fetch(`/api/leads/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outreach_status: 'Ready for Calling', last_verified: today }),
        }).catch(() => {});
      }
    }
    setBannerMessage({ type: 'info', text: summaryText });
  };

  const resetAllFilters = () => {
    setActiveTab('pipeline');
    setSearchQuery('');
    setTierFilter('ALL');
    setServiceFilter('ALL');
    setTradeFilter('ALL');
    setCategoryFilter('ALL');
    setProjectTypeFilter('ALL');
    setOutreachFilter('ALL');
    setSourceFilter('ALL');
    setStateFilter('ALL');
    setCityFilter('');
    setZipFilter('');
    setDateFilter('');
    setMinScore(0);
    setLiveProjectsOnly(false);
    setHasContactOnly(false);
    setVerifiedOnly(false);
  };

  const tierTextTone = (tier: LeadTier) => {
    if (tier === 'Hot') return 'font-semibold text-red-700';
    if (tier === 'Warm') return 'font-semibold text-amber-700';
    if (tier === 'Potential') return 'font-medium text-slate-800';
    return 'text-slate-500';
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Left Sidebar */}
      <aside className="hidden md:flex w-[256px] shrink-0 bg-white border-r border-slate-200 flex-col justify-between p-4">
        <div className="space-y-6">
          <div className="px-2 pt-1">
            <div className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
              Ai Leads Hunter
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Cost Bidding LLC · Construction Intel
            </div>
          </div>

          <nav aria-label="Primary" className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveTab('pipeline')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'pipeline'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Building2 className="w-4 h-4 shrink-0" />
                Lead Pipeline
              </span>
              <span className="font-mono-tabular text-xs opacity-80">{stats.total}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('warm')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'warm'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Flame className="w-4 h-4 shrink-0" />
                Hot &amp; Warm
              </span>
              <span className="font-mono-tabular text-xs opacity-80">{stats.highIntent}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('duplicates')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'duplicates'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <GitMerge className="w-4 h-4 shrink-0" />
                Duplicates
              </span>
              <span className="font-mono-tabular text-xs opacity-80">{stats.duplicates}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('report')}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'report'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <BarChart3 className="w-4 h-4 shrink-0" />
                Daily Report
              </span>
            </button>
          </nav>

          <div className="border-t border-slate-200 pt-4 px-2 space-y-2.5">
            <div className="text-xs font-semibold text-slate-500">Cost Bidding Services</div>
            <ul className="space-y-1.5 text-xs text-slate-700">
              <li className="flex items-center justify-between">
                <span>Estimation &amp; Takeoffs</span>
                <span className="font-mono-tabular text-slate-500">
                  {leads.filter((l) => l.service_opportunity === 'Construction Estimation').length}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>Architectural / Bid Prep</span>
                <span className="font-mono-tabular text-slate-500">
                  {leads.filter((l) => l.service_opportunity === 'Architectural Services').length}
                </span>
              </li>
              <li className="flex items-center justify-between">
                <span>Millwork Shop Drawings</span>
                <span className="font-mono-tabular text-slate-500">
                  {leads.filter((l) => l.service_opportunity === 'Millwork Services').length}
                </span>
              </li>
            </ul>
          </div>

          <div className="border-t border-slate-200 pt-4 px-2 space-y-2">
            <div className="text-xs font-semibold text-slate-500">Local AI Engine (Zero Cost)</div>
            <button
              type="button"
              onClick={() => setOllamaModalOpen(true)}
              className="w-full flex items-center justify-between px-2.5 py-2 text-xs font-medium text-slate-800 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-md transition-colors"
            >
              <span className="inline-flex items-center gap-1.5 truncate">
                <Bot className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{ollamaStatusLabel}</span>
              </span>
              <span className="text-[11px] text-slate-500 shrink-0">Settings</span>
            </button>
          </div>
        </div>

        <div className="px-2 pt-4 border-t border-slate-200 text-[11px] text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">100% Free Public Data</div>
          <div>All 50 US States · USASpending · 10 Permit Portals · SQLite · Ollama</div>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <span className="md:hidden text-base font-bold text-slate-900 whitespace-nowrap shrink-0">
              Ai Leads Hunter
            </span>
            <div className="hidden md:flex items-center gap-2 text-sm text-slate-500 whitespace-nowrap">
              <span className="font-semibold text-slate-900">Ai Leads Hunter</span>
              <span aria-hidden="true">/</span>
              <span>
                {activeTab === 'pipeline'
                  ? 'All Discovered Companies'
                  : activeTab === 'warm'
                    ? 'Hot & Warm Bid Targets'
                    : activeTab === 'duplicates'
                      ? 'Duplicate Review & Evidence'
                      : 'Cost Bidding Report'}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setOllamaModalOpen(true)}
              className="md:hidden inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
            >
              <Bot className="w-3.5 h-3.5" />
              AI Settings
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xlsm"
              onChange={handleCsvUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <FolderUp className="w-3.5 h-3.5" />
              Import CSV / Excel
            </button>
            <button
              type="button"
              onClick={() => handleExportZoomSms(filteredLeads, `zoom_dialer_sms_${new Date().toISOString().slice(0, 10)}.csv`)}
              disabled={smsReadyFiltered.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-amber-600 rounded-md hover:bg-amber-700 transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Zoom SMS CSV ({smsReadyFiltered.length})
            </button>
            <button
              type="button"
              onClick={() => handleExportCsv(filteredLeads, `leads_filtered_${new Date().toISOString().slice(0, 10)}.csv`)}
              disabled={filteredLeads.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => setCrmModalOpen(true)}
              disabled={crmSyncCount === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              Sync to CRM ({crmSyncCount})
            </button>
            <button
              type="button"
              onClick={() => handleExportExcel(filteredLeads, `leads_filtered_${new Date().toISOString().slice(0, 10)}.xlsx`)}
              disabled={filteredLeads.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Export Excel (.xlsx)
            </button>
          </div>
        </header>

        {/* Mobile Tab Switcher */}
        <div className="md:hidden bg-white border-b border-slate-200 px-4 py-2 flex items-center gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('pipeline')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'pipeline' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Pipeline ({stats.total})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('warm')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'warm' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Hot &amp; Warm ({stats.highIntent})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('duplicates')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'duplicates' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Duplicates ({stats.duplicates})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('report')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeTab === 'report' ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
            }`}
          >
            Daily Report
          </button>
        </div>

        {/* Workspace Content */}
        <main className="flex-1 p-6 space-y-5 max-w-[1600px] w-full mx-auto">
          {/* Live Discovery Bar */}
          <section className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="hunt-source" className="block text-xs font-medium text-slate-600 mb-1">
                  Public Data Source
                </label>
                <select
                  id="hunt-source"
                  value={huntSource}
                  onChange={(e) => {
                    setHuntSource(e.target.value as SourceOption);
                    setHuntPage(1);
                  }}
                  className="h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="all">All 50 States (Awards + 10 Permit Portals)</option>
                  <option value="usaspending">USASpending.gov (All 50 States)</option>
                  <option value="permits">City Permits + State Awards (All 50 States)</option>
                </select>
              </div>

              <div>
                <label htmlFor="hunt-state" className="block text-xs font-medium text-slate-600 mb-1">
                  US State (50 States + DC)
                </label>
                <select
                  id="hunt-state"
                  value={huntState}
                  onChange={(e) => {
                    setHuntState(e.target.value);
                    setHuntPage(1);
                  }}
                  className="h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="">All 50 States (USA)</option>
                  {US_STATE_OPTIONS.map(([code, name]) => (
                    <option key={code} value={code}>
                      {code} — {name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="hunt-limit" className="block text-xs font-medium text-slate-600 mb-1">
                  Batch Size
                </label>
                <select
                  id="hunt-limit"
                  value={huntLimit}
                  onChange={(e) => {
                    setHuntLimit(Number(e.target.value));
                    setHuntPage(1);
                  }}
                  className="h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value={3}>Standard (~35 leads)</option>
                  <option value={25}>Medium (~150 leads)</option>
                  <option value={150}>Bulk SMS (~500 leads)</option>
                  <option value={350}>SMS Scale (1,000+ leads)</option>
                </select>
              </div>

              <label className="h-9 px-2.5 inline-flex items-center gap-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={smsPhonePriority}
                  onChange={(e) => {
                    setSmsPhonePriority(e.target.checked);
                    setHuntPage(1);
                  }}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-600"
                />
                SMS Phone-Ready Only
              </label>

              <label className="h-9 px-2.5 inline-flex items-center gap-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={autoFindContacts}
                  onChange={(e) => setAutoFindContacts(e.target.checked)}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-600"
                />
                Auto-find phones &amp; emails
              </label>

              <label
                title="Permanently remembers every phone number and email delivered to you so you never receive repeats on future days, even after clearing the table."
                className="h-9 px-2.5 inline-flex items-center gap-2 text-xs text-slate-700 bg-emerald-50/70 border border-emerald-200 rounded-md cursor-pointer select-none whitespace-nowrap"
              >
                <input
                  type="checkbox"
                  checked={freshOnly}
                  onChange={(e) => setFreshOnly(e.target.checked)}
                  className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-700"
                />
                <span>Never Repeat Phones</span>
                <span className="font-mono-tabular text-[11px] text-emerald-800">
                  ({blockedPhoneCount.toLocaleString()} blocked)
                </span>
              </label>

              {(blockedPhoneCount > 0 || seenHistory.keys.length > 0) &&
                (confirmResetSeen ? (
                  <div className="inline-flex items-center gap-1.5 text-[11px]">
                    <button
                      type="button"
                      onClick={handleResetSeenHistory}
                      className="px-2 py-1 font-medium text-white bg-red-600 rounded hover:bg-red-700 whitespace-nowrap"
                    >
                      Confirm Reset History
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmResetSeen(false)}
                      className="px-1.5 py-1 text-slate-500 hover:text-slate-900 whitespace-nowrap"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmResetSeen(true)}
                    className="h-9 px-2 text-[11px] text-slate-500 hover:text-slate-900 underline underline-offset-2 whitespace-nowrap"
                  >
                    Reset Seen History
                  </button>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {leads.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleEnrichMissingContacts}
                    disabled={hunting || enrichingContacts}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50 whitespace-nowrap"
                  >
                    <PhoneCall className="w-3.5 h-3.5" />
                    {enrichingContacts ? 'Finding Contacts...' : 'Find Missing Contacts'}
                  </button>
                  {confirmClear ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleClearAll}
                        className="px-3 py-2 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 whitespace-nowrap"
                      >
                        Confirm Clear
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClear(false)}
                        className="px-2.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClear(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={handleHuntLive}
                disabled={hunting || enrichingContacts}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {hunting
                  ? 'Finding Projects...'
                  : enrichingContacts
                    ? 'Finding Contacts...'
                    : 'Hunt Projects + Contacts'}
              </button>
            </div>
          </section>

          {bannerMessage && (
            <div
              role="status"
              className={`px-4 py-2.5 text-xs rounded-md border flex items-center justify-between gap-4 ${
                bannerMessage.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-white border-slate-200 text-slate-700'
              }`}
            >
              <span>{bannerMessage.text}</span>
              <button
                type="button"
                onClick={() => setBannerMessage(null)}
                className="text-slate-500 hover:text-slate-900 font-medium whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'report' ? (
            <DailyReportView
              leads={leads}
              dbStats={dbStats}
              onExportCsv={handleExportCsv}
              onExportExcel={handleExportExcel}
              onExportZoomSms={handleExportZoomSms}
            />
          ) : activeTab === 'duplicates' ? (
            <DuplicatesReviewView
              onSelectLeadId={(id) => {
                setActiveTab('pipeline');
                setSelectedLeadId(id);
              }}
            />
          ) : (
            <>
              <DailyQuotaTracker
                quota={dailyQuota}
                huntSource={huntSource}
                huntLimit={huntLimit}
                smsPhonePriority={smsPhonePriority}
                onChangeDailyTier={(limit) =>
                  setDailyQuota((prev) => ({
                    ...prev,
                    discoveryLimit: limit,
                    contactLimit: limit,
                  }))
                }
                onResetToday={() =>
                  setDailyQuota((prev) => createDefaultQuota(prev.discoveryLimit, prev.contactLimit))
                }
              />

              <DiscoveryJobsPanel
                huntSource={huntSource}
                huntState={huntState}
                huntLimit={huntLimit}
                smsPhonePriority={smsPhonePriority}
                freshOnly={freshOnly}
                onJobUpdated={refreshFromDb}
              />

              <AutomatedScoringEngine
                leads={leads}
                config={scoringConfig}
                onApplyScoring={handleApplyScoring}
              />

              {/* Zoom Dialer Bulk SMS Campaign Strip */}
              <section
                aria-label="Zoom Dialer SMS Campaign"
                className="bg-white border border-slate-200 rounded-lg p-4 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <MessageSquare className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                    <span className="font-semibold text-slate-900">Zoom Dialer SMS Outreach</span>
                    <span className="text-slate-400" aria-hidden="true">·</span>
                    <span className="font-mono-tabular text-slate-700">
                      <strong>{smsReadyFiltered.length}</strong> eligible +1 US numbers ready
                    </span>
                    {suppressedFilteredCount > 0 && (
                      <>
                        <span className="text-slate-400" aria-hidden="true">·</span>
                        <span className="text-red-700 font-mono-tabular">
                          {suppressedFilteredCount} opted-out/suppressed skipped
                        </span>
                      </>
                    )}
                    <span className="text-slate-400 hidden sm:inline" aria-hidden="true">·</span>
                    <span className="text-slate-500 hidden sm:inline">
                      Winter Architecture, 2D/3D, Permit &amp; CD Sets
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopySmsTemplate}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
                    >
                      {copiedSms ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedSms ? 'Copied' : 'Copy SMS'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleExportZoomSms(filteredLeads, `zoom_dialer_sms_${new Date().toISOString().slice(0, 10)}.csv`)
                      }
                      disabled={smsReadyFiltered.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export Zoom SMS CSV ({smsReadyFiltered.length})
                    </button>
                  </div>
                </div>

                <textarea
                  aria-label="Zoom Dialer SMS template"
                  rows={2}
                  value={smsTemplate}
                  onChange={(e) => setSmsTemplate(e.target.value)}
                  className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </section>

              {/* KPI Strip (Real Stored DB Metrics) */}
              <section className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-slate-200">
                <div className="p-4">
                  <div className="text-xs text-slate-500">Companies Stored</div>
                  <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">
                    {stats.total}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Hot Leads (80+)</div>
                  <div className="text-2xl font-semibold text-red-700 font-mono-tabular mt-1">
                    {stats.hot}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Warm Leads (60–79)</div>
                  <div className="text-2xl font-semibold text-amber-700 font-mono-tabular mt-1">
                    {stats.warm}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Verified Websites</div>
                  <div className="text-2xl font-semibold text-emerald-700 font-mono-tabular mt-1">
                    {stats.verified}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-slate-500">Average Score</div>
                  <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">
                    {stats.avgScore}/100
                  </div>
                </div>
              </section>

              {/* Main Table + Inspector Split */}
              <div className="flex flex-col lg:flex-row gap-5 items-start">
                <div className="flex-1 min-w-0 w-full bg-white border border-slate-200 rounded-lg overflow-hidden">
                  {/* Search & Filter Toolbar */}
                  <div className="p-3.5 border-b border-slate-200 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2.5">
                      <div className="relative flex-1 min-w-[220px]">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search company, trade, project, city, ZIP, phone, or evidence..."
                          className="w-full h-9 pl-8 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {activeTab === 'pipeline' && (
                          <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
                            {(['ALL', 'Hot', 'Warm', 'Potential', 'Low Priority'] as const).map((tier) => (
                              <button
                                key={tier}
                                type="button"
                                onClick={() => setTierFilter(tier)}
                                className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                                  tierFilter === tier
                                    ? 'bg-white text-slate-900 shadow-xs'
                                    : 'text-slate-600 hover:text-slate-900'
                                }`}
                              >
                                {tier === 'ALL' ? 'All Tiers' : tier}
                              </button>
                            ))}
                          </div>
                        )}

                        <select
                          aria-label="Filter by construction trade"
                          value={tradeFilter}
                          onChange={(e) => setTradeFilter(e.target.value)}
                          className="h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All 21 Trades</option>
                          {CONSTRUCTION_TRADES.map((tr) => (
                            <option key={tr} value={tr}>
                              {tr}
                            </option>
                          ))}
                        </select>

                        <select
                          aria-label="Filter by US state"
                          value={stateFilter}
                          onChange={(e) => setStateFilter(e.target.value)}
                          className="h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All States</option>
                          {availableStates.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => setShowAdvancedFilters((v) => !v)}
                          className={`inline-flex items-center gap-1 h-8 px-2.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                            showAdvancedFilters
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          Filters
                        </button>

                        <button
                          type="button"
                          onClick={handleSelectHighIntentVisible}
                          disabled={highIntentLeadsFiltered.length === 0}
                          className="h-8 px-2.5 text-xs font-medium rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
                        >
                          Select Hot &amp; Warm ({highIntentLeadsFiltered.length})
                        </button>

                        {selectedLeadIds.size > 0 && (
                          <button
                            type="button"
                            onClick={() => setSelectedLeadIds(new Set())}
                            className="h-8 px-2.5 text-xs font-medium rounded-md border border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200 whitespace-nowrap"
                          >
                            Clear Selected ({selectedLeadIds.size})
                          </button>
                        )}
                      </div>
                    </div>

                    {showAdvancedFilters && (
                      <div className="pt-2.5 border-t border-slate-100 flex flex-wrap items-center gap-2">
                        <select
                          aria-label="Filter by target service"
                          value={serviceFilter}
                          onChange={(e) => setServiceFilter(e.target.value)}
                          className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All Services</option>
                          <option value="Construction Estimation">Estimation</option>
                          <option value="Architectural Services">Architectural</option>
                          <option value="Millwork Services">Millwork</option>
                        </select>

                        <select
                          aria-label="Filter by company type"
                          value={categoryFilter}
                          onChange={(e) => setCategoryFilter(e.target.value)}
                          className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All Company Types</option>
                          {COMPANY_CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>

                        <select
                          aria-label="Filter by project type"
                          value={projectTypeFilter}
                          onChange={(e) => setProjectTypeFilter(e.target.value)}
                          className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All Project Types</option>
                          {PROJECT_TYPES.map((pt) => (
                            <option key={pt} value={pt}>
                              {pt}
                            </option>
                          ))}
                        </select>

                        <select
                          aria-label="Filter by outreach status"
                          value={outreachFilter}
                          onChange={(e) => setOutreachFilter(e.target.value)}
                          className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All 16 Statuses</option>
                          {OUTREACH_STATUSES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>

                        <select
                          aria-label="Filter by data source"
                          value={sourceFilter}
                          onChange={(e) => setSourceFilter(e.target.value)}
                          className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value="ALL">All Sources</option>
                          {availableSources.map((src) => (
                            <option key={src} value={src}>
                              {src}
                            </option>
                          ))}
                        </select>

                        <input
                          type="text"
                          aria-label="Filter by city"
                          value={cityFilter}
                          onChange={(e) => setCityFilter(e.target.value)}
                          placeholder="City..."
                          className="h-8 w-28 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        />

                        <input
                          type="text"
                          aria-label="Filter by ZIP code"
                          value={zipFilter}
                          onChange={(e) => setZipFilter(e.target.value)}
                          placeholder="ZIP..."
                          className="h-8 w-24 px-2 text-xs font-mono-tabular bg-white border border-slate-200 rounded-md text-slate-700"
                        />

                        <input
                          type="date"
                          aria-label="Filter by discovery date"
                          value={dateFilter}
                          onChange={(e) => setDateFilter(e.target.value)}
                          className="h-8 px-2 text-xs font-mono-tabular bg-white border border-slate-200 rounded-md text-slate-700"
                        />

                        <select
                          aria-label="Minimum lead score"
                          value={minScore}
                          onChange={(e) => setMinScore(Number(e.target.value))}
                          className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
                        >
                          <option value={0}>Score 0+</option>
                          <option value={40}>Score 40+</option>
                          <option value={60}>Score 60+ (Warm)</option>
                          <option value={80}>Score 80+ (Hot)</option>
                        </select>

                        <button
                          type="button"
                          onClick={() => setLiveProjectsOnly((v) => !v)}
                          className={`h-8 px-2.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                            liveProjectsOnly
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          Live Projects
                        </button>

                        <button
                          type="button"
                          onClick={() => setHasContactOnly((v) => !v)}
                          className={`h-8 px-2.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                            hasContactOnly
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          Has Phone / Email
                        </button>

                        <button
                          type="button"
                          onClick={() => setVerifiedOnly((v) => !v)}
                          className={`h-8 px-2.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                            verifiedOnly
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          Verified / High Conf
                        </button>

                        <button
                          type="button"
                          onClick={resetAllFilters}
                          className="h-8 px-2 text-xs text-slate-500 hover:text-slate-900 underline underline-offset-2"
                        >
                          Reset All
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Empty State or Populated Data Grid */}
                  {leads.length === 0 ? (
                    <div className="p-12 text-center space-y-3">
                      <h2 className="text-base font-semibold text-slate-900">
                        Ready to hunt real US construction leads
                      </h2>
                      <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                        Click <strong>Hunt Projects + Contacts</strong> above to pull active US contractors across all 50 states, or import an Excel/CSV file to persist, verify, and score leads for Cost Bidding LLC.
                      </p>
                      <div className="pt-2 flex items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={handleHuntLive}
                          disabled={hunting}
                          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors whitespace-nowrap"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          {hunting ? 'Hunting Live Leads...' : 'Hunt Projects + Contacts'}
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
                        >
                          <FolderUp className="w-3.5 h-3.5" />
                          Import Excel / CSV
                        </button>
                      </div>
                    </div>
                  ) : filteredLeads.length === 0 ? (
                    <div className="p-10 text-center space-y-3 text-xs text-slate-500">
                      <div>
                        {leads.length} lead(s) are stored in your SQLite pipeline, but none match your current tab or filter settings.
                      </div>
                      <button
                        type="button"
                        onClick={resetAllFilters}
                        className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                      >
                        Reset Filters (Show All {leads.length} Leads)
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs text-left">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                              <th className="py-2.5 pl-4 pr-2 w-8">
                                <input
                                  type="checkbox"
                                  aria-label="Select all rows on page"
                                  checked={allPageSelected}
                                  onChange={toggleSelectAllPage}
                                  className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                                />
                              </th>
                              <th className="py-2.5 px-4 font-medium">Company &amp; Active Project</th>
                              <th className="py-2.5 px-3 font-medium">Trade &amp; Service Fit</th>
                              <th className="py-2.5 px-3 font-medium">Contact &amp; Verification</th>
                              <th className="py-2.5 px-3 font-medium">Location</th>
                              <th className="py-2.5 px-3 font-medium">Tier &amp; Status</th>
                              <th className="py-2.5 px-4 font-medium text-right">Score</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {paginatedLeads.map((lead) => {
                              const isSelected = lead.id === selectedLead?.id;
                              const isChecked = selectedLeadIds.has(lead.id);
                              const srcUrl = safeExternalUrl(lead.project_source_url || lead.company_source_url);
                              const isSuppressed = SUPPRESSED_OUTREACH_STATUSES.has(lead.outreach_status);
                              return (
                                <tr
                                  key={lead.id}
                                  onClick={() => setSelectedLeadId(lead.id)}
                                  className={`cursor-pointer transition-colors ${
                                    isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'
                                  }`}
                                >
                                  <td
                                    className="py-2.5 pl-4 pr-2 w-8"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${lead.company_name}`}
                                      checked={isChecked}
                                      onChange={() => toggleSelectLead(lead.id)}
                                      className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                                    />
                                  </td>
                                  <td className="py-2.5 px-4 max-w-[280px]">
                                    <div className="font-semibold text-slate-900 truncate">
                                      {lead.company_name}
                                    </div>
                                    <div className="text-[11px] text-slate-500 truncate mt-0.5 flex items-center gap-1.5">
                                      <span className="truncate">
                                        {lead.project_name || lead.company_category || lead.source_name}
                                        {lead.project_value ? ` · ${lead.project_value}` : ''}
                                      </span>
                                      {srcUrl && (
                                        <a
                                          href={srcUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          aria-label={`Open source for ${lead.company_name}`}
                                          className="text-blue-700 hover:text-blue-900 shrink-0"
                                        >
                                          <ExternalLink className="w-3 h-3" />
                                        </a>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 max-w-[180px]">
                                    <div className="text-slate-900 font-medium truncate">
                                      {lead.construction_trade || 'General Contractors'}
                                    </div>
                                    <div className="text-[11px] text-slate-500 truncate">
                                      {lead.service_opportunity || 'Construction Estimation'}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 max-w-[200px]">
                                    <div className="text-slate-900 font-medium truncate">
                                      {lead.contact_person || lead.business_phone || '—'}
                                    </div>
                                    <div className="text-[11px] font-mono-tabular text-slate-500 truncate">
                                      {lead.business_phone || lead.business_email || 'Needs website check'}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 whitespace-nowrap text-slate-700">
                                    {[lead.city, lead.state].filter(Boolean).join(', ') || '—'}
                                  </td>
                                  <td className="py-2.5 px-3 whitespace-nowrap">
                                    <span className={tierTextTone(lead.lead_tier)}>
                                      {lead.lead_tier}
                                    </span>
                                    <span className="text-slate-400 mx-1.5">·</span>
                                    <span className={isSuppressed ? 'text-red-700 font-medium' : 'text-slate-600'}>
                                      {lead.outreach_status}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-4 text-right font-mono-tabular font-semibold text-slate-900">
                                    {lead.lead_score}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination Controls */}
                      <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="text-slate-600 font-mono-tabular">
                          Showing {(safePage - 1) * pageSize + 1}–
                          {Math.min(safePage * pageSize, filteredLeads.length)} of{' '}
                          {filteredLeads.length} matching leads
                        </div>

                        <div className="flex items-center gap-3">
                          <label className="inline-flex items-center gap-1.5 text-slate-600">
                            Rows:
                            <select
                              aria-label="Rows per page"
                              value={pageSize}
                              onChange={(e) => setPageSize(Number(e.target.value))}
                              className="h-7 px-2 text-xs bg-white border border-slate-200 rounded text-slate-800 font-mono-tabular"
                            >
                              <option value={25}>25</option>
                              <option value={50}>50</option>
                              <option value={100}>100</option>
                            </select>
                          </label>

                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setPage((p) => Math.max(1, p - 1))}
                              disabled={safePage <= 1}
                              aria-label="Previous page"
                              className="p-1.5 bg-white border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-40"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                            <span className="px-2 font-mono-tabular text-slate-700">
                              Page {safePage} / {totalPages}
                            </span>
                            <button
                              type="button"
                              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                              disabled={safePage >= totalPages}
                              aria-label="Next page"
                              className="p-1.5 bg-white border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-40"
                            >
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Detail Inspector */}
                {selectedLead && (
                  <LeadDetailPanel
                    lead={selectedLead}
                    onClose={() => setSelectedLeadId(null)}
                    onUpdateLead={handleUpdateLead}
                    scoringConfig={scoringConfig}
                    onContactLookupComplete={({ phonesFound, emailsFound }) =>
                      recordContactUsage(1, phonesFound, emailsFound)
                    }
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      <CrmSyncModal
        isOpen={crmModalOpen}
        onClose={() => setCrmModalOpen(false)}
        selectedLeads={selectedLeadsForCrm}
        warmLeads={highIntentLeadsFiltered}
        onSyncComplete={handleCrmSyncComplete}
      />

      <OllamaSettingsModal
        isOpen={ollamaModalOpen}
        onClose={() => setOllamaModalOpen(false)}
        onSettingsSaved={(settings, reachable) => {
          if (settings.enabled && reachable) {
            setOllamaStatusLabel(`Ollama: ${settings.model || 'Ready'}`);
          } else if (settings.enabled) {
            setOllamaStatusLabel('Ollama: Offline');
          } else {
            setOllamaStatusLabel('Local Rules');
          }
        }}
      />
    </div>
  );
}
