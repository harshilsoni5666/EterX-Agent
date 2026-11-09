/** Recognize literal, single-file read commands without executing their shell. */
export function shellFileRead(command: string): { path: string; startLine: number; endLine?: number; complete: boolean } | null {
  const powershell = command.trim().match(/^Get-Content\s+(?:(?:-LiteralPath|-Path)\s+)?(?:"([^"$`]+)"|'((?:[^']|'')+)'|([^\s|;&]+))\s*((?:(?:-TotalCount|-Head)\s+\d+\s*|-Raw\s*|-Encoding\s+[\w-]+\s*)*)(?:\|\s*Select-Object((?:\s+-(?:Skip|First)\s+\d+)+))?\s*$/i);
  if (powershell) {
    const options = powershell[4] || '', range = powershell[5] || '';
    const skip = Number(range.match(/-Skip\s+(\d+)/i)?.[1] || 0);
    const total = options.match(/-(?:TotalCount|Head)\s+(\d+)/i)?.[1];
    const first = range.match(/-First\s+(\d+)/i)?.[1];
    const count = Math.min(total === undefined ? Infinity : Math.max(0, Number(total) - skip), first === undefined ? Infinity : Number(first));
    return { path: powershell[1] || powershell[2]?.replace(/''/g, "'") || powershell[3], startLine: skip + 1,
      ...(Number.isFinite(count) ? { endLine: skip + count } : {}), complete: skip === 0 && !Number.isFinite(count) };
  }
  const cat = command.trim().match(/^(?:cat|type)\s+(?:--\s+)?(?:'([^']+)'|"([^"$`]+)"|([^\s;&|]+))$/);
  if (cat) return { path: cat[1] || cat[2] || cat[3], startLine: 1, complete: true };
  const sed = command.trim().match(/^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(?:'([^']+)'|"([^"$`]+)"|([^\s;&|]+))$/);
  if (sed) return { path: sed[3] || sed[4] || sed[5], startLine: Number(sed[1]), endLine: Number(sed[2]), complete: false };
  return null;
}

export function recordedFileContent(output: string, startLine = 1): { content: string; startLine: number; truncated: boolean } {
  const truncated = /(?:tokens truncated|output truncated|truncated output|exceeds? (?:the )?(?:maximum|limit)|(?:characters|lines) omitted)/i.test(output);
  const raw = output.replace(/\r\n/g, '\n');
  // Claude's numbered Read result can end with a tool reminder. Only discard
  // that wrapper when the preceding payload is an actual numbered file read.
  const candidate = raw.replace(/\n\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/, '');
  const lines = candidate.replace(/\n+$/, '').split('\n');
  const numbered = lines.map(line => line.match(/^\s*(?:L)?(\d+)(?:\t|→|\s*\| ?|: ?)(.*)$/));
  if (numbered.length && numbered.every((line, index) => line && Number(line[1]) === Number(numbered[0]![1]) + index)) {
    return { content: numbered.map(line => line![2]).join('\n'), startLine: Number(numbered[0]![1]), truncated };
  }
  return { content: raw, startLine: Number.isSafeInteger(startLine) && startLine > 0 ? startLine : 1, truncated };
}
