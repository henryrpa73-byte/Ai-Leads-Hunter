import { Download } from 'lucide-react';
import { getSmsReadyLeads } from '../lib/leadEngine.ts';
import type { Lead } from '../types/lead.ts';

interface DailyReportViewProps {
  leads: Lead[];
  onExportCsv: (rows: Lead[], filename: string) => void;
  onExportExcel: (rows: Lead[], filename: string) => void;
  onExportZoomSms?: (rows: Lead[], filename: string) => void;
}

export function DailyReportView({ leads, onExportCsv, onExportExcel, onExportZoomSms }: DailyReportViewProps) {
  const warmLeads = leads.filter((l) => l.lead_tier === 'Warm');
  const potentialLeads = leads.filter((l) => l.lead_tier === 'Potential');
  const smsReadyLeads = getSmsReadyLeads(leads);
  const estimationCount = leads.filter((l) => l.service_opportunity === 'Construction Estimation').length;
  const architecturalCount = leads.filter((l) => l.service_opportunity === 'Architectural Services').length;
  const millworkCount = leads.filter((l) => l.service_opportunity === 'Millwork Services').length;

  const stateMap = new Map<string, { total: number; warm: number }>();
  const sourceMap = new Map<string, number>();

  for (const lead of leads) {
    const st = lead.state || 'Unspecified';
    const cur = stateMap.get(st) || { total: 0, warm: 0 };
    cur.total += 1;
    if (lead.lead_tier === 'Warm') cur.warm += 1;
    stateMap.set(st, cur);

    for (const src of lead.all_sources) {
      sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
    }
  }

  const byState = Array.from(stateMap.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 12);

  const bySource = Array.from(sourceMap.entries()).sort((a, b) => b[1] - a[1]);

  if (leads.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
        <h2 className="text-base font-semibold text-slate-900">No leads in pipeline yet</h2>
        <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
          Run live US public discovery or import a CSV / Excel file from your local Python pipeline to generate today&apos;s report.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Daily Pipeline Report</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Live breakdown of discovered contractors, service opportunities, and verified sources
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
            onClick={() => onExportCsv(warmLeads, `warm_leads_${new Date().toISOString().slice(0, 10)}.csv`)}
            disabled={warmLeads.length === 0}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Warm CSV ({warmLeads.length})
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

      {/* Service Opportunity Breakdown */}
      <div className="bg-white border border-slate-200 rounded-lg grid grid-cols-1 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs text-slate-500">Total Discovered</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{leads.length}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Warm Leads (70+)</div>
          <div className="text-2xl font-semibold text-amber-700 font-mono-tabular mt-1">{warmLeads.length}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Estimation Opportunities</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{estimationCount}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Architectural Opportunities</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{architecturalCount}</div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Millwork Opportunities</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono-tabular mt-1">{millworkCount}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                <th className="py-2.5 px-4 font-medium text-right">Warm</th>
                <th className="py-2.5 px-4 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byState.map(([st, counts]) => (
                <tr key={st} className="hover:bg-slate-50">
                  <td className="py-2.5 px-4 font-medium text-slate-900">{st}</td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular text-amber-700">{counts.warm}</td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular text-slate-700">{counts.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Leads by Source */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Leads by Data Source</h3>
            <span className="text-xs text-slate-500 font-mono-tabular">{potentialLeads.length} potential</span>
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
                  <td className="py-2.5 px-4 font-medium text-slate-900">{src}</td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular text-slate-700">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
