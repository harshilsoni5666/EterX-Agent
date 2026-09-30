import { createHash } from 'crypto';
import { visibleUserRequest, unwrapCurrentUserRequest } from '../chat-user-payload';

/** Admission identities are separate from provider messages and UI rendering. */
export type WorkingDialogueEntry = {
  identity: string;
  aliases?: string[];
  turnId?: string;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanText = (value: string) => value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
const identityOf = (role: string, text: string) => hash(JSON.stringify([role === 'model' ? 'assistant' : role, text]));

export const workingMessageText = (message: any): string => {
  const blocks = Array.isArray(message?.parts) ? message.parts : message?.content ?? message?.text;
  return typeof blocks === 'string' ? blocks : Array.isArray(blocks)
    ? blocks.filter(part => part?.thought !== true && !['thinking', 'redacted_thinking', 'reasoning'].includes(part?.type)
      && typeof part?.text === 'string').map(part => part.text).join('\n') : '';
};

export const workingDialogueEntry = (message: any, turnId?: string): WorkingDialogueEntry => {
  const text = workingMessageText(message);
  const role = message?.role === 'model' ? 'assistant' : String(message?.role || 'user');
  const identity = identityOf(role, cleanText(role === 'user' ? visibleUserRequest(cleanText(text)) : text));
  // Older checkpoints normalized before unwrapping, and unwrapped assistant
  // prose too. Keep those hashes as aliases; never alter the saved transcript.
  const legacy = identityOf(role, visibleUserRequest(text.replace(/\r\n/g, '\n').trim()));
  const stableId = String(turnId || message?.contextTurnId || '').trim();
  return {
    identity,
    ...(legacy !== identity ? { aliases: [legacy] } : {}),
    ...(stableId && stableId.length <= 512 ? { turnId: stableId } : {}),
  };
};

const identities = (entry: WorkingDialogueEntry) => [entry.identity, ...(entry.aliases || [])];
export const sameWorkingDialogueEntry = (left: WorkingDialogueEntry, right: WorkingDialogueEntry): boolean =>
  identities(left).some(identity => identities(right).includes(identity));

export const validWorkingDialogueEntry = (value: any): value is WorkingDialogueEntry =>
  Boolean(value && /^[a-f0-9]{64}$/.test(value.identity)
    && (value.turnId === undefined || (typeof value.turnId === 'string' && value.turnId.length <= 512))
    && (value.aliases === undefined || (Array.isArray(value.aliases) && value.aliases.length <= 12
      && value.aliases.every((identity: unknown) => typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity)))));

