import dns from 'node:dns/promises';
import net from 'node:net';
import type { Request, Response, NextFunction } from 'express';

export const USER_AGENT = 'ConstructionLeadHunter/1.0 (+public-research)';

export function isPrivateIp(ip: string): boolean {
  const low = ip.toLowerCase().trim();
  if (low.startsWith('::ffff:')) {
    return isPrivateIp(low.slice(7));
  }
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  return (
    low === '::1' ||
    low === '::' ||
    low.startsWith('fc') ||
    low.startsWith('fd') ||
    low.startsWith('fe80')
  );
}

export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS URLs are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    throw new Error('Localhost and internal hostnames are not allowed.');
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error('Private or loopback IP addresses are not allowed.');
  }
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (records.length === 0) {
    throw new Error('Hostname could not be resolved.');
  }
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new Error('Private or loopback IP addresses are not allowed.');
    }
  }
  return parsed;
}

export function assertSafeOllamaUrl(rawUrl: string): URL {
  const candidate = (rawUrl || 'http://localhost:11434').trim();
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:') {
    throw new Error('Local Ollama endpoint must use http://.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    throw new Error('Local Ollama endpoint is restricted to localhost / 127.0.0.1 for data privacy.');
  }
  return new URL(`${parsed.protocol}//${parsed.host}`);
}

export async function readResponseTextWithCap(resp: globalThis.Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = resp.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes * 2) {
      throw new Error(`Response exceeded max size limit (${maxBytes} bytes).`);
    }
  }
  if (!resp.body) {
    return (await resp.text()).slice(0, maxBytes);
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - total;
        if (remaining <= 0) break;
        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(slice);
        total += slice.byteLength;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

export async function safeFetchPublic(
  rawUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  } = {},
): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  text: string;
}> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 4;

  let currentUrl = (await assertSafePublicUrl(rawUrl)).toString();
  const method = options.method || 'GET';

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(currentUrl, {
        method: hop === 0 ? method : 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          ...(options.headers || {}),
        },
        body: hop === 0 ? options.body : undefined,
      });

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        await resp.body?.cancel().catch(() => {});
        if (!loc || hop === maxRedirects) {
          throw new Error(`Redirect limit or missing Location header from ${new URL(currentUrl).hostname}`);
        }
        const resolved = new URL(loc, currentUrl).toString();
        currentUrl = (await assertSafePublicUrl(resolved)).toString();
        continue;
      }

      const text = await readResponseTextWithCap(resp, maxBytes);
      return {
        ok: resp.ok,
        status: resp.status,
        finalUrl: currentUrl,
        text,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects.');
}

export async function fetchJsonPublic(
  rawUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<unknown> {
  const result = await safeFetchPublic(rawUrl, {
    ...options,
    maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!result.ok) {
    throw new Error(`HTTP ${result.status} from ${new URL(result.finalUrl).hostname}`);
  }
  return JSON.parse(result.text);
}

export function createRateLimiter(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (hits.get(ip) || []).filter((ts) => ts > cutoff);
    if (recent.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests in a short window. Please pause briefly and try again.',
      });
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 2000) {
      for (const [k, list] of hits.entries()) {
        if (list.every((t) => t <= cutoff)) hits.delete(k);
      }
    }
    next();
  };
}
