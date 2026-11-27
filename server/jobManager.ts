import { randomUUID } from 'node:crypto';
import type { DiscoveryJob, Lead } from '../src/types/lead.ts';
import type { LeadDatabase } from './db.ts';
import {
  DIRECT_PHONE_PORTAL_STATES,
  discoverMunicipalPermits,
  PERMIT_PORTAL_STATES,
} from './connectors/permits.ts';
import { discoverUsaSpending } from './connectors/usaspending.ts';

export interface StartJobParams {
  source: string;
  state: string;
  trade: string;
  limit: number;
  page: number;
  smsPhonePriority: boolean;
  freshOnly: boolean;
}

export class DiscoveryJobManager {
  private activeJobs = new Map<string, DiscoveryJob>();

  constructor(private db: LeadDatabase) {}

  getJob(id: string): DiscoveryJob | null {
    return this.activeJobs.get(id) || this.db.getJob(id);
  }

  listJobs(limit = 15): DiscoveryJob[] {
    const dbJobs = this.db.listJobs(limit);
    return dbJobs.map((j) => this.activeJobs.get(j.id) || j);
  }

  startJob(params: StartJobParams): DiscoveryJob {
    const now = new Date().toISOString();
    const job: DiscoveryJob = {
      id: `job_${randomUUID().slice(0, 8)}`,
      source: params.source || 'all',
      state_filter: params.state || '',
      trade_filter: params.trade || '',
      status: 'running',
      total_target: Math.max(10, Math.min(500, params.limit * 10)),
      fetched_count: 0,
      added_count: 0,
      duplicate_count: 0,
      failed_count: 0,
      current_step: 'Initializing free public data sources...',
      warnings: [],
      errors: [],
      source_stats: {},
      started_at: now,
      updated_at: now,
      finished_at: '',
    };
    this.activeJobs.set(job.id, job);
    this.db.createJob(job);
    void this.runJobLoop(job.id, params);
    return job;
  }

  pauseJob(id: string): DiscoveryJob | null {
    const job = this.getJob(id);
    if (!job || job.status !== 'running') return job;
    job.status = 'paused';
    job.current_step = 'Paused by user';
    job.updated_at = new Date().toISOString();
    this.activeJobs.set(id, job);
    this.db.updateJob(job);
    return job;
  }

  resumeJob(id: string): DiscoveryJob | null {
    const job = this.getJob(id);
    if (!job || job.status !== 'paused') return job;
    job.status = 'running';
    job.current_step = 'Resuming source sweep...';
    job.updated_at = new Date().toISOString();
    this.activeJobs.set(id, job);
    this.db.updateJob(job);
    return job;
  }

  stopJob(id: string): DiscoveryJob | null {
    const job = this.getJob(id);
    if (!job || (job.status !== 'running' && job.status !== 'paused')) return job;
    const now = new Date().toISOString();
    job.status = 'stopped';
    job.current_step = 'Stopped by user';
    job.updated_at = now;
    job.finished_at = now;
    this.activeJobs.set(id, job);
    this.db.updateJob(job);
    return job;
  }

  retryJob(id: string): DiscoveryJob | null {
    const prev = this.getJob(id);
    if (!prev) return null;
    return this.startJob({
      source: prev.source,
      state: prev.state_filter,
      trade: prev.trade_filter,
      limit: Math.max(5, Math.round(prev.total_target / 10)),
      page: 1,
      smsPhonePriority: false,
      freshOnly: true,
    });
  }

