import { getToolDisplayLabel, normalizeToolTraceName } from '../../lib/agent/tool-trace';

type ActionSummary = { key: string; singular: string; plural: string; live: string };

const summaries: Record<string, Omit<ActionSummary, 'key'>> = {
  skill: { singular: 'Loaded a skill', plural: 'Loaded skills', live: 'Loading skill' },
  read: { singular: 'Read a file', plural: 'Read files', live: 'Reading file' },
  browser: { singular: 'Used browser', plural: 'Used browser', live: 'Using browser' },
  browser_launch: { singular: 'Launched browser', plural: 'Launched browser', live: 'Launching browser' },
  click: { singular: 'Clicked', plural: 'Clicked', live: 'Clicking' },
  search: { singular: 'Searched the web', plural: 'Searched the web', live: 'Searching the web' },
  code_search: { singular: 'Searched the codebase', plural: 'Searched the codebase', live: 'Searching the codebase' },
  source: { singular: 'Read a source', plural: 'Read sources', live: 'Reading source' },
  directory: { singular: 'Listed a directory', plural: 'Listed directories', live: 'Listing directory' },
  image: { singular: 'Generated an image', plural: 'Generated images', live: 'Generating image' },
  document: { singular: 'Generated a document', plural: 'Generated documents', live: 'Generating document' },
  chart: { singular: 'Generated a chart', plural: 'Generated charts', live: 'Generating chart' },
  data: { singular: 'Analyzed data', plural: 'Analyzed data', live: 'Analyzing data' },
  memory: { singular: 'Recalled chat context', plural: 'Recalled chat context', live: 'Recalling chat context' },
  wait: { singular: 'Waited', plural: 'Waited', live: 'Waiting' },
  schedule: { singular: 'Managed a scheduled task', plural: 'Managed scheduled tasks', live: 'Managing scheduled task' },
  screenshot: { singular: 'Captured a screenshot', plural: 'Captured screenshots', live: 'Capturing screen' },
  compare: { singular: 'Compared files', plural: 'Compared files', live: 'Comparing files' },
  api: { singular: 'Made an API request', plural: 'Made API requests', live: 'Making API request' },
  database: { singular: 'Queried the database', plural: 'Queried the database', live: 'Querying database' },
  pdf: { singular: 'Read a PDF', plural: 'Read PDFs', live: 'Reading PDF' },
  speech: { singular: 'Generated speech', plural: 'Generated speech', live: 'Generating speech' },
};

const byTool: Record<string, string> = {
  get_skill_guidelines: 'skill', load_skill: 'skill',
  read_file: 'read', workspace_read_file: 'read',
  browser_control: 'browser', browser: 'browser', browser_use: 'browser',
  web_search: 'search', web_fetch: 'source',
  image_generator: 'image', context_memory: 'memory',
  wait_timer: 'wait', scheduled_tasks: 'schedule',
};

const byLabel: Record<string, string> = {
  'loading skill': 'skill', 'loaded skill': 'skill', 'loaded a skill': 'skill',
  'reading file': 'read', 'reading files': 'read', 'read file': 'read', 'read files': 'read',
  'using browser': 'browser', 'used browser': 'browser', 'browser use': 'browser',
  'launching browser': 'browser_launch', 'launch browser': 'browser_launch', 'launched browser': 'browser_launch',
  'opening chrome': 'browser_launch', 'opened chrome': 'browser_launch',
  'starting browser session': 'browser_launch', 'started browser session': 'browser_launch',
  'connecting to chrome': 'browser_launch', 'connected to chrome': 'browser_launch',
  'clicking': 'click', 'clicked': 'click',
  'right clicking': 'click', 'right clicked': 'click',
  'left clicking': 'click', 'left clicked': 'click',
  'double clicking': 'click', 'double clicked': 'click',
  'researching': 'search', 'searching the web': 'search', 'web searched': 'search',
  'searching codebase': 'code_search', 'reading source': 'source',
  'scanning directory': 'directory', 'listing directory': 'directory',
  'generating image': 'image', 'generating document': 'document',
  'generating chart': 'chart', 'analyzing data': 'data',
  'recalling chat context': 'memory', 'capturing screen': 'screenshot',
  'comparing files': 'compare',
  'api request': 'api', 'api call': 'api', 'database query': 'database',
  'reading pdf': 'pdf', 'generating speech': 'speech',
};

const completedVerbs: Record<string, string> = {
  loading: 'Loaded', reading: 'Read', searching: 'Searched', creating: 'Created',
  generating: 'Generated', analyzing: 'Analyzed', reviewing: 'Reviewed',
  updating: 'Updated', checking: 'Checked', saving: 'Saved', listing: 'Listed',
  managing: 'Managed', recalling: 'Recalled', comparing: 'Compared',
  verifying: 'Verified', connecting: 'Connected', inspecting: 'Inspected',
  fetching: 'Fetched', calculating: 'Calculated', sending: 'Sent',
  launching: 'Launched', opening: 'Opened', clicking: 'Clicked', using: 'Used',
};

/** Summary labels use tool identity and published UI text, never arguments,
 * output, file paths, or guesses based on command contents. */
export function getActionSummary(log: any): ActionSummary {
  const tool = normalizeToolTraceName(log?.toolName || log?.tool || log?.name).toLowerCase().replace(/[\s-]+/g, '_');
  const label = typeof log?.text === 'string' ? log.text.trim() : '';
  const category = byTool[tool] || byLabel[label.toLowerCase()];
  if (category) return { key: category, ...summaries[category] };

  const firstWord = label.match(/^([a-z]+)\b/i)?.[1] || '';
  const past = completedVerbs[firstWord.toLowerCase()];
  const publishedAction = past
    ? past + label.slice(firstWord.length)
    : /^(?:Loaded|Read|Searched|Created|Generated|Analyzed|Reviewed|Updated|Checked|Saved|Listed|Managed|Connected|Inspected|Fetched|Calculated|Sent|Added|Removed|Configured|Finalized|Ran|Unloaded)\b/.test(label) ? label : '';
  if (publishedAction && publishedAction.length <= 100 && !/[\r\n]/.test(publishedAction)) {
    return { key: `action:${publishedAction}`, singular: publishedAction, plural: publishedAction, live: label };
  }
  const toolLabel = tool ? getToolDisplayLabel(tool) : label && label.length <= 80 && !/[\r\n]/.test(label) ? label : '';
  const display = toolLabel && !/^(?:tool action|tool|working|(?:using|used|calling|called)(?: a)? tool)$/i.test(toolLabel) ? toolLabel : 'unnamed tool';
  return { key: `tool:${display}`, singular: `Called ${display}`, plural: `Called ${display}`, live: `Calling ${display}` };
}
