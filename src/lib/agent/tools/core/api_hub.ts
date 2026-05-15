import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import axios, { AxiosRequestConfig } from 'axios';
import path from 'path';
import fs from 'fs-extra';

/**
 * Smart API Hub — Pre-configured connectors for popular APIs
 * 
 * Resilient: auto-retry with exponential backoff, rate limiting,
 * response caching, and safe API key management.
 */

const CACHE_DIR = path.resolve(process.cwd(), '.workspaces', '.cache', 'api');
const rateLimitMap: Map<string, { count: number, resetAt: number }> = new Map();

export const apiHubTool: ToolDefinition = {
  name: 'smart_api_hub',
  description: `Pre-configured connectors for popular external APIs with auto-retry, caching, and rate limiting.
  
  Built-in connectors:
  - github: GitHub API (repos, issues, PRs, users, search)
  - weather: OpenWeatherMap (current, forecast)
  - news: NewsAPI headlines and search
  - exchangerate: Currency exchange rates
  - ip_geo: IP geolocation
  - jokes: Random jokes/fun facts
  - quotes: Inspirational quotes
  - custom: Any custom API endpoint with full config
  
  Safety features: rate limiting (60 req/min per domain), 5-min response cache, auto-retry with backoff.`,
  category: 'core',
  inputSchema: z.object({
    connector: z.enum(['github', 'weather', 'news', 'exchangerate', 'ip_geo', 'jokes', 'quotes', 'custom'])
      .describe('Which API connector to use'),
    action: z.string().optional().describe('Connector-specific action (e.g., "repos", "search", "forecast")'),
    params: z.string().optional().describe('Optional JSON object string of parameters for the API call'),
    // For custom connector
    url: z.string().optional().describe('Custom API URL (for custom connector only)'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().default('GET'),
    headers: z.string().optional().describe('Optional JSON object string of HTTP headers'),
    body: z.string().optional().describe('Optional request body. Prefer a JSON string for structured payloads.'),
    cacheMinutes: z.number().optional().default(5).describe('Cache duration (0 to disable, default: 5 min)')
  }),
  outputSchema: z.object({ success: z.boolean(), data: z.any(), cached: z.boolean().optional() }),
  execute: async (input: any) => {
    await fs.ensureDir(CACHE_DIR);

    try {
      const params = parseJsonObject(input.params) || {};
      const headers = parseStringRecord(input.headers);
      const body = parseJsonValue(input.body);
      let config: AxiosRequestConfig = { timeout: 30000 };
      let cacheKey = '';

      switch (input.connector) {
        case 'github': {
          const token = process.env.GITHUB_TOKEN || '';
          const base = 'https://api.github.com';
          const headers: any = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'EterX-Agent' };
          if (token) headers['Authorization'] = `token ${token}`;
          
          const action = input.action || 'user';
          const p = params;
          
          let url = '';
          if (action === 'repos') url = `${base}/users/${p.user || 'octocat'}/repos?per_page=${p.limit || 10}&sort=${p.sort || 'updated'}`;
          else if (action === 'repo') url = `${base}/repos/${p.owner}/${p.repo}`;
          else if (action === 'issues') url = `${base}/repos/${p.owner}/${p.repo}/issues?state=${p.state || 'open'}&per_page=${p.limit || 10}`;
          else if (action === 'search') url = `${base}/search/repositories?q=${encodeURIComponent(p.query || '')}&per_page=${p.limit || 5}`;
          else if (action === 'user') url = `${base}/users/${p.user || 'octocat'}`;
          else if (action === 'trending') url = `${base}/search/repositories?q=stars:>1000+created:>${getDateDaysAgo(7)}&sort=stars&per_page=${p.limit || 10}`;
          else url = `${base}/${action}`;
          
          config = { url, headers, method: 'GET' };
          cacheKey = `github_${action}_${JSON.stringify(p)}`;
          break;
        }

        case 'weather': {
          const apiKey = process.env.WEATHER_API_KEY || process.env.OPENWEATHER_KEY || '';
          const city = params.city || 'London';
          const action = input.action || 'current';
          
          if (action === 'forecast') {
            config.url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&cnt=8`;
          } else {
            config.url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
          }
          cacheKey = `weather_${action}_${city}`;
          break;
        }

        case 'news': {
          const apiKey = process.env.NEWS_API_KEY || '';
          const q = params.query || '';
          const category = params.category || 'general';
          const country = params.country || 'us';
          
          if (q) {
            config.url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=${params.limit || 5}&apiKey=${apiKey}`;
          } else {
            config.url = `https://newsapi.org/v2/top-headlines?country=${country}&category=${category}&pageSize=${params.limit || 5}&apiKey=${apiKey}`;
          }
          cacheKey = `news_${q || category}_${country}`;
          break;
        }

        case 'exchangerate': {
          const from = params.from || 'USD';
          const to = params.to || 'EUR';
          config.url = `https://api.exchangerate-api.com/v4/latest/${from}`;
          cacheKey = `fx_${from}`;
          break;
        }

        case 'ip_geo': {
          const ip = params.ip || '';
          config.url = ip ? `http://ip-api.com/json/${ip}` : 'http://ip-api.com/json/';
          cacheKey = `ipgeo_${ip || 'self'}`;
          break;
        }

        case 'jokes': {
          config.url = 'https://official-joke-api.appspot.com/random_joke';
          cacheKey = ''; // Don't cache jokes
          break;
        }

        case 'quotes': {
          config.url = 'https://api.quotable.io/random';
          cacheKey = ''; // Don't cache quotes
          break;
        }

        case 'custom': {
          if (!input.url) return { success: false, data: null, error: 'url is required for custom connector' };
          config = {
            url: input.url,
            method: input.method || 'GET',
            headers,
            data: body,
            timeout: 30000
          };
          cacheKey = input.cacheMinutes ? `custom_${Buffer.from(input.url).toString('base64').substring(0, 40)}` : '';
          break;
        }
      }

      // Check rate limit
      const domain = new URL(config.url || '').hostname;
      if (!checkRateLimit(domain)) {
        return { success: false, data: null, error: `Rate limited: too many requests to ${domain}. Wait and try again.` };
      }

      // Check cache
      const cacheDuration = (input.cacheMinutes ?? 5) * 60 * 1000;
      if (cacheKey && cacheDuration > 0) {
        const cached = await getCachedResponse(cacheKey, cacheDuration);
        if (cached) {
          console.log(`[API Hub] Cache HIT for ${input.connector}:${input.action || 'default'}`);
          return { success: true, data: cached, cached: true };
        }
      }

      // Execute with auto-retry
      console.log(`[API Hub] ${input.connector}:${input.action || 'default'} → ${config.url?.substring(0, 80)}`);
      const response = await retryWithBackoff(config, 3);

      // Cache response
      if (cacheKey && cacheDuration > 0) {
        await setCachedResponse(cacheKey, response.data);
      }

      // Post-process for specific connectors
      let data = response.data;
      if (input.connector === 'exchangerate' && params.to) {
        const rate = data.rates?.[params.to];
        data = { from: params.from || 'USD', to: params.to, rate, amount: params.amount ? params.amount * rate : rate };
      }

      return { success: true, data, cached: false, status: response.status };

    } catch (error: any) {
      return { success: false, data: null, error: `API error: ${error.message}`, status: error.response?.status };
    }
  }
};

