/** Provider-neutral presentation adapters. These translate recorded data only;
 * they never execute an imported command, patch, or agent instruction. */
import { numberDiffLines, type NumberedDiffLine } from '../diff-line-numbers';
import { recordedFileContent, shellFileRead } from './file-reads';
type Data = Record<string, any>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const finite = (...values: unknown[]): number | undefined => values.find(value => typeof value === 'number' && Number.isFinite(value)) as number | undefined;
export const sourceToolName = (name: unknown) => string(name).replace(/^.*[.]/, '').replace(/^mcp__[^_]+__/, '').replace(/[_-]/g, '').toLowerCase();

/** Codex can wrap a terminal result in an exec transcript, JSON, and MCP blocks.
 * Decode only known envelopes; ordinary command stdout remains verbatim. */
export function recordedResult(value: unknown, depth = 0): Data {
  if (depth > 6) return { output: typeof value === 'string' ? value : '' };
  if (typeof value === 'number' || typeof value === 'boolean') return { output: String(value) };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) { try { return recordedResult(JSON.parse(trimmed), depth + 1); } catch { } }
    const exec = trimmed.match(/^(?:Script (?:completed|running)[\s\S]*?|Chunk ID:[\s\S]*?|Wall time:[\s\S]*?)\nOutput:\s*\n([\s\S]*)$/);
    if (exec && /^[\[{]/.test(exec[1].trim())) {
      try { return recordedResult(JSON.parse(exec[1]), depth + 1); } catch { }
    }
    const metadata = exec ? trimmed.slice(0, exec.index! + exec[0].length - exec[1].length) : '';
    const exit = metadata.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/i);
    const duration = metadata.match(/(?:Wall time|Elapsed time):\s*([\d.]+)\s*(?:seconds|s)\b/i);
    const session = metadata.match(/(?:Process running with session ID|Session ID:)\s*([\w-]+)/i);
    const output = exec ? exec[1] : value;
    return { output, ...(exit ? { exitCode: Number(exit[1]) } : {}), ...(duration ? { durationMs: Number(duration[1]) * 1000 } : {}), ...(session ? { session_id: session[1] } : {}) };
  }
  if (Array.isArray(value)) {
    if (value.length === 1) return recordedResult(value[0], depth + 1);
    const blocks = value.map(part => recordedResult(part, depth + 1));
    return { output: blocks.map(part => string(part.output)).filter(Boolean).join('\n\n') };
  }
  const data = object(value);
  if (['image', 'image_url', 'input_image', 'document', 'file', 'input_file'].includes(data.type)) return { output: '' };
  if (data.status === 'fulfilled' && data.value !== undefined) return recordedResult(data.value, depth + 1);
  if (data.structuredContent) return { ...recordedResult(data.structuredContent, depth + 1), ...(data.isError || data.is_error ? { isError: true } : {}) };
  if (Array.isArray(data.content)) return { ...recordedResult(data.content, depth + 1), ...(data.isError || data.is_error ? { isError: true } : {}) };
  if (['text', 'input_text', 'output_text'].includes(data.type)) return recordedResult(data.text, depth + 1);
  const output = string(data.output) || [string(data.stdout), string(data.stderr)].filter(Boolean).join('\n') || string(data.text) || string(data.content);
  const exitCode = finite(data.exitCode, data.exit_code, data.code, object(data.metadata).exit_code);
  const seconds = finite(data.wall_time_seconds, object(data.metadata).duration_seconds);
  const hasRecordedOutput = ['output', 'stdout', 'stderr', 'text', 'content'].some(key => typeof data[key] === 'string') || exitCode !== undefined;
  return { ...data, output: hasRecordedOutput ? output : Object.keys(data).length ? JSON.stringify(data, null, 2) : '',
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(finite(data.durationMs) !== undefined ? { durationMs: data.durationMs } : seconds !== undefined ? { durationMs: seconds * 1000 } : {}) };
}

const absolutePath = (value: unknown, cwd: string) => {
  const raw = string(value).trim();
  if (!raw || /[\r\n\0]/.test(raw)) return '';
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(raw) || !cwd) return raw;
  const separator = cwd.includes('\\') ? '\\' : '/';
  return `${cwd.replace(/[\\/]$/, '')}${separator}${raw.replace(/^\.\//, '')}`;
};
type Change = { path: string; action: 'modified' | 'created' | 'deleted'; diffLines: NumberedDiffLine[]; additions?: number; deletions?: number; readback?: string; sourcePatchFormat?: 'apply_patch'; sourceLineTransform?: { includes: string; before: string; after: string } };
const change = (path: string, action: Change['action'], diffLines: NumberedDiffLine[], readback?: string): Change => ({
  path, action, diffLines: numberDiffLines(diffLines, action === 'created' ? { newLine: 1 } : {}), additions: diffLines.filter(line => line.type === 'added').length,
  deletions: diffLines.filter(line => line.type === 'removed').length, ...(readback !== undefined ? { readback } : {}),
});

