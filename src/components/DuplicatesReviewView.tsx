import { ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { safeExternalUrl } from '../lib/leadEngine.ts';
import type { DuplicateRelation } from '../types/lead.ts';

interface DuplicatesReviewViewProps {
  onSelectLeadId?: (id: string) => void;
}

export function DuplicatesReviewView({ onSelectLeadId }: DuplicatesReviewViewProps) {
  const [duplicates, setDuplicates] = useState<DuplicateRelation[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDuplicates = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/duplicates');
      if (!resp.ok) return;
      const data = (await resp.json()) as { duplicates?: DuplicateRelation[] };
      setDuplicates(data.duplicates || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  const handleStatusChange = async (
    id: number,
    resolved_status: DuplicateRelation['resolved_status'],
  ) => {
    setDuplicates((prev) =>
      prev.map((d) => (d.id === id ? { ...d, resolved_status } : d)),
    );
    await fetch(`/api/duplicates/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_status }),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Duplicate Review &amp; Preserved Evidence</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Every duplicate company, phone, email, or domain detected during discovery/import is logged here without discarding original source URLs.
          </p>
        </div>
        <button
          type="button"
          onClick={loadDuplicates}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {duplicates.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center">
          <h3 className="text-sm font-semibold text-slate-900">No duplicate collisions recorded yet</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            When discovery runs or CSV/Excel imports encounter an existing company name, domain, phone number, or email, the merged relationship and evidence URL appear here.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <th className="py-2.5 px-4 font-medium">Primary Record</th>
                <th className="py-2.5 px-3 font-medium">Duplicate Signal</th>
                <th className="py-2.5 px-3 font-medium">Match Reason</th>
                <th className="py-2.5 px-3 font-medium">Preserved Source</th>
                <th className="py-2.5 px-3 font-medium">Detected</th>
                <th className="py-2.5 px-4 font-medium text-right">Review Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {duplicates.map((dup) => {
                const safeSrc = safeExternalUrl(dup.source_url);
                return (
                  <tr key={dup.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-4">
                      {onSelectLeadId && dup.primary_lead_id ? (
                        <button
                          type="button"
                          onClick={() => onSelectLeadId(dup.primary_lead_id)}
                          className="font-semibold text-blue-700 hover:underline text-left"
                        >
                          {dup.primary_company_name || dup.primary_lead_id}
                        </button>
                      ) : (
                        <span className="font-semibold text-slate-900">
                          {dup.primary_company_name || dup.primary_lead_id}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="font-medium text-slate-800">{dup.duplicate_company_name || '—'}</div>
                      <div className="text-[11px] font-mono-tabular text-slate-500">
                        {[dup.duplicate_phone, dup.duplicate_email, dup.duplicate_domain]
                          .filter(Boolean)
                          .join(' · ') || 'Name/key match'}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">{dup.match_reason}</td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1.5 text-slate-700">
                        <span>{dup.source_name || 'Public Registry'}</span>
                        {safeSrc && (
                          <a
                            href={safeSrc}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 hover:text-blue-900"
                            aria-label="Open preserved source URL"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono-tabular text-slate-500 whitespace-nowrap">
                      {dup.detected_at.slice(0, 10)}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <select
                        aria-label={`Resolution status for ${dup.duplicate_company_name}`}
                        value={dup.resolved_status}
                        onChange={(e) =>
                          handleStatusChange(
                            dup.id,
                            e.target.value as DuplicateRelation['resolved_status'],
                          )
                        }
                        className="h-7 px-2 text-xs bg-white border border-slate-200 rounded text-slate-700"
                      >
                        <option value="merged">Merged (Evidence Kept)</option>
                        <option value="pending_review">Needs Review</option>
                        <option value="kept_separate">Kept Separate</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
