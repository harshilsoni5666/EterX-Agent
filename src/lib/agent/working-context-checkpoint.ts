import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import fs from 'fs-extra';
import { open as openFile } from 'fs/promises';
import { visibleUserRequest } from '../chat-user-payload';
import { stableScopeSegment } from './context-scope';
import { getEterxWorkspaceDir } from './storage-paths';
import type { ContextFabric } from './context-fabric';

type WireKind = 'gemini' | 'anthropic' | 'compatible';
type Checkpoint = {
  version: 1;
  scope: string;
  provider: string;
  model: string;
  kind: WireKind;
  /** Canonical admission identity and legacy working-record recovery completed. */
  lineageVersion?: 2;
  runId?: string;
  /** Visible dialogue covered by this working transcript, including its root request. */
  dialogue: string[];
  contents: any[];
  calibration?: { inputTokens: number; localTokens: number };
  fabricRevision?: number;
};
const zip = promisify(gzip);
const unzip = promisify(gunzip);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_BYTES = 128 * 1024 * 1024;
const CAPSULE = '[SYSTEM - COMPACTED CONTEXT CAPSULE ';

/** Admission metadata, not text-pattern guessing, identifies the visible root. */
export const resolveWorkingContextRequest = (context: any, runtimeRequest: string, fallback = runtimeRequest): string => {
  const admitted = context?.workingContextRequest;
  return admitted?.runtimeText === runtimeRequest && typeof admitted.visibleText === 'string'
    ? admitted.visibleText : fallback;
};

const textOf = (message: any): string => {
  const blocks = Array.isArray(message?.parts) ? message.parts : message?.content ?? message?.text;
  return (typeof blocks === 'string' ? blocks : Array.isArray(blocks)
    ? blocks.filter((part: any) => part?.thought !== true && typeof part?.text === 'string')
      .map((part: any) => part.text).join('\n') : '')
    .replace(/\r\n/g, '\n').trim();
};
const dialogueIdentity = (message: any): string => hash(JSON.stringify([
  message?.role === 'model' ? 'assistant' : message?.role,
  visibleUserRequest(textOf(message)),
]));
const capsuleOf = (message: any): string => {
  const text = textOf(message);
  return text.startsWith(CAPSULE) ? text : '';
};

const legacyRootMatches = (checkpoint: Checkpoint, message: any, identity: string): boolean => {
  if (checkpoint.lineageVersion === 2 || message?.role !== 'user') return false;
  if (identity === dialogueIdentity({ role: 'user', content: `[USER REQUEST]\n${textOf(message)}` })) return true;
  // Pinned-path envelopes also surrounded the registry wrapper. Recover the
  // exact admitted root from a sealed native part, and prove its old hash
  // before removing only our known envelope. Never search arbitrary user prose
  // for a request marker and treat its suffix as a new conversation identity.
  const start = '[CURRENT USER REQUEST - EXECUTE ONLY THIS]\n';
  const end = '\n[END CURRENT USER REQUEST]';
  const pinnedPrefix = /^\[CRITICAL PINNED CONTEXT\]\nPinned workspace paths: [^\n]*\nKeep file, code, and terminal operations inside these paths unless the user explicitly provides another target path\. External web\/API lookups are allowed only when the current request asks for current factual information\.\n\nMy Request:\n/;
  for (const turn of checkpoint.contents) {
    if (turn?.role !== 'user') continue;
    const blocks = Array.isArray(turn.parts) ? turn.parts : turn.content;
    const texts = typeof blocks === 'string' ? [blocks]
      : Array.isArray(blocks) ? blocks.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text) : [];
    for (const text of texts) {
      if (!text.startsWith(start)) continue;
      const endIndex = text.lastIndexOf(end);
      if (endIndex < start.length) continue;
      const root = text.slice(start.length, endIndex);
      if (dialogueIdentity({ role: 'user', content: root }) !== identity) continue;
      const unpinned = root.replace(pinnedPrefix, '');
      const visible = visibleUserRequest(unpinned.startsWith('[USER REQUEST]\n')
        ? unpinned.slice('[USER REQUEST]\n'.length) : unpinned);
      if (dialogueIdentity({ role: 'user', content: visible }) === dialogueIdentity(message)) return true;
    }
  }
  return false;
};

