import { buildToolTraceFields, summarizeTraceValue } from './tool-trace';

type CustomToolLogType = 'command' | 'exploration' | 'file_edit' | 'communication' | 'browser';

type CustomToolUi = {
  text: string;
  type: CustomToolLogType | 'ask_user';
  iconCategory: string;
  argKeys: string[];
};

export type CustomToolActiveTrace = {
  id: string;
  toolCallId?: string;
  toolName: string;
  command?: string;
  filename?: string;
  toolArgs?: any;
};

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

const formatCustomToolLabel = (toolName: string) => {
  const known: Record<string, string> = {
    system_shell: 'Running command',
    workspace_run_command: 'Running project command',
    workspace_list_directory: 'Scanning directory',
    workspace_read_file: 'Reading file',
    workspace_write_file: 'Writing artifact',
    workspace_edit_file: 'Editing file',
    workspace_apply_patch: 'Patching files',
    workspace_search_text: 'Searching codebase',
    smart_file_analyzer: 'Analyzing files',
    workspace_analyze: 'Analyzing workspace',
    code_intelligence: 'Analyzing code',
    realtime_verify: 'Verifying output',
    workspace_verify_code: 'Verifying code',
    file_compression: 'Compressing files',
    desktop_notification: 'Notifying',
    plan_organization: 'Planning organization',
    ask_user: 'Asking user',
    web_search: 'Researching',
    web_scraper: 'Reading source',
    browser_search: 'Researching',
    browser_control: 'Using browser',
    api_caller: 'API request',
    calculator: 'Calculating',
    csv_analyzer: 'Analyzing data',
    image_generator: 'Generating image',
    screenshot_capture: 'Capturing screen',
    markdown_to_html: 'Converting markdown',
    json_yaml_transform: 'Transforming data',
    gateway_bridge: 'Using Gateway channel',
    connector_mcp: 'Using connected service',
    slack_controller: 'Slack operation',
    telegram_user_controller: 'Telegram operation',
    whatsapp_controller: 'WhatsApp operation',
    email_manager: 'Email operation',
  };
  if (known[toolName]) return known[toolName];
  return String(toolName || 'Running tool')
    .replace(/^agent_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
    .trim();
};

const getCustomToolArg = (args: any, keys: string[]) => {
  if (!args || typeof args !== 'object') return '';
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return summarizeTraceValue(value.trim(), 180);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value) && value.length > 0) {
      const summary = summarizeTraceValue(value, 180);
      if (summary) return summary;
      return value.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, any>;
          const fileish = record.filename || record.filePath || record.filepath || record.file_path || record.path || record.file;
          if (fileish) return String(fileish);
        }
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      }).join(', ').slice(0, 180);
    }
    if (value && typeof value === 'object') return summarizeTraceValue(value, 180);
  }
  return '';
};

const getCustomToolLogType = (toolName: string): CustomToolLogType => {
  if (/write|edit|move|rename|compress|organize|create|delete|remove/i.test(toolName)) return 'file_edit';
  if (/read|list|scan|search|analyz|verify|plan|ask/i.test(toolName)) return 'exploration';
  return 'command';
};

