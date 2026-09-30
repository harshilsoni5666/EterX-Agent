/** Conservative lexical inspection only; never evaluates shell text. */
export function literalShellCommands(command: string): string[][] | null {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let started = false;
  let quote = '';
  const flushToken = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  const flushCommand = () => {
    flushToken();
    if (tokens.length) commands.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && command[index + 1] === "'") {
          token += "'";
          index++;
        } else quote = '';
      } else {
        // Interpolated strings and shell escapes need a real shell parser.
        if (quote === '"' && (/[$`]/.test(char) ||
          (char === '\\' && /["\\$`\r\n]/.test(command[index + 1] || '')))) return null;
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      flushCommand();
    } else if (char === '&') {
      if (command[index + 1] !== '&') return null;
      index++;
      flushCommand();
    } else if (/[$`(){}<>]/.test(char) || (char === '#' && !started)) {
      return null;
    } else if (/\s/.test(char)) {
      flushToken();
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) return null;
  flushCommand();
  return commands.length ? commands : null;
}

export function shellExecutableName(token: string): string {
  return token.split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
}

/** Inspect native argv directly; never reinterpret it as shell syntax. */
export function literalTerminalCommands(args: Record<string, any>): string[][] | null {
  const entries = Array.isArray(args.commands) ? args.commands : [args];
  const commands: string[][] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.program === 'string' && entry.program.trim()) {
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg: unknown) => typeof arg !== 'string'))) return null;
      commands.push([entry.program, ...(entry.args || [])]);
    } else {
      const parsed = literalShellCommands(String(entry.command || entry.cmd || entry.script || ''));
      if (!parsed) return null;
      commands.push(...parsed);
    }
  }
  return commands.length ? commands : null;
}

const READ_COMMANDS = new Set([
  'cat', 'bat', 'nl', 'more', 'gc', 'type', 'get-content', 'get-childitem', 'gci', 'dir', 'ls', 'pwd', 'get-location',
  'where', 'which', 'head', 'tail', 'rg', 'ripgrep', 'grep', 'findstr', 'select-string', 'sls',
  'test-path', 'resolve-path', 'stat', 'wc', 'measure-object', 'select-object', 'select',
]);

export function isLiteralReadCommand(tokens: string[]): boolean {
  if (!tokens.length) return false;
  const name = shellExecutableName(tokens[0]);
  const args = tokens.slice(1);
  if (name === 'rg' || name === 'ripgrep') {
    return !args.some(arg => /^(?:--pre(?:=|$)|--hostname-bin(?:=|$))/.test(arg));
  }
  if (READ_COMMANDS.has(name)) return true;
  if (name === 'sed') return args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1] || '') &&
    args.slice(2).every(arg => !arg.startsWith('-'));
  if (name === 'git') return /^(?:status|diff|log|show|rev-parse)$/.test(args[0] || '')
    && !args.some(arg => /^(?:--output|--ext-diff|--textconv)(?:=|$)/.test(arg));
  if (/^(?:node|npm|pnpm|yarn|python3?|py)$/.test(name)) {
    return args.length === 1 && /^(?:--version|-v|-V)$/.test(args[0]);
  }
  return false;
}

export function isReadOnlyShellCommand(command: string): boolean {
  const commands = literalShellCommands(command);
  return Boolean(commands?.length && commands.every(isLiteralReadCommand));
}

/** File/content reads (any file type) are not summarized like execution logs. */
export function isSourceReadShellCommand(command: string): boolean {
  const commands = literalShellCommands(command);
  return Boolean(commands?.length && commands.every(isLiteralReadCommand) && commands.some(tokens => {
    const name = shellExecutableName(tokens[0]);
    if (/^(?:cat|bat|nl|more|gc|type|get-content|head|tail|sed)$/.test(name)) return true;
    // Search context is source too. File inventories/counts keep the smaller
    // generic allowance; a keyword hit alone does not justify a project dump.
    return /^(?:rg|ripgrep|grep|findstr|select-string|sls)$/.test(name) &&
      !tokens.slice(1).some(arg => /^(?:--files|--files-with-matches|--files-without-match|--count(?:-matches)?|--type-list|--stats|-[clL]|-List|-Quiet)(?:=|$)/i.test(arg));
  }));
}

export function isLiteralVerificationCommand(tokens: string[]): boolean {
  if (!tokens.length) return false;
  const name = shellExecutableName(tokens[0]);
  const args = tokens.slice(1);
  if (args.some(arg => /^(?:--fix|--write|--updateSnapshot|--update-snapshots|--watch|-u)(?:=|$)/i.test(arg))) return false;
  const evaluator = /^(?:test(?::[\w-]+)*|lint(?::[\w-]+)*|typecheck|type-check|check|verify|build|benchmark|bench|eval|evaluate)$/;
  if (/^(?:npm|pnpm|yarn|bun)$/.test(name)) {
    if (/^(?:exec|x)$/.test(args[0] || '')) return isLiteralVerificationCommand(args.slice(1));
    return evaluator.test(args[0] === 'run' ? args[1] || '' : args[0] || '');
  }
  if (name === 'npx') return args.length > 0 && isLiteralVerificationCommand(args);
  if (/^(?:python3?|py)$/.test(name)) return args[0] === '-m' && /^(?:pytest|unittest)$/.test(args[1] || '');
  if (/^(?:cargo|go|dotnet)$/.test(name)) return /^(?:test|check|build|bench)$/.test(args[0] || '');
  return /^(?:tsc|pytest|vitest|jest)$/.test(name)
    || (name === 'playwright' && args[0] === 'test');
}
