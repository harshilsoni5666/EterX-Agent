import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getEterxDataDir } from '../../../lib/agent/storage-paths';
import { rejectCrossOrigin } from '../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PREFERENCES_DIR = path.join(getEterxDataDir(), 'settings');
const PREFERENCES_FILE = path.join(PREFERENCES_DIR, 'preferences.json');
const PREFERENCES_BACKUP_FILE = path.join(PREFERENCES_DIR, 'preferences.backup.json');
const RESERVED_KEYS = new Set(['eterx_api_keys', 'eterx_model_api_keys']);
const MAX_PREFERENCE_VALUE_BYTES = 10 * 1024 * 1024;

const preserveCorruptPreferences = (source: string) => {
  if (source !== PREFERENCES_FILE || !fs.existsSync(source)) return;
  const preserved = path.join(PREFERENCES_DIR, `preferences.corrupt-${Date.now()}.json`);
  try { fs.renameSync(source, preserved); } catch { }
};

const preferencesGlobal = globalThis as typeof globalThis & {
  __eterxPreferencesWriteChain?: Promise<void>;
};

const runSerializedPreferenceWrite = async <T,>(operation: () => T | Promise<T>): Promise<T> => {
  const previous = preferencesGlobal.__eterxPreferencesWriteChain || Promise.resolve();
  let release!: () => void;
  preferencesGlobal.__eterxPreferencesWriteChain = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    // Keep the serialization lock until an asynchronous atomic replace has
    // finished. Releasing it when the promise is merely created allows two
    // writes to race during a desktop update or shutdown.
    return await operation();
  } finally {
    release();
  }
};

const readPreferences = (): Record<string, string> => {
  for (const source of [PREFERENCES_FILE, PREFERENCES_BACKUP_FILE]) {
    try {
      if (!fs.existsSync(source)) continue;
      const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        preserveCorruptPreferences(source);
        continue;
      }
      return Object.fromEntries(
        Object.entries(parsed)
          .filter(([key, value]) => !RESERVED_KEYS.has(key) && typeof value === 'string')
          .map(([key, value]) => [key, String(value)]),
      );
    } catch {
      preserveCorruptPreferences(source);
    }
  }
  return {};
};

const replaceFileWithRetry = async (temporary: string, target: string) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not atomically replace preferences.');
};

const writePreferences = async (values: Record<string, string>) => {
  fs.mkdirSync(PREFERENCES_DIR, { recursive: true });
  const temporary = `${PREFERENCES_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (fs.existsSync(PREFERENCES_FILE)) {
    try { fs.copyFileSync(PREFERENCES_FILE, PREFERENCES_BACKUP_FILE); } catch { }
  }
  try {
    await replaceFileWithRetry(temporary, PREFERENCES_FILE);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { }
    throw error;
  }
};

export async function GET() {
  return NextResponse.json({ ok: true, values: readPreferences() });
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  try {
    const body = await req.json().catch(() => ({}));
    const submittedValues = body?.values && typeof body.values === 'object' && !Array.isArray(body.values)
      ? body.values as Record<string, unknown>
      : {};
    const oversizedKey = Object.entries(submittedValues).find(([key, value]) => (
      !RESERVED_KEYS.has(key)
      && typeof value === 'string'
      && Buffer.byteLength(value, 'utf8') > MAX_PREFERENCE_VALUE_BYTES
    ));
    if (oversizedKey) {
      return NextResponse.json(
        { ok: false, error: `Preference ${oversizedKey[0]} is too large to save safely.` },
        { status: 413 },
      );
    }
    await runSerializedPreferenceWrite(async () => {
      const current = readPreferences();
      const values = submittedValues;
      for (const [key, value] of Object.entries(values)) {
        if (RESERVED_KEYS.has(key) || key.length > 180 || typeof value !== 'string') continue;
        current[key] = value;
      }
      if (Array.isArray(body?.remove)) {
        body.remove.forEach((key: unknown) => {
          if (typeof key === 'string' && key.length <= 180) delete current[key];
        });
      }
      await writePreferences(current);
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Could not save preferences.' }, { status: 500 });
  }
}
