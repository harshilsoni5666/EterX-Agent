/**
 * Provider-neutral semantics for tool execution.
 *
 * Tool names are an adapter detail. The reasoning loop needs a stable answer to
 * more important questions: did this observe state, change state, verify the
 * latest state, or cause an external side effect? Keeping that policy here
 * prevents Gemini/OpenAI/Anthropic loops from developing different notions of
 * progress and completion.
 */

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

const MUTATION_TOOLS = new Set([
  'workspace_write_file',
  'workspace_str_replace',
  'workspace_apply_patch',
  'workspace_edit_file',
  'workspace_edit_many_files',
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
  'workspace_verify_code',
  'realtime_verify',
  'agent_builder_run_quality_check',
]);

const OBSERVATION_TOOLS = new Set([
  'workspace_read_file',
  'workspace_read_many_files',
  'workspace_search_text',
  'workspace_semantic_search',
  'workspace_file_outline',
  'workspace_list_directory',
  'workspace_find_files',
  'web_search',
  'web_scraper',
  'deep_research',
  'image_asset_search',
  'youtube_transcript',
  'parse_docx',
  'parse_pdf',
  'rss_feed_reader',
  'system_monitor',
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
  'slack_controller',
  'text_to_speech',
]);

const COORDINATION_TOOLS = new Set([
  'agent_communicate',
  'ask_user',
  'background_task',
  'context_manager',
  'spawn_sub_agent',
  'task_checkpoint',
  'task_decomposer',
  'wait_timer',
]);

const ARTIFACT_TOOLS = new Set([
  'code_generator',
  'csv_data_analyzer',
  'docx_generator',
  'file_compression',
  'image_generator',
  'json_yaml_transform',
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

export function commandLooksLikeVerification(args: Record<string, any>): boolean {
  const command = String(args?.command || args?.script || args?.cmd || '');
  return /(?:^|[\s;&|])(test|lint|build|typecheck|type-check|tsc|pytest|vitest|jest|playwright|verify|check|benchmark|bench|eval|evaluate|audit|cargo\s+check|go\s+test|dotnet\s+test)(?:$|[\s:&|])/i.test(command);
}

export function commandLooksLikeMutation(args: Record<string, any>): boolean {
  const command = String(args?.command || args?.script || args?.cmd || '');
  return /(?:^|[\s;&|])(apply|format|prettier\s+--write|sed\s+-i|move|mv|copy|cp|mkdir|install|uninstall|touch|new-item|set-content|add-content)(?:$|[\s;&|])/i.test(command);
}

export function toolResultSucceeded(result: any): boolean {
  if (result === undefined || result === null) return false;
  if (typeof result === 'string') {
    return !/^\s*(?:error|failed|failure|denied|cancelled)\b/i.test(result);
  }
  if (result.error || result.CRITICAL_ERROR || result.cancelled || result.timedOut) return false;
  if (result.success === false || result.passed === false || result.verified === false || result.ok === false) return false;
  if (Array.isArray(result.errors) && result.errors.length > 0) return false;
  const exitCode = result.exitCode ?? result.exit_code ?? result.code;
  return typeof exitCode !== 'number' || exitCode === 0;
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

  if (name === 'workspace_run_command' || name === 'system_shell' || name === 'workspace_execute_script') {
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
    return {
      effect: mutates ? 'mutation' : 'command',
      isMutation: mutates,
      isVerification: false,
      isExternalSideEffect: false,
      isRefreshSensitive: false,
      materialOnSuccess: true,
    };
  }

  if (name === 'browser_control' || name === 'screen_agent' || name === 'computer' || name === 'desktop_control' || name === 'screenshot_capture') {
    const action = normalizeAction(args);
    const verifies = name === 'screenshot_capture' || BROWSER_OBSERVATION_ACTIONS.has(action);
    const mutates = BROWSER_MUTATION_ACTIONS.has(action);
    return {
      effect: verifies ? 'verification' : mutates ? 'external_action' : 'observation',
      isMutation: false,
      isVerification: verifies,
      isExternalSideEffect: mutates,
      isRefreshSensitive: true,
      materialOnSuccess: verifies || mutates,
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
    return {
      effect: 'external_action',
      isMutation: false,
      isVerification: false,
      isExternalSideEffect: true,
      isRefreshSensitive: false,
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
    result?.path,
    result?.filePath,
    result?.url,
    ...(Array.isArray(result?.filesModified) ? result.filesModified : []),
    ...(Array.isArray(result?.filesCreated) ? result.filesCreated : []),
    ...(Array.isArray(result?.filesDeleted) ? result.filesDeleted : []),
    ...(Array.isArray(result?.artifacts) ? result.artifacts.map((item: any) => item?.path || item?.url || item) : []),
  ];
  return Array.from(new Set(raw.filter(Boolean).map(item => String(item))));
}
