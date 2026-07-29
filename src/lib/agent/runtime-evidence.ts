export type RuntimeEvidenceKind =
  | 'artifact'
  | 'browser'
  | 'command'
  | 'edit'
  | 'failure'
  | 'read'
  | 'research'
  | 'safety'
  | 'verification';

export interface RuntimeEvidenceNode {
  id: string;
  timestamp: number;
  toolName: string;
  kind: RuntimeEvidenceKind;
  success: boolean;
  summary: string;
  targets: string[];
}

const VERIFICATION_TOOLS = new Set([
  'workspace_verify_code',
  'realtime_verify',
  'browser_control',
]);

const EDIT_TOOLS = new Set([
  'workspace_write_file',
  'workspace_str_replace',
  'workspace_apply_patch',
  'workspace_edit_file',
  'workspace_edit_many_files',
]);

function truncate(value: unknown, max = 180): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${ text.slice(0, max - 3) }...` : text;
}

function compactTargets(args: Record<string, any>, result: any): string[] {
  const raw = [
    args?.filename,
    args?.path,
    args?.filePath,
    args?.file_path,
    result?.path,
    result?.filePath,
    ...(Array.isArray(result?.filesModified) ? result.filesModified : []),
    ...(Array.isArray(result?.filesCreated) ? result.filesCreated : []),
    ...(Array.isArray(result?.filesDeleted) ? result.filesDeleted : []),
  ];
  return Array.from(new Set(raw.filter(Boolean).map(item => String(item))));
}

function resultSucceeded(result: any): boolean {
  if (!result) return false;
  if (result.error || result.CRITICAL_ERROR) return false;
  if (result.success === false || result.passed === false || result.verified === false) return false;
  if (Array.isArray(result.errors) && result.errors.length > 0) return false;
  const exitCode = result.exitCode ?? result.code;
  if (typeof exitCode === 'number' && exitCode !== 0) return false;
  return true;
}

function commandLooksLikeVerification(command: string): boolean {
  return /\b(test|lint|build|typecheck|tsc|pytest|vitest|jest|playwright|verify|check)\b/i.test(command);
}

function classifyTool(toolName: string, args: Record<string, any>, result: any): RuntimeEvidenceKind {
  if (!resultSucceeded(result)) return 'failure';
  if (VERIFICATION_TOOLS.has(toolName)) return 'verification';
  if ((toolName === 'workspace_run_command' || toolName === 'system_shell') && commandLooksLikeVerification(String(args?.command || ''))) {
    return 'verification';
  }
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (toolName === 'web_search' || toolName === 'web_scraper' || toolName === 'deep_research') return 'research';
  if (toolName === 'safety_guard') return 'safety';
  if (toolName === 'browser_control' || toolName === 'screenshot_capture') return 'browser';
  if (toolName.includes('read') || toolName.includes('search') || toolName.includes('symbol')) return 'read';
  if (toolName.includes('command') || toolName.includes('shell') || toolName.includes('process')) return 'command';
  return 'artifact';
}

function summarizeToolResult(toolName: string, args: Record<string, any>, result: any, kind: RuntimeEvidenceKind): string {
  if (result?.error) return `${ toolName } failed: ${ truncate(result.error) }`;
  if (Array.isArray(result?.errors) && result.errors.length > 0) return `${ toolName } failed: ${ truncate(result.errors.join('; ')) }`;
  if (result?.summary) return truncate(result.summary);
  if (kind === 'verification') {
    const command = args?.command ? ` ${ truncate(args.command, 80) }` : '';
    return `${ toolName }${ command } produced verification evidence`;
  }
  if (kind === 'edit') {
    const target = compactTargets(args, result)[0];
    return `${ toolName } changed ${ target ? truncate(target, 100) : 'workspace files' }`;
  }
  const target = compactTargets(args, result)[0] || args?.query || args?.topic || args?.command || '';
  return target ? `${ toolName }: ${ truncate(target) }` : `${ toolName } completed`;
}

export class RuntimeEvidenceLedger {
  private readonly nodes: RuntimeEvidenceNode[] = [];
  private sequence = 0;

  constructor(private readonly scopeId: string = 'default') { }

  recordTool(toolName: string, args: Record<string, any> = {}, result: any = {}): RuntimeEvidenceNode {
    const kind = classifyTool(toolName, args, result);
    const node: RuntimeEvidenceNode = {
      id: `${ this.scopeId }-${ Date.now() }-${ ++this.sequence }`,
      timestamp: Date.now(),
      toolName,
      kind,
      success: resultSucceeded(result),
      summary: summarizeToolResult(toolName, args, result, kind),
      targets: compactTargets(args, result),
    };
    this.nodes.push(node);
    return node;
  }

  list(): RuntimeEvidenceNode[] {
    return [...this.nodes];
  }

  hasVerificationEvidence(): boolean {
    return this.nodes.some(node => node.kind === 'verification');
  }

  hasWorkEvidence(): boolean {
    return this.nodes.some(node => node.kind === 'edit' || node.kind === 'artifact' || node.kind === 'command' || node.kind === 'browser');
  }

  summarize(maxItems = 6): string[] {
    return this.nodes
      .filter(node => node.success)
      .slice(-maxItems)
      .map(node => `${ node.kind }: ${ node.summary }`);
  }

}
