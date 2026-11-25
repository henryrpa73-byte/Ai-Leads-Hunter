import { Check, Copy, Download, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  CRM_PLATFORMS,
  type CrmPlatform,
  leadsToCrmCsv,
  leadsToCrmJson,
  mapLeadsToCrmRecords,
} from '../lib/crmSync.ts';
import type { Lead } from '../types/lead.ts';

interface CrmSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedLeads: Lead[];
  warmLeads: Lead[];
  onSyncComplete: (leadIds: string[], summaryText: string, markQueued: boolean) => void;
}

type SyncStatusMap = Record<CrmPlatform, boolean>;

export function CrmSyncModal({
  isOpen,
  onClose,
  selectedLeads,
  warmLeads,
  onSyncComplete,
}: CrmSyncModalProps) {
  const [platform, setPlatform] = useState<CrmPlatform>('hubspot');
  const [scope, setScope] = useState<'selected' | 'warm'>(
    selectedLeads.length > 0 ? 'selected' : 'warm',
  );
  const [webhookUrl, setWebhookUrl] = useState('');
  const [markQueued, setMarkQueued] = useState(true);
  const [configuredMap, setConfiguredMap] = useState<SyncStatusMap>({
    hubspot: false,
    salesforce: false,
    pipedrive: false,
    zoho: false,
    webhook: false,
  });
  const [syncingApi, setSyncingApi] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setScope(selectedLeads.length > 0 ? 'selected' : 'warm');
    setFeedback(null);
    fetch('/api/crm/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.configured) {
          setConfiguredMap((prev) => ({ ...prev, ...data.configured }));
        }
      })
      .catch(() => {
        // Keep defaults if offline
      });
  }, [isOpen, selectedLeads.length]);

  const targetLeads = useMemo(() => {
    const base = scope === 'selected' && selectedLeads.length > 0 ? selectedLeads : warmLeads;
    return base.slice(0, 100);
  }, [scope, selectedLeads, warmLeads]);

  const platformMeta = useMemo(
    () => CRM_PLATFORMS.find((p) => p.id === platform) || CRM_PLATFORMS[0],
    [platform],
  );

  const samplePayload = useMemo(() => {
    if (targetLeads.length === 0) return '';
    return JSON.stringify(mapLeadsToCrmRecords([targetLeads[0]], platform)[0], null, 2);
  }, [targetLeads, platform]);

  if (!isOpen) return null;

  const isServerConfigured = configuredMap[platform];
  const canPushJsonApi =
    targetLeads.length > 0 &&
    (platform === 'webhook' ? Boolean(webhookUrl.trim() || isServerConfigured) : isServerConfigured);

  const triggerDownload = (content: string, mime: string, filename: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportCrmCsv = () => {
    if (targetLeads.length === 0) return;
    const csv = leadsToCrmCsv(targetLeads, platform);
    const filename = `${platformMeta.csvFilePrefix}_${new Date().toISOString().slice(0, 10)}.csv`;
    triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
    onSyncComplete(
      targetLeads.map((l) => l.id),
      `Exported ${targetLeads.length} lead(s) as ${platformMeta.name} CSV.`,
      markQueued,
    );
    setFeedback({
      type: 'info',
      text: `Downloaded ${filename} (${targetLeads.length} ${platformMeta.name} rows).`,
    });
  };

  const handleDownloadJson = () => {
    if (targetLeads.length === 0) return;
    const json = leadsToCrmJson(targetLeads, platform);
    const filename = `${platformMeta.csvFilePrefix}_${new Date().toISOString().slice(0, 10)}.json`;
    triggerDownload(json, 'application/json;charset=utf-8;', filename);
    setFeedback({
      type: 'info',
      text: `Downloaded ${filename} (${targetLeads.length} JSON records).`,
    });
  };

  const handleCopyJson = async () => {
    if (targetLeads.length === 0) return;
    try {
      await navigator.clipboard.writeText(leadsToCrmJson(targetLeads, platform));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 1800);
    } catch {
      setFeedback({ type: 'error', text: 'Clipboard copy was blocked by browser permissions.' });
    }
  };

  const handlePushJsonApi = async () => {
    if (targetLeads.length === 0) return;
    setSyncingApi(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/crm/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          webhookUrl: platform === 'webhook' ? webhookUrl.trim() : undefined,
          leads: targetLeads,
        }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        syncedCount?: number;
        message?: string;
        error?: string;
      };
      if (!resp.ok || !data.ok) {
        setFeedback({ type: 'error', text: data.error || 'CRM API sync failed.' });
        return;
      }
      const msg = data.message || `Synced ${data.syncedCount || targetLeads.length} leads to ${platformMeta.name}.`;
      setFeedback({ type: 'info', text: msg });
      onSyncComplete(
        targetLeads.map((l) => l.id),
        msg,
        markQueued,
      );
    } catch {
      setFeedback({ type: 'error', text: 'Could not reach the CRM sync endpoint.' });
    } finally {
      setSyncingApi(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="crm-sync-title"
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div>
            <h2 id="crm-sync-title" className="text-base font-semibold text-slate-900">
              Sync High-Intent Leads to CRM
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Export field-mapped CSV files or push directly via server-side JSON API.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Sync to CRM modal"
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 text-xs">
          {/* Scope Selector */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-md p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={selectedLeads.length === 0}
                onClick={() => setScope('selected')}
                className={`px-3 py-1.5 font-medium rounded border transition-colors disabled:opacity-40 ${
                  scope === 'selected' && selectedLeads.length > 0
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                Selected Rows ({selectedLeads.length})
              </button>
              <button
                type="button"
                disabled={warmLeads.length === 0}
                onClick={() => setScope('warm')}
                className={`px-3 py-1.5 font-medium rounded border transition-colors disabled:opacity-40 ${
                  scope === 'warm' || selectedLeads.length === 0
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                All Warm Leads ({warmLeads.length})
              </button>
            </div>

            <div className="font-mono-tabular text-slate-600">
              Ready: <strong className="text-slate-900">{targetLeads.length}</strong> lead(s)
              {scope === 'warm' && warmLeads.length > 100 ? ' (max 100/batch)' : ''}
            </div>
          </div>

          {/* CRM Platform Grid */}
          <div className="space-y-2">
            <div className="font-semibold text-slate-700">1. Choose CRM Platform</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {CRM_PLATFORMS.map((item) => {
                const active = platform === item.id;
                const serverReady = configuredMap[item.id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setPlatform(item.id);
                      setFeedback(null);
                    }}
                    className={`p-3 rounded-md border text-left transition-colors ${
                      active
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{item.name}</span>
                      {serverReady && (
                        <span className="text-[10px] font-medium text-emerald-700">API Ready</span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{item.tagline}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* JSON API / Webhook Options */}
          <div className="space-y-2.5 border border-slate-200 rounded-md p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">
                2. {platformMeta.name} Export &amp; JSON API Sync
              </span>
              <span className="font-mono-tabular text-[11px] text-slate-500">
                {platformMeta.endpointSummary}
              </span>
            </div>

            {platform === 'webhook' ? (
              <div>
                <label htmlFor="crm-webhook-url" className="block text-[11px] text-slate-600 mb-1">
                  Public HTTPS Destination URL {isServerConfigured ? '(or leave blank to use server CRM_WEBHOOK_URL)' : ''}
                </label>
                <input
                  id="crm-webhook-url"
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.zapier.com/hooks/catch/..."
                  className="w-full h-9 px-3 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            ) : (
              <p className="text-[11px] text-slate-600">
                {isServerConfigured ? (
                  <span className="text-emerald-700 font-medium">
                    Server credentials detected ({platformMeta.envHint}). Direct JSON API push is active.
                  </span>
                ) : (
                  <>
                    Download {platformMeta.name}-mapped CSV or JSON right away, or set{' '}
                    <code className="font-mono-tabular bg-slate-100 px-1 py-0.5 rounded text-slate-800">
                      {platformMeta.envHint}
                    </code>{' '}
                    in server Secrets to enable direct JSON API push.
                  </>
                )}
              </p>
            )}

            <label className="inline-flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={markQueued}
                onChange={(e) => setMarkQueued(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              Update synced leads&apos; Outreach Status to &quot;Queued&quot;
            </label>
          </div>

          {/* Live Mapped Payload Preview */}
          {samplePayload && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>Mapped {platformMeta.name} Record Preview (1st lead)</span>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="inline-flex items-center gap-1 text-slate-700 hover:text-slate-900 font-medium"
                >
                  {copiedJson ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  {copiedJson ? 'Copied All JSON' : 'Copy Full JSON'}
                </button>
              </div>
              <pre className="p-3 bg-slate-900 text-slate-100 rounded-md text-[11px] font-mono-tabular overflow-x-auto max-h-36">
                {samplePayload}
              </pre>
            </div>
          )}

          {feedback && (
            <div
              role="status"
              className={`px-3 py-2 rounded-md border text-xs ${
                feedback.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-900'
              }`}
            >
              {feedback.text}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportCrmCsv}
              disabled={targetLeads.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-100 disabled:opacity-40 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {platformMeta.name} CSV
            </button>
            <button
              type="button"
              onClick={handleDownloadJson}
              disabled={targetLeads.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-100 disabled:opacity-40 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              JSON File
            </button>
          </div>

          <button
            type="button"
            onClick={handlePushJsonApi}
            disabled={!canPushJsonApi || syncingApi}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            <Send className="w-3.5 h-3.5" />
            {syncingApi ? 'Syncing...' : `Push via ${platformMeta.name} API`}
          </button>
        </div>
      </div>
    </div>
  );
}
