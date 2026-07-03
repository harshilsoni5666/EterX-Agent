/**
 * ═══════════════════════════════════════════════════════════════
 * EterX Localhost Proxy — Forward any localhost port into the app
 * Allows the Preview tab to show dev servers like npm run dev
 * Usage: /api/proxy/3001/some/path → http://localhost:3001/some/path
 * ═══════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../../agent/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BLOCKED_PORTS = new Set([22, 25, 465, 587, 3306, 5432, 6379, 27017]);

export async function GET(
  req: NextRequest,
  { params }: { params: { port: string; path: string[] } }
) {
  return proxyRequest(req, params, 'GET');
}

export async function POST(
  req: NextRequest,
  { params }: { params: { port: string; path: string[] } }
) {
  return proxyRequest(req, params, 'POST');
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { port: string; path: string[] } }
) {
  return proxyRequest(req, params, 'PUT');
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { port: string; path: string[] } }
) {
  return proxyRequest(req, params, 'DELETE');
}

async function proxyRequest(
  req: NextRequest,
  params: { port: string; path: string[] },
  method: string
) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const port = parseInt(params.port, 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      return NextResponse.json({ error: 'Invalid port' }, { status: 400 });
    }
    if (BLOCKED_PORTS.has(port)) {
      return NextResponse.json({ error: 'Port not allowed' }, { status: 403 });
    }

    const pathSegments = params.path || [];
    const search = req.nextUrl.search || '';
    const targetPath = '/' + pathSegments.map(decodeURIComponent).join('/') + search;
    const targetUrl = `http://127.0.0.1:${port}${targetPath}`;

    // Forward relevant headers, strip host
    const headers = new Headers();
    for (const [key, val] of req.headers.entries()) {
      if (['host', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) continue;
      headers.set(key, val);
    }
    headers.set('Host', `127.0.0.1:${port}`);

    const body = method !== 'GET' && method !== 'HEAD' ? await req.arrayBuffer() : undefined;

    const response = await fetch(targetUrl, {
      method,
      headers,
      body: body as any,
      redirect: 'follow',
      // @ts-ignore
      signal: AbortSignal.timeout(15000),
    });

    // Read response body
    const responseBody = await response.arrayBuffer();

    // Build response headers — rewrite absolute URLs in HTML/CSS to go through proxy
    const responseHeaders = new Headers();
    for (const [key, val] of response.headers.entries()) {
      if (['transfer-encoding', 'connection', 'keep-alive'].includes(key.toLowerCase())) continue;
      responseHeaders.set(key, val);
    }
    // Allow embedding in iframe
    responseHeaders.delete('x-frame-options');
    responseHeaders.delete('content-security-policy');

    const contentType = response.headers.get('content-type') || '';
    let finalBody: ArrayBuffer | string = responseBody;

    // Rewrite HTML to inject base tag and fix absolute asset paths
    if (contentType.includes('text/html')) {
      let html = new TextDecoder().decode(responseBody);
      const baseHref = `/api/proxy/${port}/`;
      if (!html.includes('<base ')) {
        html = html.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseHref}" />`);
        if (!html.includes('<base ')) {
          html = `<base href="${baseHref}" />\n` + html;
        }
      }
      finalBody = html;
      responseHeaders.set('content-type', 'text/html; charset=utf-8');
    }

    return new NextResponse(finalBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err: any) {
    const msg = err?.message || 'Proxy error';
    const isRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
    return NextResponse.json(
      {
        error: isRefused
          ? `Cannot connect to localhost:${params.port}. Is the dev server running?`
          : `Proxy error: ${msg}`,
        port: params.port,
      },
      { status: isRefused ? 503 : 500 }
    );
  }
}
