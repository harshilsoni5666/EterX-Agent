'use client';

import { useEffect, useState } from 'react';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../client-storage';
import { DEFAULT_GIT_PREFERENCES, normalizeGitPreferences } from './preferences';
import type { GitMutation, GitMutationResult, GitStatus } from './types';

export const GIT_CHANGED_EVENT = 'eterx-git-changed';

export function useGitPreferences() {
  const [state, setState] = useState({ ...DEFAULT_GIT_PREFERENCES, ready: false });
  useEffect(() => {
    let disposed = false;
    const read = () => {
      if (disposed) return;
      try {
        const next = { ...normalizeGitPreferences(JSON.parse(appStorage.getItem('eterx_settings') || '{}')), ready: true };
        setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      }
      catch { setState({ ...DEFAULT_GIT_PREFERENCES, ready: true }); }
    };
    void appStorageReady.then(ready => { if (ready) read(); });
    window.addEventListener('eterx-settings-updated', read);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, read);
    const stored = (event: Event) => { if ((event as CustomEvent).detail?.key === 'eterx_settings') read(); };
    window.addEventListener('eterx-folder-storage-updated', stored);
    // appStorage owns cross-window synchronization and emits only after its
    // local view has caught up with durable preferences.
    return () => { disposed = true; window.removeEventListener('eterx-settings-updated', read); window.removeEventListener(FOLDER_STORAGE_READY_EVENT, read); window.removeEventListener('eterx-folder-storage-updated', stored); };
  }, []);
  return state;
}

async function decode<T>(response: Response): Promise<T> {
  const result = await response.json().catch(() => { throw new Error('The Git service returned an incomplete response. Refresh the repository before retrying.'); });
  if (!response.ok) throw new Error(result.error || 'Git could not complete this action.');
  return result as T;
}

export async function readGit<T>(root: string, view = 'status', options: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ root, view, ...options });
  return decode<T>(await fetch('/api/git?' + query, { cache: 'no-store', signal }));
}

export const readGitStatus = (root: string, signal?: AbortSignal) => readGit<GitStatus>(root, 'status', {}, signal);

export async function mutateGit(input: GitMutation): Promise<GitMutationResult> {
  // Mutations are deliberately never retried: a lost response can still mean
  // the commit/push succeeded. Refresh repository state before trying again.
  try {
    return await decode<GitMutationResult>(await fetch('/api/git', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }));
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Connection interrupted. Refresh the repository before retrying; the action may have completed.');
    throw error;
  } finally {
    window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT, { detail: { root: input.root } }));
  }
}