  private async waitIfPaused(id: string): Promise<'continue' | 'stop'> {
    while (true) {
      const current = this.activeJobs.get(id);
      if (!current || current.status === 'stopped') return 'stop';
      if (current.status === 'running') return 'continue';
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  private async runJobLoop(jobId: string, params: StartJobParams) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    const state = params.state;
    const hasDirectPhonePermitPortal = !state || DIRECT_PHONE_PORTAL_STATES.includes(state);
    const hasAnyPermitPortal = !state || PERMIT_PORTAL_STATES.includes(state);

    const steps: Array<{ label: string; run: () => Promise<void> }> = [];

    const shouldRunUsa =
      params.source === 'usaspending' ||
      (params.source === 'all' && (!params.smsPhonePriority || !hasDirectPhonePermitPortal)) ||
      (params.source === 'permits' && Boolean(state) && !hasAnyPermitPortal);

    if (shouldRunUsa) {
      steps.push({
        label: 'USASpending.gov Federal Awards',
        run: async () => {
          const usaCap = params.limit >= 50 ? Math.min(40, Math.ceil(params.limit / 4)) : Math.min(4, params.limit);
          const { leads, errors } = await discoverUsaSpending(state, usaCap, params.page);
          const filtered = filterByTradeAndState(leads, state, params.trade);
          const merged = this.db.upsertLeads(filtered, { checkCrossSession: params.freshOnly });
          job.fetched_count += filtered.length;
          job.added_count += merged.added;
          job.duplicate_count += merged.duplicates;
          job.failed_count += errors.length;
          if (errors.length > 0) job.errors.push(...errors.slice(0, 3));
          job.source_stats['USASpending.gov'] = {
            fetched: filtered.length,
            added: merged.added,
            errors: errors.length,
          };
        },
      });
    }

    const shouldRunPermits = (params.source === 'all' || params.source === 'permits') && hasAnyPermitPortal;
    if (shouldRunPermits) {
      steps.push({
        label: 'Municipal Open-Data Permits',
        run: async () => {
          const portalCap = params.limit >= 50 ? params.limit : params.limit * 4;
          const { leads, errors, portalStats } = await discoverMunicipalPermits(
            portalCap,
            params.page,
            state,
            params.smsPhonePriority && hasDirectPhonePermitPortal,
          );
          const filtered = filterByTradeAndState(leads, state, params.trade);
          const merged = this.db.upsertLeads(filtered, { checkCrossSession: params.freshOnly });
          job.fetched_count += filtered.length;
          job.added_count += merged.added;
          job.duplicate_count += merged.duplicates;
          job.failed_count += errors.length;
          if (errors.length > 0) job.errors.push(...errors.slice(0, 4));
          for (const [k, st] of Object.entries(portalStats)) {
            job.source_stats[k] = {
              fetched: st.fetched,
              added: st.fetched > 0 ? Math.min(st.fetched, merged.added) : 0,
              errors: st.errors,
            };
          }
        },
      });
    }

    try {
      for (const step of steps) {
        const ctrl = await this.waitIfPaused(jobId);
        if (ctrl === 'stop') return;

        job.current_step = `Querying ${step.label}...`;
        job.updated_at = new Date().toISOString();
        this.db.updateJob(job);

        await step.run();

        job.updated_at = new Date().toISOString();
        this.db.updateJob(job);
      }

      const finalCtrl = await this.waitIfPaused(jobId);
      if (finalCtrl === 'stop') return;

      const doneAt = new Date().toISOString();
      job.status = 'completed';
      job.current_step = `Completed: ${job.added_count} new leads saved (${job.duplicate_count} deduplicated)`;
      job.updated_at = doneAt;
      job.finished_at = doneAt;
      this.db.updateJob(job);
    } catch (err) {
      const failAt = new Date().toISOString();
      job.status = 'failed';
      job.current_step = 'Discovery run failed';
      job.errors.push(err instanceof Error ? err.message : 'Unknown job error');
      job.updated_at = failAt;
      job.finished_at = failAt;
      this.db.updateJob(job);
    }
  }
}

function filterByTradeAndState(leads: Lead[], state: string, trade: string): Lead[] {
  return leads.filter((l) => {
    if (state && l.state && l.state !== state) return false;
    if (trade && trade !== 'ALL' && l.construction_trade !== trade) return false;
    return true;
  });
}
