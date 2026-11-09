import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../agent/_shared';
import { applyImport, configureImports, discardImportPreview, getImportJob, getImportStatus, scanImport, syncImports, toggleImportedSetup } from '../../../lib/imports/service';
import { isImportProvider, normalizeImportSelection, type ImportSourceFile } from '../../../lib/imports/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
function guard(request: NextRequest) {
  const denied = rejectCrossOrigin(request);
  if (denied) return denied;
  // Reading the host's assistant history is a local desktop capability.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(request.nextUrl.hostname)) return reply({ error: 'Local imports are available in the desktop app or on localhost.' }, 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site') return reply({ error: 'Cross-site import requests are not allowed.' }, 403);
  return null;
}
export async function GET(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const id = request.nextUrl.searchParams.get('job');
    if (id) { const job = getImportJob(id); return job ? reply({ job }) : reply({ error: 'This operation expired or the server restarted. Scan again to continue.' }, 404); }
    return reply(await getImportStatus());
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Could not read import settings.' }, 500); }
}
export async function POST(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      if (Number(request.headers.get('content-length') || 0) > 64 * 1024 * 1024) return reply({ error: 'Choose files totaling less than 64 MB.' }, 413);
      const form = await request.formData();
      const provider = form.get('provider');
      if (!isImportProvider(provider)) return reply({ error: 'Choose Codex, Claude, or Cursor.' }, 400);
      const files: ImportSourceFile[] = [];
      let size = 0;
      let expandedTotal = 0;
      for (const file of form.getAll('files')) {
        if (typeof file === 'string') continue;
        size += file.size;
        if (size > 64 * 1024 * 1024 || files.length > 2000) throw new Error('Choose files totaling less than 64 MB and 2,000 entries.');
        if (/\.zip$/i.test(file.name)) {
          const AdmZip = require('adm-zip') as new (buffer: Buffer) => { getEntries(): Array<{ entryName: string; isDirectory: boolean; header: { size: number }; getData(): Buffer }> };
          const archive = new AdmZip(Buffer.from(await file.arrayBuffer()));
          for (const entry of archive.getEntries()) {
            if (entry.isDirectory || !/\.(json|jsonl|md|txt|mdc|ya?ml|toml|py|js|mjs|cjs|tsx?|jsx|sh|ps1|csv|html|css|svg|png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|docx|xlsx|pptx|mp3|wav|mp4)$/i.test(entry.entryName)) continue;
            if (/(^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|^[A-Za-z]:/.test(entry.entryName)) continue;
            if (expandedTotal + entry.header.size > 64 * 1024 * 1024 || files.length >= 2000) throw new Error('These archives are too large when expanded. Export a smaller selection.');
            const data = entry.getData();
            expandedTotal += data.length;
            if (expandedTotal > 64 * 1024 * 1024) throw new Error('These archives are too large when expanded.');
            const binary = /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|docx|xlsx|pptx|mp3|wav|mp4)$/i.test(entry.entryName);
            files.push({ name: `${file.name.replace(/[\\/]/g, '_').replace(/\.zip$/i, '')}/${entry.entryName}`, content: data.toString(binary ? 'base64' : 'utf8'), ...(binary ? { encoding: 'base64' as const } : {}) });
          }
        } else {
          if (!/\.(json|jsonl|md|txt|mdc|toml)$/i.test(file.name)) throw new Error('Choose JSON, JSONL, Markdown, TOML, text, or ZIP exports.');
          files.push({ name: file.name, content: await file.text() });
          expandedTotal += file.size;
          if (expandedTotal > 64 * 1024 * 1024) throw new Error('Choose files totaling less than 64 MB when expanded.');
        }
      }
      if (!files.length) throw new Error('Choose at least one supported export file.');
      return reply({ job: scanImport(provider, [], files) }, 202);
    }
    if (Number(request.headers.get('content-length') || 0) > 2 * 1024 * 1024) return reply({ error: 'Import request is too large.' }, 413);
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid import request.');
    if (body.action === 'scan') {
      if (!isImportProvider(body.provider)) throw new Error('Choose a supported source.');
      const roots = Array.isArray(body.roots) ? body.roots.filter((value: unknown): value is string => typeof value === 'string' && value.length < 4096) : [];
      return reply({ job: scanImport(body.provider, roots) }, 202);
    }
    if (body.action === 'import') {
      const folder = typeof body.folder === 'string' ? body.folder.trim().replace(/[\x00-\x1f]/g, '').slice(0, 80) : null;
      return reply({ job: applyImport(String(body.previewId || ''), normalizeImportSelection(body.selection), folder) }, 202);
    }
    if (body.action === 'configure') {
      return reply(await configureImports({
        ...(typeof body.autoSync === 'boolean' ? { autoSync: body.autoSync } : {}),
        ...(isImportProvider(body.provider) ? { provider: body.provider } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(body.selection ? { selection: normalizeImportSelection(body.selection) } : {}),
      }));
    }
    if (body.action === 'discard') { discardImportPreview(String(body.previewId || '')); return reply({ ok: true }); }
    if (body.action === 'setup') {
      if (typeof body.enabled !== 'boolean') throw new Error('Choose whether this item is enabled.');
      return reply({ entry: await toggleImportedSetup(String(body.id || ''), body.enabled) });
    }
    if (body.action === 'sync') return reply({ job: await syncImports(isImportProvider(body.provider) ? body.provider : undefined, body.automatic === true) });
    return reply({ error: 'Unknown import operation.' }, 400);
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Could not complete the import.' }, 400); }
}