const checkpointMatchesDialogue = (checkpoint: Checkpoint, messages: any[]): boolean => {
  if (!checkpoint.dialogue.length || checkpoint.dialogue.length > messages.length) return false;
  return checkpoint.dialogue.every((identity, index) => {
    if (identity === dialogueIdentity(messages[index])) return true;
    // Version-one admission hashed the registry's standalone wrapper, while
    // the next request carried visible UI text. Only the root (last identity)
    // may have this known encoding difference; all earlier turns must match.
    return index === checkpoint.dialogue.length - 1 && legacyRootMatches(checkpoint, messages[index], identity);
  });
};

const readCheckpoint = async (sourcePath: string, scope: string): Promise<Checkpoint> => {
  if ((await fs.stat(sourcePath)).size > MAX_BYTES) throw new Error('Saved working context exceeds the safe read size.');
  const envelope = JSON.parse((await unzip(await fs.readFile(sourcePath), { maxOutputLength: MAX_BYTES })).toString('utf8'));
  const checkpoint: Checkpoint = envelope?.checkpoint;
  if (!checkpoint || checkpoint.version !== 1 || checkpoint.scope !== scope
    || !Array.isArray(checkpoint.contents) || !Array.isArray(checkpoint.dialogue)
    || !checkpoint.dialogue.every(identity => typeof identity === 'string')
    || envelope.hash !== hash(JSON.stringify(checkpoint))) {
    throw new Error('Saved working context failed its integrity check. It has not been replaced.');
  }
  return checkpoint;
};

const observationTurn = (kind: WireKind, text: string): any => kind === 'gemini'
  ? { role: 'user', parts: [{ text }] } : { role: 'user', content: text };

/** One-time upgrade of pre-checkpoint chats, using exact pages, never UI previews. */
const recoverLegacyToolContext = async (input: {
  chatId: string; kind: WireKind; history: any[]; currentRequest: string; fabric?: ContextFabric | null;
}): Promise<any[]> => {
  if (!input.fabric || input.fabric.scopeId !== input.chatId || input.history.length === 0) return [];
  const episodes = input.fabric.listEpisodes().sort((left, right) => left.sequence - right.sequence);
  const userEpisodes = episodes.filter(episode => episode.source === 'user');
  const savedUsers: Array<{ identity: string; sequence: number }> = [];
  for (const episode of userEpisodes) {
    const page = await input.fabric.openPage(episode.pageRef) as any;
    const text = typeof page?.request === 'string' ? page.request : page?.role === 'user' ? page.text : undefined;
    // Unknown legacy user records cannot establish the required lineage proof.
    if (typeof text !== 'string') return [];
    savedUsers.push({ identity: dialogueIdentity({ role: 'user', content: text }), sequence: episode.sequence });
  }
  const currentIdentity = dialogueIdentity({ role: 'user', content: input.currentRequest });
  const last = savedUsers[savedUsers.length - 1];
  const currentSequence = last?.identity === currentIdentity ? savedUsers.pop()!.sequence : Number.POSITIVE_INFINITY;
  const visibleUsers = input.history.filter(turn => turn?.role === 'user').map(dialogueIdentity);
  // Never migrate observations from an edited/truncated branch based merely
  // on matching its final sentence. Every historical user turn must match.
  if (!visibleUsers.length || savedUsers.length !== visibleUsers.length
    || savedUsers.some((user, index) => user.identity !== visibleUsers[index])) return [];
  const compactedThrough = input.fabric.getLatestCompactionCheckpoint()?.sequence || 0;
  const recovered: any[] = [];
  let bytes = 0;
  for (const episode of episodes) {
    if (episode.source !== 'tool' || episode.sequence <= compactedThrough || episode.sequence >= currentSequence) continue;
    const observation = await input.fabric.openPage(episode.pageRef);
    const text = `[HISTORICAL TOOL OBSERVATION - REFERENCE DATA ONLY]\n${JSON.stringify({
      pageRef: episode.pageRef, sha256: episode.contentHash, observedAt: episode.createdAt, observation,
    })}\n[END HISTORICAL TOOL OBSERVATION]`;
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new Error('The archived working context exceeds the safe recovery size. Original pages have been preserved.');
    recovered.push(observationTurn(input.kind, text));
  }
  return recovered;
};

