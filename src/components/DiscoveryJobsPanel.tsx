import { Pause, Play, RotateCcw, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CONSTRUCTION_TRADES } from '../lib/trades.ts';
import type { DiscoveryJob } from '../types/lead.ts';

interface DiscoveryJobsPanelProps {
  huntSource: string;
  huntState: string;
  huntLimit: number;
  smsPhonePriority: boolean;
  freshOnly: boolean;
  onJobUpdated?: () => void;
}

export function DiscoveryJobsPanel({
  huntSource,
  huntState,
  huntLimit,
  smsPhonePriority,
  freshOnly,
  onJobUpdated,
}: DiscoveryJobsPanelProps) {
  const [jobs, setJobs] = useState<DiscoveryJob[]>([]);
  const [tradeFilter, setTradeFilter] = useState<string>('ALL');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const resp = await fetch('/api/jobs');
      if (!resp.ok) return;
      const data = (await resp.json()) as { jobs?: DiscoveryJob[] };
      const nextJobs = data.jobs || [];
      setJobs(nextJobs);
    } catch {
      // Ignore transient poll errors
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const activeJob = jobs[0] || null;
  const isActive = activeJob?.status === 'running' || activeJob?.status === 'paused';

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(async () => {
      await loadJobs();
      onJobUpdated?.();
    }, 1500);
    return () => clearInterval(timer);
  }, [isActive, loadJobs, onJobUpdated]);

  const handleStartJob = async () => {
    setBusy(true);
    setExpanded(true);
    try {
      const resp = await fetch('/api/jobs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: huntSource,
          state: huntState,
          trade: tradeFilter,
          limit: huntLimit,
          page: 1,
          smsPhonePriority,
          freshOnly,
        }),
      });
      if (resp.ok) {
        await loadJobs();
        onJobUpdated?.();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleJobAction = async (id: string, action: 'pause' | 'resume' | 'stop' | 'retry') => {
    setBusy(true);
    try {
      const resp = await fetch(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
      });
      if (resp.ok) {
        await loadJobs();
        onJobUpdated?.();
      }
    } finally {
      setBusy(false);
    }
  };

  const statusTone = (st: DiscoveryJob['status']) => {
    if (st === 'running') return 'text-amber-700 font-semibold';
    if (st === 'completed') return 'text-emerald-700 font-semibold';
    if (st === 'paused') return 'text-slate-700 font-semibold';
    if (st === 'failed' || st === 'stopped') return 'text-red-700 font-semibold';
    return 'text-slate-600';
  };

  return (
    <section
      aria-label="Discovery Job Manager"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs min-w-0">
          <span className="font-semibold text-slate-900">Background Discovery Jobs</span>
          {activeJob ? (
            <>
              <span className="text-slate-400" aria-hidden="true">·</span>
              <span className={statusTone(activeJob.status)}>
                {activeJob.status.toUpperCase()}
              </span>
              <span className="text-slate-400" aria-hidden="true">·</span>
              <span className="font-mono-tabular text-slate-600 truncate">
                {activeJob.added_count} added · {activeJob.duplicate_count} dupes · {activeJob.failed_count} errors
              </span>
            </>
          ) : (
            <>
              <span className="text-slate-400" aria-hidden="true">·</span>
              <span className="text-slate-500">Queue multi-source runs with Pause, Resume, Stop &amp; Retry</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <select
            aria-label="Job target construction trade"
            value={tradeFilter}
            onChange={(e) => setTradeFilter(e.target.value)}
            className="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md text-slate-700"
          >
            <option value="ALL">All 21 Trades</option>
            {CONSTRUCTION_TRADES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleStartJob}
            disabled={busy || isActive}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
          >
            <Play className="w-3 h-3" />
            Start Background Job
          </button>

          {activeJob && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
            >
              {expanded ? 'Hide Jobs' : `History (${jobs.length})`}
            </button>
          )}
        </div>
      </div>

      {expanded && jobs.length > 0 && (
        <div className="border-t border-slate-200 divide-y divide-slate-100 bg-slate-50/50">
          {jobs.slice(0, 4).map((job) => {
            const pct =
              job.total_target > 0
                ? Math.min(100, Math.round((job.fetched_count / job.total_target) * 100))
                : job.status === 'completed'
                  ? 100
                  : 0;
            const srcEntries = Object.entries(job.source_stats || {});
            return (
              <div key={job.id} className="p-3.5 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={statusTone(job.status)}>{job.status.toUpperCase()}</span>
                    <span className="font-mono-tabular text-slate-500">
                      {job.source} · {job.state_filter || 'All 50 States'} · {job.trade_filter}
                    </span>
                    <span className="text-slate-600">{job.current_step}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {job.status === 'running' && (
                      <button
                        type="button"
                        onClick={() => handleJobAction(job.id, 'pause')}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-white border border-slate-300 rounded hover:bg-slate-100"
                      >
                        <Pause className="w-3 h-3" /> Pause
                      </button>
                    )}
                    {job.status === 'paused' && (
                      <button
                        type="button"
                        onClick={() => handleJobAction(job.id, 'resume')}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-white border border-slate-300 rounded hover:bg-slate-100"
                      >
                        <Play className="w-3 h-3" /> Resume
                      </button>
                    )}
                    {(job.status === 'running' || job.status === 'paused') && (
                      <button
                        type="button"
                        onClick={() => handleJobAction(job.id, 'stop')}
                        disabled={busy}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-700 bg-white border border-red-200 rounded hover:bg-red-50"
                      >
                        <Square className="w-3 h-3" /> Stop
                      </button>
                    )}
                    {(job.status === 'stopped' || job.status === 'failed' || job.status === 'completed') && (
                      <button
                        type="button"
                        onClick={() => handleJobAction(job.id, 'retry')}
                        disabled={busy || isActive}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-40"
                      >
                        <RotateCcw className="w-3 h-3" /> Retry
                      </button>
                    )}
                  </div>
                </div>

                <div className="h-1.5 w-full bg-slate-200 rounded-sm overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      job.status === 'failed' || job.status === 'stopped'
                        ? 'bg-red-600'
                        : job.status === 'completed'
                          ? 'bg-emerald-600'
                          : 'bg-slate-900'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-mono-tabular">
                  <span>
                    Fetched {job.fetched_count} · Added {job.added_count} · Merged/Dupes {job.duplicate_count}
                  </span>
                  {srcEntries.length > 0 && (
                    <span>
                      {srcEntries
                        .map(([name, s]) => `${name}: ${s.fetched} (${s.errors} err)`)
                        .join(' · ')}
                    </span>
                  )}
                </div>

                {job.errors.length > 0 && (
                  <div className="text-[11px] text-red-700">
                    Errors: {job.errors.slice(0, 2).join(' | ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
