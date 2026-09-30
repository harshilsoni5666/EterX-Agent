import path from 'path';
import { formatTerminalProgram } from './terminal-invocation';

export type ToolTraceLabel = {
  text: string;
  type: string;
  iconCategory: string;
  argKey?: string;
};

export type ToolTraceFields = {
  secondary: string;
  filename?: string;
  files?: string[];
  fileCount?: number;
};

export type DiffLine = {
  type: 'added' | 'removed' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
  isGap?: boolean;
  skipped?: number;
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  // Normalize provider casing without preserving retired workspace tools.
  workspace_edit_file: 'workspace_edit_file',
  workspace_run_command: 'workspace_run_command',
};

/** Keep provider aliases and legacy short names from leaking into UI traces. */
export function normalizeToolTraceName(name: unknown): string {
  const value = String(name || '').trim();
  if (!value) return '';
  const alias = value.toLowerCase().replace(/[\s-]+/g, '_');
  return TOOL_NAME_ALIASES[alias] || value;
}

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  workspace_edit_file: 'Editing file',
  workspace_run_command: 'Running project command',
  spawn_sub_agent: 'Managing agent work',
  agent_builder_get_profile: 'Reviewed agent profile',
  agent_builder_list_capabilities: 'Explored agent capabilities',
  agent_builder_save_profile: 'Updated agent profile',
  agent_builder_attach_main_tool: 'Added agent capability',
  agent_builder_remove_tool: 'Removed agent capability',
  agent_builder_attach_all_main_tools: 'Configured tool access',
  agent_builder_attach_connector_tools: 'Connected agent services',
  agent_builder_define_tool: 'Created custom capability',
  agent_builder_run_quality_check: 'Checked agent quality',
  agent_builder_finalize: 'Finalized agent profile',
  agent_builder_save_flow: 'Updated agent workflow',
  agent_builder_list_flows: 'Reviewed agent workflows',
  agent_builder_delete_flow: 'Removed agent workflow',
  agent_builder_run_flow: 'Ran agent workflow',
  agent_flow_blackboard_set: 'Updated workflow state',
  agent_flow_blackboard_get: 'Reviewed workflow state',
  agent_flow_blackboard_list: 'Reviewed workflow state',
  agent_tool_load: 'Loaded temporary capability',
  agent_tool_unload: 'Unloaded temporary capability',
  gateway_bridge: 'Inspected Gateway service',
  connector_mcp: 'Inspected connected service',
};

/** Human label for traces, including provider aliases and unknown custom names. */
export function getToolDisplayLabel(name: unknown): string {
  const canonical = normalizeToolTraceName(name);
  if (!canonical) return 'Tool action';
  if (TOOL_DISPLAY_LABELS[canonical]) return TOOL_DISPLAY_LABELS[canonical];
  return canonical
    .replace(/^workspace_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

/** Replace a raw tool identifier leaking into a short trace subtitle. */
export function normalizeToolTraceText(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^(.*?\b)([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)\s*$/i);
  if (!match) return text;
  const candidate = normalizeToolTraceName(match[2]);
  if (!TOOL_DISPLAY_LABELS[candidate] && !/^workspace_/.test(candidate)) return text;
  const prefix = match[1].trim();
  // Do not rewrite a real path that merely ends in a tool-shaped filename.
  if (/[\\/:]/.test(prefix)) return text;
  if (/^(?:preparing|calling|executing|running|using|invoking|loading)[:\s]*$/i.test(prefix)) {
    return getToolDisplayLabel(candidate);
  }
  return prefix ? `${prefix} ${getToolDisplayLabel(candidate)}` : getToolDisplayLabel(candidate);
}

const PATH_KEYS = [
  'filename',
  'filepath',
  'filePath',
  'file_path',
  'path',
  'file',
  'target',
  'targetPath',
  'target_path',
  'source',
  'sourcePath',
  'source_path',
  'outputFile',
  'output_file',
];

const HEAVY_KEYS = new Set([
  'content',
  'old_string',
  'new_string',
  'search',
  'replace',
  'patch',
  'diff',
  'stdout',
  'stderr',
  'output',
  'result',
  'toolResult',
]);

const COMMON_EXTENSIONLESS_FILES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'rakefile',
  'gemfile',
  'procfile',
  'readme',
  'authors',
  'copying',
  'install',
  'todo',
  'changelog',
]);

