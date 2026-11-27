import { open, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { meterModelResponse } from '../../usage/ledger';
import { normalizeAttachmentMime } from '../attachment-pipeline';
import type { ProjectContext } from '../schemas';
import { requestToolApproval } from '../tool-approval-runtime';
import { askUserTool } from '../tools/core/ask_user';
import { getRuntimeScratchRoot, getRuntimeWorkspaceRoot } from '../workspace/path_resolver';
import { recordAntigravityUsage, withAntigravitySession } from './provider';
import { antigravityUsageFile } from './profiles';
import { modelThinking, selectSessionModel, setSessionMode, thinkingOption } from './session-config';
import type { MainAgentThinkingLevel } from '../model-routing';
import { readAntigravityTurnUsage } from './usage';

type Attachment = { name?: string; path?: string; mimeType: string; data?: string; inlineData?: { data?: string } | string };
type History = { role: string; text: string };
type Trace = (event: Record<string, unknown>) => void;
type Turn = {
  chatId?: string;
  model: string;
  prompt: string;
  instruction: string;
  history?: History[];
  attachments?: Attachment[];
  thinking?: MainAgentThinkingLevel;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onThought?: (text: string) => void;
  onContextUsage?: Trace;
  mcpServers?: unknown[];
  auxiliary?: boolean;
  agent?: { context: ProjectContext; trace?: Trace };
};

type Content = Record<string, unknown>;
const CANCELLED = { outcome: { outcome: 'cancelled' } };
const IMAGE_MIME = /^image\/(?:png|jpeg|webp|bmp)$/;
const AUDIO_MIME = /^audio\/(?:aac|flac|mp3|mpeg|mp4|m4a|x-m4a|ogg|wav|x-wav|webm)$/;
const TEXT_MIME = /^(?:text\/|application\/(?:json|ld\+json|javascript|typescript|xml|yaml|x-yaml|x-sh)$)/;
const TEXT_EXT = /\.(?:md|txt|jsonl|toml|csv|tsv|tsx?|jsx?|mjs|cjs|html|css|py|go|rs|java|kt|sh|ps1|sql|log|diff|patch)$/i;

function attachmentKind(name: string, mime: string) {
  if (IMAGE_MIME.test(mime)) return 'image';
  if (AUDIO_MIME.test(mime)) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (TEXT_MIME.test(mime) || TEXT_EXT.test(name)) return 'text';
  return 'unsupported';
}

async function attachmentBlocks(files: Attachment[], capabilities: any, canReadFiles: boolean): Promise<Content[]> {
  const blocks: Content[] = [];
  const mib = 1024 * 1024;
  let total = 0;
  for (const file of files) {
    const name = file.name || path.basename(file.path || 'attachment');
    const mimeType = normalizeAttachmentMime(name, file.mimeType);
    const kind = attachmentKind(name, mimeType);
    const limit = (kind === 'image' ? 10 : kind === 'audio' ? 20 : kind === 'text' ? 1 : 50) * mib;
    const supported = kind === 'image' || kind === 'audio' ? capabilities?.[kind] === true
      : kind !== 'unsupported' && capabilities?.embeddedContext === true;
    const location = file.path && path.isAbsolute(file.path) ? file.path : null;
    if (!supported) {
      if (canReadFiles && location && kind === 'unsupported' && !/^(?:image|audio|video)\//.test(mimeType)) {
        blocks.push({ type: 'text', text: `Attached file ${JSON.stringify(name)} is at ${JSON.stringify(location)}.` });
        continue;
      }
      throw new Error(`Antigravity does not accept ${name} as a native input for this session.`);
    }
    const inline = typeof file.inlineData === 'string' ? file.inlineData : file.inlineData?.data;
    const data = (file.data || inline || '').replace(/^data:[^,]+,/, '');
    if (!data && !location) throw new Error(`Antigravity could not read the attachment ${name}.`);
    const size = data ? Buffer.byteLength(data, 'base64') : (await stat(location!)).size;
    if (size > limit || total + size > 50 * mib) throw new Error(`The attachment ${name} exceeds Antigravity’s input size limit.`);
    total += size;
    const uri = location ? pathToFileURL(location).href : `file:///attachment/${encodeURIComponent(name)}`;
    if (kind === 'pdf' && location) {
      blocks.push({ type: 'resource_link', uri, name, mimeType, size });
      continue;
    }
    let bytes: Buffer;
    if (data) bytes = Buffer.from(data, 'base64');
    else {
      const handle = await open(location!, 'r');
      try {
        if (!(await handle.stat()).isFile()) throw new Error(`Antigravity could not read the attachment ${name}.`);
        const buffer = Buffer.alloc(size + 1);
        const { bytesRead } = await handle.read({ buffer });
        if (bytesRead > size) throw new Error(`The attachment ${name} changed while it was being read.`);
        bytes = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    }
    if (kind === 'image' || kind === 'audio') blocks.push({ type: kind, mimeType, data: bytes.toString('base64') });
    else if (kind === 'pdf') blocks.push({ type: 'resource', resource: { uri, mimeType, blob: bytes.toString('base64') } });
    else {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      blocks.push({ type: 'resource', resource: { uri, mimeType, text: new TextDecoder(encoding, { fatal: true }).decode(bytes) } });
    }
  }
  return blocks;
}

function measuredUsage(response: any) {
  const raw = response?.usage ?? response?._meta?.usage ?? response?._meta?.antigravity?.usage;
  if (!raw || typeof raw !== 'object') return undefined;
  const counts: Record<string, unknown> = {
    prompt_tokens: raw.inputTokens ?? raw.promptTokens ?? raw.input_tokens,
    completion_tokens: raw.outputTokens ?? raw.completionTokens ?? raw.output_tokens,
    total_tokens: raw.totalTokens ?? raw.total_tokens,
    cached_tokens: raw.cachedReadTokens ?? raw.cacheReadTokens ?? raw.cachedInputTokens,
    cache_write_tokens: raw.cachedWriteTokens ?? raw.cacheWriteTokens,
    reasoning_tokens: raw.thoughtTokens ?? raw.reasoningTokens,
  };
  const usage = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0));
  return Object.keys(usage).length ? usage : undefined;
}

