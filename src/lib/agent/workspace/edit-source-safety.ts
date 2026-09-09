import type * as TypeScript from 'typescript';

type Duplicate = { count: number; label: string; line: number };

/**
 * Catch newly shadowed declarations caused by replacing only a class/file
 * prefix with code that also reintroduces its unselected helpers. This is a
 * staged-text guard, not a compiler, test runner, or project-wide validator.
 */
export async function assertNoNewDuplicateDeclarations(filename: string, before: string, after: string): Promise<void> {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filename) || before === after) return;
  const ts = await import('typescript');
  const scriptKind = /\.tsx$/i.test(filename) ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(filename) ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(filename) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

  function collect(text: string): Map<string, Duplicate> {
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, scriptKind);
    const duplicates = new Map<string, Duplicate>();
    const scopeCounts = new Map<string, number>();
    const scopeFor = (parent: string, name: string) => {
      const key = `${parent}/${encodeURIComponent(name)}`;
      const ordinal = scopeCounts.get(key) || 0;
      scopeCounts.set(key, ordinal + 1);
      return `${key}#${ordinal}`;
    };
    const nameOf = (name: TypeScript.Node | undefined): string | undefined => {
      if (!name) return undefined;
      if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
      if (ts.isComputedPropertyName(name) && (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression))) return name.expression.text;
      return undefined; // Computed names can have side effects: never evaluate them.
    };
    const report = (scope: string, name: string, count: number, node: TypeScript.Node) => {
      if (count > 0) duplicates.set(JSON.stringify([scope, name]), {
        count,
        label: name,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    };
    const visit = (node: TypeScript.Node, parentScope: string): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const className = nameOf(node.name) || '<anonymous class>';
        const scope = scopeFor(parentScope, `class:${className}`);
        const members = new Map<string, { definitions: number; getters: number; setters: number; node: TypeScript.Node }>();
        for (const member of node.members) {
          const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) || [] : [];
          if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword || modifier.kind === ts.SyntaxKind.AbstractKeyword)) continue;
          if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)
              || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && !member.body) continue;
          if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)
            && !ts.isPropertyDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue;
          const name = ts.isConstructorDeclaration(member) ? 'constructor' : nameOf(member.name);
          if (name === undefined) continue;
          const key = `${modifiers.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 'static ' : ''}${name}`;
          const item = members.get(key) || { definitions: 0, getters: 0, setters: 0, node: member };
          if (ts.isGetAccessorDeclaration(member)) item.getters++;
          else if (ts.isSetAccessorDeclaration(member)) item.setters++;
          else item.definitions++;
          item.node = member;
          members.set(key, item);
        }
        for (const [name, item] of members) {
          // One getter/setter pair is valid. Overload signatures were skipped;
          // static/instance members and separate classes have separate scopes.
          const count = Math.max(0, item.definitions - 1) + Math.max(0, item.getters - 1) + Math.max(0, item.setters - 1)
            + (item.definitions > 0 && (item.getters > 0 || item.setters > 0) ? 1 : 0);
          report(scope, `${className}.${name}`, count, item.node);
        }
        ts.forEachChild(node, child => visit(child, scope));
        return;
      }
      if (ts.isFunctionLike(node)) {
        const body = (node as TypeScript.FunctionLikeDeclaration).body;
        if (body) {
          const ownerName = nameOf(node.name) || (ts.isVariableDeclaration(node.parent) ? nameOf(node.parent.name) : undefined) || '<anonymous>';
          visit(body, scopeFor(parentScope, `function:${ownerName}`));
        }
        return;
      }
      if (ts.isModuleDeclaration(node)) {
        if (node.body) visit(node.body, scopeFor(parentScope, `module:${nameOf(node.name) || '<anonymous>'}`));
        return;
      }
      if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
        const scope = ts.isSourceFile(node) ? parentScope : scopeFor(parentScope, 'block');
        const declared = new Map<string, { count: number; node: TypeScript.Node }>();
        for (const statement of node.statements) {
          if (!ts.isClassDeclaration(statement) && !(ts.isFunctionDeclaration(statement) && statement.body)) continue;
          if (ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
          const name = nameOf(statement.name);
          if (name === undefined) continue;
          const item = declared.get(name) || { count: 0, node: statement };
          item.count++;
          item.node = statement;
          declared.set(name, item);
        }
        for (const [name, item] of declared) report(scope, name, item.count - 1, item.node);
        ts.forEachChild(node, child => visit(child, scope));
        return;
      }
      ts.forEachChild(node, child => visit(child, parentScope));
    };
    visit(source, 'file');
    return duplicates;
  }

  const previous = collect(before);
  const introduced = [...collect(after)].filter(([key, value]) => value.count > (previous.get(key)?.count || 0));
  if (introduced.length === 0) return;
  const details = introduced.slice(0, 4).map(([, issue]) => `${issue.label} at line ${issue.line}`).join(', ');
  throw new Error(`Edit would introduce duplicate declarations in ${filename}: ${details}. Nothing has been written. The replacement may include helpers/methods outside its selected block. Replace those existing declarations explicitly, or select the entire class/file only when a complete rewrite is intended.`);
}