export function languageFromFilename(filename: string): string {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.htm': 'html',
    '.json': 'json',
    '.md': 'markdown',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'bash',
    '.ps1': 'powershell',
    '.sql': 'sql',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.cpp': 'cpp',
    '.c': 'c',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.xml': 'xml',
    '.toml': 'toml',
    '.env': 'bash',
    '.gitignore': 'bash',
    '.txt': 'text',
    '.vue': 'vue',
    '.svelte': 'svelte',
  };
  return map[ext] || 'text';
}

export function basenameForTrace(value: unknown): string {
  const text = cleanTraceString(value);
  if (!text) return '';
  return text.replace(/\\/g, '/').split('/').filter(Boolean).pop() || text;
}

export function normalizeTracePath(value: unknown): string {
  return cleanTraceString(value).replace(/\\/g, '/').toLowerCase();
}

/**
 * One file in one tool call owns one preview identity for its entire lifecycle.
 * The content may arrive through many live snapshots and a final read-back, but
 * renderers and persisted task state must keep updating the same expandable row.
 */
export function buildFilePreviewTraceId(ownerTraceId: unknown, filePath: unknown): string {
  const owner = cleanTraceString(ownerTraceId) || 'file-operation';
  const normalizedPath = normalizeTracePath(filePath) || 'file';
  let hash = 2166136261;
  const source = `${owner}\u0000${normalizedPath}`;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const ownerSegment = owner.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 72) || 'file-operation';
  return `file_preview_${ownerSegment}_${(hash >>> 0).toString(36)}`;
}

function cleanTraceString(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^["'`]+|["'`,;]+$/g, '')
    .trim();
}

function looksLikePath(value: string): boolean {
  const cleaned = cleanTraceString(value);
  if (!cleaned || cleaned.length > 280 || cleaned.includes('\n')) return false;
  if (/^(?:system|true|false|null|undefined)$/i.test(cleaned)) return false;
  if (/^(?:https?:|data:|blob:)/i.test(cleaned)) return false;

  const normalized = cleaned.replace(/^\.?[\\/]+/, '');
  const filename = normalized.split(/[\\/]/).filter(Boolean).pop() || normalized;
  if (!filename || filename.length > 160) return false;

  const lowerFilename = filename.toLowerCase();
  return /[\\/]/.test(normalized) ||
    /\.[A-Za-z0-9]{1,16}$/.test(filename) ||
    filename.startsWith('.') ||
    COMMON_EXTENSIONLESS_FILES.has(lowerFilename);
}

function pushUniquePath(paths: string[], seen: Set<string>, candidate: unknown): void {
  const cleaned = cleanTraceString(candidate);
  if (!looksLikePath(cleaned)) return;
  const key = normalizeTracePath(cleaned);
  const filename = basenameForTrace(cleaned).toLowerCase();
  if (seen.has(key)) return;

  const existingIdx = paths.findIndex(existing => {
    const existingKey = normalizeTracePath(existing);
    const existingName = basenameForTrace(existing).toLowerCase();
    return existingKey === key ||
      (existingName === filename && (existingKey === filename || key === filename));
  });

  if (existingIdx >= 0) {
    if (!/[\\/]/.test(paths[existingIdx]) && /[\\/]/.test(cleaned)) {
      paths[existingIdx] = cleaned;
    }
    seen.add(key);
    return;
  }

  seen.add(key);
  paths.push(cleaned);
}

export function parsePatchFileTargets(value: unknown): string[] {
  const text = cleanTraceString(value);
  if (!text) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    const patchMatch = trimmed.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/i);
    const legacyMatch = trimmed.match(/^File:\s+(.+)$/i);
    const gitMatch = trimmed.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/i);
    const plusMatch = trimmed.match(/^\+\+\+\s+(?:b\/)?(.+)$/i);
    const target = patchMatch?.[1] || legacyMatch?.[1] || gitMatch?.[2] ||
      (plusMatch?.[1] && plusMatch[1] !== '/dev/null' ? plusMatch[1] : '');
    if (target) pushUniquePath(found, seen, target);
  });
  return found;
}

