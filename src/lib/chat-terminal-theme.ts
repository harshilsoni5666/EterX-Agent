import type { ITheme } from '@xterm/xterm';

export function chatTerminalTheme(): ITheme {
  const light = document.documentElement.dataset.theme === 'light';
  return light ? {
    background: '#fafafa', foreground: '#292d35', cursor: '#3b5bcc', cursorAccent: '#fafafa',
    selectionBackground: '#4666cc30', selectionInactiveBackground: '#4666cc18',
    black: '#383c46', red: '#be3548', green: '#237a49', yellow: '#926b16',
    blue: '#365dc1', magenta: '#8951b2', cyan: '#177d88', white: '#c4c8ce',
    brightBlack: '#747b87', brightRed: '#cc3d50', brightGreen: '#26864e', brightYellow: '#9a7118',
    brightBlue: '#426ad2', brightMagenta: '#965bbe', brightCyan: '#198793', brightWhite: '#edf0f4',
  } : {
    background: '#111111', foreground: '#dedbd6', cursor: '#dedbd6', cursorAccent: '#111111',
    selectionBackground: '#8797bf40', selectionInactiveBackground: '#8797bf22',
    black: '#30343b', red: '#e78284', green: '#a6c98c', yellow: '#e5c890',
    blue: '#8caee8', magenta: '#c6a0d8', cyan: '#81c8be', white: '#dedbd6',
    brightBlack: '#747985', brightRed: '#f2999b', brightGreen: '#b8d99f', brightYellow: '#efdaa8',
    brightBlue: '#a6c3f4', brightMagenta: '#d9b8e9', brightCyan: '#9bdcd2', brightWhite: '#f5f3ef',
  };
}

export function terminalTitle(title: string, fallback: string) {
  const value = title.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!value) return fallback;
  if (/^(?:[a-z]:[\\/]|\/).*\b(?:powershell|pwsh|cmd|bash|zsh|fish)(?:\.exe)?$/i.test(value)) {
    const name = value.split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
    return /^(powershell|pwsh)$/i.test(name) ? 'PowerShell' : name === 'cmd' ? 'Command Prompt' : name;
  }
  return value.slice(0, 120);
}
