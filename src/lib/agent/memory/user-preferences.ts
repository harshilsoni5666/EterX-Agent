export interface ExtractedUserMemory {
  scope: 'user' | 'project';
  type: 'user_preference' | 'user_aversion' | 'project_instruction';
  content: string;
}

/**
 * Conservative automatic learning. Task state belongs to the chat's Context
 * Fabric; only explicit durable statements belong in cross-turn preferences.
 * Keep the complete clause rather than reconstructing a rule from keywords.
 */
export function extractDurableUserMemories(message: string): ExtractedUserMemory[] {
  const prose = message
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n')
    .replace(/^\s*>.*$/gm, '')
    .replace(/[’‘]/g, "'");
  const memories: ExtractedUserMemory[] = [];
  const seen = new Set<string>();
  for (const part of prose.split(/\n+|(?<=[.!?;])\s+/)) {
    const content = part.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim();
    // Oversized/mixed instructions stay in exact chat history for deliberate recall.
    if (content.length < 8 || content.length > 1000 || /\?\s*$/.test(content)) continue;
    if (/["“”]/.test(content)) continue;
    if (/\b(?:for (?:now|this (?:task|turn|run|request))|just (?:this|for)|this time|today only|temporarily|until)\b/i.test(content)) continue;
    if (/^(?:if\b|suppose\b|imagine\b|for example\b)|\b(?:says?|said|wrote|quoted|example|hypothetically)\b/i.test(content)) continue;

    const project = /\b(?:this|our|the)\s+(?:project|repo(?:sitory)?|codebase|app|workspace)\b|\b(?:project|repo|codebase|workspace)\s+(?:uses|is)|\beterx\s+uses\b/i.test(content);
    const projectFact = /\b(?:uses|built with|architecture is|default model|main folder|workspace is|package manager is)\b/i.test(content);
    const explicitPreference = /\b(?:i (?:prefer|like|dislike|hate)|my preference|from now on|in (?:the )?future|by default|always|never|(?:don't|dont|do not) ever)\b/i.test(content);
    // "Remember to fix X" is a task, not a permanent behavior preference.
    if (!(project && (projectFact || explicitPreference)) && !explicitPreference) continue;
    const key = content.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    memories.push({
      scope: project ? 'project' : 'user',
      type: project ? 'project_instruction'
        : /\b(?:don't|dont|do not|never|hate|dislike|avoid)\b/i.test(content) ? 'user_aversion' : 'user_preference',
      content,
    });
  }
  return memories.slice(0, 12);
}
