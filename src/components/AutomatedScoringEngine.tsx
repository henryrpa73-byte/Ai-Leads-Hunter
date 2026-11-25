import { SlidersHorizontal, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  DEFAULT_SCORING_CONFIG,
  extractProjectValueUsd,
  formatProjectValue,
  inferCompanySizeProfile,
  type ScoringCriteriaConfig,
} from '../lib/leadEngine.ts';
import type { Lead } from '../types/lead.ts';

interface AutomatedScoringEngineProps {
  leads: Lead[];
  config: ScoringCriteriaConfig;
  onApplyScoring: (nextConfig: ScoringCriteriaConfig) => void;
}

const PRESETS: Array<{ label: string; config: ScoringCriteriaConfig }> = [
  {
    label: 'Balanced',
    config: DEFAULT_SCORING_CONFIG,
  },
  {
    label: 'High-Value Projects',
    config: {
      warmThreshold: 70,
      projectValueWeight: 45,
      companySizeWeight: 20,
      serviceMatchWeight: 20,
      activityReachWeight: 15,
    },
  },
  {
    label: 'Service Match Focus',
    config: {
      warmThreshold: 65,
      projectValueWeight: 20,
      companySizeWeight: 15,
      serviceMatchWeight: 45,
      activityReachWeight: 20,
    },
  },
];

