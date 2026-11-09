import path from 'node:path';

export type RecordedReplacements = { path: string; edits: Array<{ before: string; after: string }> };

/** Decode only the literal ReadAllText / Replace / WriteAllText idiom found
 * in source history. This is a data parser, never a PowerShell evaluator. */
export function recordedPowerShellReplacements(command: string, cwd: string): RecordedReplacements | null {
  if (command.length > 100_000) return null;
  const bindings = new Map<string, string>();
  const readString = (input: string): { value: string; rest: string } | null => {
    const text = input.trimStart(), quote = text[0];
    if (quote === '$') {
      const match = text.match(/^\$([A-Za-z_]\w*)(\.Trim\(\))?/i);
      if (!match) return null;
      const value = bindings.get(match[1].toLowerCase());
      return value !== undefined ? { value: match[2] ? value.trim() : value, rest: text.slice(match[0].length) } : null;
    }
    if (quote !== "'" && quote !== '"') return null;
    let value = '';
    for (let at = 1; at < text.length; at++) {
      const char = text[at];
      if (char === quote) {
        if (text[at + 1] === quote) { value += quote; at++; continue; }
        return { value, rest: text.slice(at + 1) };
      }
      if (quote === '"' && char === '$') return null;
      if (quote === '"' && char === '`') {
        const escape = text[++at]; if (escape === undefined) return null;
        value += ({ n: '\n', r: '\r', t: '\t', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[escape] ?? escape;
      } else value += char;
    }
    return null;
  };
  let rest = command.trim();
  const declaration = rest.match(/^\$([A-Za-z_]\w*)\s*=\s*(?:Join-Path\s+\(Get-Location\)\s+)?/i);
  if (!declaration) return null;
  const fileVariable = declaration[1].toLowerCase();
  const file = readString(rest.slice(declaration[0].length));
  if (!file || /[\r\n\0]/.test(file.value) || !path.isAbsolute(file.value) && !path.isAbsolute(cwd)) return null;
  rest = file.rest.trimStart().replace(/^;\s*/, '');
  const read = rest.match(/^\$([A-Za-z_]\w*)\s*=\s*\[System\.IO\.File\]::ReadAllText\(\$([A-Za-z_]\w*)\)\s*;?/i);
  if (!read || read[2].toLowerCase() !== fileVariable) return null;
  const contentVariable = read[1].toLowerCase();
  rest = rest.slice(read[0].length).trimStart();
  const edits: RecordedReplacements['edits'] = [];
  while (rest && edits.length < 100) {
    const write = rest.match(/^\[System\.IO\.File\]::WriteAllText\(\$([A-Za-z_]\w*)\s*,\s*\$([A-Za-z_]\w*)(?:\s*,\s*\[System\.Text\.UTF8Encoding\]::new\(\$false\))?\s*\)\s*;?\s*$/i);
    if (write) return write[1].toLowerCase() === fileVariable && write[2].toLowerCase() === contentVariable && edits.length
      ? { path: path.resolve(cwd || '.', file.value), edits } : null;
    const here = rest.match(/^\$([A-Za-z_]\w*)\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@\s*;?/);
    if (here) { bindings.set(here[1].toLowerCase(), here[2]); rest = rest.slice(here[0].length).trimStart(); continue; }
    const replace = rest.match(/^\$([A-Za-z_]\w*)\s*=\s*\$([A-Za-z_]\w*)\.Replace\(/i);
    if (!replace || replace[1].toLowerCase() !== contentVariable || replace[2].toLowerCase() !== contentVariable) return null;
    const before = readString(rest.slice(replace[0].length));
    if (!before?.value || !before.rest.trimStart().startsWith(',')) return null;
    const after = readString(before.rest.trimStart().slice(1));
    if (!after || !after.rest.trimStart().startsWith(')')) return null;
    edits.push({ before: before.value, after: after.value });
    rest = after.rest.trimStart().slice(1).trimStart().replace(/^;\s*/, '');
  }
  return null;
}