const getCustomToolUi = (toolName: string): CustomToolUi => {
  const known: Record<string, CustomToolUi> = {
    system_shell: { text: 'Running command', type: 'command', iconCategory: 'terminal', argKeys: ['command'] },
    workspace_run_command: { text: 'Running project command', type: 'command', iconCategory: 'terminal', argKeys: ['command'] },
    workspace_list_directory: { text: 'Scanning directory', type: 'exploration', iconCategory: 'folder_read', argKeys: ['directory', 'dir', 'path'] },
    workspace_semantic_search: { text: 'Searching codebase', type: 'exploration', iconCategory: 'search', argKeys: ['query', 'question'] },
    workspace_symbol_lookup: { text: 'Finding symbol', type: 'exploration', iconCategory: 'search', argKeys: ['symbol', 'name'] },
    workspace_file_outline: { text: 'Outlining file', type: 'exploration', iconCategory: 'file_read', argKeys: ['filename', 'path', 'file'] },
    workspace_str_replace: { text: 'Editing file', type: 'file_edit', iconCategory: 'file_edit', argKeys: ['filename', 'filePath', 'file_path', 'path', 'file'] },
    workspace_apply_patch: { text: 'Patching files', type: 'file_edit', iconCategory: 'file_edit', argKeys: ['patch', 'content', 'diff'] },
    workspace_find_files: { text: 'Finding files', type: 'exploration', iconCategory: 'search', argKeys: ['glob', 'directory'] },
    workspace_read_file: { text: 'Reading file', type: 'exploration', iconCategory: 'file_read', argKeys: ['filename', 'filePath', 'file_path', 'path'] },
    workspace_read_many_files: { text: 'Reading files', type: 'exploration', iconCategory: 'file_read', argKeys: ['files'] },
    workspace_write_file: { text: 'Writing artifact', type: 'file_edit', iconCategory: 'file_create', argKeys: ['filename', 'filePath', 'file_path', 'path'] },
    workspace_edit_file: { text: 'Editing file', type: 'file_edit', iconCategory: 'file_edit', argKeys: ['filename', 'filePath', 'file_path', 'path'] },
    workspace_edit_many_files: { text: 'Editing files', type: 'file_edit', iconCategory: 'file_edit', argKeys: ['edits', 'files'] },
    workspace_search_text: { text: 'Searching codebase', type: 'exploration', iconCategory: 'search', argKeys: ['pattern', 'query', 'directory'] },
    smart_file_analyzer: { text: 'Analyzing files', type: 'exploration', iconCategory: 'search', argKeys: ['path', 'filename', 'directory'] },
    workspace_analyze: { text: 'Analyzing workspace', type: 'exploration', iconCategory: 'search', argKeys: ['directory', 'path'] },
    code_intelligence: { text: 'Analyzing code', type: 'exploration', iconCategory: 'search', argKeys: ['target', 'path', 'query'] },
    realtime_verify: { text: 'Verifying output', type: 'command', iconCategory: 'verification', argKeys: ['target', 'mode', 'checkType'] },
    workspace_verify_code: { text: 'Verifying code', type: 'command', iconCategory: 'verification', argKeys: ['checkType', 'filename', 'path'] },
    file_compression: { text: 'Compressing files', type: 'file_edit', iconCategory: 'file_create', argKeys: ['source', 'sourcePath', 'path', 'targetPath'] },
    desktop_notification: { text: 'Notifying', type: 'communication', iconCategory: 'computer', argKeys: ['title', 'message'] },
    plan_organization: { text: 'Planning organization', type: 'exploration', iconCategory: 'search', argKeys: ['goal', 'request', 'target'] },
    web_search: { text: 'Researching', type: 'exploration', iconCategory: 'web_search', argKeys: ['query'] },
    web_scraper: { text: 'Reading source', type: 'exploration', iconCategory: 'web_search', argKeys: ['url'] },
    browser_search: { text: 'Researching', type: 'exploration', iconCategory: 'web_search', argKeys: ['query'] },
    browser_control: { text: 'Using browser', type: 'browser', iconCategory: 'computer', argKeys: ['action', 'url'] },
    api_caller: { text: 'API request', type: 'exploration', iconCategory: 'computer', argKeys: ['url', 'method'] },
    calculator: { text: 'Calculating', type: 'command', iconCategory: 'computer', argKeys: ['expression'] },
    csv_analyzer: { text: 'Analyzing data', type: 'exploration', iconCategory: 'search', argKeys: ['filename', 'path'] },
    image_generator: { text: 'Generating image', type: 'file_edit', iconCategory: 'image', argKeys: ['prompt', 'filename'] },
    screenshot_capture: { text: 'Capturing screen', type: 'exploration', iconCategory: 'computer', argKeys: ['target', 'filename'] },
    markdown_to_html: { text: 'Converting markdown', type: 'file_edit', iconCategory: 'file_create', argKeys: ['title', 'filename'] },
    json_yaml_transform: { text: 'Transforming data', type: 'command', iconCategory: 'computer', argKeys: ['operation'] },
    gateway_bridge: { text: 'Using Gateway channel', type: 'communication', iconCategory: 'connector', argKeys: ['platform', 'channel', 'action', 'target'] },
    connector_mcp: { text: 'Using connected service', type: 'communication', iconCategory: 'connector', argKeys: ['connector_id', 'connectorId', 'server_id', 'action'] },
    slack_controller: { text: 'Slack operation', type: 'communication', iconCategory: 'connector', argKeys: ['action', 'channel', 'target'] },
    telegram_user_controller: { text: 'Telegram operation', type: 'communication', iconCategory: 'connector', argKeys: ['action', 'chatId', 'target'] },
    whatsapp_controller: { text: 'WhatsApp operation', type: 'communication', iconCategory: 'connector', argKeys: ['action', 'target'] },
    email_manager: { text: 'Email operation', type: 'communication', iconCategory: 'connector', argKeys: ['action', 'subject', 'to'] },
  };

  if (known[toolName]) return known[toolName];
  const fallbackType = getCustomToolLogType(toolName);
  return {
    text: formatCustomToolLabel(toolName),
    type: fallbackType,
    iconCategory: fallbackType === 'file_edit'
      ? 'file_edit'
      : fallbackType === 'exploration'
        ? 'search'
        : 'terminal',
    argKeys: ['command', 'cmd', 'path', 'filename', 'directory', 'query', 'target', 'goal', 'request'],
  };
};

