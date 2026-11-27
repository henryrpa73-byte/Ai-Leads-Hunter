import { Download } from 'lucide-react';
import { getSmsReadyLeads, isHighIntentTier } from '../lib/leadEngine.ts';
import type { DashboardDbStats, Lead } from '../types/lead.ts';

interface DailyReportViewProps {
  leads: Lead[];
  dbStats?: DashboardDbStats | null;
  onExportCsv: (rows: Lead[], filename: string) => void;
  onExportExcel: (rows: Lead[], filename: string) => void;
  onExportZoomSms?: (rows: Lead[], filename: string) => void;
}

export function DailyReportView({
  leads,
  dbStats,
  onExportCsv,
  onExportExcel,
  onExportZoomSms,
}: DailyReportViewProps) {
  const hotLeads = leads.filter((l) => l.lead_tier === 'Hot');
  const warmLeads = leads.filter((l) => l.lead_tier === 'Warm');
  const highIntentLeads = leads.filter((l) => isHighIntentTier(l.lead_tier));
  const smsReadyLeads = getSmsReadyLeads(leads);
  const newCount = dbStats?.newLeads ?? leads.filter((l) => l.outreach_status === 'New').length;
  const verifiedCount =
    dbStats?.verifiedLeads ??
    leads.filter((l) => l.website_status === 'Verified' || l.confidence_level === 'Verified').length;
  const projectOppsCount =
    dbStats?.projectOpportunities ?? leads.filter((l) => Boolean(l.project_name)).length;
  const duplicateCount = dbStats?.duplicateCount ?? 0;
  const failedRequestsCount = dbStats?.failedSourceRequests ?? 0;
  const lastRunText = dbStats?.lastSuccessfulRun ? dbStats.lastSuccessfulRun.slice(0, 19).replace('T', ' ') + 'Z' : 'Not yet recorded';

  const estimationCount = leads.filter((l) => l.service_opportunity === 'Construction Estimation').length;
  const architecturalCount = leads.filter((l) => l.service_opportunity === 'Architectural Services').length;
  const millworkCount = leads.filter((l) => l.service_opportunity === 'Millwork Services').length;

  const stateMap = new Map<string, { total: number; hot: number; warm: number }>();
  const tradeMap = new Map<string, number>();
  const sourceMap = new Map<string, number>();

  for (const lead of leads) {
    const st = lead.state || 'Unspecified';
    const cur = stateMap.get(st) || { total: 0, hot: 0, warm: 0 };
    cur.total += 1;
    if (lead.lead_tier === 'Hot') cur.hot += 1;
    if (lead.lead_tier === 'Warm') cur.warm += 1;
    stateMap.set(st, cur);

    const tr = lead.construction_trade || 'General Contractors';
    tradeMap.set(tr, (tradeMap.get(tr) || 0) + 1);

    for (const src of lead.all_sources) {
      sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
    }
  }

  const byState = Array.from(stateMap.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 15);
  const byTrade = Array.from(tradeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 21);
  const bySource = Array.from(sourceMap.entries()).sort((a, b) => b[1] - a[1]);

  if (leads.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
        <h2 className="text-base font-semibold text-slate-900">No leads in SQLite database yet</h2>
        <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
          Run live US public discovery or import a CSV / Excel file to populate real construction intelligence metrics.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Cost Bidding Intelligence Report</h2>
          <p className="text-xs text-slate-500 mt-0.5 font-mono-tabular">
            Real SQLite database figures · Last successful run: {lastRunText}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onExportZoomSms && (
            <button
              type="button"
              onClick={() => onExportZoomSms(leads, `zoom_dialer_sms_${new Date().toISOString().slice(0, 10)}.csv`)}
              disabled={smsReadyLeads.length === 0}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-amber-600 rounded-md hover:bg-amber-700 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Zoom SMS CSV ({smsReadyLeads.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => onExportCsv(highIntentLeads, `hot_warm_leads_${new Date().toISOString().slice(0, 10)}.csv`)}
            disabled={highIntentLeads.length === 0}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Hot &amp; Warm CSV ({highIntentLeads.length})
          </button>
          <button
            type="button"
            onClick={() => onExportCsv(leads, `all_leads_${new Date().toISOString().slice(0, 10)}.csv`)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Full CSV
          </button>
          <button
            type="button"
            onClick={() => onExportExcel(leads, `all_leads_${new Date().toISOString().slice(0, 10)}.xlsx`)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export Excel (.xlsx)
          </button>
        </div>
      </div>

      {/* Primary Pipeline Metrics */}
      <div className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Companies</div>
          <div className="text-xl font-semibold text-slate-900 font-mono-tabular mt-1">{leads.length}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">New Leads</div>
          <div className="text-xl font-semibold text-slate-900 font-mono-tabular mt-1">{newCount}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Verified</div>
          <div className="text-xl font-semibold text-emerald-700 font-mono-tabular mt-1">{verifiedCount}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Hot (80+)</div>
          <div className="text-xl font-semibold text-red-700 font-mono-tabular mt-1">{hotLeads.length}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Warm (60–79)</div>
          <div className="text-xl font-semibold text-amber-700 font-mono-tabular mt-1">{warmLeads.length}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Active Projects</div>
          <div className="text-xl font-semibold text-slate-900 font-mono-tabular mt-1">{projectOppsCount}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Duplicates</div>
          <div className="text-xl font-semibold text-slate-900 font-mono-tabular mt-1">{duplicateCount}</div>
        </div>
        <div className="p-3.5">
          <div className="text-[11px] text-slate-500">Failed Requests</div>
          <div className="text-xl font-semibold text-slate-700 font-mono-tabular mt-1">{failedRequestsCount}</div>
        </div>
      </div>

      {/* Cost Bidding Service Focus */}
      <div className="bg-white border border-slate-200 rounded-lg grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs text-slate-500">Estimation &amp; Takeoffs</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{estimationCount}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Architectural &amp; Bid Support</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{architecturalCount}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Millwork &amp; Casework Takeoffs</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{millworkCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Leads by State */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Leads by State</h3>
            <span className="text-xs text-slate-500 font-mono-tabular">{stateMap.size} states</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500 text-left">
                <th className="py-2.5 px-4 font-medium">State</th>
                <th className="py-2.5 px-3 font-medium text-right">Hot</th>
                <th className="py-2.5 px-3 font-medium text-right">Warm</th>
                <th className="py-2.5 px-4 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byState.map(([st, counts]) => (
                <tr key={st} className="hover:bg-slate-50">
                  <td className="py-2 px-4 font-medium text-slate-900">{st}</td>
                  <td className="py-2 px-3 text-right font-mono-tabular text-red-700">{counts.hot}</td>
                  <td className="py-2 px-3 text-right font-mono-tabular text-amber-700">{counts.warm}</td>
                  <td className="py-2 px-4 text-right font-mono-tabular text-slate-700">{counts.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Leads by Construction Trade */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Leads by Trade</h3>
            <span className="text-xs text-slate-500 font-mono-tabular">{tradeMap.size} trades</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500 text-left">
                <th className="py-2.5 px-4 font-medium">Construction Trade</th>
                <th className="py-2.5 px-4 font-medium text-right">Companies</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byTrade.map(([tr, count]) => (
                <tr key={tr} className="hover:bg-slate-50">
                  <td className="py-2 px-4 font-medium text-slate-900">{tr}</td>
                  <td className="py-2 px-4 text-right font-mono-tabular text-slate-700">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Leads by Source */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Leads by Source</h3>
            <span className="text-xs text-slate-500 font-mono-tabular">{bySource.length} sources</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500 text-left">
                <th className="py-2.5 px-4 font-medium">Public / Imported Source</th>
                <th className="py-2.5 px-4 font-medium text-right">Records</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bySource.map(([src, count]) => (
                <tr key={src} className="hover:bg-slate-50">
                  <td className="py-2 px-4 font-medium text-slate-900">{src}</td>
                  <td className="py-2 px-4 text-right font-mono-tabular text-slate-700">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
