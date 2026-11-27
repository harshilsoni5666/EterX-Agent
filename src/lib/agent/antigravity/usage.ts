import { lstatSync } from 'node:fs';
import { openReadonlyDatabase } from '../../imports/sqlite-reader';

type Fields = Map<number, Array<number | Uint8Array>>;

function decodeFields(bytes: Uint8Array): Fields {
  let cursor = 0;
  const fields: Fields = new Map();
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = bytes[cursor++];
      if (byte === undefined) break;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error('Invalid Antigravity usage metadata.');
  };
  while (cursor < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!field || !Number.isSafeInteger(tag)) throw new Error('Invalid Antigravity usage field.');
    let value: number | Uint8Array;
    if (wire === 0) value = varint();
    else if (wire === 2 || wire === 1 || wire === 5) {
      const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (size > bytes.length - cursor) throw new Error('Truncated Antigravity usage field.');
      value = bytes.subarray(cursor, cursor + size);
      cursor += size;
      if (wire !== 2) continue;
    } else throw new Error('Unknown Antigravity usage encoding.');
    const previous = fields.get(field);
    if (previous) previous.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

const counts = (fields: Fields, field: number): number => {
  const value = fields.get(field)?.[0];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

function message(fields: Fields, field: number) {
  const bytes = fields.get(field)?.[0];
  return bytes instanceof Uint8Array ? decodeFields(bytes) : undefined;
}

// Older ACP responses omit turn token counts. Read just the numeric usage
// fields recorded by the native runtime for this EterX-created conversation.
export function readAntigravityTurnUsage(file: string) {
  let db: ReturnType<typeof openReadonlyDatabase> | undefined;
  try {
    if (!lstatSync(file).isFile()) return undefined;
    db = openReadonlyDatabase(file);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const sources = [
      { table: 'gen_metadata', query: 'SELECT hex(data) AS metadata FROM gen_metadata WHERE length(data) BETWEEN 1 AND 8388608', generated: true },
      { table: 'steps', query: 'SELECT hex(metadata) AS metadata FROM steps WHERE length(metadata) BETWEEN 1 AND 8388608', generated: false },
    ];
    for (const source of sources) {
      if (!tables.has(source.table)) continue;
      let input = 0;
      let cached = 0;
      let written = 0;
      let output = 0;
      let reasoning = 0;
      const seen = new Set<string>();
      for (const row of db.prepare(source.query).iterate()) {
        const root = decodeFields(Buffer.from(row.metadata, 'hex'));
        const metadata = source.generated ? message(root, 1) : root;
        if (!metadata) continue;
        const usages = [message(metadata, source.generated ? 4 : 9)];
        for (const retry of metadata.get(source.generated ? 17 : 28) || []) {
          if (retry instanceof Uint8Array) usages.push(message(decodeFields(retry), 2));
        }
        for (const usage of usages) {
          if (!usage) continue;
          const identities = [7, 11, 12].flatMap(field => {
            const id = usage.get(field)?.[0];
            return id instanceof Uint8Array && id.length ? [`${field}:${Buffer.from(id).toString('base64')}`] : [];
          });
          const duplicate = identities.some(id => seen.has(id));
          for (const id of identities) seen.add(id);
          if (duplicate) continue;
          const read = counts(usage, 5);
          const write = counts(usage, 4);
          const thought = counts(usage, 9);
          input += counts(usage, 2) + read + write;
          cached += read;
          written += write;
          output += Math.max(counts(usage, 3), thought + counts(usage, 10));
          reasoning += thought;
        }
      }
      if (input || output) return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
        prompt_tokens_details: { cached_tokens: cached }, cache_write_tokens: written,
        completion_tokens_details: { reasoning_tokens: reasoning } };
    }
  } catch { /* An absent or unsupported native usage store leaves token counts unavailable. */ }
  finally { try { db?.close(); } catch { /* Usage must not affect the turn outcome. */ } }
}