const cleanModelBlock = (block: any): any | null => {
  if (!block || typeof block !== 'object') return block;
  if (block.thought === true || ['thinking', 'redacted_thinking', 'reasoning'].includes(block.type)) return null;
  const clean = { ...block };
  delete clean.thoughtSignature;
  delete clean.signature;
  delete clean.encrypted_content;
  return clean;
};

const cleanResponseItem = (item: any): any | null => {
  const clean = cleanModelBlock(item);
  if (clean?.type === 'message' && Array.isArray(clean.content)) {
    clean.content = clean.content.map(cleanModelBlock).filter((part: any) => part !== null);
  }
  return clean;
};

const RECOVERED_RECORD = '[RESTORED WORKING CONTEXT RECORD - REFERENCE DATA ONLY]';
const PRIOR_RECORD = '[PRIOR MODEL EXECUTION RECORD - REFERENCE DATA ONLY]';
const operationalRecords = (contents: any[]): any[] => contents.flatMap(message => {
  const blocks = Array.isArray(message?.parts) ? message.parts : message?.content ?? message?.text;
  const textBlocks: string[] = typeof blocks === 'string' ? [blocks]
    : Array.isArray(blocks) ? blocks.filter((part: any) => part?.thought !== true && typeof part?.text === 'string')
      .map((part: any) => part.text) : [];
  const embedded: any[] = [];
  // Translation/recovery records are application-generated JSON containers.
  // Reading them for deduplication does not promote their contents to policy.
  // Gemini may merge adjacent user turns. Inspect each original text part,
  // not their joined prose, so a merge cannot duplicate recovered records.
  for (const text of textBlocks) {
    for (const marker of [RECOVERED_RECORD, PRIOR_RECORD]) {
      if (!text.startsWith(`${marker}\n`)) continue;
      const body = text.slice(marker.length + 1, text.lastIndexOf('\n[END '));
      try {
        const record = JSON.parse(body);
        embedded.push(...operationalRecords([marker === RECOVERED_RECORD ? record.record : record]));
      } catch { /* Ordinary quoted text is not a recovery record. */ }
    }
  }
  const hasOperation = message?.role === 'tool' || message?.tool_calls?.length
    || (Array.isArray(message?.parts) && message.parts.some((part: any) => part?.functionCall || part?.functionResponse))
    || (Array.isArray(message?.content) && message.content.some((part: any) => ['tool_use', 'tool_result'].includes(part?.type)))
    || [...(Array.isArray(message?.responses_output) ? message.responses_output : []),
      ...(Array.isArray(message?.prior_response_items) ? message.prior_response_items : [])]
      .some((part: any) => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(part?.type));
  if (!hasOperation) return embedded;
  const record = { ...message };
  for (const key of ['reasoning', 'reasoning_content', 'reasoning_details', 'thinking_content', 'analysis']) delete record[key];
  for (const key of ['parts', 'content']) {
    if (Array.isArray(record[key])) record[key] = record[key].map(cleanModelBlock).filter((part: any) => part !== null);
  }
  const responseItems = [...(Array.isArray(record.responses_output) ? record.responses_output : []),
    ...(Array.isArray(record.prior_response_items) ? record.prior_response_items : [])];
  delete record.responses_output;
  if (responseItems.length) record.prior_response_items = responseItems.map(cleanResponseItem).filter((part: any) => part !== null);
  return [...embedded, record];
});