function collectPathsFromValue(value: unknown, paths: string[], seen: Set<string>, depth = 0): void {
  if (paths.length >= 30 || depth > 3 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.slice(0, 40).forEach(item => collectPathsFromValue(item, paths, seen, depth + 1));
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    PATH_KEYS.forEach((key) => {
      if (key in record) collectPathsFromValue(record[key], paths, seen, depth + 1);
    });

    if (Array.isArray(record.filesModified)) collectPathsFromValue(record.filesModified, paths, seen, depth + 1);
    if (Array.isArray(record.filesCreated)) collectPathsFromValue(record.filesCreated, paths, seen, depth + 1);
    if (Array.isArray(record.filesDeleted)) collectPathsFromValue(record.filesDeleted, paths, seen, depth + 1);
    if (Array.isArray(record.files)) collectPathsFromValue(record.files, paths, seen, depth + 1);
    if (Array.isArray(record.results)) collectPathsFromValue(record.results, paths, seen, depth + 1);
    if (Array.isArray(record.edits)) collectPathsFromValue(record.edits, paths, seen, depth + 1);

    return;
  }

  const text = cleanTraceString(value);
  if (!text) return;
  if (text.includes('\n')) {
    parsePatchFileTargets(text).forEach(target => pushUniquePath(paths, seen, target));
    return;
  }

  if ((text.startsWith('{') || text.startsWith('[')) && text.length < 5000) {
    try {
      collectPathsFromValue(JSON.parse(text), paths, seen, depth + 1);
      return;
    } catch {
      // Fall through to direct path parsing.
    }
  }

  text
    .split(/\s*,\s*/)
    .filter(Boolean)
    .forEach(part => pushUniquePath(paths, seen, part));
}

export function collectToolTraceTargets(toolName: string, args: any = {}, result?: any): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  void toolName;

  const collect = (value: unknown) => collectPathsFromValue(value, paths, seen);

  collect(result?.path || result?.filePath || result?.filepath);
  collect(result?.filesModified);
  collect(result?.filesCreated);
  collect(result?.filesDeleted);
  collect(result?.results);
  collect(args);

  return paths;
}

function summarizePathList(paths: string[], maxItems = 3): string {
  const names = paths.map(basenameForTrace).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= maxItems) return names.join(', ');
  return `${names.slice(0, maxItems).join(', ')} +${names.length - maxItems}`;
}

function compactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return '[object]';
  if (Array.isArray(value)) return value.slice(0, 6).map(item => compactJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  Object.entries(value as Record<string, unknown>).slice(0, 12).forEach(([key, item]) => {
    if (HEAVY_KEYS.has(key)) {
      const text = typeof item === 'string' ? item : '';
      out[key] = text ? `[${text.length} chars]` : '[omitted]';
      return;
    }
    out[key] = compactJsonValue(item, depth + 1);
  });
  return out;
}

