/**
 * Provider-neutral semantics for tool execution.
 *
 * Tool names are an adapter detail. The reasoning loop needs a stable answer to
 * more important questions: did this observe state, change state, verify the
 * latest state, or cause an external side effect? Keeping that policy here
 * prevents Gemini/OpenAI/Anthropic loops from developing different notions of
 * progress and completion.
 */

import { isLiteralReadCommand, isLiteralVerificationCommand, literalTerminalCommands } from './shell-command-shape';
import { isParallelSafeToolCall } from './parallel-tool-calls';

export type ToolEffect =
  | 'observation'
  | 'mutation'
  | 'verification'
  | 'external_action'
  | 'coordination'
  | 'command'
  | 'artifact';

export interface ToolSemantics {
  effect: ToolEffect;
  isMutation: boolean;
  isVerification: boolean;
  isExternalSideEffect: boolean;
  isRefreshSensitive: boolean;
  materialOnSuccess: boolean;
}

const SOURCE_PATH_EXTENSION = /\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|md|mdx|mjs|mts|php|prisma|py|rb|rs|scss|sh|sql|svelte|toml|ts|tsx|txt|vue|xml|yaml|yml)$/i;

const MUTATION_TOOLS = new Set([
  'workspace_edit_file',
  'agent_builder_attach_all_main_tools',
  'agent_builder_attach_connector_tools',
  'agent_builder_attach_main_tool',
  'agent_builder_define_tool',
  'agent_builder_delete_flow',
  'agent_builder_remove_tool',
  'agent_builder_save_flow',
  'agent_builder_save_profile',
]);

const VERIFICATION_TOOLS = new Set([
  'agent_builder_run_quality_check',
]);

const OBSERVATION_TOOLS = new Set([
  'context_memory',
  'web_search',
  'image_asset_search',
  'agent_builder_get_profile',
  'agent_builder_list_flows',
  'agent_flow_blackboard_get',
  'agent_flow_blackboard_list',
]);

const EXTERNAL_ACTION_TOOLS = new Set([
  'channel_agent',
  'connector_mcp',
  'desktop_notification',
  'gateway_bridge',
  'scheduled_tasks',
]);

const COORDINATION_TOOLS = new Set([
  'agent_communicate',
  'ask_user',
  'spawn_sub_agent',
  'task_checkpoint',
  'task_decomposer',
  'wait_timer',
]);

const ARTIFACT_TOOLS = new Set([
  'image_generator',
  'video_generator',
]);

const BROWSER_OBSERVATION_ACTIONS = new Set([
  'see',
  'inspect',
  'snapshot',
  'screenshot',
  'capture',
  'get',
  'read',
  'status',
]);

const BROWSER_MUTATION_ACTIONS = new Set([
  'click',
  'double_click',
  'drag',
  'drop',
  'fill',
  'input',
  'key',
  'press',
  'select',
  'submit',
  'type',
  'upload',
]);

function normalizeToolName(toolName: string): string {
  return String(toolName || '').trim().toLowerCase();
}

function normalizeAction(args: Record<string, any>): string {
  return String(args?.action || args?.mode || args?.operation || '').trim().toLowerCase();
}

function terminalCommandTexts(args: Record<string, any>): string[] {
  const commands = Array.isArray(args?.commands)
    ? args.commands.map((entry: any) => String(entry?.command || entry?.cmd || '')).filter(Boolean)
    : [];
  if (commands.length > 0) return commands;
  const command = String(args?.command || args?.script || args?.cmd || '');
  return command ? [command] : [];
}

function terminalCommandText(args: Record<string, any>): string {
  return terminalCommandTexts(args).join('\n');
}

export function commandLooksLikeVerification(args: Record<string, any>): boolean {
  const commands = literalTerminalCommands(args);
  return Boolean(commands?.some(isLiteralVerificationCommand)
    && commands.every(tokens => isLiteralVerificationCommand(tokens) || isLiteralReadCommand(tokens)));
}