/** Repair the known v1 wrapper bug without guessing a branch or summarizing data. */
const recoverMissingLegacyRecords = async (input: {
  directory: string; names: string[]; checkpoint: Checkpoint; dialogue: any[];
  contents: any[]; kind: WireKind; fabric?: ContextFabric | null;
}): Promise<any[]> => {
  if (input.checkpoint.lineageVersion === 2) return [];
  // Never undo a committed compaction. Its capsule/archive, not an old working
  // file, owns which historical observations are still in the active window.
  if (input.contents.some(capsuleOf) || input.fabric?.getLatestCompactionCheckpoint()) return [];
  const recordHash = (record: any) => hash(JSON.stringify(record));
  const seen = new Set(operationalRecords(input.contents).map(recordHash));
  const seenRuns = new Set<string>(input.checkpoint.runId ? [input.checkpoint.runId] : []);
  const ancestors: Checkpoint[] = [];
  let readBytes = Buffer.byteLength(JSON.stringify(input.checkpoint));
  for (const name of input.names.slice(1)) {
    const checkpoint = await readCheckpoint(path.join(input.directory, name), input.checkpoint.scope);
    readBytes += Buffer.byteLength(JSON.stringify(checkpoint));
    if (readBytes > MAX_BYTES) throw new Error('Legacy context recovery exceeds the safe read size. Its original checkpoints remain preserved.');
    if (checkpoint.runId && seenRuns.has(checkpoint.runId)) continue;
    if (checkpoint.runId) seenRuns.add(checkpoint.runId);
    if (checkpoint.dialogue.length > input.checkpoint.dialogue.length
      || !checkpointMatchesDialogue(checkpoint, input.dialogue)) continue;
    // Even if the current legacy file omitted its capsule, encountering an
    // ancestor with one must not resurrect observations from before it.
    if (checkpoint.contents.some(capsuleOf)) return [];
    ancestors.push(checkpoint);
    if (checkpoint.lineageVersion === 2) break;
  }
  const recovered: any[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(input.contents));
  for (const ancestor of ancestors.reverse()) {
    for (const record of operationalRecords(ancestor.contents)) {
      const identity = recordHash(record);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const text = `${RECOVERED_RECORD}\n${JSON.stringify({
        provider: ancestor.provider, model: ancestor.model, runId: ancestor.runId, sha256: identity, record,
      })}\n[END RESTORED WORKING CONTEXT RECORD]`;
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_BYTES) throw new Error('Recovered working context exceeds the safe read size. Its original checkpoints remain preserved.');
      recovered.push(observationTurn(input.kind, text));
    }
  }
  return recovered;
};

