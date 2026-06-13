import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { lookup as dnsLookup } from 'dns/promises';
import type { LookupAddress } from 'dns';
import * as net from 'net';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

const BLOCKED_METADATA_IPV4 = new Set([
  '100.100.100.200',
  '168.63.129.16',
  '169.254.169.254',
]);

const BLOCKED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SENSITIVE_REQUEST_HEADER = /authorization|cookie|token|secret|api[-_]?key|x-api-key/i;
const SENSITIVE_QUERY_PARAM = /access[_-]?token|api[_-]?key|apikey|auth|authorization|client[_-]?secret|code|key|password|secret|token/i;

type ValidatedUrl = {
  url: URL;
  addresses: LookupAddress[];
};

type LookupOptions = number | {
  family?: number;
  all?: boolean;
};

export async function assertPublicHttpUrl(rawUrl: string | URL): Promise<URL> {
  return (await validatePublicHttpUrl(rawUrl)).url;
}

export async function safeAxiosRequest<T = any>(
  config: AxiosRequestConfig,
  context?: any,
): Promise<AxiosResponse<T>> {
  if (context?.networkPolicy === 'deny' && context?.allowNetwork !== true) {
    throw new Error('Network access is disabled for this tool context');
  }

  if (!config.url) throw new Error('Network request requires a URL');

  const maxRedirects = normalizeRedirectLimit(config.maxRedirects);
  let requestConfig: AxiosRequestConfig = { ...config };
  let currentUrl = String(config.url);
  let redirects = 0;

  while (true) {
    const validated = await validatePublicHttpUrl(currentUrl);
    const sanitizedHeaders = sanitizeHeaders(requestConfig.headers, validated.url, context);
    const sanitizedAuth = sanitizeAuth(requestConfig.auth, validated.url, context);
    const validateStatus = requestConfig.validateStatus;

    const response = await axios.request<T>({
      ...requestConfig,
      url: validated.url.toString(),
      headers: sanitizedHeaders,
      auth: sanitizedAuth,
      proxy: requestConfig.proxy ?? false,
      timeout: requestConfig.timeout ?? DEFAULT_TIMEOUT_MS,
      maxContentLength: requestConfig.maxContentLength ?? DEFAULT_MAX_BYTES,
      maxBodyLength: requestConfig.maxBodyLength ?? DEFAULT_MAX_BYTES,
      maxRedirects: 0,
      validateStatus: status => isRedirectStatus(status) || (validateStatus ? validateStatus(status) : status >= 200 && status < 300),
      lookup: createPinnedSafeLookup(validated),
    } as AxiosRequestConfig & { lookup: any });

    if (!isRedirectStatus(response.status)) return response;

    const location = response.headers.location;
    if (!location) return response;
    if (redirects >= maxRedirects) {
      throw new Error(`Blocked redirect after ${maxRedirects} hops`);
    }

    const nextUrl = new URL(Array.isArray(location) ? location[0] : String(location), validated.url);
    requestConfig = prepareRedirectConfig(requestConfig, response.status, validated.url, nextUrl);
    currentUrl = nextUrl.toString();
    redirects++;
  }
}

export function redactUrlForLog(rawUrl: string | URL | undefined): string {
  if (!rawUrl) return '';
  try {
    const url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(String(rawUrl));
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAM.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return String(rawUrl).replace(/([?&][^=&]*(?:token|key|secret|password|auth)[^=]*=)[^&\s]+/gi, '$1REDACTED');
  }
}

async function validatePublicHttpUrl(rawUrl: string | URL): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Blocked URL with embedded credentials');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error('Blocked URL without hostname');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`Blocked private host: ${hostname}`);
  }

  const addresses = await resolvePublicAddresses(hostname);
  return { url, addresses };
}

