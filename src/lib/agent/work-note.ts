const PROMPT_TAGS = [
  'identity',
  'request_contract',
  'enterprise_engineering_standards',
  'web_application_development',
  'repo_workflow',
  'tool_protocol',
  'subagents_and_parallel_work',
  'messaging_and_async_work',
  'work_notes',
  'truthful_execution',
  'filesystem',
  'autonomous_execution_protocol',
  'intelligent_autonomy',
  'temporal_context',
  'core_identity',
];

const PROMPT_TAG_PATTERN = new RegExp(`<\\/?(?:${ PROMPT_TAGS.join('|') })[^>]*>`, 'gi');

const PROMPT_MARKER_PATTERN =
  /\[(?:CURRENT USER REQUEST(?:\s*-\s*EXECUTE ONLY THIS)?|END CURRENT USER REQUEST|SYSTEM\s*-\s*(?:WORKING MEMORY|COMPRESSED HISTORY|SELF-REFLECTION)|END COMPRESSED HISTORY|META-COGNITIVE ALERT)[^\]]*\]/gi;

const PROMPT_BLOCK_PATTERN =
  /\[CURRENT USER REQUEST(?:\s*-\s*EXECUTE ONLY THIS)?\][\s\S]*?\[END CURRENT USER REQUEST\]|\[SYSTEM\s*-\s*COMPRESSED HISTORY\][\s\S]*?\[END COMPRESSED HISTORY\]/gi;

const PROMPT_HEADING_PATTERN =
  /^(?:#+\s*)?(?:CURRENT REQUEST GUARD|EXTERNAL ACTION NOTE CUE|UI TRACE PROTOCOL|WORK NOTES|VISIBLE WORK NOTES|RUNTIME SAFETY GUARDRAILS|EFFICIENCY GUIDELINES|ENVIRONMENT CONTEXT|OPERATING RULES|SAFETY RULES|COMPLETION CRITERIA|TOOL PROTOCOL|REQUEST CONTRACT|CORE IDENTITY|TEMPORAL CONTEXT|TRUTHFUL EXECUTION|FILESYSTEM|AUTONOMOUS EXECUTION PROTOCOL|INTELLIGENT AUTONOMY)\b/i;

const PROMPT_LINE_PATTERN =
  /^(?:instruction priority|current user request|memory\/session\/tool summaries|memory, session summaries|conversation history|tool history|review the tool memory|continue to the next pending step|every tool call must include|use exact eterx tool names|before a tool call|visible work notes are|work notes are|the latest user request|use the current request|these rules are enforced|your tool calls are rendered|decide intelligently whether|if a new action phase|if this is a continuation|if you are ready to answer|this is guidance|create a new note only|the note should sound|use the formula|mention what you just saw|keep it realistic|long notes are not needed|convert action labels|strong |weak style to avoid|do not expose chain-of-thought|do not create a 1 note|never start with dangling|never turn a work note)\b/i;

const DIRECTIVE_LINE_PATTERN =
  /^(?:you are|your behavior|you execute|you run|the task may require|classify each request|ask only for|read before editing|prefer the repository|keep changes scoped|preserve unrelated|treat all external|no placeholders|for shared behavior|when a command fails|maintain a compact|for debugging|for reviews|inspection:|editing:|commands and verification:|research:|use file_read|use file_create|use file_edit|use dev servers|build the actual|avoid generic|for ui changes|current date\/time|timezone:|operating system:|workspace:|available tools:)\b/i;

function normalizeLineStart(line: string): string {
  return line
    .replace(/^[\s>*#-]+/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
}

function isPromptScaffoldLine(line: string): boolean {
  const normalized = normalizeLineStart(line);
  if (!normalized) return false;
  PROMPT_MARKER_PATTERN.lastIndex = 0;
  PROMPT_TAG_PATTERN.lastIndex = 0;
  return (
    PROMPT_MARKER_PATTERN.test(normalized) ||
    PROMPT_TAG_PATTERN.test(normalized) ||
    PROMPT_HEADING_PATTERN.test(normalized) ||
    PROMPT_LINE_PATTERN.test(normalized) ||
    DIRECTIVE_LINE_PATTERN.test(normalized) ||
    (/^[A-Z][A-Z0-9_ /\-.]{8,}:?$/.test(normalized) && !/[a-z]/.test(normalized))
  );
}

function removePromptScaffold(value: string): string {
  const withoutBlocks = value
    .replace(PROMPT_BLOCK_PATTERN, '\n')
    .replace(PROMPT_MARKER_PATTERN, '\n')
    .replace(PROMPT_TAG_PATTERN, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?thought>/gi, '')
    .replace(/`([^`]+)`/g, '$1');

  return withoutBlocks
    .split(/\r?\n/)
    .filter(line => !isPromptScaffoldLine(line))
    .join('\n');
}

function rewriteInternalRepairNote(value: string): string {
  const text = value.trim();
  const lower = text.toLowerCase();

  if (/\b(?:the|my)\s+patch\s+created\b/.test(lower) || /\bduplicate initialization block\b/.test(lower)) {
    return 'I found overlapping initialization logic, so I am consolidating it before verification.';
  }

  if (/\brewriting\s+.+\s+from\s+scratch\b/.test(lower) || /\binefficient and prone to errors\b/.test(lower)) {
    return 'I found the implementation flow needed cleanup, so I am consolidating it before verification.';
  }

  return text
    .replace(/\bwould cause a runtime error\b/gi, 'could affect runtime behavior')
    .replace(/\bwill cause the script to fail\b/gi, 'could affect runtime behavior');
}

export function formatVisibleWorkNote(value: string, _maxLength = 720): string {
  let text = removePromptScaffold(String(value || ''))
    .replace(/\*\*(CLASSIFY|DECOMPOSE|ASSESS|ACT|VERIFY)\*\*/gi, '$1')
    .replace(/\b(CLASSIFY|DECOMPOSE|ASSESS|ACT|VERIFY)\s*(?:->|:|-)\s*/gi, '')
    .replace(/^[\s*>\-\u2022]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';

  text = rewriteInternalRepairNote(text);

  if (text.startsWith('.')) {
    text = text.replace(/^\.+/, '').trim();
  }

  text = text.replace(/^(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\b\s*[:\-]?\s*(?=\b(to|how|if|whether|for|what)\b)/i, '');
  text = text.replace(/^(?:\.?\/)?([a-zA-Z0-9_-]+\.(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1))\b\s*(?=\b(to|how|if|whether|for|what|show|check|verify)\b)/i, 'Checking $1 ');
  text = text.replace(/^(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\b\s*[:\-]?\s*/i, '');

  if (text) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text
    .replace(/^(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\s*(?=\b(where|which|that|has|is|was|the)\b)/i, 'The file ')
    .replace(/^(?:in\s+)?(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\s*[:\-]\s*/i, 'The file ')
    .replace(/\s+/g, ' ')
    .trim();
}
