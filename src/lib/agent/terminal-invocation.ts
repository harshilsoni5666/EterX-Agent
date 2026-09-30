/** Human-readable display only. Never execute this text or use it as shell escaping. */
export function formatTerminalProgram(program: string, args: string[] = [], compact = false): string {
  const name = compact ? program.split(/[\\/]/).pop() || program : program;
  const display = (value: string) => {
    const text = String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
    return text && !/[\s"';&|<>]/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
  };
  return [name, ...args].map(display).join(' ');
}