const mapCustomUiIcon = (value: any) => {
  const icon = String(value || '').toLowerCase().trim();
  if (!icon) return '';
  if (['computer', 'agent', 'terminal', 'image', 'file_read', 'file_create', 'file_edit', 'folder_read', 'folder_create', 'search', 'web_search', 'verification', 'connector'].includes(icon)) {
    return icon;
  }
  if (['bot', 'subagent', 'sub_agent'].includes(icon)) return 'agent';
  if (['photo', 'picture', 'visual'].includes(icon)) return 'image';
  if (['code', 'settings', 'barchart', 'monitor', 'cpu'].includes(icon)) return 'computer';
  if (['database', 'find', 'scan'].includes(icon)) return 'search';
  if (['globe', 'rss', 'compass', 'web'].includes(icon)) return 'web_search';
  if (['filetext', 'file', 'document', 'doc', 'read'].includes(icon)) return 'file_read';
  if (['edit', 'pen', 'patch'].includes(icon)) return 'file_edit';
  if (['fileplus', 'fileadd', 'create', 'write'].includes(icon)) return 'file_create';
  if (['folder', 'folderopen'].includes(icon)) return 'folder_read';
  if (['folderplus', 'folderadd'].includes(icon)) return 'folder_create';
  if (['check', 'checkcircle', 'shield', 'award', 'verify'].includes(icon)) return 'verification';
  return '';
};

const cleanActionText = (value: any, fallback: string) =>
  String(value || fallback || '')
    .replace(/^(?:step\s+\d+[:\s.]*|\[\s*step\s+\d+\s*\]\s*|\(\s*step\s+\d+\s*\)\s*|\(\s*\d+\s*\)\s*|\[\s*\d+(?:\/\d+)?\s*\]\s*|\d+[.:]\s*)/i, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim() || fallback;

const languageFromFilename = (filename: string) => {
  const ext = filename.toLowerCase().match(/\.[^.\\/]+$/)?.[0] || '';
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.css': 'css',
    '.html': 'html',
    '.htm': 'html',
    '.json': 'json',
    '.md': 'markdown',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'bash',
    '.ps1': 'powershell',
    '.sql': 'sql',
    '.txt': 'text',
  };
  return map[ext] || 'text';
};

