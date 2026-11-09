import { readFile } from 'node:fs/promises';
import { Decompress } from 'fzstd';

export class TranscriptSizeLimit extends Error {
  constructor() { super('The expanded transcript exceeds the import size limit.'); }
}

// Bound each frame's advertised window before the decoder allocates it. Walk
// block lengths (without interpreting payloads) to cover concatenated frames.
function boundFrames(data: Buffer, limit: number) {
  let offset = 0, declaredBytes = BigInt(0);
  const requireBytes = (count: number) => { if (offset + count > data.length) throw new Error('Incomplete Zstandard frame.'); };
  while (offset < data.length) {
    requireBytes(4);
    const magic = data.readUInt32LE(offset); offset += 4;
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      requireBytes(4); const length = data.readUInt32LE(offset); offset += 4;
      requireBytes(length); offset += length; continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('Invalid Zstandard frame.');
    requireBytes(1);
    const flags = data[offset++], single = Boolean(flags & 32), sizeFlag = flags >>> 6;
    if (flags & 8) throw new Error('Unsupported Zstandard frame header.');
    let window = 0;
    if (!single) {
      requireBytes(1); const descriptor = data[offset++], base = 2 ** (10 + (descriptor >>> 3));
      window = base + (base / 8) * (descriptor & 7);
    }
    const dictionaryBytes = [0, 1, 2, 4][flags & 3];
    requireBytes(dictionaryBytes); offset += dictionaryBytes;
    const sizeBytes = sizeFlag ? 2 ** sizeFlag : single ? 1 : 0;
    requireBytes(sizeBytes);
    const size = sizeBytes === 8 ? data.readBigUInt64LE(offset) : sizeBytes ? BigInt(data.readUIntLE(offset, sizeBytes) + (sizeFlag === 1 ? 256 : 0)) : BigInt(0);
    offset += sizeBytes; declaredBytes += size;
    if (declaredBytes > BigInt(limit) || (single ? size > BigInt(limit) : window > limit)) throw new TranscriptSizeLimit();
    let last = false;
    while (!last) {
      requireBytes(3); const block = data.readUIntLE(offset, 3); offset += 3;
      last = Boolean(block & 1);
      const kind = (block >>> 1) & 3;
      if (kind === 3) throw new Error('Invalid Zstandard block.');
      const length = kind === 1 ? 1 : block >>> 3;
      requireBytes(length); offset += length;
    }
    if (flags & 4) { requireBytes(4); offset += 4; }
  }
}

/** Stream archived source data with the same expanded-byte budget as JSONL.
 * The pure-JS decoder also works in desktop runtimes without Node Zstandard. */
export async function readCompressedTranscript(file: string, limit: number): Promise<Buffer> {
  const compressed = await readFile(file);
  boundFrames(compressed, limit);
  const chunks: Buffer[] = [];
  let size = 0;
  const decoder = new Decompress(chunk => {
    size += chunk.byteLength;
    if (size > limit) throw new TranscriptSizeLimit();
    if (chunk.byteLength) chunks.push(Buffer.from(chunk));
  });
  for (let offset = 0; offset < compressed.length; offset += 64 * 1024) decoder.push(compressed.subarray(offset, offset + 64 * 1024));
  decoder.push(new Uint8Array(0), true);
  return Buffer.concat(chunks, size);
}