/** Never replay private reasoning/signatures or foreign tool protocol to another model. */
const translateCheckpoint = (checkpoint: Checkpoint, kind: WireKind): any[] =>
  checkpoint.contents.flatMap<any>((message, index) => {
    if (index > 0 && capsuleOf(checkpoint.contents[index - 1])
      && textOf(message) === 'Context capsule loaded. Continuing the retained active objective.') return [];
    const capsule = capsuleOf(message);
    if (capsule) return kind === 'gemini'
      ? [{ role: 'user', parts: [{ text: capsule }] },
        { role: 'model', parts: [{ text: 'Context capsule loaded. Continuing the retained active objective.' }] }]
      // A user-role marker must pass the target adapter's journal validation
      // before it can become system context, even when stored in a checkpoint.
      : [{ role: message?.role === 'system' ? 'system' : 'user', content: capsule }];
    const clean: any = { ...message };
    // Responses output is not synonymous with reasoning: it can contain the
    // only copy of a tool call, its result, citations, or a visible message.
    // Keep those items as historical data, never as executable target protocol.
    const responseItems = Array.isArray(message?.responses_output)
      ? message.responses_output.map(cleanResponseItem).filter((item: any) => item !== null)
      : [];
    for (const key of ['reasoning', 'reasoning_content', 'reasoning_details', 'thinking_content', 'analysis', 'responses_output']) {
      delete clean[key];
    }
    for (const key of ['parts', 'content']) {
      if (!Array.isArray(clean[key])) continue;
      clean[key] = clean[key].map(cleanModelBlock).filter((part: any) => part !== null);
    }
    if (responseItems.length > 0) clean.prior_response_items = responseItems;
    const blocks = Array.isArray(clean.parts) ? clean.parts : clean.content ?? clean.text;
    const textOnly = typeof blocks === 'string' || (Array.isArray(blocks)
      && blocks.every((part: any) => typeof part?.text === 'string' && !part.functionCall && !part.functionResponse
        && (!part.type || part.type === 'text')));
    if (textOnly && clean.role !== 'tool' && !clean.tool_calls?.length && responseItems.length === 0) {
      const text = typeof blocks === 'string' ? blocks : blocks.map((part: any) => part.text).join('\n');
      const assistant = clean.role === 'assistant' || clean.role === 'model';
      // Only collapse plain text blocks. Annotations/citations are operational
      // evidence too and must remain in the reference record below.
      const plainBlocks = !Array.isArray(blocks) || blocks.every((part: any) =>
        Object.keys(part).every(key => key === 'type' || key === 'text' || key === 'cache_control'),
      );
      const plainMessage = Object.keys(clean).every(key =>
        ['role', 'parts', 'content', 'text', 'cache_control', 'tool_calls'].includes(key),
      );
      if (plainBlocks && plainMessage) {
        // A thinking-only record has no visible message after translation.
        // Empty assistant/user messages are rejected by some provider wires.
        if (!text.trim()) return [];
        return kind === 'gemini' ? { role: assistant ? 'model' : 'user', parts: [{ text }] }
          : { role: assistant ? 'assistant' : 'user', content: text };
      }
    }
    // Mixed user turns can carry binding instructions alongside attachments.
    // Preserve that text in its original conversation role; it must not be
    // demoted to tool/reference data merely because its wire shape changed.
    const visibleText = typeof blocks === 'string' ? blocks
      : Array.isArray(blocks) ? blocks.filter((part: any) => typeof part?.text === 'string'
        && (!part.type || part.type === 'text' || part.type === 'output_text'))
        .map((part: any) => part.text).join('\n') : '';
    const isDialogue = ['user', 'assistant', 'model'].includes(clean.role);
    const visibleTurn = isDialogue && visibleText.trim()
      ? kind === 'gemini'
        ? { role: clean.role === 'user' ? 'user' : 'model', parts: [{ text: visibleText }] }
        : { role: clean.role === 'user' ? 'user' : 'assistant', content: visibleText }
      : null;
    if (visibleTurn) {
      // Avoid duplicating plain prose in both the native dialogue and the
      // historical record. Annotated text stays exact with its citations.
      for (const key of ['parts', 'content', 'text']) {
        if (typeof clean[key] === 'string') delete clean[key];
        else if (Array.isArray(clean[key])) clean[key] = clean[key].filter((part: any) =>
          !(typeof part?.text === 'string' && (!part.type || ['text', 'output_text'].includes(part.type))
            && Object.keys(part).every(field => ['type', 'text', 'cache_control'].includes(field))),
        );
      }
    }
    // These are historical observations, not newly issued tool calls. Retain
    // exact operational data without inventing valid protocol IDs/signatures.
    const text = `[PRIOR MODEL EXECUTION RECORD - REFERENCE DATA ONLY]\n${JSON.stringify(clean)}\n[END PRIOR MODEL EXECUTION RECORD]`;
    return [...(visibleTurn ? [visibleTurn] : []), observationTurn(kind, text)];
  });

/** Model switches inside a live adapter obey the same protocol boundary as restart. */
export function rebaseWorkingTranscriptForModel(contents: any[], kind: WireKind): any[] {
  const systems = contents.filter(message => message?.role === 'system' && !capsuleOf(message));
  return [...systems, ...translateCheckpoint({
    version: 1, scope: '', provider: '', model: '', kind, dialogue: [],
    contents: contents.filter(message => message?.role !== 'system' || capsuleOf(message)),
  }, kind)];
}

