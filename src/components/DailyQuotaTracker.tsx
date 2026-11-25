import { Activity, AlertTriangle, RotateCcw } from 'lucide-react';
import { type DailyQuotaState, getEstimatedLeadsPerRun } from '../lib/dailyQuota.ts';

interface DailyQuotaTrackerProps {
  quota: DailyQuotaState;
  huntSource: 'all' | 'usaspending' | 'permits';
  huntLimit: number;
  onChangeDailyTier: (dailyLimit: number) => void;
  onResetToday: () => void;
}

function getBarColor(pct: number, defaultColor: string): string {
  if (pct >= 95) return 'bg-red-600';
  if (pct >= 75) return 'bg-amber-600';
  return defaultColor;
}

export function DailyQuotaTracker({
  quota,
  huntSource,
  huntLimit,
  onChangeDailyTier,
  onResetToday,
}: DailyQuotaTrackerProps) {
  const discoveryRemaining = Math.max(0, quota.discoveryLimit - quota.discoveryLeadsToday);
  const discoveryPct = Math.min(100, Math.round((quota.discoveryLeadsToday / Math.max(1, quota.discoveryLimit)) * 100));

  const contactRemaining = Math.max(0, quota.contactLimit - quota.contactChecksToday);
  const contactPct = Math.min(100, Math.round((quota.contactChecksToday / Math.max(1, quota.contactLimit)) * 100));

  const estPerRun = getEstimatedLeadsPerRun(huntSource, huntLimit);
  const runsRemaining = estPerRun > 0 ? Math.floor(discoveryRemaining / estPerRun) : 0;

  const hasAnyUsage =
    quota.discoveryLeadsToday > 0 || quota.contactChecksToday > 0 || quota.runsToday > 0;
  const nearOrAtLimit = discoveryRemaining === 0 || contactRemaining === 0;

  return (
    <section
      aria-label="Daily API usage limits"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      {/* Header Row */}
      <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          <Activity className="w-3.5 h-3.5 text-slate-600 shrink-0" />
          <span className="font-semibold text-slate-900">Daily Safe API Capacity</span>
          <span className="text-slate-400" aria-hidden="true">·</span>
          <span className="font-mono-tabular text-slate-500">{quota.date}</span>
          <span className="text-slate-400 hidden sm:inline" aria-hidden="true">·</span>
          <span className="text-slate-500 hidden sm:inline">Resets at midnight</span>
        </div>

        <div className="flex items-center gap-2.5">
          <label htmlFor="daily-limit-preset" className="text-[11px] text-slate-500 whitespace-nowrap">
            Daily target
          </label>
          <select
            id="daily-limit-preset"
            value={quota.discoveryLimit}
            onChange={(e) => onChangeDailyTier(Number(e.target.value))}
            className="h-7 px-2 text-xs bg-white border border-slate-200 rounded text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value={100}>Conservative (100 / day)</option>
            <option value={150}>Standard (150 / day)</option>
            <option value={300}>High Volume (300 / day)</option>
          </select>

          {hasAnyUsage && (
            <button
              type="button"
              onClick={onResetToday}
              title="Reset today's local usage counters"
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 rounded transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          )}
        </div>
      </div>

      {/* 2-Column Progress Split */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200">
        {/* Project Discovery Progress */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-slate-600">Project Discovery Quota</div>
              <div className="text-lg font-semibold text-slate-900 font-mono-tabular mt-0.5">
                {discoveryRemaining}{' '}
                <span className="text-xs font-normal text-slate-500">leads remaining today</span>
              </div>
            </div>
            <div className="text-right font-mono-tabular text-xs">
              <span className="font-semibold text-slate-900">{quota.discoveryLeadsToday}</span>
              <span className="text-slate-400"> / {quota.discoveryLimit}</span>
              <div className="text-[11px] text-slate-500">{discoveryPct}% used</div>
            </div>
          </div>

          <div
            role="progressbar"
            aria-label="Project discovery daily limit"
            aria-valuenow={quota.discoveryLeadsToday}
            aria-valuemin={0}
            aria-valuemax={quota.discoveryLimit}
            className="h-2 w-full bg-slate-100 rounded-full overflow-hidden"
          >
            <div
              className={`h-full transition-all duration-300 ${getBarColor(discoveryPct, 'bg-slate-900')}`}
              style={{ width: `${discoveryPct}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-mono-tabular">
            <span>
              USASpending: {quota.usaspendingLeadsToday} · Permits: {quota.permitLeadsToday}
            </span>
            <span className={discoveryRemaining === 0 ? 'text-red-700 font-medium' : 'text-slate-600'}>
              {discoveryRemaining === 0
                ? 'Daily safe cap reached'
                : `~${runsRemaining} batch ${runsRemaining === 1 ? 'run' : 'runs'} left (${estPerRun}/run)`}
            </span>
          </div>
        </div>

        {/* Contact Enrichment Progress */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-slate-600">Contact &amp; Website Lookups</div>
              <div className="text-lg font-semibold text-slate-900 font-mono-tabular mt-0.5">
                {contactRemaining}{' '}
                <span className="text-xs font-normal text-slate-500">lookups remaining today</span>
              </div>
            </div>
            <div className="text-right font-mono-tabular text-xs">
              <span className="font-semibold text-slate-900">{quota.contactChecksToday}</span>
              <span className="text-slate-400"> / {quota.contactLimit}</span>
              <div className="text-[11px] text-slate-500">{contactPct}% used</div>
            </div>
          </div>

          <div
            role="progressbar"
            aria-label="Contact enrichment daily limit"
            aria-valuenow={quota.contactChecksToday}
            aria-valuemin={0}
            aria-valuemax={quota.contactLimit}
            className="h-2 w-full bg-slate-100 rounded-full overflow-hidden"
          >
            <div
              className={`h-full transition-all duration-300 ${getBarColor(contactPct, 'bg-emerald-600')}`}
              style={{ width: `${contactPct}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-mono-tabular">
            <span>
              Phones found: {quota.phonesFoundToday} · Emails found: {quota.emailsFoundToday}
            </span>
            <span className="text-slate-600">
              {quota.runsToday} {quota.runsToday === 1 ? 'run' : 'runs'} today · Rate-safe
            </span>
          </div>
        </div>
      </div>

      {nearOrAtLimit && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 flex items-center gap-2 text-xs text-amber-900">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
          <span>
            You have reached today&apos;s safe public limit to prevent portal throttling. Raise the daily target above or wait until midnight reset.
          </span>
        </div>
      )}
    </section>
  );
}
