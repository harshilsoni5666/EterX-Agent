import { distillEvidence } from './memory/evidence-distiller';

const DEFAULT_RETAIN_RECENT_TOOL_TURNS = 6;
const DEFAULT_STALE_RESULT_CHARS = 3_200;

type CompactedEvidence = {
  __eterxContextDigest: true;
  originalChars: number;
  status: string;
  evidence: string;
};

function compactEvidence(value: unknown, query: string, maxChars: number): unknown {
  if (value && typeof value === 'object' && (value as any).__eterxContextDigest === true) return value;
  const digest = distillEvidence(value, query, maxChars);
  if (digest.originalChars <= maxChars) return value;
  const compacted: CompactedEvidence = {
    __eterxContextDigest: true,
    originalChars: digest.originalChars,
    status: digest.status,
    evidence: digest.text,
  };
  return compacted;
}

function geminiToolResultTurn(turn: any): boolean {
  return Array.isArray(turn?.parts) && turn.parts.some((part: any) => part?.functionResponse);
}

/**
 * Shrink only stale tool payloads that the model has already consumed. Recent
 * protocol pairs remain byte-for-byte intact. The extractive digest preserves
 * paths, identifiers, errors, decisions, and values without inventing facts.
 */
export function compactStaleGeminiHistory(
  contents: any[],
  query: string,
  retainRecentToolTurns = DEFAULT_RETAIN_RECENT_TOOL_TURNS,
  maxResultChars = DEFAULT_STALE_RESULT_CHARS,
): any[] {
  const toolTurnIndexes = contents.map((turn, index) => geminiToolResultTurn(turn) ? index : -1).filter(index => index >= 0);
  const staleIndexes = new Set(toolTurnIndexes.slice(0, Math.max(0, toolTurnIndexes.length - retainRecentToolTurns)));
  if (staleIndexes.size === 0) return contents;

  return contents.map((turn, index) => {
    if (!staleIndexes.has(index) || !Array.isArray(turn?.parts)) return turn;
    const parts = turn.parts.map((part: any) => {
      if (part?.functionResponse) {
        const response = part.functionResponse.response || {};
        return {
          ...part,
          functionResponse: {
            ...part.functionResponse,
            response: {
              ...response,
              output: compactEvidence(response.output, query, maxResultChars),
            },
          },
        };
      }
      if (part?.inlineData?.data) {
        return { text: `[Older inline ${part.inlineData.mimeType || 'media'} omitted after it was inspected.]` };
      }
      return part;
    });
    return { ...turn, parts };
  });
}

function providerToolResultTurn(message: any): boolean {
  if (message?.role === 'tool') return true;
  return message?.role === 'user' && Array.isArray(message?.content)
    && message.content.some((block: any) => block?.type === 'tool_result');
}

export function compactStaleProviderHistory(
  messages: any[],
  query: string,
  retainRecentToolTurns = DEFAULT_RETAIN_RECENT_TOOL_TURNS,
  maxResultChars = DEFAULT_STALE_RESULT_CHARS,
): any[] {
  const toolTurnIndexes = messages.map((message, index) => providerToolResultTurn(message) ? index : -1).filter(index => index >= 0);
  const staleIndexes = new Set(toolTurnIndexes.slice(0, Math.max(0, toolTurnIndexes.length - retainRecentToolTurns)));
  if (staleIndexes.size === 0) return messages;

  return messages.map((message, index) => {
    if (!staleIndexes.has(index)) return message;
    if (message?.role === 'tool') {
      const compacted = compactEvidence(message.content, query, maxResultChars);
      return { ...message, content: typeof compacted === 'string' ? compacted : JSON.stringify(compacted) };
    }
    if (!Array.isArray(message?.content)) return message;
    return {
      ...message,
      content: message.content.map((block: any) => {
        if (block?.type === 'tool_result') {
          const compacted = compactEvidence(block.content, query, maxResultChars);
          return { ...block, content: typeof compacted === 'string' ? compacted : JSON.stringify(compacted) };
        }
        if ((block?.type === 'image' || block?.type === 'input_image') && block?.source?.data) {
          return { type: 'text', text: '[Older inline image omitted after it was inspected.]' };
        }
        return block;
      }),
    };
  });
}

const ROLLED_HISTORY_PREFIX = '[SYSTEM - ROLLED EXECUTION HISTORY]';
const ROLLED_HISTORY_ACK = 'Rolled execution history loaded. Continuing from the retained recent turns.';

function providerMessageText(message: any): string {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((block: any) => block?.type === 'text' ? String(block.text || '') : '').join('\n');
}

function stripPriorRolledHistory(messages: any[]): any[] {
  let removedMarker = false;
  return messages.filter(message => {
    const text = providerMessageText(message);
    if (text.startsWith(ROLLED_HISTORY_PREFIX)) {
      removedMarker = true;
      return false;
    }
    if (removedMarker && message?.role === 'assistant' && text === ROLLED_HISTORY_ACK) {
      removedMarker = false;
      return false;
    }
    removedMarker = false;
    return true;
  });
}

/** Local rolling state transfer for provider loops; no extra model call. */
export function rollProviderHistory(
  messages: any[],
  ledgerSummary: string,
  provider: 'anthropic' | 'openai',
  maxConversationMessages = 18,
  keepRecentMessages = 12,
): any[] {
  if (!ledgerSummary) return messages;
  const clean = stripPriorRolledHistory(messages);
  const systems = clean.filter(message => message?.role === 'system');
  const conversation = clean.filter(message => message?.role !== 'system');
  if (conversation.length <= maxConversationMessages) return clean;

  let start = Math.max(0, conversation.length - keepRecentMessages);
  if (conversation[start]?.role === 'tool') {
    while (start > 0 && conversation[start]?.role === 'tool') start--;
    if (start > 0) start--;
  }
  const firstContent = conversation[start]?.content;
  if (Array.isArray(firstContent) && firstContent.some((block: any) => block?.type === 'tool_result') && start > 0) {
    start--;
  }
  const tail = conversation.slice(start);
  const marker = `${ROLLED_HISTORY_PREFIX}\n${ledgerSummary}\n[END ROLLED EXECUTION HISTORY]`;

  if (provider === 'anthropic') {
    const capsule = { role: 'user', content: [{ type: 'text', text: marker }] };
    return tail[0]?.role === 'user'
      ? [capsule, { role: 'assistant', content: [{ type: 'text', text: ROLLED_HISTORY_ACK }] }, ...tail]
      : [capsule, ...tail];
  }
  const capsule = { role: 'user', content: marker };
  return tail[0]?.role === 'user'
    ? [...systems, capsule, { role: 'assistant', content: ROLLED_HISTORY_ACK }, ...tail]
    : [...systems, capsule, ...tail];
}