const nativeDialogueEntries = (contents: any[]): WorkingDialogueEntry[] => {
  const entries: WorkingDialogueEntry[] = [];
  for (const message of contents) {
    if (!['user', 'assistant', 'model'].includes(message?.role)) continue;
    const blocks = Array.isArray(message.parts) ? message.parts : message.content ?? message.text;
    const texts: string[] = typeof blocks === 'string' ? [blocks] : Array.isArray(blocks)
      ? blocks.filter(part => part?.thought !== true && !['thinking', 'redacted_thinking', 'reasoning'].includes(part?.type)
        && typeof part?.text === 'string').map(part => part.text) : [];
    // A rendered assistant answer joins its text blocks. Index the complete
    // answer once, rather than appending it again on the next admission.
    const dialogueTexts = message.role === 'user' ? texts : [texts.join('\n')];
    for (const raw of dialogueTexts) {
      if (!raw.trim() || /^\[(?:SYSTEM - COMPACTED CONTEXT CAPSULE |CURRENT RUNTIME |SYSTEM-PROVIDED CURRENT RUNTIME |HISTORICAL TOOL OBSERVATION|RECOVERED COMPLETED TOOL OBSERVATION|RESTORED WORKING CONTEXT RECORD|PRIOR MODEL EXECUTION RECORD)/.test(raw)
        || raw === 'Context capsule loaded. Continuing the retained active objective.') continue;
      let text = raw;
      const aliases = new Set<string>();
      if (message.role !== 'user' && texts.length > 1) {
        aliases.add(workingDialogueEntry({ role: message.role, content: texts.join('') }).identity);
      }
      if (message.role === 'user') {
        const request = unwrapCurrentUserRequest(raw);
        if (request !== null) {
          text = request;
          for (const identity of identities(workingDialogueEntry({ role: 'user', content: text }))) aliases.add(identity);
          // This is a sealed, application-generated provider carrier. Its
          // aliases identify old admissions only; they do not grant authority.
          text = text.replace(/^\[CRITICAL PINNED CONTEXT\]\nPinned workspace paths: [^\n]*\nKeep file, code, and terminal operations inside these paths unless the user explicitly provides another target path\. External web\/API lookups are allowed only when the current request asks for current factual information\.\n\nMy Request:\n/, '');
          if (text.startsWith('[USER REQUEST]\n')) text = text.slice('[USER REQUEST]\n'.length);
        }
      }
      const entry = workingDialogueEntry({ role: message.role, content: text });
      for (const identity of entry.aliases || []) aliases.add(identity);
      aliases.delete(entry.identity);
      entries.push({ ...entry, ...(aliases.size ? { aliases: [...aliases] } : {}) });
    }
  }
  return entries;
};

/** Add only native occurrences not already represented by admission lineage. */
export const extendWorkingDialogue = (lineage: WorkingDialogueEntry[], contents: any[]): WorkingDialogueEntry[] => {
  const result = lineage.map(entry => ({ ...entry, ...(entry.aliases ? { aliases: [...entry.aliases] } : {}) }));
  const byIdentity = new Map<string, number[]>();
  result.forEach((entry, index) => identities(entry).forEach(identity => {
    const indexes = byIdentity.get(identity) || [];
    indexes.push(index);
    byIdentity.set(identity, indexes);
  }));
  const offsets = new Map<string, number>();
  const matched = new Set<number>();
  for (const entry of nativeDialogueEntries(contents)) {
    let match: number | undefined;
    for (const identity of identities(entry)) {
      const indexes = byIdentity.get(identity) || [];
      let offset = offsets.get(identity) || 0;
      while (offset < indexes.length && matched.has(indexes[offset])) offset++;
      offsets.set(identity, offset);
      if (offset < indexes.length) { match = indexes[offset]; break; }
    }
    if (match === undefined) result.push(entry);
    else {
      matched.add(match);
      const aliases = new Set([...identities(result[match]), ...identities(entry)]);
      aliases.delete(result[match].identity);
      if (aliases.size) result[match].aliases = [...aliases].slice(0, 12);
    }
  }
  return result;
};

/**
 * The feed is a projection, not the durable execution transcript. Reconcile
 * known occurrences without requiring equal positions or assistant rendering.
 * Stable IDs distinguish repeated requests; legacy text matches consume one
 * occurrence each. Unmatched history is retained, never used to replace tools.
 */
export const reconcileWorkingDialogue = (lineage: WorkingDialogueEntry[], history: any[]) => {
  const retainedLineage = lineage.map(entry => ({ ...entry }));
  const byId = new Map<string, number[]>();
  const byIdentity = new Map<string, number[]>();
  const withoutId = new Map<string, number[]>();
  const addIndex = (map: Map<string, number[]>, key: string, index: number) => {
    const indexes = map.get(key) || [];
    indexes.push(index);
    map.set(key, indexes);
  };
  lineage.forEach((entry, index) => {
    if (entry.turnId) addIndex(byId, entry.turnId, index);
    for (const identity of identities(entry)) {
      addIndex(byIdentity, identity, index);
      if (!entry.turnId) addIndex(withoutId, identity, index);
    }
  });
  const consumed = new Set<number>();
  const seenIncomingIds = new Set<string>();
  const offsets = new Map<string, number>();
  const unmatched: Array<{ message: any; index: number; revision: boolean }> = [];
  let lastMatchedIndex = -1;
  const additions: WorkingDialogueEntry[] = [];
  for (const [historyIndex, message] of history.entries()) {
    const entry = workingDialogueEntry(message);
    const incomingKey = entry.turnId ? JSON.stringify([entry.turnId, entry.identity]) : '';
    if (incomingKey && seenIncomingIds.has(incomingKey)) continue;
    if (incomingKey) seenIncomingIds.add(incomingKey);
    const idCandidates = entry.turnId ? byId.get(entry.turnId) : undefined;
    let match = idCandidates?.find(index => !consumed.has(index) && sameWorkingDialogueEntry(lineage[index], entry));
    if (match === undefined && !idCandidates) {
      for (const identity of identities(entry)) {
        const key = `${entry.turnId ? 'legacy' : 'all'}:${identity}`;
        const indexes = (entry.turnId ? withoutId : byIdentity).get(identity) || [];
        let offset = offsets.get(key) || 0;
        while (offset < indexes.length && consumed.has(indexes[offset])) offset++;
        offsets.set(key, offset);
        if (offset < indexes.length) { match = indexes[offset]; break; }
      }
    }
    if (match !== undefined) {
      consumed.add(match);
      lastMatchedIndex = historyIndex;
      if (!retainedLineage[match].turnId && entry.turnId) retainedLineage[match].turnId = entry.turnId;
    }
    else {
      unmatched.push({ message, index: historyIndex, revision: Boolean(idCandidates) });
      additions.push(entry);
    }
  }
  // Recovered older bubbles must not become later instructions than the
  // saved work that followed them. Never splice inside native tool batches.
  // A changed stable ID is a correction and stays in the later suffix.
  return {
    earlierHistory: unmatched.filter(item => item.index < lastMatchedIndex && !item.revision).map(item => item.message),
    remainingHistory: unmatched.filter(item => item.index >= lastMatchedIndex || item.revision).map(item => item.message),
    lineage: [...retainedLineage, ...additions],
  };
};

/** Internal admission metadata must never become provider protocol fields. */
export const withoutWorkingDialogueMetadata = (message: any): any => {
  if (!message || typeof message !== 'object' || !('contextTurnId' in message)) return message;
  const { contextTurnId: _turnId, ...providerMessage } = message;
  return providerMessage;
};