export const formatVisibleCustomWorkNote = (value: string, maxLength = 720): string => {
  let text = String(value || '')
    .replace(/<\/?thought>/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(CLASSIFY|DECOMPOSE|ASSESS|ACT|VERIFY)\*\*/gi, '$1')
    .replace(/\b(CLASSIFY|DECOMPOSE|ASSESS|ACT|VERIFY)\s*(?:->|:|-)\s*/gi, '')
    .replace(/^[\s*>\-\u2022]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (text.startsWith('.')) text = text.replace(/^\.+/, '').trim();
  text = text.replace(/^(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\b\s*[:\-]?\s*(?=\b(to|how|if|whether|for|what)\b)/i, '');
  text = text.replace(/^(?:\.?\/)?([a-zA-Z0-9_-]+\.(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1))\b\s*(?=\b(to|how|if|whether|for|what|show|check|verify)\b)/i, 'Checking $1 ');
  text = text.replace(/^(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\b\s*[:\-]?\s*/i, '');
  if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
  text = text
    .replace(/^(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\s*(?=\b(where|which|that|has|is|was|the)\b)/i, 'The file ')
    .replace(/^(?:in\s+)?(?:jsx?|tsx?|ts|css|scss|json|md|html|py|sh|ps1)\s*[:\-]\s*/i, 'The file ')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  text = sentences.slice(0, 4).join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1).replace(/\s+\S*$/, '').trim()}...`;
  }
  return text;
};

export const createCustomWorkNoteLog = (
  text: string,
  agentName: string,
  noteId: string,
  at = Date.now(),
) => {
  const noteText = formatVisibleCustomWorkNote(text);
  if (noteText.length < 8) return null;
  return {
    id: `custom_work_note_${at}_${randomSuffix()}`,
    type: 'work_note',
    text: noteText,
    subAgent: agentName,
    noteId,
    isDelta: false,
    isStreaming: false,
    startTime: at,
    endTime: at,
    timestamp: at,
  };
};

export const createCustomToolActionLog = (
  event: any,
  agentName: string,
  startedAt = Date.now(),
) => {
  const toolName = String(event?.toolName || 'custom_tool');
  const args = event?.toolArgs || {};
  const ui = getCustomToolUi(toolName);
  const traceFields = buildToolTraceFields(toolName, args, { argKey: ui.argKeys[0] });
  const preferredSecondary = getCustomToolArg(args, ui.argKeys);
  const command = getCustomToolArg(args, ['command', 'cmd', 'script']);
  const filePath = getCustomToolArg(args, [
    'filename',
    'filepath',
    'filePath',
    'file_path',
    'targetFile',
    'target_file',
    'outputFile',
    'output_file',
  ]);
  const directoryPath = getCustomToolArg(args, [
    'path',
    'directory',
    'dir',
    'folder',
    'workspacePath',
  ]);
  const primaryPath = filePath || directoryPath || getCustomToolArg(args, [
    'targetPath',
    'target_path',
    'sourcePath',
    'source_path',
  ]);
  const query = getCustomToolArg(args, ['query', 'pattern', 'search', 'goal', 'request']);
  const secondary = traceFields.secondary || preferredSecondary || command || primaryPath || query;
  const type = ui.type === 'ask_user' ? 'exploration' : ui.type;
  const shouldLinkFile = ['file_read', 'file_edit', 'file_create'].includes(ui.iconCategory)
    || /workspace_(?:read|write|edit)_file|docx|pdf|csv|markdown|chart|image/i.test(toolName);
  const linkedFile = shouldLinkFile ? (traceFields.filename || filePath || primaryPath) : '';
  const isConnectorTool = ui.type === 'communication' || ['gateway_bridge', 'connector_mcp', 'slack_controller', 'telegram_user_controller', 'whatsapp_controller', 'email_manager'].includes(toolName);
  const iconCategory = isConnectorTool ? 'connector' : (mapCustomUiIcon(args?.uiIcon) || (command ? 'terminal' : ui.iconCategory));
  return {
    id: `custom_tool_${startedAt}_${toolName}_${randomSuffix()}`,
    type,
    text: cleanActionText(args?.uiActionText, ui.text),
    secondary,
    filename: linkedFile || undefined,
    files: traceFields.files,
    fileCount: traceFields.fileCount,
    command: command || undefined,
    icon: args?.uiIcon,
    toolArgs: args,
    connectorId: args?.connectorId || args?.connector_id || args?.server_id || args?.platform || args?.channel || undefined,
    tool: toolName,
    name: toolName,
    subAgent: agentName,
    iconCategory,
    add: undefined,
    remove: undefined,
    startTime: startedAt,
    endTime: startedAt,
    timestamp: startedAt,
  };
};

export const shouldShowCustomAgentStatus = (text: string) => {
  const value = text.trim();
  if (!value) return false;
  if (/\bis starting\b/i.test(value)) return false;
  if (/^.+\s+is thinking\.{0,3}$/i.test(value)) return false;
  if (/processed\s+\d+\s+tool call/i.test(value)) return false;
  if (/completed\.?$/i.test(value)) return false;
  if (/rate limited|retrying/i.test(value)) return false;
  return true;
};

export const normalizeCustomAgentStatus = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\.\.\./g, '...')
    .trim();

const summarizeCustomToolResult = (result: any) => {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result.slice(0, 12000);
  if (typeof result !== 'object') return String(result).slice(0, 12000);

  const fields = ['output', 'stdout', 'stderr', 'message', 'error', 'result', 'status'];
  const parts = fields
    .map(field => result[field])
    .filter(value => value !== null && value !== undefined && String(value).trim())
    .map(value => typeof value === 'string' ? value : JSON.stringify(value, null, 2));

  if (parts.length > 0) return parts.join('\n').slice(0, 12000);
  try {
    return JSON.stringify(result, null, 2).slice(0, 12000);
  } catch {
    return String(result).slice(0, 12000);
  }
};

export const createCustomToolResultLogs = (
  event: any,
  active: CustomToolActiveTrace,
  at = Date.now(),
) => {
  const result = event?.toolResult;
  const resultText = summarizeCustomToolResult(result);
  const logs: any[] = [];

  // terminal_background already streams the command's output and emits its
  // final event. Do not manufacture a second console card from tool_result.
  if (!result?._consoleTraceEmitted && (active.command || /(?:system_shell|workspace_run_command)/i.test(active.toolName)) && resultText) {
    logs.push({
      id: `custom_console_${at}_${randomSuffix()}`,
      type: 'console_output',
      command: active.command || active.toolName,
      output: resultText,
      content: resultText,
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : undefined,
      durationMs: typeof result?.durationMs === 'number' ? result.durationMs : undefined,
      ownerTraceId: active.id,
      startTime: at,
      endTime: at,
      timestamp: at,
    });
  }

  if (active.filename && active.toolName === 'workspace_read_file' && typeof result?.content === 'string') {
    logs.push({
      id: `custom_preview_${at}_${randomSuffix()}`,
      type: 'file_preview',
      filename: active.filename,
      filepath: result.path || active.filename,
      content: result.content,
      language: languageFromFilename(active.filename),
      isEdit: false,
      ownerTraceId: active.id,
      dedupe: false,
      startTime: at,
      endTime: at,
      timestamp: at,
    });
  }

  if (active.filename && active.toolName === 'workspace_write_file' && typeof active.toolArgs?.content === 'string') {
    logs.push({
      id: `custom_preview_${at}_${randomSuffix()}`,
      type: 'file_preview',
      filename: active.filename,
      filepath: result?.path || active.filename,
      content: active.toolArgs.content,
      language: languageFromFilename(active.filename),
      lineCount: active.toolArgs.content.split('\n').length,
      linesAdded: active.toolArgs.content.split('\n').length,
      linesRemoved: 0,
      isEdit: false,
      ownerTraceId: active.id,
      dedupe: false,
      startTime: at,
      endTime: at,
      timestamp: at,
    });
  }

  // --- Add Professional Tool Result Previews ---
  const EXCLUDED_PREVIEW_TOOLS = new Set([
    'skill_loader', 'screenshot_capture', 'system_automation', 'self_improve',
    'memory_v2', 'api_hub', 'api_key_vault', 'env_manager', 'desktop_control',
    'browser_control', 'checkpoint', 'computer', 'screen_agent'
  ]);

  if (result !== undefined && result !== null && !EXCLUDED_PREVIEW_TOOLS.has(active.toolName)) {
    if (!['workspace_read_file', 'workspace_write_file', 'workspace_edit_file', 'system_shell', 'workspace_run_command'].includes(active.toolName)) {
      logs.push({
        id: `custom_result_${at}_${randomSuffix()}`,
        type: 'tool_result_preview',
        toolName: active.toolName,
        toolArgs: active.toolArgs,
        result: result,
        ownerTraceId: active.id,
        startTime: at,
        endTime: at,
        timestamp: at,
      });
    }
  }

  return logs;
};
