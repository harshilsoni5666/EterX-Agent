import ts from 'typescript';
import { recordedResult, sourceToolName } from './actions';
import { recordedPatchBuilder } from './recorded-patch-builder';

type Data = Record<string, any>;
type SourceCall = { name: string; args: Data };
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const unsafeKey = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key);

/** Parse literal arguments in orchestration scripts. No eval, VM, process,
 * filesystem access, interpolation execution, or source imports are allowed. */
function scriptCalls(code: string): SourceCall[] {
  if (!code || code.length > 512_000) return [];
  const file = ts.createSourceFile('imported-action.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const transform = recordedPatchBuilder(file);
  if (transform) return [{ name: 'imported_line_transform', args: { transform, source: code } }];
  const bindings = new Map<string, unknown>();
  const calls: SourceCall[] = [];
  let visited = 0;
  const literal = (node?: ts.Node, depth = 0): unknown => {
    if (!node || depth > 12) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) return bindings.get(node.text);
    if (ts.isParenthesizedExpression(node)) return literal(node.expression, depth + 1);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const value = literal(node.operand, depth + 1); return typeof value === 'number' ? -value : undefined;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, depth + 1), right = literal(node.right, depth + 1);
      if (typeof left === 'string' && (typeof right === 'string' || typeof right === 'number')) return left + right;
      if (typeof left === 'number' && typeof right === 'number') return left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = literal(span.expression, depth + 1);
        if (!['string', 'number', 'boolean'].includes(typeof part)) return undefined;
        value += String(part) + span.literal.text;
      }
      return value;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item, depth + 1));
    if (ts.isObjectLiteralExpression(node)) {
      const value: Data = Object.create(null);
      for (const field of node.properties) {
        if (ts.isSpreadAssignment(field)) {
          for (const [key, part] of Object.entries(object(literal(field.expression, depth + 1)))) if (!unsafeKey(key)) value[key] = part;
          continue;
        }
        if (!ts.isPropertyAssignment(field) && !ts.isShorthandPropertyAssignment(field)) continue;
        const key = ts.isIdentifier(field.name) || ts.isStringLiteral(field.name) ? field.name.text : '';
        if (!key || unsafeKey(key)) continue;
        const part = ts.isShorthandPropertyAssignment(field) ? bindings.get(key) : literal(field.initializer, depth + 1);
        if (part !== undefined) value[key] = part;
      }
      return value;
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (++visited > 30_000 || calls.length >= 100) return;
    // A function definition or conditional branch is not proof of execution.
    if (ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)
      || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
      || ts.isWhileStatement(node) || ts.isSwitchStatement(node) || ts.isDoStatement(node)) {
      // Skipped dynamic control flow may mutate an earlier literal. Keeping
      // that initializer fabricated partial patches such as "Begin Patch".
      const invalidate = (child: ts.Node) => {
        if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(child.left)) bindings.delete(child.left.text);
        if ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) && ts.isIdentifier(child.operand)) bindings.delete(child.operand.text);
        ts.forEachChild(child, invalidate);
      };
      invalidate(node);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) bindings.delete(node.left.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const value = literal(node.initializer); if (value !== undefined) bindings.set(node.name.text, value);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && ['tools', 'functions'].includes(node.expression.expression.text)) {
      const value = literal(node.arguments[0]);
      if (value !== undefined) calls.push({ name: node.expression.name.text, args: typeof value === 'string' ? { input: value } : object(value) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function splitResults(value: unknown, count: number): unknown[] | null {
  let parsed = value;
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(parsed)) {
      if (parsed.length === 1 && ['text', 'input_text', 'output_text'].includes(parsed[0]?.type)) { parsed = parsed[0].text; continue; }
      if (parsed.length === count && parsed.every(item => item && typeof item === 'object' && !['text', 'input_text', 'input_image'].includes(item.type))) {
        return parsed.map(item => item.status === 'fulfilled' ? item.value : item);
      }
      return null;
    }
    if (typeof parsed !== 'string') { const data = object(parsed); parsed = data.content ?? data.output; continue; }
    try { parsed = JSON.parse(parsed); } catch {
      const unwrapped = recordedResult(parsed).output;
      if (!unwrapped || unwrapped === parsed) return null;
      parsed = unwrapped;
    }
  }
  return null;
}

export function expandImportedActions(logs: any[]): any[] {
  const expanded: any[] = [];
  for (const log of logs) {
    if (!log?.importedFrom || log.importActionExpanded || !['tool_call', 'command'].includes(log.type)) { expanded.push(log); continue; }
    const name = sourceToolName(log.sourceToolName || log.toolName || log.tool);
    const args = object(log.toolArgs || log.args);
    let calls: SourceCall[] = [];
    if (name === 'exec') calls = scriptCalls(String(args.code || args.input || ''));
    else if (name === 'parallel' && Array.isArray(args.tool_uses)) calls = args.tool_uses.map((call: Data) => ({ name: String(call.recipient_name || call.name || ''), args: object(call.parameters || call.arguments) })).filter((call: SourceCall) => call.name);
    if (!calls.length) { expanded.push(log); continue; }
    const rawResult = log.toolResult ?? log.output;
    const results = calls.length === 1 ? [rawResult] : splitResults(rawResult, calls.length);
    const hasCombinedResult = !results && Boolean(rawResult);
    calls.forEach((call, index) => expanded.push({ ...log, id: index ? `${log.id}-action-${index}` : log.id,
      toolCallId: index ? `${log.toolCallId || log.id}:action:${index}` : log.toolCallId,
      sourceToolName: call.name, toolName: call.name, tool: call.name, toolArgs: call.args,
      importActionExpanded: true, importWrapper: log.toolName,
      importWrapperArgs: args,
      importPresentationVersion: undefined,
      // Child commands do not inherit the orchestration script as their input.
      text: '', secondary: '', command: undefined, iconCategory: undefined,
      output: results ? results[index] : '', toolResult: results ? results[index] : '',
      attachments: calls.length === 1 ? log.attachments : [],
    }));
    if (hasCombinedResult) expanded.push({ ...log, id: `${log.id}-combined-result`, toolName: 'imported_action_results', tool: 'imported_action_results', sourceToolName: 'imported_action_results',
      toolCallId: `${log.toolCallId || log.id}:results`,
      importActionExpanded: true, importPresentationVersion: undefined, toolArgs: { title: 'Tool sequence results' }, text: 'Tool sequence results', toolResult: rawResult });
  }
  // Relate recorded output polls to the original command without creating a
  // managed terminal or reconnecting to a source application's process.
  const sessions = new Map<string, { command: string; cwd: string }>();
  for (const log of expanded) {
    if (!log?.importedFrom || !['command', 'tool_call'].includes(log.type)) continue;
    const args = object(log.toolArgs);
    const result = recordedResult(log.toolResult ?? log.output);
    const session = result.session_id ?? args.session_id ?? result.shellId ?? args.shell_id;
    const command = typeof (args.cmd || args.command) === 'string' ? args.cmd || args.command : '';
    const cwd = String(args.cwd || args.workdir || log.workspacePath || '');
    if (session !== undefined && command) sessions.set(String(session), { command, cwd });
    else if (session !== undefined && sessions.has(String(session))) {
      const previous = sessions.get(String(session))!;
      log.toolArgs = { ...args, command: previous.command, cwd: previous.cwd };
    }
  }
  return expanded;
}
