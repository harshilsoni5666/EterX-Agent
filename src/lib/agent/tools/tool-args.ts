import { normalizeRegistryToolName, getToolInputJsonSchema } from './registry';
import type { ToolDefinition } from '../schemas';
import { normalizeWorkspaceEditChunk } from '../workspace/edit-input';
import { getSubAgentCreationArgumentGaps, SUB_AGENT_SPAWN_GUIDANCE } from '../sub-agent-spawn-guidance';

type ToolArgValidationResult = {
  success: boolean;
  args?: any;
  error?: string;
  missing?: string[];
};

export function getRecoverableToolArgumentGaps(toolName: string, args: any): string[] {
  const canonicalToolName = normalizeRegistryToolName(toolName);
  if (canonicalToolName === 'spawn_sub_agent') return getSubAgentCreationArgumentGaps(args);
  if (canonicalToolName !== 'workspace_edit_file') return [];
  const files = Array.isArray(args?.files) ? args.files : [];
  const missing: string[] = [];
  if (files.length > 0) {
    files.forEach((target: any, index: number) => {
      if (!String(target?.filename || '').trim()) missing.push(`files.${index}.filename`);
      if (target?.delete !== true && (!Array.isArray(target?.edits) || target.edits.length === 0)) {
        missing.push(`files.${index}.edits or delete`);
      }
    });
    return missing;
  }
  if (!String(args?.filename || '').trim()) missing.push('filename or files');
  if (args?.delete !== true && (!Array.isArray(args?.edits) || args.edits.length === 0)) {
    missing.push('edits or delete');
  }
  return missing;
}

function normalizeFilenameArgs(input: any): void {
  if (!input || typeof input !== 'object') return;
  if (typeof input.filename === 'string' && input.filename.trim()) {
    input.filename = input.filename.trim();
    return;
  }
  if (input.filename !== undefined) delete input.filename;
  const aliases = [
    input.path, input.file, input.fileName, input.file_name, input['file-name'],
    input.filePath, input.filepath, input.file_path, input.outputPath,
    input.output_path, input.targetPath, input.target_path, input.target, input.name,
  ];
  const candidate = aliases.find(value => typeof value === 'string' && value.trim());
  if (candidate) input.filename = candidate.trim();
}

function normalizeFileSpec(value: any): any {
  if (typeof value === 'string') return { filename: value };
  if (!value || typeof value !== 'object') return value;
  const spec = { ...value };
  normalizeFilenameArgs(spec);
  normalizeEditArgs(spec);
  return spec;
}

function normalizeEditChunk(value: any): any {
  return normalizeWorkspaceEditChunk(value);
}

function normalizeEditArgs(spec: any): void {
  if (!spec || typeof spec !== 'object') return;
  if (typeof spec.delete === 'string') {
    const normalizedDelete = spec.delete.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalizedDelete)) spec.delete = true;
    else if (['false', 'no', '0'].includes(normalizedDelete)) spec.delete = false;
  }
  if (spec.delete === undefined) {
    const operation = String(spec.operation || spec.action || '').trim().toLowerCase();
    if (['delete', 'deleted', 'remove', 'removed', 'unlink'].includes(operation) || spec.remove === true || spec.deleted === true) {
      spec.delete = true;
    }
  }
  const rawEdits = spec.edits ?? spec.changes ?? spec.patches;
  if (Array.isArray(rawEdits)) {
    if (rawEdits.length > 0) {
      spec.edits = rawEdits.map(normalizeEditChunk);
      return;
    }
    delete spec.edits;
  }
  if (typeof rawEdits === 'string') {
    const trimmed = rawEdits.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) {
          spec.edits = parsed.map(normalizeEditChunk);
          return;
        }
        if (
          parsed
          && typeof parsed === 'object'
          && Object.keys(parsed).some(key => [
            'search', 'old_string', 'oldString', 'oldText', 'old_content', 'oldContent', 'searchText', 'match', 'before', 'find',
            'replace', 'new_string', 'newString', 'newText', 'replacement', 'newContent', 'new_content', 'replacementText', 'after',
            'new_file_content', 'fileContent', 'content', 'code', 'body',
            'startLine', 'start_line', 'endLine', 'end_line', 'range',
          ].includes(key))
        ) {
          spec.edits = [normalizeEditChunk(parsed)];
          return;
        }
      } catch { /* plain generated content can legitimately begin with [ or { */ }
    }
    spec.edits = [{ replace: rawEdits }];
    return;
  }
  if (rawEdits && typeof rawEdits === 'object' && !Array.isArray(rawEdits)) {
    spec.edits = [normalizeEditChunk(rawEdits)];
    return;
  }

  const hasInlineEdit = [
    'search', 'old_string', 'oldString', 'oldText', 'old_content', 'oldContent', 'searchText', 'match', 'before', 'find',
    'replace', 'new_string', 'newString', 'newText', 'replacement', 'newContent', 'new_content', 'replacementText', 'after', 'new_file_content', 'fileContent', 'content', 'code', 'body',
    'startLine', 'start_line', 'lineStart', 'line_start', 'lineNumber', 'line',
    'endLine', 'end_line', 'lineEnd', 'line_end', 'range', 'lineRange', 'line_range',
  ].some(key => spec[key] !== undefined);
  if (hasInlineEdit) spec.edits = [normalizeEditChunk(spec)];
}