function fileChanges(name: string, args: Data, result: Data, cwd: string): Change[] {
  const patch = string(args.patch || args.input || args.code || args.diff || result.patch || result.diff);
  const sourcePatchFormat = /^\*\*\* Begin Patch\r?\n/.test(patch) ? 'apply_patch' as const : undefined;
  if (Array.isArray(result.changes)) return result.changes.filter((item: any) => typeof item?.path === 'string').map((item: any) => ({
    ...change(absolutePath(item.path, cwd), ['modified', 'created', 'deleted'].includes(item.action) ? item.action : 'modified', Array.isArray(item.diffLines) ? item.diffLines : [], item.readback),
    ...(sourcePatchFormat ? { sourcePatchFormat } : {}),
    ...(item.sourceLineTransform ? { sourceLineTransform: item.sourceLineTransform } : {}),
    ...(typeof item.additions === 'number' ? { additions: item.additions } : {}), ...(typeof item.deletions === 'number' ? { deletions: item.deletions } : {}),
  }));
  if (name === 'importedlinetransform') {
    const transform = object(args.transform);
    if (!Array.isArray(transform.paths) || typeof transform.includes !== 'string' || !transform.before || typeof transform.before !== 'string' || typeof transform.after !== 'string'
      || /[\r\n]/.test(transform.before + transform.after + transform.includes)) return [];
    return transform.paths.filter((value: unknown) => typeof value === 'string').map((value: string) => ({
      path: absolutePath(value, cwd), action: 'modified', diffLines: [],
      sourceLineTransform: { includes: transform.includes, before: transform.before, after: transform.after },
    }));
  }
  const changes: Change[] = [];
  let current: Change | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      current = change(absolutePath(header[2], cwd), header[1] === 'Add' ? 'created' : header[1] === 'Delete' ? 'deleted' : 'modified', []);
      changes.push(current); continue;
    }
    if (line.startsWith('*** Move to: ') && current) { current.path = absolutePath(line.slice(13), cwd); continue; }
    if (line === '*** End of File' && current?.diffLines.length) { current.diffLines[current.diffLines.length - 1].patchEndOfFile = true; continue; }
    if (!current || line.startsWith('***')) continue;
    if (line.startsWith('@@')) {
      const context = line.slice(2).replace(/^ /, '');
      current.diffLines.push({ type: 'context', content: context || 'Changed section', isGap: true,
        ...(context && !/^-\d+(?:,\d+)?\s+\+\d+/.test(context) ? { patchContext: context } : {}) });
    }
    else if (/^[+ -]/.test(line)) current.diffLines.push({ type: line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context', content: line.slice(1) });
  }
  if (changes.length) return changes.map(item => ({ ...change(item.path, item.action, item.diffLines), sourcePatchFormat }));
  const target = absolutePath(args.file_path || args.target_file || args.path || args.filePath || args.filename || args.relative_workspace_path, cwd);
  // Exported tools may use standard unified hunks instead of apply_patch's
  // file headers. Keep their original old/new offsets for the native gutter.
  const patchLines = patch.split(/\r?\n/);
  current = undefined;
  for (let index = 0; index < patchLines.length; index++) {
    const line = patchLines[index];
    if (line.startsWith('--- ') && patchLines[index + 1]?.startsWith('+++ ')) {
      const before = line.slice(4).split('\t')[0], after = patchLines[++index].slice(4).split('\t')[0];
      const filepath = absolutePath((after === '/dev/null' ? before : after).replace(/^[ab]\//, ''), cwd);
      current = change(filepath, before === '/dev/null' ? 'created' : after === '/dev/null' ? 'deleted' : 'modified', []);
      changes.push(current); continue;
    }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (!current && target) { current = change(target, 'modified', []); changes.push(current); }
      current?.diffLines.push({ type: 'context', content: line, isGap: true });
    } else if (current && /^[+ -]/.test(line)) {
      current.diffLines.push({ type: line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context', content: line.slice(1) });
    }
  }
  if (changes.length) return changes.map(item => change(item.path, item.action, item.diffLines));
  if (!target) return [];
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  const diffLines: NumberedDiffLine[] = [];
  let hasReplacement = false;
  for (const edit of edits) {
    const before = edit.old_string ?? edit.oldString ?? edit.oldText ?? edit.old_str;
    const after = edit.new_string ?? edit.newString ?? edit.newText ?? edit.new_str;
    if (typeof before !== 'string' || typeof after !== 'string') continue;
    hasReplacement = true;
    if (diffLines.length) diffLines.push({ type: 'context', content: 'Next change', isGap: true });
    if (before) diffLines.push(...before.split(/\r?\n/).map(content => ({ type: 'removed', content })));
    if (after) diffLines.push(...after.split(/\r?\n/).map(content => ({ type: 'added', content })));
  }
  if (hasReplacement) return [change(target, 'modified', diffLines)];
  const contents = args.content ?? args.contents ?? args.file_text;
  const deleted = /delete|remove/.test(name);
  // A whole-file write may replace an existing file. Only source evidence may
  // label it as created or supply a before/after diff.
  return [change(target, deleted ? 'deleted' : result.created === true ? 'created' : 'modified', [], typeof contents === 'string' ? contents : undefined)];
}

export function adaptImportedAction(log: Data): Data[] {
  const originalName = string(log.sourceToolName || log.toolName || log.tool) || 'Tool output';
  const name = sourceToolName(originalName);
  const args = object(log.toolArgs || log.args);
  const result = recordedResult(log.toolResult ?? log.output);
  const cwd = string(args.workdir || args.cwd || result.cwd || log.cwd || log.workspacePath);
  const next: Data = { ...log, type: 'command', sourceToolName: originalName, toolName: originalName, tool: originalName,
    toolArgs: args, historical: true, isStreaming: false, isComplete: true, streamState: 'closed',
    status: log.sourceFailed || result.isError || result.is_error || result.success === false || result.exitCode && result.exitCode !== 0 ? 'failed' : 'completed',
    output: result.output, toolResult: { ...result, input: args, historical: true }, secondary: '', iconCategory: 'api' };
  const terminal = ['execcommand', 'shellcommand', 'shell', 'bash', 'terminal', 'runterminalcmd', 'runterminalcommand', 'workspaceruncommand', 'terminalaccess', 'writestdin', 'bashoutput'].includes(name);
  const edit = ['applypatch', 'edit', 'multiedit', 'write', 'writefile', 'editfile', 'strreplace', 'strreplaceeditor', 'strreplacebasededittool', 'deletefile', 'workspaceditfile', 'workspaceeditfile', 'importedlinetransform'].includes(name);
  const read = ['read', 'readfile', 'view', 'workspacereadfile', 'readmcpresource', 'viewimage', 'openfile'].includes(name);
  const search = ['grep', 'glob', 'rg', 'listdir', 'ls', 'filesearch', 'codesearch', 'codebasesearch', 'searchfiles'].includes(name);
  if (terminal) {
    const control = ['writestdin', 'bashoutput'].includes(name);
    const command = string(args.cmd || args.command || args.script) || (Array.isArray(args.command) ? args.command.join(' ') : '') || string(log.command);
    const fileRead = !control && next.status !== 'failed' ? shellFileRead(command) : null;
    if (fileRead && result.output) {
      const filepath = absolutePath(fileRead.path, cwd);
      const content = recordedFileContent(result.output, fileRead.startLine);
      next.type = 'exploration'; next.toolName = next.tool = 'workspace_read_file'; next.iconCategory = 'file_read';
      next.text = 'Read file'; next.filepath = filepath; next.filename = filepath.split(/[\\/]/).pop(); next.secondary = filepath;
      next.toolArgs = { ...args, path: filepath, startLine: content.startLine, endLine: fileRead.endLine };
      return [next, { id: `${log.id}-read-preview`, type: 'file_preview', ownerTraceId: log.id, toolCallId: log.toolCallId,
        turnId: log.turnId, runId: log.runId, chatId: log.chatId, ownerChatId: log.ownerChatId, importedFrom: log.importedFrom,
        timestamp: log.timestamp, importPresentationVersion: log.importPresentationVersion, importRevision: log.importRevision,
        historical: true, isStreaming: false, streamState: 'closed', status: 'completed', filepath, filename: next.filename,
        ...content, endLine: fileRead.endLine, sourceFileSnapshot: true, sourceFileComplete: fileRead.complete && !content.truncated }];
    }
    const hasKnownExit = result.exitCode !== undefined;
    next.toolName = next.tool = 'workspace_run_command'; next.iconCategory = 'terminal';
    next.text = control ? 'Read process output' : 'Ran command';
    next.command = command || (control ? 'Read recorded process output' : 'Recorded command');
    next.toolArgs = { ...args, command: next.command, cwd, ...(control ? { mode: 'check' } : {}) };
    next.cwd = cwd; next.shell = string(args.shell || result.shell);
    next.exitCode = result.exitCode; next.durationMs = result.durationMs;
    // A historical session ID cannot reconnect to an EterX live process.
    next.sourceSessionId = result.session_id ?? args.session_id;
    next.toolResult = { ...result, output: result.output, cwd, running: false, stillRunning: false, historical: true, status: hasKnownExit ? next.status : 'unknown' };
    return [next];
  }
  if (edit) {
    const changes = fileChanges(name, args, result, cwd);
    if (!changes.length) {
      next.toolName = next.tool = 'imported_action'; next.iconCategory = 'code'; next.text = 'File operation details';
      return [next];
    }
    const failed = next.status === 'failed' || /^\s*(?:Error:|Failed to|Patch failed|apply_patch verification failed)/i.test(result.output);
    const files = (action: string) => changes.filter(item => item.action === action).map(item => item.path);
    const actions = new Set(changes.map(item => item.action));
    const operation = failed ? 'none' : actions.size > 1 ? 'mixed' : actions.has('created') ? 'created' : actions.has('deleted') ? 'deleted' : changes.length ? 'edited' : 'none';
    next.type = 'file_edit'; next.toolName = next.tool = 'workspace_edit_file'; next.iconCategory = 'file_edit';
    next.text = failed ? 'File edit failed' : operation === 'created' ? 'Created file' : operation === 'deleted' ? 'Deleted file' : 'Edited file';
    next.files = changes.map(item => item.path); next.fileCount = changes.length; next.filepath = changes[0]?.path; next.filename = changes[0]?.path.split(/[\\/]/).pop();
    next.toolResult = { ...result, operation, changes: failed ? [] : changes, filesCreated: failed ? [] : files('created'), filesModified: failed ? [] : files('modified'), filesDeleted: failed ? [] : files('deleted'), errors: failed ? [result.output || 'The source reported that this edit failed.'] : [], rolledBack: false };
    return [next, ...changes.filter(item => !failed && (item.diffLines?.length || item.readback !== undefined || item.sourceLineTransform)).map((item, index) => ({
      id: `${log.id}-file-${index}`, type: 'file_preview', ownerTraceId: log.id, toolCallId: log.toolCallId,
      turnId: log.turnId, runId: log.runId, chatId: log.chatId, ownerChatId: log.ownerChatId, importedFrom: log.importedFrom,
      timestamp: log.timestamp, startTime: log.startTime, endTime: log.endTime, importPresentationVersion: log.importPresentationVersion,
      importRevision: log.importRevision, historical: true, isStreaming: false, streamState: 'closed', status: 'completed',
      toolName: 'workspace_edit_file', filepath: item.path, filename: item.path.split(/[\\/]/).pop(), isEdit: item.action !== 'created',
      created: item.action === 'created', operation: item.action === 'created' ? 'created' : item.action === 'deleted' ? 'deleted' : 'edited',
      sourcePatchFormat: item.sourcePatchFormat,
      sourceLineTransform: item.sourceLineTransform,
      diffLines: item.diffLines, content: item.readback || '', linesAdded: item.additions, linesRemoved: item.deletions,
      sourceFileComplete: item.readback !== undefined,
    }))];
  }
  const path = absolutePath(args.file_path || args.path || args.filePath || args.filename || args.target_file || args.relative_workspace_path, cwd);
  if (read) {
    next.type = 'exploration'; next.text = name === 'viewimage' ? 'Viewed image' : 'Read file'; next.iconCategory = name === 'viewimage' ? 'image' : 'file_read';
    next.filepath = path; next.filename = path.split(/[\\/]/).pop(); next.secondary = path;
    if (path && name !== 'viewimage' && result.output) return [next, {
      id: `${log.id}-read-preview`, type: 'file_preview', ownerTraceId: log.id, toolCallId: log.toolCallId,
      turnId: log.turnId, runId: log.runId, chatId: log.chatId, ownerChatId: log.ownerChatId, importedFrom: log.importedFrom,
      timestamp: log.timestamp, startTime: log.startTime, endTime: log.endTime, importPresentationVersion: log.importPresentationVersion,
      importRevision: log.importRevision, historical: true, isStreaming: false, streamState: 'closed', status: 'completed',
      filepath: path, filename: next.filename, ...recordedFileContent(result.output, args.offset ?? args.start_line ?? args.startLine ?? 1),
      sourceFileSnapshot: true, sourceFileComplete: result.complete === true && !result.truncated,
    }];
  } else if (search) {
    next.type = 'exploration'; next.text = /glob|listdir|ls/.test(name) ? 'Explored files' : 'Searched files'; next.iconCategory = 'search';
    next.secondary = string(args.pattern || args.query || args.search_term || args.path);
  } else if (/websearch|webfetch|web.*run/.test(name) || originalName === 'web.run' || originalName === 'web__run') {
    next.type = 'exploration'; next.text = /fetch/.test(name) ? 'Read web page' : 'Searched the web'; next.iconCategory = 'web_search';
    next.secondary = string(args.query || args.url) || string(args.search_query?.[0]?.q);
    if (Array.isArray(result.results)) { next.toolName = next.tool = 'web_search'; next.toolResult = result; }
  } else if (/browser|computer|cua|screenshot/.test(originalName.toLowerCase())) {
    next.type = 'browser'; next.iconCategory = 'browser'; next.text = /screenshot/.test(name) ? 'Captured screenshot' : 'Used browser'; next.secondary = string(args.title || args.url || args.action);
  } else if (/spawnagent|subagent|agenttask|^task$|^agent$|sendmessagetothread|waitthreads|waitagent|sendmessage/.test(name)) {
    next.iconCategory = 'agent'; next.text = /wait/.test(name) ? 'Read agent progress' : /send/.test(name) ? 'Sent agent message' : 'Agent work'; next.secondary = string(args.description || args.task_name || args.title);
    const agents = Array.isArray(result.agents) ? result.agents : result.agent_id || result.agentId ? [{
      agentId: result.agent_id || result.agentId, name: result.nickname || args.task_name || args.description || 'Imported agent',
      task: args.message || args.prompt || args.description, ...(result.status ? { status: result.status } : {}), result: result.result,
    }] : [];
    if (agents.length) {
      next.toolName = next.tool = 'spawn_sub_agent';
      next.toolArgs = { ...args, mode: 'status' };
      next.toolResult = { ...result, agents, message: result.message || 'Recorded agent activity', historical: true };
    }
  } else if (/database|dbquery|sqlquery/.test(name) && Array.isArray(result.rows)) {
    next.iconCategory = 'database'; next.text = 'Queried data'; next.toolName = next.tool = 'db_query'; next.toolResult = result;
  } else if (/skill|readskill/.test(name)) {
    next.iconCategory = 'skill'; next.text = 'Loaded skill'; next.secondary = string(args.skill || args.name || args.path);
    next.toolName = next.tool = 'get_skill_guidelines';
    next.toolArgs = { ...args, skill_name: args.skill_name || args.skill || args.name };
  } else if (/todo|updateplan/.test(name)) {
    next.iconCategory = 'verification'; next.text = 'Updated plan';
    const plan = Array.isArray(args.plan) ? args.plan : Array.isArray(args.todos) ? args.todos : [];
    if (plan.length) next.toolResult = { steps: plan.map((item: Data) => ({ step: item.step || item.content || item.description, status: item.status || 'pending' })), ...(args.explanation ? { output: args.explanation } : {}) };
  } else if (/wait|sleep/.test(name)) {
    next.iconCategory = args.cell_id ? 'code' : 'clock'; next.text = args.cell_id ? 'Read tool output' : 'Waited for completion';
  } else if (/imagegen|generateimage/.test(name)) {
    next.iconCategory = 'image'; next.text = 'Generated image';
  } else if (/^exec$|^js$|python|jupyter|notebook/.test(name)) {
    next.iconCategory = 'code'; next.text = 'Ran code';
  } else {
    next.text = string(args.title) || originalName.replace(/^.*(?:\.|__)/, '').replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase());
    next.iconCategory = /mcp|connector/i.test(originalName) ? 'connector' : 'api';
  }
  if (!string(result.output).trim() && next.toolResult?.steps === undefined) next.toolResult = { output: 'No separate result was recorded in the source.', input: args };
  return [next];
}
