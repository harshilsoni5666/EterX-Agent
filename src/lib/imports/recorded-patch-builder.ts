import ts from 'typescript';

export type RecordedLineTransform = { paths: string[]; includes: string; before: string; after: string };
const identifier = (node: ts.Node | undefined) => node && ts.isIdentifier(node) ? node.text : '';
const text = (node: ts.Node | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const declaration = (node: ts.Node | undefined) => node && ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0] : undefined;
const call = (node: ts.Node | undefined, method: string) => node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method ? node : undefined;
const receiver = (node: ts.CallExpression) => (node.expression as ts.PropertyAccessExpression).expression;
const parts = (node: ts.Expression): ts.Expression[] => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken ? [...parts(node.left), ...parts(node.right)] : [node];
const append = (node: ts.Node | undefined, variable: string) => node && ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
  && node.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && identifier(node.expression.left) === variable ? node.expression.right : undefined;

/** Recognize a closed data-transform idiom, not arbitrary JavaScript. The
 * script reads a literal file list, filters lines, replaces a literal string,
 * and appends those pairs to apply_patch. Actual source versions are supplied
 * later by recorded history. No source code or shell command is executed. */
export function recordedPatchBuilder(file: ts.SourceFile): RecordedLineTransform | null {
  if (file.statements.length !== 6) return null;
  const [filesStatement, readsStatement, patchStatement, outer, ending, execution] = file.statements;
  const files = declaration(filesStatement), reads = declaration(readsStatement), patch = declaration(patchStatement);
  if (!files?.initializer || !ts.isArrayLiteralExpression(files.initializer) || !reads?.initializer || !patch?.initializer) return null;
  const filesName = identifier(files.name), readsName = identifier(reads.name), patchName = identifier(patch.name);
  const paths = files.initializer.elements.map(text);
  if (!filesName || !readsName || !patchName || !paths.length || paths.length > 100 || paths.some(value => !value || /[\r\n\0]/.test(value))) return null;
  if (text(patch.initializer) !== '*** Begin Patch\n' || text(append(ending, patchName)) !== '*** End Patch') return null;
  const all = call(ts.isAwaitExpression(reads.initializer) ? reads.initializer.expression : undefined, 'allSettled');
  const map = all && identifier(receiver(all)) === 'Promise' && all.arguments.length === 1 ? call(all.arguments[0], 'map') : undefined;
  const mapper = map?.arguments[0];
  if (!map || identifier(receiver(map)) !== filesName || map.arguments.length !== 1 || !mapper || !ts.isArrowFunction(mapper) || mapper.parameters.length !== 1) return null;
  const read = call(mapper.body, 'exec_command');
  if (!read || !['tools', 'functions'].includes(identifier(receiver(read))) || read.arguments.length !== 1 || !ts.isObjectLiteralExpression(read.arguments[0])) return null;
  const command = read.arguments[0].properties.find(property => ts.isPropertyAssignment(property) && identifier(property.name) === 'cmd');
  if (!command || !ts.isPropertyAssignment(command) || !ts.isTemplateExpression(command.initializer) || command.initializer.templateSpans.length !== 1) return null;
  const span = command.initializer.templateSpans[0];
  if (identifier(span.expression) !== identifier(mapper.parameters[0].name)) return null;
  const readCommand = command.initializer.head.text + '__source_file__' + span.literal.text;
  if (!/^Get-Content\s+(?:(?:-Raw|-LiteralPath|-Path)\s+)*(?:'__source_file__'|"__source_file__"|__source_file__)(?:\s+-Raw)?\s*$/i.test(readCommand) || !/-Raw\b/i.test(readCommand)) return null;
  if (!ts.isForStatement(outer) || !outer.initializer || !ts.isVariableDeclarationList(outer.initializer) || outer.initializer.declarations.length !== 1 || !ts.isBlock(outer.statement)) return null;
  const index = outer.initializer.declarations[0], indexName = identifier(index.name);
  const compact = (node: ts.Node | undefined) => node?.getText(file).replace(/\s+/g, '') || '';
  if (!indexName || compact(index.initializer) !== '0' || compact(outer.condition) !== `${indexName}<${readsName}.length`
    || ![`${indexName}++`, `++${indexName}`].includes(compact(outer.incrementor))) return null;
  const body = outer.statement.statements;
  if (body.length !== 6) return null;
  const result = declaration(body[0]), selected = declaration(body[2]);
  const resultName = identifier(result?.name), selectedName = identifier(selected?.name);
  if (!resultName || !selectedName || compact(result?.initializer) !== `${readsName}[${indexName}]`) return null;
  if (!ts.isIfStatement(body[1]) || body[1].elseStatement || !ts.isThrowStatement(body[1].thenStatement)
    || compact(body[1].expression).replace(/"/g, "'") !== `${resultName}.status!=='fulfilled'||${resultName}.value.exit_code!==0`) return null;
  const filter = call(selected?.initializer, 'filter');
  const split = filter && call(receiver(filter), 'split');
  const predicate = filter?.arguments[0];
  if (!filter || !split || compact(receiver(split)) !== `${resultName}.value.output` || split.arguments.length !== 1
    || !['/\\r?\\n/', '/\\n/'].includes(compact(split.arguments[0])) || filter.arguments.length !== 1
    || !predicate || !ts.isArrowFunction(predicate) || predicate.parameters.length !== 1) return null;
  const includes = call(predicate.body, 'includes');
  const match = includes && text(includes.arguments[0]);
  if (!includes || identifier(receiver(includes)) !== identifier(predicate.parameters[0].name) || includes.arguments.length !== 1 || !match || /[\r\n]/.test(match)) return null;
  if (!ts.isIfStatement(body[3]) || body[3].elseStatement || compact(body[3].expression) !== `!${selectedName}.length` || !ts.isContinueStatement(body[3].thenStatement)) return null;
  const header = append(body[4], patchName), loop = body[5];
  if (!header || !ts.isForOfStatement(loop) || loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer) || loop.initializer.declarations.length !== 1 || identifier(loop.expression) !== selectedName) return null;
  const headerParts = parts(header), prefix = text(headerParts[0]);
  if (headerParts.length !== 3 || !prefix?.startsWith('*** Update File: ') || /[\r\n\0]/.test(prefix)
    || compact(headerParts[1]) !== `${filesName}[${indexName}]` || text(headerParts[2]) !== '\n') return null;
  const lineName = identifier(loop.initializer.declarations[0].name);
  const hunk = append(loop.statement, patchName);
  if (!lineName || !hunk) return null;
  const hunkParts = parts(hunk), replace = call(hunkParts[3], 'replaceAll');
  const before = replace && text(replace.arguments[0]), after = replace && text(replace.arguments[1]);
  if (hunkParts.length !== 5 || text(hunkParts[0]) !== '@@\n-' || identifier(hunkParts[1]) !== lineName || text(hunkParts[2]) !== '\n+' || text(hunkParts[4]) !== '\n'
    || !replace || identifier(receiver(replace)) !== lineName || replace.arguments.length !== 2 || !before || after === undefined
    || /[\r\n]/.test(before + after) || /\$[$&`'\d<]/.test(after)) return null;
  if (!ts.isExpressionStatement(execution) || !ts.isCallExpression(execution.expression) || identifier(execution.expression.expression) !== 'text' || execution.expression.arguments.length !== 1) return null;
  const awaited = execution.expression.arguments[0];
  const apply = ts.isAwaitExpression(awaited) && call(awaited.expression, 'apply_patch');
  if (!apply || !['tools', 'functions'].includes(identifier(receiver(apply))) || apply.arguments.length !== 1 || identifier(apply.arguments[0]) !== patchName) return null;
  return { paths: paths.map(value => prefix.slice('*** Update File: '.length) + value!), includes: match, before, after };
}