function normalizeFileSpecArray(value: any): any[] {
  if (Array.isArray(value)) return value.map(normalizeFileSpec);
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        return normalizeFileSpecArray(JSON.parse(trimmed));
      } catch { /* fall through to a comma-delimited path list */ }
    }
    return value
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(filename => ({ filename }));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, any>;
    if (Object.keys(record).length === 0) return [];
    const hasNamedTarget = ['filename', 'path', 'file', 'fileName', 'file_path', 'filePath'].some(key => record[key]);
    if (!hasNamedTarget) {
      const mappedTargets = Object.entries(record)
        .filter(([filename, content]) => Boolean(String(filename).trim()) && (
          typeof content === 'string' || Array.isArray(content) || Boolean(content && typeof content === 'object')
        ))
        .map(([filename, content]) => {
          if (typeof content === 'string') return { filename, edits: [{ replace: content }] };
          if (Array.isArray(content)) return { filename, edits: content.map(normalizeEditChunk) };
          const normalized = normalizeFileSpec(content);
          return {
            ...normalized,
            filename: String(normalized?.filename || '').trim() || filename,
          };
        });
      if (mappedTargets.length > 0) return mappedTargets;
    }
    return [normalizeFileSpec(value)];
  }
  return [];
}

function reconcileMixedWorkspaceEditModes(input: any): void {
  if (!Array.isArray(input?.files) || input.files.length === 0) return;
  const filename = String(input.filename || '').trim();
  const hasSingleMutation = (Array.isArray(input.edits) && input.edits.length > 0) || input.delete !== undefined;
  if (!filename && hasSingleMutation && input.files.length !== 1) return;
  if (input.files.length === 1) {
    const onlyTarget = { ...input.files[0] };
    if (!String(onlyTarget.filename || '').trim() && filename) onlyTarget.filename = filename;
    if (hasSingleMutation && (!filename || String(onlyTarget.filename || '').trim() === filename)) {
      if ((!Array.isArray(onlyTarget.edits) || onlyTarget.edits.length === 0) && Array.isArray(input.edits)) {
        onlyTarget.edits = input.edits;
      }
      if (onlyTarget.delete === undefined && input.delete !== undefined) onlyTarget.delete = input.delete;
    }
    input.files[0] = onlyTarget;
  }
  if (filename && hasSingleMutation) {
    const normalizePath = (value: unknown) => {
      const filename = String(value || '').trim().replace(/\\/g, '/');
      return process.platform === 'win32' ? filename.toLowerCase() : filename;
    };
    const matchingIndex = input.files.findIndex((target: any) =>
      normalizePath(target?.filename) === normalizePath(filename)
    );
    if (matchingIndex >= 0) {
      const target = { ...input.files[matchingIndex] };
      // A repeated equivalent envelope is safe to collapse. Conflicting
      // mutations are not: retain both so schema validation explains the
      // collision rather than silently dropping part of the requested edit.
      if ((Array.isArray(target.edits) && target.edits.length > 0 && Array.isArray(input.edits)
          && JSON.stringify(target.edits) !== JSON.stringify(input.edits))
        || (target.delete !== undefined && input.delete !== undefined && target.delete !== input.delete)
        || (target.delete === true && Array.isArray(input.edits))
        || (input.delete === true && Array.isArray(target.edits))) return;
      if ((!Array.isArray(target.edits) || target.edits.length === 0) && Array.isArray(input.edits)) {
        target.edits = input.edits;
      }
      if (target.delete === undefined && input.delete !== undefined) target.delete = input.delete;
      input.files[matchingIndex] = target;
    } else {
      // A distinct filename with a complete mutation is real work, not an
      // invalid mode collision. Preserve it as another atomic target.
      input.files.push({ filename, edits: input.edits, delete: input.delete });
    }
  }

  if (!filename && input.files.length === 1 && hasSingleMutation) {
    const target = input.files[0];
    if ((Array.isArray(input.edits) && JSON.stringify(target.edits) !== JSON.stringify(input.edits))
      || (input.delete !== undefined && target.delete !== input.delete)
      || (target.delete === true && Array.isArray(input.edits))
      || (input.delete === true && Array.isArray(target.edits))) return;
  }

  // Once reconciled, expose one canonical multi-file shape to Zod and the
  // executor. Alias fields remain harmless because object parsing strips them.
  delete input.filename;
  delete input.edits;
  delete input.delete;
}