async function permission(params: any, turn: Turn, signal: AbortSignal) {
  const agent = turn.agent;
  if (!agent || signal.aborted) return CANCELLED;
  const call = params?.toolCall;
  const title = String(call?.title || 'Antigravity action').slice(0, 240);
  const options: Array<{ optionId: string; name: string; kind?: string }> = (Array.isArray(params?.options) ? params.options : [])
    .filter((option: any) => typeof option?.optionId === 'string' && typeof option?.name === 'string');
  const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
  if (String(call?.toolCallId || '').startsWith('interaction_')) {
    if (!options.length) return CANCELLED;
    const result = await askUserTool.execute({ question: title, mode: 'choice', options: options.map(option => ({
      label: option.name.slice(0, 160), value: option.optionId,
    })) }, { ...agent.context, chatId: turn.chatId, abortSignal: signal, _onTrace: agent.trace });
    const choice = options.find(option => option.optionId === (result.selectedOption?.value || result.answer));
    return result.success && choice ? selected(choice.optionId) : CANCELLED;
  }
  if (agent.context.planMode && !['read', 'search'].includes(call?.kind)) return CANCELLED;
  const allow = options.find(option => option.kind === 'allow_once');
  if (!allow) return CANCELLED;
  const raw = call?.rawInput;
  const blocked = await requestToolApproval('antigravity', {
    title, kind: call?.kind, paths: call?.locations?.map?.((location: any) => location?.path),
    request: raw && typeof raw === 'object' ? raw : String(raw ?? '').slice(0, 4_000),
  }, { ...agent.context, abortSignal: signal }, { label: title, requireScope: true });
  if (!blocked) return selected(allow.optionId);
  const reject = options.find(option => option.kind === 'reject_once');
  return reject && !signal.aborted ? selected(reject.optionId) : CANCELLED;
}

