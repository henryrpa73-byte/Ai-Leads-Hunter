import { CONSTRUCTION_TRADES, classifyConstructionTrade, classifyProjectType, inferCostBiddingRelevance } from '../src/lib/trades.ts';
import type { Lead, OllamaSettings } from '../src/types/lead.ts';
import { assertSafeOllamaUrl, readResponseTextWithCap } from './security.ts';

export interface OllamaStatusResponse {
  enabled: boolean;
  reachable: boolean;
  baseUrl: string;
  selectedModel: string;
  models: string[];
  error?: string;
}

export async function getOllamaStatus(settings: OllamaSettings): Promise<OllamaStatusResponse> {
  let safeBase: URL;
  try {
    safeBase = assertSafeOllamaUrl(settings.baseUrl);
  } catch (err) {
    return {
      enabled: settings.enabled,
      reachable: false,
      baseUrl: settings.baseUrl,
      selectedModel: settings.model,
      models: [],
      error: err instanceof Error ? err.message : 'Invalid local Ollama URL.',
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const resp = await fetch(`${safeBase.origin}/api/tags`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) {
        return {
          enabled: settings.enabled,
          reachable: false,
          baseUrl: safeBase.origin,
          selectedModel: settings.model,
          models: [],
          error: `Ollama returned HTTP ${resp.status}`,
        };
      }
      const text = await readResponseTextWithCap(resp, 512 * 1024);
      const parsed = JSON.parse(text) as { models?: Array<{ name?: string }> };
      const models = (parsed.models || [])
        .map((m) => String(m.name || '').trim())
        .filter(Boolean);
      const selectedModel =
        settings.model && models.includes(settings.model)
          ? settings.model
          : models[0] || settings.model || '';
      return {
        enabled: settings.enabled,
        reachable: true,
        baseUrl: safeBase.origin,
        selectedModel,
        models,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return {
      enabled: settings.enabled,
      reachable: false,
      baseUrl: safeBase.origin,
      selectedModel: settings.model,
      models: [],
      error: `Ollama is not running at ${safeBase.origin}. Deterministic rule engine remains active.`,
    };
  }
}

export interface LeadAiAnalysisResult {
  usedOllama: boolean;
  model: string;
  construction_trade: string;
  project_type: string;
  service_opportunity: string;
  ai_summary: string;
  warning?: string;
}

export async function analyzeLeadWithLocalAi(
  lead: Partial<Lead>,
  settings: OllamaSettings,
): Promise<LeadAiAnalysisResult> {
  const combinedText = `${lead.company_name || ''} ${lead.company_category || ''} ${lead.services_offered || ''} ${lead.project_name || ''} ${lead.project_description || ''} ${lead.buying_intent_evidence || ''}`;
  const fallbackTrade = classifyConstructionTrade(combinedText);
  const fallbackType = classifyProjectType(combinedText);
  const fallbackRelevance = inferCostBiddingRelevance(combinedText, fallbackTrade);
  const fallbackSummary = [
    `${lead.company_name || 'Contractor'} operates as ${fallbackTrade} (${lead.city || 'US'}${lead.state ? `, ${lead.state}` : ''}).`,
    lead.project_name
      ? `Active scope "${lead.project_name}" aligns with Cost Bidding LLC ${fallbackRelevance.supportLabel}.`
      : `Recommended Cost Bidding LLC outreach angle: ${fallbackRelevance.supportLabel}.`,
  ].join(' ');

  if (!settings.enabled) {
    return {
      usedOllama: false,
      model: 'deterministic-rules',
      construction_trade: fallbackTrade,
      project_type: fallbackType,
      service_opportunity: fallbackRelevance.serviceOpportunity,
      ai_summary: fallbackSummary,
    };
  }

  let safeBase: URL;
  try {
    safeBase = assertSafeOllamaUrl(settings.baseUrl);
  } catch (err) {
    return {
      usedOllama: false,
      model: 'deterministic-rules',
      construction_trade: fallbackTrade,
      project_type: fallbackType,
      service_opportunity: fallbackRelevance.serviceOpportunity,
      ai_summary: fallbackSummary,
      warning: err instanceof Error ? err.message : 'Invalid Ollama URL',
    };
  }

  const status = await getOllamaStatus(settings);
  const targetModel = status.selectedModel || settings.model;
  if (!status.reachable || !targetModel) {
    return {
      usedOllama: false,
      model: 'deterministic-rules',
      construction_trade: fallbackTrade,
      project_type: fallbackType,
      service_opportunity: fallbackRelevance.serviceOpportunity,
      ai_summary: fallbackSummary,
      warning: status.error || 'No local Ollama model installed.',
    };
  }

  const prompt = [
    'You are a construction lead research analyst for Cost Bidding LLC (estimating, quantity takeoffs, architectural drawings, permit sets, CD sets, millwork shop drawings).',
    'Analyze ONLY the public company/project text below. Never invent phone numbers, emails, names, or URLs.',
    `Allowed construction_trade values: ${CONSTRUCTION_TRADES.join(', ')}.`,
    'Allowed service_opportunity values: Construction Estimation, Architectural Services, Millwork Services.',
    'Respond ONLY with JSON matching: {"construction_trade":"...","project_type":"...","service_opportunity":"...","ai_summary":"2 short factual sentences about why this company fits Cost Bidding LLC"}',
    '',
    `Company: ${lead.company_name || ''}`,
    `Category: ${lead.company_category || ''}`,
    `Location: ${lead.city || ''}, ${lead.state || ''}`,
    `Project: ${lead.project_name || ''}`,
    `Project Description: ${(lead.project_description || '').slice(0, 600)}`,
    `Evidence: ${(lead.buying_intent_evidence || '').slice(0, 400)}`,
  ].join('\n');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(45000, Math.max(5000, settings.timeoutMs || 25000)));
    try {
      const resp = await fetch(`${safeBase.origin}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: targetModel,
          prompt,
          stream: false,
          format: 'json',
          options: { temperature: 0.1, num_predict: 250 },
        }),
      });
      if (!resp.ok) {
        throw new Error(`Ollama generate HTTP ${resp.status}`);
      }
      const rawText = await readResponseTextWithCap(resp, 512 * 1024);
      const outer = JSON.parse(rawText) as { response?: string };
      const parsed = JSON.parse(outer.response || '{}') as {
        construction_trade?: string;
        project_type?: string;
        service_opportunity?: string;
        ai_summary?: string;
      };

      const validTrade = (CONSTRUCTION_TRADES as readonly string[]).includes(parsed.construction_trade || '')
        ? parsed.construction_trade!
        : fallbackTrade;
      const validSvc = [
        'Construction Estimation',
        'Architectural Services',
        'Millwork Services',
      ].includes(parsed.service_opportunity || '')
        ? parsed.service_opportunity!
        : fallbackRelevance.serviceOpportunity;

      return {
        usedOllama: true,
        model: targetModel,
        construction_trade: validTrade,
        project_type: String(parsed.project_type || fallbackType).slice(0, 60),
        service_opportunity: validSvc,
        ai_summary: String(parsed.ai_summary || fallbackSummary).slice(0, 500),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      usedOllama: false,
      model: 'deterministic-rules',
      construction_trade: fallbackTrade,
      project_type: fallbackType,
      service_opportunity: fallbackRelevance.serviceOpportunity,
      ai_summary: fallbackSummary,
      warning: err instanceof Error ? err.message : 'Ollama inference timed out; used rule-based fallback.',
    };
  }
}