export function commandLooksLikeMutation(args: Record<string, any>): boolean {
  const command = terminalCommandText(args);
  return /(?:^|[\s;&|])(apply_patch|apply|format|prettier\s+--write|sed\s+-i|perl\s+-pi|move-item|move|mv|copy-item|copy|cp|rename-item|rename|ren|remove-item|rm|rmdir|del|mkdir|install|uninstall|touch|new-item|set-content|add-content|out-file|tee)(?:$|[\s;&|])/i.test(command)
    || /(?:^|\s)(?:npm|pnpm|yarn|bun|pip|pip3|uv|cargo|gem|composer)\s+(?:add|install|remove|uninstall|update|upgrade)(?:$|\s)/i.test(command)
    || /(?:^|[^<>])>{1,2}(?![>&])/.test(command);
}

/**
 * Recognize terminal calls whose useful result is an observation of the
 * workspace. These are durable context evidence, not generic executions.
 * Mutation and verification classification runs before this predicate.
 */
export function commandLooksLikeObservation(args: Record<string, any>): boolean {
  const commands = literalTerminalCommands(args);
  return Boolean(commands?.length && commands.every(isLiteralReadCommand));
}

export type ToolResultOutcome = 'completed' | 'pending' | 'noop' | 'failed';

/** Transport acceptance, useful completion, and failure are separate facts. */
export function getToolResultOutcome(result: any, depth = 0): ToolResultOutcome {
  if (result === undefined || result === null || result === false) return 'failed';
  if (typeof result === 'string') {
    return /^\s*(?:error|failed|failure|denied|cancelled)\b/i.test(result) ? 'failed' : 'completed';
  }
  if (typeof result !== 'object') return 'completed';
  if (result.error || result.CRITICAL_ERROR || result.isError === true || result.cancelled || result.timedOut) return 'failed';
  if (result.passed === false || result.verified === false || result.ok === false) return 'failed';
  if (Array.isArray(result.errors) && result.errors.length > 0) return 'failed';
  const status = String(result.status || '').trim().toLowerCase();
  if (/^(?:failed|error|denied|cancelled|canceled|killed|timed_out)$/.test(status)) return 'failed';
  const exitCode = result.exitCode ?? result.exit_code ?? result.code;
  if (typeof exitCode === 'number' && exitCode !== 0) return 'failed';
  // Running terminal observations explicitly report success=false until exit.
  if (result.running === true || result.stillRunning === true || /^(?:pending|queued|running|in_progress|accepted)$/.test(status)) return 'pending';
  if (result.success === false) return 'failed';
  if (result.needsArguments || result.skipped === true || result.skippedDuplicate === true || result.operation === 'none') return 'noop';
  // Inspect only known result envelopes, never arbitrary source/page content.
  if (depth < 4) {
    const children = result.result ?? result.results;
    const entries = Array.isArray(children) ? children : children && typeof children === 'object' ? [children] : [];
    const outcomes = entries.map(entry => getToolResultOutcome(entry, depth + 1));
    if (outcomes.includes('failed')) return 'failed';
    if (outcomes.includes('pending')) return 'pending';
    if (outcomes.length > 0 && outcomes.every(outcome => outcome === 'noop')) return 'noop';
  }
  return 'completed';
}

export function toolResultSucceeded(result: any): boolean {
  return getToolResultOutcome(result) !== 'failed';
}

export function toolResultMadeProgress(result: any, semantics: ToolSemantics): boolean {
  if (getToolResultOutcome(result) !== 'completed') return false;
  if (semantics.isMutation) return toolResultChangedState(result, semantics);
  // New observations are useful evidence for research and diagnosis too.
  return semantics.materialOnSuccess || semantics.effect === 'observation';
}

