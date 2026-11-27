const startCode = new Uint8Array([0, 0, 0, 1]);
const maxAccessUnit = 8 * 1024 * 1024;

function concat(chunks: readonly Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function findStart(bytes: Uint8Array, from: number) {
  for (let index = from; index + 2 < bytes.length; index++) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0) continue;
    if (bytes[index + 2] === 1) return { index, end: index + 3 };
    if (bytes[index + 2] === 0 && bytes[index + 3] === 1) return { index, end: index + 4 };
  }
  return null;
}

export async function drawDeviceVideo(url: string, canvas: HTMLCanvasElement, signal: AbortSignal, onFirstFrame: () => void) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Video display is unavailable in this window.');
  const session = new AbortController();
  const request = AbortSignal.any([signal, session.signal]);
  const startup = setTimeout(() => session.abort(new Error('The device did not start sending video.')), 15_000);
  let hasFrame = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new VideoDecoder({
    output(frame) {
      try {
        if (request.aborted) return;
        const { displayWidth, displayHeight } = frame;
        if (!displayWidth || !displayHeight || displayWidth > 8192 || displayHeight > 8192) {
          session.abort(new Error('The stream has an invalid display size.'));
          return;
        }
        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
          canvas.width = displayWidth;
          canvas.height = displayHeight;
        }
        context.drawImage(frame, 0, 0);
        if (!hasFrame) {
          hasFrame = true;
          clearTimeout(startup);
          onFirstFrame();
        }
      } catch (error) {
        session.abort(error);
      } finally {
        frame.close();
      }
    },
    error(error) { session.abort(error); },
  });

  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  let slices: Uint8Array[] = [];
  let frameBytes = 0;
  let key = false;
  let needsKey = true;
  let codec = '';
  let timestamp = 0;

  function decodePicture() {
    if (!slices.length) return;
    const picture = slices;
    const isKey = key;
    slices = [];
    frameBytes = 0;
    key = false;

    // Recover at the next key frame if rendering falls behind the encoder.
    if (decoder.decodeQueueSize > 12) needsKey = true;
    if (needsKey && !isKey) return;
    if (isKey) {
      if (!sps || sps.length < 4 || !pps) return;
      const nextCodec = 'avc1.' + Array.from(sps.subarray(1, 4), byte => byte.toString(16).padStart(2, '0')).join('');
      if (needsKey || codec !== nextCodec) {
        if (decoder.state === 'configured') decoder.reset();
        decoder.configure({ codec: nextCodec, optimizeForLatency: true });
        codec = nextCodec;
        needsKey = false;
      }
      picture.unshift(sps, pps);
    }
    const data = concat(picture.flatMap(nal => [startCode, nal]));
    decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: timestamp++, data }));
  }

  function readNal(nal: Uint8Array) {
    if (!nal.length) return;
    const kind = nal[0] & 31;
    if (kind === 7 || kind === 8 || kind === 9 || kind === 10 || kind === 11) {
      decodePicture();
      if (kind === 7) sps = nal.slice();
      if (kind === 8) pps = nal.slice();
      return;
    }
    if (kind !== 1 && kind !== 5 || nal.length < 2) return;
    // first_mb_in_slice is Exp-Golomb coded. A leading one means zero and starts a new picture.
    if (nal[1] & 0x80) decodePicture();
    frameBytes += nal.length;
    if (frameBytes > maxAccessUnit || slices.length > 512) throw new Error('The device returned an oversized video frame.');
    slices.push(nal);
    key ||= kind === 5;
  }

  try {
    const response = await fetch(url, { signal: request, cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error('Video could not start.');
    reader = response.body.getReader();
    let remainder = new Uint8Array(0);
    while (!request.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = remainder.length ? concat([remainder, value]) : value;
      let start = findStart(bytes, 0);
      if (!start) {
        remainder = new Uint8Array(bytes.slice(-3));
        continue;
      }
      for (let next = findStart(bytes, start.end); next; next = findStart(bytes, start.end)) {
        readNal(bytes.subarray(start.end, next.index));
        start = next;
      }
      if (bytes.length - start.index > maxAccessUnit) throw new Error('The stream returned an oversized video packet.');
      remainder = new Uint8Array(bytes.slice(start.index));
    }
    request.throwIfAborted();
    if (!hasFrame) throw new Error('The device stream ended before sending a frame.');
  } finally {
    clearTimeout(startup);
    session.abort();
    if (decoder.state !== 'closed') decoder.close();
    void reader?.cancel().catch(() => undefined);
  }
}