export function AutomatedScoringEngine({
  leads,
  config,
  onApplyScoring,
}: AutomatedScoringEngineProps) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<ScoringCriteriaConfig>(config);

  const summary = useMemo(() => {
    const warmCount = leads.filter((l) => l.lead_tier === 'Warm').length;
    const potentialCount = leads.filter((l) => l.lead_tier === 'Potential').length;

    const values = leads
      .map((l) => extractProjectValueUsd(`${l.buying_intent_evidence} ${l.project_description}`))
      .filter((v): v is number => v !== null && v > 0);
    const avgValue = values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null;
    const highValueCount = values.filter((v) => v >= 250_000).length;

    let primeOrMidCount = 0;
    for (const l of leads) {
      const sz = inferCompanySizeProfile(l);
      if (sz.tier === 'Enterprise / Prime GC' || sz.tier === 'Mid-Market Contractor') {
        primeOrMidCount += 1;
      }
    }

    return {
      warmCount,
      potentialCount,
      avgValue,
      disclosedCount: values.length,
      highValueCount,
      primeOrMidCount,
    };
  }, [leads]);

  const totalDraftWeight = Math.max(
    1,
    draft.projectValueWeight +
      draft.companySizeWeight +
      draft.serviceMatchWeight +
      draft.activityReachWeight,
  );
  const norm = (w: number) => Math.round((w / totalDraftWeight) * 100);

  const handleOpenToggle = () => {
    if (!expanded) setDraft(config);
    setExpanded((v) => !v);
  };

  return (
    <section
      aria-label="Automated Lead Scoring"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      {/* Summary Header Bar */}
      <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-0.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-slate-900">Automated Lead Scoring Engine</span>
            <span className="text-slate-400" aria-hidden="true">·</span>
            <span className="text-slate-600">
              Warm cutoff <span className="font-mono-tabular font-semibold text-amber-700">{config.warmThreshold}+</span>
            </span>
            <span className="text-slate-400 hidden sm:inline" aria-hidden="true">·</span>
            <span className="text-slate-500 hidden sm:inline font-mono-tabular">
              Value {norm(config.projectValueWeight)}% · Size {norm(config.companySizeWeight)}% · Service {norm(config.serviceMatchWeight)}% · Activity {100 - norm(config.projectValueWeight) - norm(config.companySizeWeight) - norm(config.serviceMatchWeight)}%
            </span>
          </div>
          <div className="text-[11px] text-slate-500 font-mono-tabular">
            {leads.length === 0
              ? 'Evaluates every lead on Project Value, Company Size & Service Match to assign Warm or Potential'
              : `Auto-classified ${summary.warmCount} Warm · ${summary.potentialCount} Potential · ${summary.primeOrMidCount} Prime/Mid-Market GCs${
                  summary.avgValue ? ` · Avg Disclosed Value ${formatProjectValue(summary.avgValue)}` : ''
                }`}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleOpenToggle}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {expanded ? 'Hide Rules' : 'Configure Rules'}
          </button>
          <button
            type="button"
            onClick={() => onApplyScoring(expanded ? draft : config)}
            disabled={leads.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Auto-Score Leads
          </button>
        </div>
      </div>

      {/* Expandable Weight & Rule Customizer */}
      {expanded && (
        <div className="border-t border-slate-200 bg-slate-50/60 p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-600">Scoring Presets:</span>
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setDraft(preset.config)}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="warm-cutoff" className="text-xs font-medium text-slate-600">
                Assign &apos;Warm&apos; at score:
              </label>
              <select
                id="warm-cutoff"
                value={draft.warmThreshold}
                onChange={(e) => setDraft((p) => ({ ...p, warmThreshold: Number(e.target.value) }))}
                className="h-8 px-2.5 text-xs bg-white border border-slate-300 rounded text-slate-900 font-mono-tabular"
              >
                <option value={60}>60+ (Broader Warm)</option>
                <option value={65}>65+</option>
                <option value={70}>70+ (Default)</option>
                <option value={75}>75+ (Strict)</option>
                <option value={80}>80+ (Top Priority Only)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">Project Value</span>
                <span className="font-mono-tabular font-semibold text-slate-700">
                  {norm(draft.projectValueWeight)} pts
                </span>
              </div>
              <input
                type="range"
                aria-label="Project Value weight"
                min={10}
                max={55}
                step={5}
                value={draft.projectValueWeight}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, projectValueWeight: Number(e.target.value) }))
                }
                className="w-full accent-slate-900"
              />
              <p className="text-[11px] text-slate-500">
                $1M+ awards score 100%, $250K+ score 85%, $50K+ score 65%.
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">Company Size</span>
                <span className="font-mono-tabular font-semibold text-slate-700">
                  {norm(draft.companySizeWeight)} pts
                </span>
              </div>
              <input
                type="range"
                aria-label="Company Size weight"
                min={5}
                max={40}
                step={5}
                value={draft.companySizeWeight}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, companySizeWeight: Number(e.target.value) }))
                }
                className="w-full accent-slate-900"
              />
              <p className="text-[11px] text-slate-500">
                Prime / Enterprise GCs score 100%, Mid-Market 80%, Specialty Trades 60%.
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">Service Match</span>
                <span className="font-mono-tabular font-semibold text-slate-700">
                  {norm(draft.serviceMatchWeight)} pts
                </span>
              </div>
              <input
                type="range"
                aria-label="Service Match weight"
                min={10}
                max={55}
                step={5}
                value={draft.serviceMatchWeight}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, serviceMatchWeight: Number(e.target.value) }))
                }
                className="w-full accent-slate-900"
              />
              <p className="text-[11px] text-slate-500">
                Direct fit for Estimation, Architectural CAD, or Millwork shop drawings.
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">Activity &amp; Contact</span>
                <span className="font-mono-tabular font-semibold text-slate-700">
                  {100 -
                    norm(draft.projectValueWeight) -
                    norm(draft.companySizeWeight) -
                    norm(draft.serviceMatchWeight)}{' '}
                  pts
                </span>
              </div>
              <input
                type="range"
                aria-label="Activity and Contact weight"
                min={5}
                max={40}
                step={5}
                value={draft.activityReachWeight}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, activityReachWeight: Number(e.target.value) }))
                }
                className="w-full accent-slate-900"
              />
              <p className="text-[11px] text-slate-500">
                Live/won project status, verified source link, phone, email, and website.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(DEFAULT_SCORING_CONFIG);
                onApplyScoring(DEFAULT_SCORING_CONFIG);
              }}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Reset Defaults
            </button>
            <button
              type="button"
              onClick={() => onApplyScoring(draft)}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors"
            >
              Apply Rules &amp; Re-Score All ({leads.length})
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
