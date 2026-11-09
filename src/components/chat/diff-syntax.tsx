'use client';

import React, { useEffect, useState } from 'react';
import { highlightWorkspaceCode, workspaceLanguage, type WorkspaceToken, type WorkspaceTokens } from '../../lib/workspace-syntax';

type DiffLine = { type: string; content: string; isGap?: boolean; skipped?: number };

// Imported patches without hunk coordinates use these structural separators.
// Keep them in the data for diff grouping, but do not render placeholder bars.
export function isPlaceholderDiffGap(line: DiffLine): boolean {
  return Boolean(line.isGap && !line.skipped && /^(?:Changed section|Next change)?$/i.test(String(line.content || '').trim()));
}

export function useCodeSyntax(content: string, filepath: string, enabled = true) {
  const [syntax, setSyntax] = useState<{ content: string; filepath: string; tokens: WorkspaceTokens | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void highlightWorkspaceCode(content, workspaceLanguage(filepath)).then(tokens => {
      if (!disposed) setSyntax({ content, filepath, tokens });
    });
    return () => { disposed = true; };
  }, [content, filepath, enabled]);
  return enabled && syntax?.content === content && syntax.filepath === filepath ? syntax.tokens : null;
}

// Tokenize the two versions separately so deleted strings/comments cannot
// change the syntax colors of the replacement lines.
export function useDiffSyntax<T extends DiffLine>(lines: T[], filepath: string, language?: string) {
  const [syntax, setSyntax] = useState<{ lines: T[]; tokens: Map<T, WorkspaceToken[]> } | null>(null);
  useEffect(() => {
    let disposed = false;
    const versions = [
      lines.filter(line => !line.isGap && ['removed', 'unchanged', 'context'].includes(line.type)),
      lines.filter(line => !line.isGap && ['added', 'unchanged', 'context'].includes(line.type)),
    ];
    void Promise.all(versions.map(version => highlightWorkspaceCode(
      version.map(line => line.content).join('\n'), workspaceLanguage(filepath, language),
    ))).then(results => {
      if (disposed) return;
      const tokens = new Map<T, WorkspaceToken[]>();
      versions.forEach((version, side) => version.forEach((line, index) => {
        const highlighted = results[side]?.[index];
        if (highlighted) tokens.set(line, highlighted);
      }));
      setSyntax({ lines, tokens });
    });
    return () => { disposed = true; };
  }, [lines, filepath, language]);
  return syntax?.lines === lines ? syntax.tokens : undefined;
}

export function diffWordRanges<T extends DiffLine>(lines: T[]) {
  const ranges = new Map<T, [number, number]>();
  for (let i = 0; i < lines.length;) {
    if (lines[i].isGap || !['removed', 'added'].includes(lines[i].type)) { i++; continue; }
    const removed: T[] = [], added: T[] = [];
    while (lines[i] && !lines[i].isGap && ['removed', 'added'].includes(lines[i].type)) {
      (lines[i].type === 'removed' ? removed : added).push(lines[i++]);
    }
    for (let n = 0; n < Math.min(removed.length, added.length); n++) {
      const before = removed[n].content, after = added[n].content;
      let start = 0, suffix = 0;
      const length = Math.min(before.length, after.length);
      while (start < length && before[start] === after[start]) start++;
      while (suffix < length - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      ranges.set(removed[n], [start, before.length - suffix]);
      ranges.set(added[n], [start, after.length - suffix]);
    }
  }
  return ranges;
}

export function HighlightedDiffCode({ line, tokens, range }: {
  line: DiffLine; tokens?: WorkspaceToken[]; range?: [number, number];
}) {
  let offset = 0;
  return <>{(tokens || [{ text: line.content || ' ', light: '', dark: '' }]).map((token, index) => {
    const start = offset;
    offset += token.text.length;
    const from = range ? Math.max(0, range[0] - start) : token.text.length;
    const to = range ? Math.min(token.text.length, range[1] - start) : 0;
    return <span key={index} className="eterx-workspace-syntax-token" style={token.light ? {
      '--ws-code-light': token.light, '--ws-code-dark': token.dark,
    } as React.CSSProperties : undefined}>
      {to > from ? <>{token.text.slice(0, from)}<mark className={`eterx-code-word-change diff-${line.type}`}>{token.text.slice(from, to)}</mark>{token.text.slice(to)}</> : token.text}
    </span>;
  })}</>;
}