/** A successful mutation-shaped call can still explicitly report a no-op. */
export function toolResultChangedState(result: any, semantics?: ToolSemantics): boolean {
  if (semantics && !semantics.isMutation) return false;
  if (result?.stateChanged === true || result?.rollbackIncomplete === true) return true;
  if (getToolResultOutcome(result) !== 'completed') return false;
  if (!result || typeof result !== 'object') return true;
  const changedPaths = [
    ...(Array.isArray(result.filesModified) ? result.filesModified : []),
    ...(Array.isArray(result.filesCreated) ? result.filesCreated : []),
    ...(Array.isArray(result.filesDeleted) ? result.filesDeleted : []),
  ];
  if (changedPaths.length > 0) return true;
  const operation = String(result.operation || '').trim().toLowerCase();
  const explicitChanges = Array.isArray(result.changes) ? result.changes : null;
  if (operation === 'none') return false;
  if (result.changed === false || (result.editsApplied === 0 && !changedPaths.length)) return false;
  if (
    explicitChanges
    && explicitChanges.length === 0
    && Object.prototype.hasOwnProperty.call(result, 'editsApplied')
    && Number(result.editsApplied) === 0
  ) return false;
  return true;
}

export function classifyToolSemantics(toolName: string, args: Record<string, any> = {}): ToolSemantics {
  const name = normalizeToolName(toolName);

  if (VERIFICATION_TOOLS.has(name) || /(?:^|_)(verify|verification|quality_check)(?:_|$)/.test(name)) {
    return {
      effect: 'verification',
      isMutation: false,
      isVerification: true,
      isExternalSideEffect: false,
      isRefreshSensitive: true,
      materialOnSuccess: true,
    };
  }

  if (name === 'workspace_run_command') {
    const mode = normalizeAction(args);
    if (mode === 'check' || mode === 'wait' || mode === 'list') {
      return {
        effect: 'observation',
        isMutation: false,
        isVerification: false,
        isExternalSideEffect: false,
        isRefreshSensitive: true,
        materialOnSuccess: false,
      };
    }
    if (commandLooksLikeVerification(args)) {
      return {
        effect: 'verification',
        isMutation: false,
        isVerification: true,
        isExternalSideEffect: false,
        isRefreshSensitive: true,
        materialOnSuccess: true,
      };
    }
    const mutates = commandLooksLikeMutation(args);
    const observes = !mutates && commandLooksLikeObservation(args);
    return {
      effect: mutates ? 'mutation' : observes ? 'observation' : 'command',
      isMutation: mutates,
      isVerification: false,
      isExternalSideEffect: false,
      isRefreshSensitive: observes,
      materialOnSuccess: !observes,
    };
  }

  if (name === 'browser_control' || name === 'screen_agent' || name === 'computer' || name === 'screenshot_capture') {
    const action = normalizeAction(args);
    const observes = name === 'screenshot_capture' || BROWSER_OBSERVATION_ACTIONS.has(action);
    const mutates = BROWSER_MUTATION_ACTIONS.has(action);
    return {
      effect: observes ? 'observation' : mutates ? 'external_action' : 'observation',
      isMutation: false,
      isVerification: false,
      isExternalSideEffect: mutates,
      isRefreshSensitive: true,
      materialOnSuccess: observes || mutates,
    };
  }

  if (MUTATION_TOOLS.has(name) || /(?:^|_)(write|edit|patch|replace|delete|remove|save|attach|define)(?:_|$)/.test(name)) {
    return {
      effect: 'mutation',
      isMutation: true,
      isVerification: false,
      isExternalSideEffect: false,
      isRefreshSensitive: false,
      materialOnSuccess: true,
    };
  }

  if (EXTERNAL_ACTION_TOOLS.has(name)) {
    const observes = isParallelSafeToolCall({ name, args })
      || (name === 'scheduled_tasks' && /^(?:list|get|status|view)$/.test(normalizeAction(args)));
    return {
      effect: observes ? 'observation' : 'external_action',
      isMutation: false,
      isVerification: false,
      isExternalSideEffect: !observes,
      isRefreshSensitive: observes,
      materialOnSuccess: true,
    };
  }

  if (OBSERVATION_TOOLS.has(name) || /(?:^|_)(read|search|find|list|inspect|outline|scrape|transcript)(?:_|$)/.test(name)) {
    return {
      effect: 'observation',
      isMutation: false,
      isVerification: false,
      isExternalSideEffect: false,
      isRefreshSensitive: true,
      materialOnSuccess: false,
    };
  }

  if (COORDINATION_TOOLS.has(name)) {
    return {
      effect: 'coordination',
      isMutation: false,
      isVerification: false,
      isExternalSideEffect: false,
      isRefreshSensitive: false,
      materialOnSuccess: false,
    };
  }

  if (ARTIFACT_TOOLS.has(name) || /(?:^|_)(generator|export|compression)(?:_|$)/.test(name)) {
    return {
      effect: 'artifact',
      isMutation: true,
      isVerification: false,
      isExternalSideEffect: false,
      isRefreshSensitive: false,
      materialOnSuccess: true,
    };
  }

  return {
    effect: 'artifact',
    isMutation: false,
    isVerification: false,
    isExternalSideEffect: false,
    isRefreshSensitive: false,
    materialOnSuccess: true,
  };
}

