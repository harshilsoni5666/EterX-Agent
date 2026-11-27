import { type NextRequest, NextResponse } from 'next/server';
import { readJsonObject, rejectCrossOrigin } from '../../agent/_shared';
import { saveLiveReceipt } from '../../../../lib/usage/ledger';
import { telemetryClientContext } from '../../../../lib/telemetry/client-context';
import { publicTelemetryModel, recordTelemetry, withTelemetryScope } from '../../../../lib/telemetry/runtime';

export const runtime = 'nodejs';
const providers = new Set(['openai', 'grok', 'gemini', 'deepgram', 'elevenlabs']);
const temporarilyUnavailable = () => NextResponse.json({ error: 'Usage storage temporarily unavailable.' }, { status: 503 });

export async function POST(req: NextRequest) {
  const origin = rejectCrossOrigin(req);
  if (origin) return origin;
  const { kind, provider, model, id, at, usage, outcome, status, durationMs, resumed, resumes } = await readJsonObject(req);
  if (!providers.has(provider) || typeof model !== 'string' || !model.trim() || model.length > 240
      || typeof id !== 'string' || !/^[\w.:-]{1,220}$/.test(id) || !Number.isSafeInteger(at) || at <= 0) {
    return NextResponse.json({ error: 'Invalid live usage receipt.' }, { status: 400 });
  }
  const occurred = Math.min(at, Date.now());
  const client = telemetryClientContext(req);
  if (kind === 'session_started' || kind === 'session_stopped') {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)
        || (kind === 'session_stopped' && status !== 'closed' && status !== 'failed')) {
      return NextResponse.json({ error: 'Invalid live session receipt.' }, { status: 400 });
    }
    const dimensions = { provider, model: publicTelemetryModel(provider, model), feature: 'live', origin: 'interactive' };
    const options = { dimensions, key: 'live-session:' + id, at: occurred };
    if (kind === 'session_started') {
      const started = recordTelemetry('provider.session.started', {
        ...client, interactionMode: 'live', variant: 'voice', sessionCount: 1,
        hasResumeCursor: resumed === true, restartContinuation: resumed === true,
      }, options);
      const feature = recordTelemetry('feature.used', {
        ...client, interactionMode: 'live', variant: 'voice', outcome: 'succeeded',
      }, options);
      if (!started || !feature) return temporarilyUnavailable();
    } else {
      const stopped = recordTelemetry('provider.session.stopped', {
        ...client, interactionMode: 'live', variant: 'voice', terminalStatus: status, durationMs,
        durationReports: Number.isSafeInteger(durationMs) && durationMs >= 0 ? 1 : undefined,
        continuations: resumes, restartContinuation: Number.isSafeInteger(resumes) && resumes > 0,
        lifecycleObserved: true,
      }, options);
      if (!stopped) return temporarilyUnavailable();
    }
    return new Response(null, { status: 204 });
  }
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return NextResponse.json({ error: 'Invalid live usage receipt.' }, { status: 400 });
  }
  try {
    const status = outcome === 'failed' || outcome === 'cancelled' || outcome === 'interrupted' ? outcome : 'succeeded';
    const stored = withTelemetryScope({ origin: 'interactive' }, () => saveLiveReceipt(provider, model, id, occurred, usage, status), {
      ...client, interactionMode: 'live', variant: 'voice',
    });
    if (!stored) return temporarilyUnavailable();
    return new Response(null, { status: 204 });
  } catch {
    return temporarilyUnavailable();
  }
}