export function normalizeRegistryToolArgs(toolName: string, args: any): any {
  const name = normalizeRegistryToolName(toolName);
  let parsedArgs = args;
  if (typeof args === 'string' && args.trim()) {
    try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
  }
  const input = parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs) ? { ...parsedArgs } : {};

  if (name === 'workspace_edit_file') {
    if (!input.files && input.file && typeof input.file === 'object' && !Array.isArray(input.file)) {
      input.files = [input.file];
    }
    if (!input.files && input.target && typeof input.target === 'object' && !Array.isArray(input.target)) {
      input.files = [input.target];
    }
    if (!input.files) input.files = input.targets ?? input.fileChanges ?? input.file_changes;
    if (Array.isArray(input.files) && input.files.length === 0) delete input.files;
    if (typeof input.files === 'string' && !input.files.trim()) delete input.files;
    normalizeFilenameArgs(input);
    normalizeEditArgs(input);
  }
  if (name === 'workspace_edit_file' && input.files) {
    input.files = normalizeFileSpecArray(input.files);
    if (input.files.length > 0) reconcileMixedWorkspaceEditModes(input);
    else delete input.files;
  }
  if (name === 'workspace_run_command') {
    if (input.cmd && !input.command) input.command = input.cmd;
    if (Array.isArray(input.commands)) {
      input.commands = input.commands.map((entry: any) => {
        if (typeof entry === 'string') return { command: entry };
        if (!entry || typeof entry !== 'object') return entry;
        return entry.cmd && !entry.command ? { ...entry, command: entry.cmd } : entry;
      });
    }
  }
  if (name === 'ask_user') {
    const normalizeOptions = (value: any) => Array.isArray(value) ? value.map(option => {
      if (typeof option === 'string') return { label: option, value: option };
      if (!option || typeof option !== 'object') return option;
      return { ...option, label: option.label ?? option.value, value: option.value ?? option.label };
    }) : value;
    if (input.options !== undefined) input.options = normalizeOptions(input.options);
    if (Array.isArray(input.questions)) {
      const seenIds = new Set<string>();
      input.questions = input.questions.map((question: any, index: number) => {
        if (!question || typeof question !== 'object') return question;
        const options = normalizeOptions(question.options);
        let id = String(question.id || `q_${index + 1}`);
        while (seenIds.has(id)) id += `_${index + 1}`;
        seenIds.add(id);
        return { ...question, id, ...(options !== undefined ? { options } : {}),
          mode: question.mode ?? (Array.isArray(options) && options.length > 1 ? 'choice' : 'text') };
      });
    }
    if (input.mode === undefined) input.mode = input.questions?.length ? 'questions'
      : input.options?.length > 1 ? 'choice' : 'text';
  }
  if (name === 'task_decomposer') {
    if (input.complexTask === undefined) input.complexTask = input.task ?? input.complex_task;
    if (input.maxSubtasks === undefined) input.maxSubtasks = input.max_subtasks ?? input.maxSteps;
  }
  if (name === 'task_checkpoint') {
    if (input.stepNumber === undefined) input.stepNumber = input.step_number;
    if (input.revisedSteps === undefined) input.revisedSteps = input.revised_steps;
    if (typeof input.evidence === 'string') input.evidence = [input.evidence];
  }
  return input;
}