export function extractToolTargets(args: Record<string, any> = {}, result: any = {}): string[] {
  const raw = [
    args.filename,
    args.path,
    args.filePath,
    args.file_path,
    args.directory,
    args.target,
    args.url,
    args.channel,
    args.recipient,
    ...(Array.isArray(args.files) ? args.files.map((item: any) => item?.filename || item?.path || item?.filePath || item?.file_path) : []),
    result?.path,
    result?.filePath,
    result?.url,
    ...(Array.isArray(result?.filesModified) ? result.filesModified : []),
    ...(Array.isArray(result?.filesCreated) ? result.filesCreated : []),
    ...(Array.isArray(result?.filesDeleted) ? result.filesDeleted : []),
    ...(Array.isArray(result?.changes) ? result.changes.map((item: any) => item?.path || item?.filename) : []),
    ...(Array.isArray(result?.artifacts) ? result.artifacts.map((item: any) => item?.path || item?.url || item) : []),
  ];
  const commands = terminalCommandTexts(args);
  const commandTargets: string[] = [];
  const cwd = String(
    result?.cwd
    || (Array.isArray(result?.results)
      ? result.results.map((entry: any) => String(entry?.cwd || '').trim()).find(Boolean)
      : '')
    || args?.cwd
    || '',
  ).trim();
  const addCommandTarget = (candidate: unknown) => {
    let value = String(candidate || '').trim().replace(/^["']|["']$/g, '').replace(/[),;]+$/g, '');
    if (!value || value.startsWith('-') || /^https?:\/\//i.test(value)) return;
    const pathLike = /[\\/]/.test(value) || SOURCE_PATH_EXTENSION.test(value);
    if (!pathLike || /[*?{}]/.test(value)) return;
    if (cwd && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(value)) {
      value = `${cwd.replace(/[\\/]+$/, '')}/${value.replace(/^\.\/?/, '')}`;
    }
    commandTargets.push(value);
  };
  for (const command of commands) {
    for (const match of command.matchAll(/["']([^"'\r\n]+)["']/g)) addCommandTarget(match[1]);
    for (const match of command.matchAll(/(?:^|\s)(?:-LiteralPath|-Path|--path)\s+([^\s;&|]+)/gi)) addCommandTarget(match[1]);
    for (const match of command.matchAll(/(?:[A-Za-z]:[\\/][^\s"';&|]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+(?:\.[A-Za-z0-9]+)?|[A-Za-z0-9_.-]+\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|md|mdx|mjs|mts|php|prisma|py|rb|rs|scss|sh|sql|svelte|toml|ts|tsx|txt|vue|xml|yaml|yml))/gi)) {
      addCommandTarget(match[0]);
    }
  }
  const normalizeReportedTarget = (candidate: unknown): string => {
    const value = String(candidate || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value || !cwd || /^https?:\/\//i.test(value)) return value;
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(value)) return value;
    const pathLike = /[\\/]/.test(value) || SOURCE_PATH_EXTENSION.test(value);
    return pathLike
      ? `${cwd.replace(/[\\/]+$/, '')}/${value.replace(/^\.\/?/, '')}`
      : value;
  };
  return Array.from(new Set(
    [...raw, ...commandTargets]
      .filter(Boolean)
      .map(normalizeReportedTarget)
      .filter(Boolean),
  ));
}