export async function runAntigravityTurn(turn: Turn) {
  const controller = new AbortController();
  const signal = turn.signal ? AbortSignal.any([turn.signal, controller.signal]) : controller.signal;
  const context = turn.agent?.context;
  const cwd = context ? getRuntimeWorkspaceRoot(context) : path.join(getRuntimeScratchRoot({ chatId: turn.chatId }), 'antigravity');
  const explicitWorkspace = context && (('workspacePath' in context && context.workspacePath) || ('paths' in context && Array.isArray(context.paths) && context.paths.length));
  if (explicitWorkspace) {
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error(`The selected Antigravity workspace is unavailable: ${cwd}`);
  } else await mkdir(cwd, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const toolStates = new Map<string, { started: number; title: string; kind?: string; status: string; filename?: string }>();
  const turnId = context?.subAgentTurnId || context?.turnId || context?.runId;
  const trace = turn.agent?.trace;
  let text = '';
  const instruction = [turn.instruction, !context ? 'Respond as a conversational assistant. Use the supplied text and attachments. Do not invoke tools or run commands.' :
    context.planMode ? 'Produce a plan. Do not edit files, run commands, or make external changes.' : 'Use the selected workspace for files and commands. Respect the client’s approval decisions.'].filter(Boolean).join('\n\n');
  try {
    return await withAntigravitySession({
      cwd, signal, instruction, mcpServers: turn.mcpServers, onPermission: params => permission(params, turn, signal),
      onUpdate(update) {
        const delta = update?.content?.type === 'text' ? String(update.content.text || '') : '';
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': text += delta; turn.onText?.(delta); break;
          case 'agent_thought_chunk': if (delta) turn.onThought?.(delta); break;
          case 'usage_update': {
            const { used, size } = update;
            if (Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(size) && size > 0) {
              turn.onContextUsage?.({ type: 'context_usage', provider: 'antigravity', model: turn.model,
                usedTokens: used, contextWindow: size, modelContextWindow: size, providerCalibrationApplied: true, timestamp: Date.now() });
            }
            break;
          }
          case 'tool_call':
          case 'tool_call_update': {
            if (!trace || typeof update.toolCallId !== 'string') break;
            const previous = toolStates.get(update.toolCallId);
            const location = update.locations?.find?.((item: any) => typeof item?.path === 'string')?.path;
            const tool = {
              started: previous?.started ?? Date.now(), title: String(update.title || previous?.title || 'Antigravity action').slice(0, 240),
              kind: update.kind || previous?.kind, status: String(update.status || previous?.status || 'pending'),
              filename: location || previous?.filename,
            };
            toolStates.set(update.toolCallId, tool);
            const closed = ['completed', 'failed'].includes(tool.status);
            const type = tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move' ? 'file_edit'
              : tool.kind === 'read' || tool.kind === 'search' ? 'exploration' : 'tool_call';
            const toolCallId = `antigravity:${turnId || tool.started}:${update.toolCallId}`;
            trace({ type, id: toolCallId, toolCallId, filename: tool.filename,
              toolName: 'antigravity', text: tool.title, status: closed ? tool.status : 'running', startTime: tool.started,
              ...(closed ? { endTime: Date.now() } : {}), isStreaming: !closed, timestamp: Date.now() });
            break;
          }
        }
      },
    }, async (client, { accountId, info, session, appended }) => {
      await setSessionMode(client, session, context && !context.planMode ? 'default' : 'plan');
      const current = await selectSessionModel(client, session, turn.model);
      const thinking = thinkingOption(current);
      const effort = turn.thinking && modelThinking(current, turn.model)?.wireValues?.[turn.thinking];
      if (thinking && effort && effort !== thinking.currentValue) {
        await client.request('session/set_config_option', { sessionId: client.sessionId, configId: thinking.id, value: effort });
      }
      const history = turn.history?.length ? `Earlier messages for context\n${JSON.stringify(turn.history)}\n\n` : '';
      const prompt: Content[] = [{ type: 'text', text: `${appended ? '' : `${instruction}\n\n`}${history}Current request\n${turn.prompt}` }];
      prompt.push(...await attachmentBlocks(turn.attachments || [], info.agentCapabilities?.promptCapabilities, Boolean(context)));
      const { response: usage, usageId } = await meterModelResponse('antigravity', turn.model, async () => {
        const result = await client.request('session/prompt', { sessionId: client.sessionId, prompt }, 15 * 60_000);
        if (result?.stopReason === 'cancelled') throw new Error('CANCELLED_BY_USER');
        const usage = measuredUsage(result);
        if (usage) return usage;
        const file = antigravityUsageFile(accountId, client.sessionId);
        if (!file) return undefined;
        if (info.agentCapabilities?.sessionCapabilities?.close != null) {
          await client.request('session/close', { sessionId: client.sessionId }, 2_000).catch(() => undefined);
        }
        signal.throwIfAborted();
        return readAntigravityTurnUsage(file);
      }, usage => ({ usage }), signal);
      recordAntigravityUsage(accountId, turn.model, usage, !turn.auxiliary);
      if (!text.trim() && !context?.askUserInbox?.hasWork) throw new Error('Antigravity ended the turn without a text response.');
      return { text: text.trim(), usage: usage ? { ...usage, eterxUsageId: usageId } : undefined };
    });
  } finally {
    controller.abort();
  }
}