export function summarizeTraceValue(value: unknown, maxLength = 140): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const patchTargets = value.includes('\n') ? parsePatchFileTargets(value) : [];
    const text = patchTargets.length > 0 ? summarizePathList(patchTargets) : value;
    return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const targets = collectToolTraceTargets('', value);
  if (targets.length > 0) return summarizePathList(targets).slice(0, maxLength);

  try {
    const json = JSON.stringify(compactJsonValue(value));
    return (json || '').slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

export function buildToolTraceFields(
  toolName: string,
  args: any,
  label?: Pick<ToolTraceLabel, 'argKey'>,
): ToolTraceFields {
  const canonicalToolName = normalizeToolTraceName(toolName);
  const targets = collectToolTraceTargets(canonicalToolName, args);
  const argKey = label?.argKey;
  const argValue = argKey ? args?.[argKey] : undefined;

  let secondary = targets.length > 0
    ? summarizePathList(targets)
    : summarizeTraceValue(argValue ?? args?.path ?? args?.command ?? args?.commands ?? args?.taskId ?? args?.mode ?? args?.query ?? args?.action ?? canonicalToolName);

  if (canonicalToolName === 'workspace_run_command' && args?.program) {
    secondary = formatTerminalProgram(args.program, Array.isArray(args.args) ? args.args : [], true);
  }

  if (!secondary && argKey) secondary = summarizeTraceValue(args?.[argKey]);
  if (!secondary) secondary = String(canonicalToolName || 'tool');

  return {
    secondary: secondary.slice(0, 160),
    filename: targets[0],
    files: targets.length > 0 ? targets : undefined,
    fileCount: targets.length > 0 ? targets.length : undefined,
  };
}

export function buildLineDiffPreview(before: string, after: string): {
  diffLines: DiffLine[];
  added: number;
  removed: number;
} {
  if (before === after) return { diffLines: [], added: 0, removed: 0 };

  const oldLines = String(before || '').replace(/\r\n/g, '\n').split('\n');
  const newLines = String(after || '').replace(/\r\n/g, '\n').split('\n');
  const oldCount = oldLines.length;
  const newCount = newLines.length;

  let prefixCount = 0;
  while (prefixCount < oldCount && prefixCount < newCount && oldLines[prefixCount] === newLines[prefixCount]) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < oldCount - prefixCount &&
    suffixCount < newCount - prefixCount &&
    oldLines[oldCount - 1 - suffixCount] === newLines[newCount - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const middleOld = oldLines.slice(prefixCount, oldCount - suffixCount);
  const middleNew = newLines.slice(prefixCount, newCount - suffixCount);
  const midOldCount = middleOld.length;
  const midNewCount = middleNew.length;
  const diffLines: DiffLine[] = [];

  const prefixContextStart = Math.max(0, prefixCount - 3);
  for (let i = prefixContextStart; i < prefixCount; i++) {
    diffLines.push({ type: 'context', content: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  if (midOldCount < 1000 && midNewCount < 1000 && midOldCount * midNewCount < 250000) {
    const dp: number[][] = Array.from({ length: midOldCount + 1 }, () => new Array(midNewCount + 1).fill(0));
    for (let i = midOldCount - 1; i >= 0; i--) {
      for (let j = midNewCount - 1; j >= 0; j--) {
        dp[i][j] = middleOld[i] === middleNew[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    let oldIdx = 0;
    let newIdx = 0;
    while (oldIdx < midOldCount || newIdx < midNewCount) {
      const oldLine = prefixCount + oldIdx + 1;
      const newLine = prefixCount + newIdx + 1;
      if (oldIdx < midOldCount && newIdx < midNewCount && middleOld[oldIdx] === middleNew[newIdx]) {
        diffLines.push({ type: 'context', content: middleOld[oldIdx], oldLine, newLine });
        oldIdx++;
        newIdx++;
      } else if (newIdx < midNewCount && (oldIdx >= midOldCount || dp[oldIdx][newIdx + 1] >= dp[oldIdx + 1][newIdx])) {
        diffLines.push({ type: 'added', content: middleNew[newIdx], newLine });
        newIdx++;
      } else if (oldIdx < midOldCount) {
        diffLines.push({ type: 'removed', content: middleOld[oldIdx], oldLine });
        oldIdx++;
      }
    }
  } else {
    middleOld.forEach((line, index) => {
      diffLines.push({ type: 'removed', content: line, oldLine: prefixCount + index + 1 });
    });
    middleNew.forEach((line, index) => {
      diffLines.push({ type: 'added', content: line, newLine: prefixCount + index + 1 });
    });
  }

  const suffixContextEnd = Math.min(oldCount, oldCount - suffixCount + 3);
  const suffixOffset = newCount - oldCount;
  for (let i = oldCount - suffixCount; i < suffixContextEnd; i++) {
    diffLines.push({ type: 'context', content: oldLines[i], oldLine: i + 1, newLine: i + 1 + suffixOffset });
  }

  const visible = new Set<number>();
  diffLines.forEach((line, index) => {
    if (line.type !== 'context') {
      for (let i = Math.max(0, index - 3); i <= Math.min(diffLines.length - 1, index + 3); i++) {
        visible.add(i);
      }
    }
  });

  const visibleIndexes = Array.from(visible).sort((a, b) => a - b);
  const compacted: DiffLine[] = [];
  let previousIndex = -1;
  for (const index of visibleIndexes) {
    if (previousIndex >= 0 && index > previousIndex + 1) {
      const skipped = index - previousIndex - 1;
      const firstSkipped = diffLines[previousIndex + 1];
      compacted.push({
        type: 'context',
        content: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`,
        oldLine: firstSkipped?.oldLine,
        newLine: firstSkipped?.newLine,
        isGap: true,
        skipped,
      });
    }
    compacted.push(diffLines[index]);
    previousIndex = index;
  }
  return {
    diffLines: compacted,
    added: compacted.filter(line => line.type === 'added').length,
    removed: compacted.filter(line => line.type === 'removed').length,
  };
}
