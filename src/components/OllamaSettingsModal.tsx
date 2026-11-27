import { Bot, RefreshCw, Terminal, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { OllamaSettings } from '../types/lead.ts';

interface OllamaStatusResponse {
  enabled?: boolean;
  reachable: boolean;
  baseUrl: string;
  selectedModel?: string;
  models: string[];
  error?: string;
  settings: OllamaSettings;
}

interface OllamaSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved?: (settings: OllamaSettings, reachable: boolean) => void;
}

export function OllamaSettingsModal({
  isOpen,
  onClose,
  onSettingsSaved,
}: OllamaSettingsModalProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<OllamaStatusResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434');
  const [model, setModel] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/ai/ollama/status');
      const data = (await resp.json()) as OllamaStatusResponse;
      setStatus(data);
      if (data.settings) {
        setEnabled(Boolean(data.settings.enabled));
        setBaseUrl(data.settings.baseUrl || 'http://localhost:11434');
        setModel(data.settings.model || data.selectedModel || data.models?.[0] || '');
      }
    } catch {
      setFeedback({ type: 'error', text: 'Could not reach local server AI settings endpoint.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadStatus();
    }
  }, [isOpen, loadStatus]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const resp = await fetch('/api/ai/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          baseUrl: baseUrl.trim() || 'http://localhost:11434',
          model: model.trim(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setFeedback({ type: 'error', text: data.error || 'Could not save Ollama settings.' });
        return;
      }
      setStatus({ ...data.status, settings: data.settings });
      setFeedback({
        type: 'info',
        text: data.settings.enabled
          ? data.status.reachable
            ? `Local Ollama connected (${data.status.models.length} local model(s) ready).`
            : 'Settings saved. Ollama is currently offline—deterministic rule engine remains active.'
          : 'Local AI disabled. Application is running 100% on deterministic Python/TS rules.',
      });
      onSettingsSaved?.(data.settings, Boolean(data.status?.reachable));
    } catch {
      setFeedback({ type: 'error', text: 'Network error while saving AI settings.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ollama-settings-title"
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Bot className="w-5 h-5 text-slate-800 shrink-0 mt-0.5" />
            <div>
              <h2 id="ollama-settings-title" className="text-base font-semibold text-slate-900">
                Local AI Engine (Optional Ollama)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                100% free &amp; private on your machine. Zero cloud API keys, zero data transmitted externally.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Ollama settings"
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-slate-50 border border-slate-200 rounded-md">
            <div>
              <span className="font-semibold text-slate-900">Connection Status: </span>
              <span
                className={
                  status?.reachable ? 'font-semibold text-emerald-700' : 'font-medium text-slate-600'
                }
              >
                {loading
                  ? 'Checking http://localhost:11434...'
                  : status?.reachable
                    ? `Online (${status.models.length} local model${status.models.length === 1 ? '' : 's'} discovered)`
                    : 'Not Running (Deterministic rule engine active)'}
              </span>
            </div>
            <button
              type="button"
              onClick={loadStatus}
              disabled={loading}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              Discover Models
            </button>
          </div>

          <label className="flex items-start gap-2.5 p-3 border border-slate-200 rounded-md cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
            />
            <div>
              <div className="font-semibold text-slate-900">Enable Local Ollama AI Enrichment</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                When enabled and Ollama is running locally, classifies construction trades, project types, Cost Bidding opportunities, and research summaries on demand. Turn off anytime to run purely on fast deterministic rules.
              </div>
            </div>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="ollama-url" className="block font-medium text-slate-700 mb-1">
                Local Ollama Endpoint (Loopback Only)
              </label>
              <input
                id="ollama-url"
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="w-full h-9 px-3 text-xs font-mono-tabular bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div>
              <label htmlFor="ollama-model" className="block font-medium text-slate-700 mb-1">
                Local Open-Source Model
              </label>
              {status?.models && status.models.length > 0 ? (
                <select
                  id="ollama-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full h-9 px-2.5 text-xs font-mono-tabular bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  {status.models.map((mName) => (
                    <option key={mName} value={mName}>
                      {mName}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="ollama-model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. qwen2.5:3b or llama3.2:3b"
                  className="w-full h-9 px-3 text-xs font-mono-tabular bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              )}
            </div>
          </div>

          {!status?.reachable && (
            <div className="border border-slate-200 rounded-md p-3.5 bg-slate-50/80 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                <Terminal className="w-3.5 h-3.5" />
                Optional Local Ollama Setup Guide (100% Free)
              </div>
              <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-600 leading-relaxed">
                <li>
                  Install Ollama locally from <span className="font-mono-tabular text-slate-900">ollama.com</span> (no account or API key required).
                </li>
                <li>
                  Pull a lightweight open-source model: <code className="bg-white border border-slate-200 px-1.5 py-0.5 rounded font-mono-tabular text-slate-900">ollama pull qwen2.5:3b</code>
                </li>
                <li>
                  Ensure Ollama is listening on <code className="bg-white border border-slate-200 px-1.5 py-0.5 rounded font-mono-tabular text-slate-900">http://localhost:11434</code>, then click <strong>Discover Models</strong> above.
                </li>
              </ol>
              <p className="text-[11px] text-slate-500">
                Note: Local processing speed depends on your CPU/RAM/GPU hardware. Discovery, scoring, deduplication, and CSV/Excel exports all work without Ollama.
              </p>
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

        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-100"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save AI Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