/**
 * Durable working input, distinct from the UI transcript and the compaction
 * archive. Completed tool batches remain verbatim until actual compaction.
 * Each run owns a separate atomic file: a delayed old writer cannot replace
 * a newer run, and an edited chat cannot destroy its prior checkpoint.
 */
export async function openWorkingContextCheckpoint(input: {
  chatId: string;
  provider: string;
  model: string;
  kind: WireKind;
  history: any[];
  currentRequest: string;
  enabled: boolean;
  runId?: string;
  /** In-process retries already own a complete survivor transcript. */
  hasSurvivorState?: boolean;
  fabric?: ContextFabric | null;
  /** Text-only chat adapters retain operational records as reference data. */
  referenceOnly?: boolean;
  onWarning?: (message: string) => void;
}) {
  const directory = getEterxWorkspaceDir('.context', 'working', stableScopeSegment(input.chatId));
  let admissionTime = Date.now();
  const incoming = input.history.map(dialogueIdentity);
  const dialogue = [...incoming, dialogueIdentity({ role: 'user', content: input.currentRequest })];
  let restored: any[] = [];
  let calibration: Checkpoint['calibration'];
  let covered = 0;
  let currentRequestIncluded = false;
  if (input.enabled) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(directory)).filter(value => /^\d{16}-[a-f0-9-]+\.json\.gz$/.test(value)).sort().reverse();
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('Saved working context could not be read. The existing context has been preserved.');
    }
    if (names.length > 0) {
      admissionTime = Math.max(admissionTime, Number(names[0].slice(0, 16)) + 1);
    }
    if (names.length === 0 && !input.hasSurvivorState) restored = await recoverLegacyToolContext(input);
    if (names.length > 0 && !input.hasSurvivorState) {
      // Only the newest admitted run is authoritative. Never resurrect an old
      // branch by scanning backwards for a coincidentally matching sentence.
      const checkpoint = await readCheckpoint(path.join(directory, names[0]), input.chatId);
      const suppliedDialogue = [...input.history, { role: 'user', content: input.currentRequest }];
      const resumesSameRun = Boolean(input.runId && input.runId === checkpoint.runId
        && checkpoint.dialogue.length === dialogue.length
        && checkpointMatchesDialogue(checkpoint, suppliedDialogue));
      const continuesHistory = checkpointMatchesDialogue(checkpoint, input.history);
      if (resumesSameRun || continuesHistory) {
        covered = checkpoint.dialogue.length;
        currentRequestIncluded = resumesSameRun;
        restored = !input.referenceOnly && checkpoint.kind === input.kind && checkpoint.provider === input.provider && checkpoint.model === input.model
          ? checkpoint.contents : translateCheckpoint(checkpoint, input.kind);
        if (!input.referenceOnly && checkpoint.kind === input.kind && checkpoint.provider === input.provider && checkpoint.model === input.model
          && Number.isFinite(checkpoint.calibration?.inputTokens) && Number.isFinite(checkpoint.calibration?.localTokens)
          && checkpoint.calibration!.inputTokens > 0 && checkpoint.calibration!.localTokens > 0) {
          calibration = checkpoint.calibration;
        }
        const recovered = await recoverMissingLegacyRecords({
          directory, names, checkpoint, dialogue: suppliedDialogue, contents: restored,
          kind: input.kind, fabric: input.fabric,
        });
        if (recovered.length) {
          restored = [...recovered, ...restored];
          // These exact recovered observations were absent from the measured
          // payload; its calibration is no longer a count of the whole input.
          calibration = undefined;
        }
        // A stopped batch can have completed effects in the exact ledger
        // after the last protocol-safe request checkpoint. Reattach those
        // observations without fabricating pending tool calls or rerunning them.
        if (input.fabric?.scopeId === input.chatId && Number.isSafeInteger(checkpoint.fabricRevision)) {
          const unseen = input.fabric.listEpisodes().filter(episode =>
            episode.source === 'tool' && episode.sequence > checkpoint.fabricRevision!,
          ).sort((left, right) => left.sequence - right.sequence);
          let restoredBytes = Buffer.byteLength(JSON.stringify(restored));
          for (const episode of unseen) {
            const observation = await input.fabric.openPage(episode.pageRef);
            const text = `[RECOVERED COMPLETED TOOL OBSERVATION - REFERENCE DATA ONLY]\n${JSON.stringify({
              pageRef: episode.pageRef, sha256: episode.contentHash, observedAt: episode.createdAt, observation,
            })}\n[END RECOVERED TOOL OBSERVATION]`;
            restoredBytes += Buffer.byteLength(text);
            if (restoredBytes > MAX_BYTES) throw new Error('Recovered working context exceeds the safe read size. Its checkpoint and exact pages have been preserved.');
            restored.push(observationTurn(input.kind, text));
          }
        }
      } else if (incoming.length < checkpoint.dialogue.length
        && incoming.every((identity, index) => identity === checkpoint.dialogue[index])) {
        throw new Error('The saved working context is newer than the supplied chat history. Reload this chat before continuing; its saved context has not been replaced.');
      } else {
        throw new Error('This chat history does not match its saved working context. Reload the chat before continuing; its full checkpoint has been preserved instead of replacing it with the shorter chat feed.');
      }
    }
  }
  let warned = false;
  let previousHash = '';
  let saveChain: Promise<void> = Promise.resolve();
  const destination = path.join(directory, `${String(admissionTime).padStart(16, '0')}-${randomUUID()}.json.gz`);
  return {
    contents: restored,
    remainingHistory: input.history.slice(covered),
    calibration,
    currentRequestIncluded,
    async save(contents: any[], model = input.model, provider = input.provider, measured?: Checkpoint['calibration']): Promise<void> {
      if (!input.enabled) return;
      // Runtime prompts/tools are rebuilt from current settings. The only
      // persisted system carrier is the journal-validated compaction capsule.
      const conversational = contents.filter(message => message?.role !== 'system' || capsuleOf(message));
      const checkpoint: Checkpoint = { version: 1, scope: input.chatId, provider, model,
        kind: input.kind, lineageVersion: 2, runId: input.runId, dialogue, contents: conversational, calibration: measured,
        fabricRevision: input.fabric?.scopeId === input.chatId ? input.fabric.getRevision() : undefined };
      const temporary = `${destination}.${randomUUID()}.tmp`;
      // Capture before the first await, then serialize commits in call order.
      // A slower compression/write for an older frontier cannot replace a
      // newer checkpoint from this same run.
      const previousSave = saveChain;
      let releaseSave!: () => void;
      saveChain = new Promise<void>(resolve => { releaseSave = resolve; });
      try {
        const serialized = JSON.stringify(checkpoint);
        const digest = hash(serialized);
        await previousSave;
        if (digest === previousHash) return;
        if (Buffer.byteLength(serialized) > MAX_BYTES - 1024) throw new Error('The working transcript exceeds the safe checkpoint size.');
        await input.fabric?.flushLedger();
        await fs.ensureDir(directory);
        const file = await openFile(temporary, 'wx', 0o600);
        try {
          // Seal the exact bytes captured above. A concurrent ledger/tool
          // update must not change a referenced object between hash and write.
          await file.writeFile(await zip(`{"checkpoint":${serialized},"hash":${JSON.stringify(digest)}}`));
          await file.sync();
        } finally { await file.close(); }
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(temporary, destination); break; }
          catch (error: any) {
            if (attempt >= 2 || !['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
        previousHash = digest;
      } catch {
        // Leave both the caller's full context and every committed file intact.
        if (!warned) {
          try { input.onWarning?.('Working context could not be saved. This run still has its full context, but reopening may not restore the latest work.'); } catch { }
        }
        warned = true;
      } finally {
        // Even a serialization failure must not release a successor while
        // the preceding save is still committing.
        await previousSave;
        await fs.remove(temporary).catch(() => undefined);
        releaseSave();
      }
    },
  };
}