// --- Rate Limiter ---
function checkRateLimit(domain: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(domain);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(domain, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 60) return false; // 60 req/min max
  entry.count++;
  return true;
}

// --- Auto-Retry with Backoff ---
async function retryWithBackoff(config: AxiosRequestConfig, maxRetries: number): Promise<any> {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios(config);
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxRetries && (err.response?.status === 429 || err.response?.status >= 500 || !err.response)) {
        const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`[API Hub] Retry ${attempt + 1}/${maxRetries} in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// --- Response Cache ---
async function getCachedResponse(key: string, maxAge: number): Promise<any | null> {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    if (!await fs.pathExists(file)) return null;
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > maxAge) return null;
    return await fs.readJSON(file);
  } catch { return null; }
}

async function setCachedResponse(key: string, data: any): Promise<void> {
  try {
    await fs.writeJSON(path.join(CACHE_DIR, `${key}.json`), data);
  } catch { }
}

function getDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function parseJsonValue(value: any): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseJsonObject(value: any): Record<string, any> | undefined {
  const parsed = parseJsonValue(value);
  if (parsed == null) return undefined;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, any>;
}

function parseStringRecord(value: Record<string, string> | string | undefined): Record<string, string> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized: Record<string, string> = {};
    for (const [key, recordValue] of Object.entries(parsed)) {
      normalized[key] = String(recordValue);
    }
    return normalized;
  } catch {
    return {};
  }
}