function hasSafeParse(schema: unknown): schema is { safeParse: (value: unknown) => any } {
  return Boolean(schema && typeof (schema as any).safeParse === 'function');
}

function formatIssuePath(pathValue: unknown): string {
  if (!Array.isArray(pathValue) || pathValue.length === 0) return 'args';
  return pathValue.map(part => String(part)).join('.');
}

function formatValidationIssues(error: any): string {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) {
    return error?.message ? String(error.message) : 'Input did not match the tool schema.';
  }

  const shown = issues.slice(0, 8).map((issue: any) => {
    const path = formatIssuePath(issue?.path);
    const message = issue?.message ? String(issue.message) : 'Invalid value';
    return `${path}: ${message}`;
  });

  if (issues.length > shown.length) {
    shown.push(`...and ${issues.length - shown.length} more issue(s)`);
  }

  return shown.join('; ');
}

/** Decode only fields whose real schema requires structured data. File
 * content/search strings remain byte-for-byte strings even when they are JSON. */
function schemaAcceptsNull(schema: any): boolean {
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) return true;
  if (schema.nullable === true || schema.type === 'null' || schema.const === null) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  const alternatives = schema.anyOf || schema.oneOf;
  if (Array.isArray(alternatives)) return alternatives.some(schemaAcceptsNull);
  if (Array.isArray(schema.allOf)) return schema.allOf.every(schemaAcceptsNull);
  return !schema.type && !schema.properties && !schema.items;
}

function decodeStructuredArguments(value: any, schema: any): any {
  const alternatives = schema?.anyOf || schema?.oneOf;
  if (Array.isArray(alternatives)) {
    const nonNull = alternatives.filter((item: any) => item.type !== 'null');
    if (nonNull.length === 1) return decodeStructuredArguments(value, nonNull[0]);
  }
  const rawType = Array.isArray(schema?.type)
    ? schema.type.find((candidate: string) => candidate !== 'null') : schema?.type;
  const type = String(rawType || (schema?.properties ? 'object' : '')).toLowerCase();
  let decoded = value;
  if ((type === 'object' || type === 'array') && typeof value === 'string') {
    try {
      const candidate = JSON.parse(value);
      if (type === 'array' ? Array.isArray(candidate) : candidate && typeof candidate === 'object' && !Array.isArray(candidate)) decoded = candidate;
    } catch { /* The real schema reports malformed input; never guess. */ }
  }
  if (type === 'array' && Array.isArray(decoded)) {
    return decoded.map(item => decodeStructuredArguments(item, schema.items));
  }
  if (type === 'object' && decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.fromEntries(Object.entries(decoded).flatMap(([key, item]) => {
      const propertySchema = schema.properties?.[key];
      // Providers may fill omitted optional fields with null. Remove only
      // placeholders the original schema cannot accept; meaningful nullable
      // values, required fields, and arbitrary JSON payloads stay intact.
      if (item === null && propertySchema && !required.has(key) && !schemaAcceptsNull(propertySchema)) return [];
      return [[key, decodeStructuredArguments(item, propertySchema || schema.additionalProperties)]];
    }));
  }
  return decoded;
}

export function validateRegistryToolArgs(
  tool: Pick<ToolDefinition, 'name' | 'inputSchema'>,
  args: any,
): ToolArgValidationResult {
  if (!hasSafeParse(tool.inputSchema)) {
    return { success: true, args };
  }

  try {
    // The provider wire may require JSON strings for free-form objects. Decode
    // against the original schema before Zod, not with unrelated tool guesses.
    const schema = getToolInputJsonSchema(tool);
    const normalized = normalizeRegistryToolArgs(tool.name, decodeStructuredArguments(args, schema));
    const decoded = decodeStructuredArguments(normalized, schema);
    const result = tool.inputSchema.safeParse(decoded ?? {});
    if (result.success) {
      return { success: true, args: result.data };
    }

    return {
      success: false,
      error: `Invalid arguments for ${tool.name} after alias normalization: ${formatValidationIssues(result.error)}${normalizeRegistryToolName(tool.name) === 'spawn_sub_agent' ? `\n${SUB_AGENT_SPAWN_GUIDANCE}` : ''}`,
      missing: getRecoverableToolArgumentGaps(tool.name, decoded),
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Invalid arguments for ${tool.name}: ${err?.message || 'Tool schema validation failed.'}`,
    };
  }
}
