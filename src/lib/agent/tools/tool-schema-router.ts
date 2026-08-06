import type { ToolDefinition } from '../schemas';

export type ToolSchemaRoutingDecision = {
  tools: ToolDefinition[];
  deferredToolNames: string[];
  matchedIntents: string[];
};

export type ToolCapabilityMatch = {
  name: string;
  score: number;
  intent: string;
};

type CapabilityRule = {
  intent: string;
  patterns: RegExp[];
  tools: string[];
};

const DISCOVERY_TOOL = 'tool_finder';
const DEFAULT_MAX_DIRECT_TOOLS = 8;

// These rules describe user goals, not words copied from tool descriptions.
// Ordering within a rule is the preferred execution order. A future scheduled
// task only needs scheduled_tasks now; the future run routes its own saved prompt.
const CAPABILITY_RULES: CapabilityRule[] = [
  {
    intent: 'schedule-recurring-task',
    patterns: [
      /\bcron\b/i,
      /\b(?:schedule|scheduled|recurring|recurrence|repeat(?:ing|ed)?|automate)\b/i,
      /\b(?:every|each)\s+(?:morning|evening|night|day|weekday|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(?:daily|weekly|monthly|hourly|nightly)\b/i,
      /\bremind\s+me\b/i,
      /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
    ],
    tools: ['scheduled_tasks'],
  },
  {
    intent: 'pause-current-run',
    patterns: [/\b(?:wait|sleep|pause)\s+(?:for\s+)?\d+/i, /\bcheck\s+again\s+in\b/i],
    tools: ['wait_timer'],
  },
  {
    intent: 'background-process',
    patterns: [/\b(?:in the background|background (?:job|process|task)|long[- ]running process)\b/i],
    tools: ['background_task', 'process_manager'],
  },
  {
    intent: 'system-health',
    patterns: [/\b(?:cpu|memory usage|disk usage|system health|system resources|running processes)\b/i],
    tools: ['system_monitor'],
  },
  {
    intent: 'notify-desktop',
    patterns: [/\b(?:desktop|system) notification\b/i, /\bnotify me (?:on|through) (?:my )?(?:computer|desktop)\b/i],
    tools: ['desktop_notification'],
  },
  {
    intent: 'inspect-codebase',
    patterns: [
      /\b(?:codebase|repository|repo|workspace|source code|project files?)\b/i,
      /\b(?:where is|find|locate)\b.{0,50}\b(?:file|symbol|class|function|component|implementation|definition|reference)\b/i,
      /\b(?:inspect|understand|trace|explain)\b.{0,50}\b(?:code|implementation|architecture|flow)\b/i,
    ],
    tools: ['workspace_semantic_search', 'workspace_search_text', 'workspace_read_many_files', 'workspace_read_file'],
  },
  {
    intent: 'modify-codebase',
    patterns: [
      /\b(?:fix|implement|refactor|patch|edit|change|update|add|remove|rename)\b.{0,80}\b(?:bug|code|file|function|class|component|feature|typescript|javascript|python|api|ui)\b/i,
      /\b(?:build|create)\b.{0,50}\b(?:feature|component|endpoint|script|module|app|website)\b/i,
    ],
    tools: ['workspace_semantic_search', 'workspace_search_text', 'workspace_read_many_files', 'workspace_edit_file', 'workspace_apply_patch'],
  },
  {
    intent: 'run-code',
    patterns: [/\b(?:run|execute)\b.{0,40}\b(?:command|script|program|server|app)\b/i, /\b(?:terminal|shell|powershell|command prompt)\b/i],
    tools: ['workspace_run_command'],
  },
  {
    intent: 'verify-code',
    patterns: [/\b(?:test|verify|lint|typecheck|type-check|compile|build check)\b/i],
    tools: ['workspace_verify_code', 'workspace_run_command', 'realtime_verify'],
  },
  {
    intent: 'read-files',
    patterns: [/\b(?:read|open|inspect|summari[sz]e)\b.{0,45}\b(?:file|folder|directory|config|source)\b/i, /\blist\b.{0,30}\b(?:files|folder|directory)\b/i],
    tools: ['workspace_find_files', 'workspace_read_many_files', 'workspace_read_file', 'workspace_list_directory'],
  },
  {
    intent: 'write-file',
    patterns: [/\b(?:create|write|save|generate)\b.{0,50}\b(?:file|config|source|script)\b/i],
    tools: ['workspace_write_file', 'workspace_edit_file'],
  },
  {
    intent: 'search-current-web',
    patterns: [
      /\b(?:search|browse|look up|find online|on the web|internet)\b/i,
      /\b(?:latest|current|today(?:'s)?|recent|news|up[- ]to[- ]date)\b/i,
      /\b(?:source|citation|cite|verify online)\b/i,
    ],
    tools: ['web_search'],
  },
  {
    intent: 'extract-web-page',
    patterns: [/https?:\/\//i, /\b(?:scrape|extract|read|summari[sz]e)\b.{0,40}\b(?:webpage|website|url|page)\b/i],
    tools: ['web_scraper', 'web_search'],
  },
  {
    intent: 'interactive-browser',
    patterns: [/\b(?:click|log in|sign in|fill|submit|navigate)\b.{0,50}\b(?:website|webpage|browser|form|button)\b/i],
    tools: ['browser_control'],
  },
  {
    intent: 'deep-web-research',
    patterns: [/\b(?:deep|comprehensive|exhaustive|multi-source) research\b/i, /\bresearch report\b/i],
    tools: ['deep_research', 'web_search', 'web_scraper'],
  },
  {
    intent: 'spreadsheet-data',
    patterns: [/\b(?:csv|xlsx|excel|spreadsheet|tabular dataset)\b/i, /\b(?:clean|analy[sz]e|profile)\b.{0,35}\bdata(?:set)?\b/i],
    tools: ['csv_data_analyzer', 'workspace_run_command', 'workspace_read_many_files', 'workspace_write_file', 'office_artifact_builder'],
  },
  {
    intent: 'pdf',
    patterns: [/\bpdf\b/i],
    tools: ['parse_pdf', 'office_artifact_builder'],
  },
  {
    intent: 'word-document',
    patterns: [/\b(?:docx|word document)\b/i],
    tools: ['parse_docx', 'docx_generator', 'office_artifact_builder'],
  },
  {
    intent: 'presentation',
    patterns: [/\b(?:pptx|powerpoint|slide deck|presentation|slides)\b/i],
    tools: ['office_artifact_builder'],
  },
  {
    intent: 'generate-image',
    patterns: [/\b(?:generate|create|draw|make)\b.{0,35}\b(?:image|picture|illustration|logo|icon|artwork)\b/i],
    tools: ['image_generator'],
  },
  {
    intent: 'find-image',
    patterns: [/\b(?:find|search|look for|download)\b.{0,35}\b(?:image|photo|picture|icon|stock photo)\b/i],
    tools: ['image_asset_search'],
  },
  {
    intent: 'screen-capture',
    patterns: [/\b(?:screenshot|screen capture|capture the screen)\b/i],
    tools: ['screenshot_capture'],
  },
  {
    intent: 'desktop-control',
    patterns: [/\b(?:click|type|press|move the mouse|keyboard|clipboard)\b.{0,45}\b(?:desktop|computer|screen|window|app)?\b/i],
    tools: ['computer', 'clipboard_manager'],
  },
  {
    intent: 'video',
    patterns: [/\b(?:generate|create|make)\b.{0,30}\bvideo\b/i],
    tools: ['video_generator'],
  },
  {
    intent: 'youtube-transcript',
    patterns: [/\b(?:youtube|video)\b.{0,35}\b(?:transcript|captions|subtitles)\b/i],
    tools: ['youtube_transcript'],
  },
  {
    intent: 'text-to-speech',
    patterns: [/\b(?:text to speech|tts|speak aloud|voice narration|generate audio)\b/i],
    tools: ['text_to_speech'],
  },
  {
    intent: 'api-request',
    patterns: [/\b(?:call|request|send to)\b.{0,40}\b(?:api|endpoint|webhook)\b/i, /\b(?:rest|graphql) api\b/i],
    tools: ['api_caller'],
  },
  {
    intent: 'connector',
    patterns: [/\b(?:mcp|connector|integration)\b/i],
    tools: ['connector_mcp', 'gateway_bridge'],
  },
  {
    intent: 'slack',
    patterns: [/\bslack\b/i],
    tools: ['slack_controller'],
  },
  {
    intent: 'calculate',
    patterns: [/\b(?:calculate|compute|arithmetic|equation|percentage)\b/i],
    tools: ['calculator'],
  },
  {
    intent: 'structured-transform',
    patterns: [/\b(?:json|ya?ml)\b.{0,35}\b(?:convert|transform|parse|format|validate)\b/i],
    tools: ['json_yaml_transform'],
  },
  {
    intent: 'regex-text',
    patterns: [/\b(?:regex|regular expression|pattern match|find and replace)\b/i],
    tools: ['regex_text_processor'],
  },
  {
    intent: 'archive-files',
    patterns: [/\b(?:zip|unzip|archive|compress|extract archive)\b/i],
    tools: ['file_compression'],
  },
  {
    intent: 'remember',
    patterns: [/\b(?:remember|save to memory|recall from memory|forget)\b/i],
    tools: ['memory_v2'],
  },
  {
    intent: 'delegate-agent',
    patterns: [/\b(?:sub[- ]?agent|delegate|parallel agents?|another agent)\b/i],
    tools: ['spawn_sub_agent', 'agent_communicate'],
  },
  {
    intent: 'load-skill',
    patterns: [/\b(?:use|load|follow)\b.{0,35}\b(?:skill|guidelines|playbook)\b/i],
    tools: ['get_skill_guidelines'],
  },
];

const TOOL_ALIASES: Record<string, string[]> = {
  scheduled_tasks: ['cron', 'recurring task', 'scheduled job', 'reminder', 'run every day', 'automation schedule'],
  wait_timer: ['wait', 'sleep', 'pause', 'check again later'],
  workspace_semantic_search: ['understand code', 'search codebase', 'find implementation', 'where in repository'],
  workspace_search_text: ['grep', 'search text', 'find references', 'find symbol'],
  workspace_find_files: ['find files', 'locate file', 'glob files'],
  workspace_read_file: ['read file', 'open source file'],
  workspace_read_many_files: ['read many files', 'inspect multiple files'],
  workspace_edit_file: ['edit code', 'change file', 'fix code'],
  workspace_apply_patch: ['apply patch', 'patch code'],
  workspace_write_file: ['create file', 'write file'],
  workspace_run_command: ['run command', 'terminal', 'shell', 'execute script'],
  workspace_verify_code: ['test code', 'lint', 'typecheck', 'compile'],
  web_search: ['search web', 'latest information', 'current news', 'online sources'],
  web_scraper: ['scrape webpage', 'extract website', 'read url'],
  browser_control: ['control browser', 'click website', 'fill web form', 'login website'],
  deep_research: ['deep research', 'research report', 'many sources'],
  csv_data_analyzer: ['analyze csv', 'clean dataset', 'spreadsheet analysis', 'dataframe'],
  office_artifact_builder: ['create spreadsheet', 'create slides', 'office document'],
  parse_pdf: ['read pdf', 'extract pdf'],
  parse_docx: ['read docx', 'parse word document'],
  docx_generator: ['create docx', 'write word document'],
  image_generator: ['generate image', 'create artwork'],
  image_asset_search: ['find image', 'search photo'],
  screenshot_capture: ['take screenshot', 'capture screen'],
  computer: ['control computer', 'desktop click', 'type on screen'],
  clipboard_manager: ['clipboard', 'copy paste'],
  api_caller: ['call api', 'http request', 'webhook'],
  connector_mcp: ['mcp connector', 'external integration'],
  calculator: ['calculate', 'math'],
  memory_v2: ['remember', 'recall memory', 'forget'],
  spawn_sub_agent: ['sub agent', 'delegate work', 'parallel agent'],
};

function configuredLimit(): number {
  const parsed = Number(process.env.ETERX_MAX_DIRECT_TOOL_SCHEMAS);
  return Number.isFinite(parsed)
    ? Math.max(2, Math.min(24, Math.floor(parsed)))
    : DEFAULT_MAX_DIRECT_TOOLS;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function trigrams(value: string): Set<string> {
  const compact = `  ${normalize(value)}  `;
  const result = new Set<string>();
  for (let i = 0; i <= compact.length - 3; i++) result.add(compact.slice(i, i + 3));
  return result;
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  return (2 * overlap) / (a.size + b.size);
}

function phraseScore(query: string, phrase: string): number {
  const normalizedPhrase = normalize(phrase);
  if (!normalizedPhrase) return 0;
  if (query.includes(normalizedPhrase)) return 80 + normalizedPhrase.split(' ').length * 5;
  const queryTerms = new Set(query.split(' ').filter(term => term.length >= 3));
  const phraseTerms = normalizedPhrase.split(' ').filter(term => term.length >= 3);
  if (!phraseTerms.length) return 0;
  const overlap = phraseTerms.filter(term => queryTerms.has(term)).length;
  if (overlap === phraseTerms.length) return 30 + overlap * 5;
  // Character n-grams make the capability catalog typo tolerant without an
  // embedding request, model load, or dependency. The catalog is tiny and the
  // vectors are bounded, so this remains a sub-millisecond-scale operation in
  // normal routing.
  const fuzzy = diceSimilarity(trigrams(query), trigrams(normalizedPhrase));
  return fuzzy >= 0.42 ? Math.round(fuzzy * 70) : 0;
}

/** Shared human-language capability search for direct routing and tool_finder. */
export function searchToolCapabilities(
  eligibleTools: ToolDefinition[],
  task: string,
  limit = DEFAULT_MAX_DIRECT_TOOLS,
): { matches: ToolCapabilityMatch[]; matchedIntents: string[] } {
  const available = new Set(eligibleTools.map(tool => tool.name));
  const normalizedTask = normalize(task);
  const scores = new Map<string, ToolCapabilityMatch>();
  const matchedIntents: string[] = [];
  const add = (name: string, score: number, intent: string) => {
    if (!available.has(name)) return;
    const previous = scores.get(name);
    if (!previous || score > previous.score) scores.set(name, { name, score, intent });
  };

  for (const rule of CAPABILITY_RULES) {
    if (!rule.patterns.some(pattern => pattern.test(task))) continue;
    matchedIntents.push(rule.intent);
    rule.tools.forEach((name, index) => add(name, 200 - index * 8, rule.intent));
  }

  for (const tool of eligibleTools) {
    const normalizedName = normalize(tool.name);
    if (normalizedName && normalizedTask.includes(normalizedName)) add(tool.name, 500, 'explicit-tool-name');
    for (const alias of TOOL_ALIASES[tool.name] || []) {
      const score = phraseScore(normalizedTask, alias);
      if (score > 0) add(tool.name, score, 'capability-alias');
    }
  }

  return {
    matches: [...scores.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, limit)),
    matchedIntents: [...new Set(matchedIntents)],
  };
}

/**
 * Select a stable, small direct-call surface for the next user goal. Unknown
 * phrasing gets only tool_finder, which uses the same capability catalog.
 */
export function routeToolSchemas(
  eligibleTools: ToolDefinition[],
  task: string,
  options: { preserveFullSurface?: boolean; maxDirectTools?: number } = {},
): ToolSchemaRoutingDecision {
  if (options.preserveFullSurface || process.env.ETERX_DISABLE_DYNAMIC_TOOL_ROUTING === '1' || eligibleTools.length <= 4) {
    return { tools: eligibleTools, deferredToolNames: [], matchedIntents: [] };
  }

  const byName = new Map(eligibleTools.map(tool => [tool.name, tool]));
  const limit = Math.max(1, options.maxDirectTools ?? configuredLimit());
  const { matches, matchedIntents } = searchToolCapabilities(eligibleTools, task, limit);
  const selectedNames = matches.map(match => match.name);
  if (byName.has(DISCOVERY_TOOL) && !selectedNames.includes(DISCOVERY_TOOL)) selectedNames.unshift(DISCOVERY_TOOL);

  const tools = selectedNames.slice(0, limit).map(name => byName.get(name)).filter((tool): tool is ToolDefinition => Boolean(tool));
  const selected = new Set(tools.map(tool => tool.name));
  return {
    tools,
    deferredToolNames: eligibleTools.filter(tool => !selected.has(tool.name)).map(tool => tool.name),
    matchedIntents,
  };
}