async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  const ipFamily = net.isIP(hostname);
  if (ipFamily) {
    assertPublicIp(hostname);
    return [{ address: hostname, family: ipFamily }];
  }

  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Could not resolve host: ${hostname}`);

  for (const address of addresses) {
    assertPublicIp(address.address, hostname);
  }

  return addresses;
}

function createPinnedSafeLookup(validated: ValidatedUrl) {
  return async (hostname: string, options: LookupOptions = {}): Promise<LookupAddress | LookupAddress[]> => {
    const opts = typeof options === 'object' && options !== null ? options : {};
    const normalized = normalizeHostname(hostname);
    const addresses = normalized === normalizeHostname(validated.url.hostname)
      ? validated.addresses
      : await resolvePublicAddresses(normalized);
    const family = typeof options === 'number' ? options : (opts.family ? Number(opts.family) : 0);
    const filtered = family ? addresses.filter(address => address.family === family) : addresses;
    const selected = filtered[0] || addresses[0];
    if (!selected) throw new Error(`Could not resolve host: ${normalized}`);

    return opts.all ? (filtered.length ? filtered : addresses) : selected;
  };
}

function assertPublicIp(ip: string, hostname?: string): void {
  if (isBlockedIp(ip)) {
    const suffix = hostname ? ` for host ${hostname}` : '';
    throw new Error(`Blocked private or reserved IP address${suffix}: ${ip}`);
  }
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  if (BLOCKED_METADATA_IPV4.has(ip)) return true;

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;

  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 192 && b === 88 && parts[2] === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;

  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return true;

  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeRedirectLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_REDIRECTS;
  return Math.max(0, Math.min(Math.floor(value), DEFAULT_MAX_REDIRECTS));
}

function prepareRedirectConfig(config: AxiosRequestConfig, status: number, fromUrl: URL, toUrl: URL): AxiosRequestConfig {
  const next: AxiosRequestConfig = { ...config };
  const method = String(next.method || 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
    next.method = 'GET';
    delete next.data;
    next.headers = removeBodyHeaders(next.headers);
  }
  if (fromUrl.origin !== toUrl.origin) {
    next.headers = removeSensitiveHeaders(next.headers);
    delete next.auth;
  }
  return next;
}

function removeBodyHeaders(headers: any): any {
  if (!headers) return headers;
  const plain = typeof headers.toJSON === 'function' ? headers.toJSON() : { ...headers };
  for (const key of Object.keys(plain)) {
    if (/^content-(type|length)$/i.test(key)) delete plain[key];
  }
  return plain;
}

function removeSensitiveHeaders(headers: any): any {
  if (!headers) return headers;
  const plain = typeof headers.toJSON === 'function' ? headers.toJSON() : { ...headers };
  for (const key of Object.keys(plain)) {
    if (SENSITIVE_REQUEST_HEADER.test(key)) delete plain[key];
  }
  return plain;
}

function sanitizeHeaders(headers: any, url: URL, context?: any): any {
  if (!headers) return headers;

  const plain = typeof headers.toJSON === 'function' ? headers.toJSON() : { ...headers };
  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(plain)) {
    const name = String(rawName).trim();
    const lower = name.toLowerCase();
    if (!name) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Blocked unsafe HTTP header name: ${rawName}`);
    }
    if (BLOCKED_REQUEST_HEADERS.has(lower)) {
      throw new Error(`Blocked unsafe HTTP header: ${name}`);
    }

    const value = Array.isArray(rawValue) ? rawValue.map(String).join(', ') : String(rawValue ?? '');
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`Blocked unsafe HTTP header value for: ${name}`);
    }
    if (url.protocol === 'http:' && SENSITIVE_REQUEST_HEADER.test(name) && context?.allowInsecureAuthHeaders !== true) {
      throw new Error(`Blocked sensitive header over plain HTTP: ${name}`);
    }

    sanitized[name] = value;
  }

  return sanitized;
}

function sanitizeAuth(auth: AxiosRequestConfig['auth'], url: URL, context?: any): AxiosRequestConfig['auth'] {
  if (!auth) return auth;
  if (url.protocol === 'http:' && context?.allowInsecureAuthHeaders !== true) {
    throw new Error('Blocked HTTP basic auth over plain HTTP');
  }
  return auth;
}
