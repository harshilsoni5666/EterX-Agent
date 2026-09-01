// Google documents this sentinel for histories that contain a function call
// which was not accompanied by a provider-issued signature. It disables only
// signature validation for that step; authentic signatures are always kept
// byte-for-byte and are preferred whenever the model returned one.
export const GEMINI_SIGNATURE_VALIDATION_BYPASS = 'skip_thought_signature_validator';

function makeGeminiFunctionCallStepReplayable(turn: any): any {
  if (turn?.role !== 'model' || !Array.isArray(turn.parts)) return turn;
  const firstFunctionCallIndex = turn.parts.findIndex((part: any) => !!part?.functionCall);
  if (firstFunctionCallIndex < 0) return turn;

  const firstFunctionCallPart = turn.parts[firstFunctionCallIndex];
  if (typeof firstFunctionCallPart?.thoughtSignature === 'string' && firstFunctionCallPart.thoughtSignature) {
    return turn;
  }

  // A parallel call group intentionally has a signature only on its first
  // functionCall. Never add signatures to the remaining calls and never move a
  // signature from a different Part, because signatures are position-bound.
  const parts = [...turn.parts];
  parts[firstFunctionCallIndex] = {
    ...firstFunctionCallPart,
    thoughtSignature: GEMINI_SIGNATURE_VALIDATION_BYPASS,
  };
  return { ...turn, parts };
}

function geminiCallMatchesResponse(call: any, response: any): boolean {
  if (!call || !response) return false;
  const callId = String(call.id || '').trim();
  const responseId = String(response.id || '').trim();
  if (callId && responseId) return callId === responseId;
  const callName = String(call.name || '').trim();
  const responseName = String(response.name || '').trim();
  return Boolean(callName && responseName && callName === responseName);
}

/**
 * Normalize Gemini turns without ever manufacturing provider protocol parts.
 * Gemini 3 thought signatures are opaque and live on the original model parts;
 * recreating a missing functionCall produces an unsigned call that the provider
 * rejects. Authentic parts are therefore retained by reference, while an
 * orphaned functionResponse left behind by rolling/compaction is omitted.
 */
export function sanitizeGeminiHistory(rawContents: any[]): any[] {
  const normalized: any[] = [];
  for (const turn of rawContents) {
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === turn.role) {
      previous.parts.push(...turn.parts);
    } else {
      normalized.push({ ...turn, parts: [...turn.parts] });
    }
  }

  const sanitized: any[] = [];
  for (const turn of normalized) {
    let parts = turn.parts;
    if (turn.role === 'user' && parts.some((part: any) => part?.functionResponse)) {
      const previous = sanitized[sanitized.length - 1];
      const precedingCalls = previous?.role === 'model' && Array.isArray(previous.parts)
        ? previous.parts.map((part: any) => part?.functionCall).filter(Boolean)
        : [];
      parts = parts.filter((part: any) => {
        const response = part?.functionResponse;
        return !response || precedingCalls.some((call: any) => geminiCallMatchesResponse(call, response));
      });
    }
    if (parts.length === 0) continue;

    const previous = sanitized[sanitized.length - 1];
    if (previous?.role === turn.role) previous.parts.push(...parts);
    else sanitized.push({ ...turn, parts: [...parts] });
  }
  return sanitized.map(makeGeminiFunctionCallStepReplayable);
}
