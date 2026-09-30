'use client';

export type WorkspaceToken = { text: string; light: string; dark: string };
export type WorkspaceTokens = WorkspaceToken[][];
let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, (tokens: WorkspaceTokens | null) => void>();
const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
function dispose() {
  worker?.terminate(); worker = undefined; clearTimeout(idle);
  for (const timeout of deadlines.values()) clearTimeout(timeout);
  deadlines.clear();
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}
export function workspaceLanguage(path: string, language?: string) {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const aliases: Record<string, string> = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', py: 'python', md: 'markdown', yml: 'yaml', sh: 'bash', zsh: 'bash', rs: 'rust', cc: 'cpp', c: 'cpp', h: 'cpp' };
  return aliases[extension] || aliases[language || ''] || language || extension;
}
export function highlightWorkspaceCode(content: string, language: string): Promise<WorkspaceTokens | null> {
  if (!content || content.length > 300000 || typeof Worker === 'undefined') return Promise.resolve(null);
  try {
    if (!worker) {
      worker = new Worker(new URL('./workspace-syntax.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; tokens: WorkspaceTokens | null }>) => {
        clearTimeout(deadlines.get(event.data.id)); deadlines.delete(event.data.id);
        pending.get(event.data.id)?.(event.data.tokens); pending.delete(event.data.id);
        if (!pending.size) { clearTimeout(idle); idle = setTimeout(dispose, 60000); }
      };
      worker.onerror = dispose;
    }
    clearTimeout(idle);
    const id = ++sequence;
    return new Promise(resolve => {
      pending.set(id, resolve); deadlines.set(id, setTimeout(dispose, 10000));
      try { worker!.postMessage({ id, content, language }); } catch { dispose(); }
    });
  } catch { dispose(); return Promise.resolve(null); }
}
