import { createHash } from 'crypto';
import type { MainAgentProvider } from './model-routing';
import { normalizeProviderCacheUsage } from './provider-prompt-cache';
import { writeRuntimeTrace } from './runtime-trace';

export type PromptCacheDiagnostics = {
  version: 1;
  reason: 'first_observation' | 'model_changed' | 'route_changed' | 'tools_changed'
    | 'settings_changed' | 'system_changed' | 'history_changed' | 'prefix_preserved';
  sharedPrefixChars: number;
  requestChars: number;
  addedChars: number;
  previousInputTokens?: number;
  gapMs?: number;
  changedMessageIndex?: number;
};

type Atom = { hash: string; chars: number; message?: number };
type Snapshot = {
  model: string; route: string; settings: string; tools: Atom;
  system: Atom[]; history: Atom[]; chars: number; completedAt: number; inputTokens?: number;
};
const snapshots = new Map<string, Snapshot>();
let storedAtoms = 0;
const countAtoms = (snapshot: Snapshot) => snapshot.system.length + snapshot.history.length + 1;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const serialize = (value: any): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
};
const cleanBlock = (block: any) => {
  if (!block || typeof block !== 'object') return block;
  const { cache_control: _cache, prompt_cache_breakpoint: _boundary, ...content } = block;
  return content;
};
// These are visible-content character counts, never provider token counts.
// Opaque reasoning signatures/IDs are fingerprinted but do not inflate them.
const charsOf = (value: any): number => {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + charsOf(item), 0);
  return Object.entries(value).reduce((sum, [key, item]) => sum
    + (['signature', 'encrypted_content', 'id', 'call_id', 'type', 'role'].includes(key) ? 0 : charsOf(item)), 0);
};
const atom = (value: any, message?: number): Atom => ({ hash: hash(serialize(value)), chars: charsOf(value), message });
const blocks = (content: any): any[] => typeof content === 'string' ? [{ type: 'text', text: content }]
  : Array.isArray(content) ? content.map(cleanBlock) : content == null ? [] : [content];

/** Observe ordinary requests without saving prompt text or making extra API
 * calls. A matching local prefix is evidence of stability, not a cache hit. */
export function beginPromptCacheDiagnostics(input: {
  provider: MainAgentProvider; model: string; scope?: string;
  endpoint: string; apiKey: string; request: Record<string, any>;
}): { report: PromptCacheDiagnostics; complete: (usage: any) => void } | undefined {
  if (!input.scope) return undefined;
  try {
    const scope = hash(`${input.provider}\0${input.scope}`);
    const request = input.request;
    const system = blocks(request.system ?? request.systemInstruction).map(block => atom(block));
    const history: Atom[] = [];
    for (const [index, message] of (request.input || request.messages || request.contents || []).entries()) {
      const { content, output, parts, ...header } = message;
      const target = ['system', 'developer'].includes(message?.role) ? system : history;
      target.push(atom(header, index));
      for (const block of blocks(content ?? output ?? parts)) target.push(atom(block, index));
    }
    const controls = ['tool_choice', 'parallel_tool_calls', 'thinking', 'reasoning', 'reasoning_effort',
      'output_config', 'output_format', 'response_format', 'context_management', 'text', 'thinkingConfig', 'toolConfig'];
    const current: Snapshot = {
      model: input.model,
      route: hash(`${input.endpoint}\0${input.apiKey}\0${request.prompt_cache_key || ''}`),
      settings: hash(serialize(Object.fromEntries(controls.filter(key => request[key] !== undefined).map(key => [key, request[key]])))),
      tools: atom((request.tools || []).map(cleanBlock)),
      system, history, chars: 0, completedAt: 0,
    };
    current.chars = [current.tools, ...system, ...history].reduce((sum, item) => sum + item.chars, 0);
    const previous = snapshots.get(scope);
    const report: PromptCacheDiagnostics = {
      version: 1, reason: 'first_observation', sharedPrefixChars: 0,
      requestChars: current.chars, addedChars: current.chars,
    };
    if (previous) {
      report.previousInputTokens = previous.inputTokens;
      report.gapMs = Math.max(0, Date.now() - previous.completedAt);
      report.reason = previous.model !== current.model ? 'model_changed'
        : previous.route !== current.route ? 'route_changed'
        : previous.settings !== current.settings ? 'settings_changed'
        : previous.tools.hash !== current.tools.hash ? 'tools_changed' : 'prefix_preserved';
      if (report.reason === 'prefix_preserved') {
        report.sharedPrefixChars = current.tools.chars;
        for (const section of ['system', 'history'] as const) {
          const before = previous[section], after = current[section];
          let index = 0;
          while (index < before.length && index < after.length && before[index].hash === after[index].hash) {
            report.sharedPrefixChars += after[index].chars;
            index++;
          }
          const changed = section === 'system' ? index !== before.length || index !== after.length : index !== before.length;
          if (changed) {
            report.reason = section === 'system' ? 'system_changed' : 'history_changed';
            if (section === 'history') report.changedMessageIndex = after[index]?.message ?? before[index]?.message;
            break;
          }
        }
      }
      report.addedChars = Math.max(0, current.chars - report.sharedPrefixChars);
    }
    return { report, complete: (usage: any) => {
      try {
        const measured = normalizeProviderCacheUsage(input.provider, usage);
        current.inputTokens = measured.promptTokensMeasured ? measured.promptTokens : undefined;
        current.completedAt = Date.now();
        const old = snapshots.get(scope);
        if (old) { storedAtoms -= countAtoms(old); snapshots.delete(scope); }
        // Bound fingerprints for long-running servers and many concurrent chats.
        if (countAtoms(current) <= 20_000) {
          snapshots.set(scope, current);
          storedAtoms += countAtoms(current);
        }
        while (snapshots.size > 256 || storedAtoms > 50_000) {
          const oldest = snapshots.keys().next().value;
          if (oldest === undefined) break;
          storedAtoms -= countAtoms(snapshots.get(oldest)!);
          snapshots.delete(oldest);
        }
        writeRuntimeTrace('prompt_cache_diagnostics', {
          provider: input.provider, model: input.model, scopeFingerprint: scope,
          ...report, inputTokens: current.inputTokens,
          cachedTokens: measured.cacheTokensMeasured ? measured.cachedTokens : undefined,
        });
      } catch { /* Observability must never change the provider result. */ }
    } };
  } catch { return undefined; }
}
