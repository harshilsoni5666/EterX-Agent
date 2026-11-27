'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { appStorage, subscribeAppStorageKeys } from '../../lib/client-storage';
import { chatWorkspaceKey, chatWorkspaceName } from '../../lib/chat-scope';
import { assignFolderAvatars, IdentityAvatar, type IdentityAvatarDescriptor } from './identity-avatar';
import { isWorkspaceGlyph, workspaceGlyphs, type WorkspaceGlyph } from './workspace-icon-suggestions';
import styles from './workspace-avatar.module.css';

export type WorkspaceSource = {
  workspacePath?: string | null;
  importFolder?: string;
};

export type WorkspaceIdentity = {
  identity: string;
  name: string;
  path?: string;
};

const noWorkspace: WorkspaceIdentity = { identity: 'default', name: 'No workspace' };

export function workspaceIdentity(source: WorkspaceSource): WorkspaceIdentity {
  const path = typeof source.workspacePath === 'string' ? source.workspacePath.trim() : '';
  if (path) return { identity: 'workspace:' + chatWorkspaceKey(path), name: chatWorkspaceName(path), path };
  const folder = typeof source.importFolder === 'string' ? source.importFolder.trim() : '';
  return folder ? { identity: 'folder:' + folder, name: folder } : noWorkspace;
}

export function assignWorkspaceAvatars(sources: readonly WorkspaceSource[], tasks: readonly WorkspaceSource[]) {
  const folders = new Map([[noWorkspace.identity, noWorkspace.name]]);
  const register = (source: WorkspaceSource) => {
    const { identity, name } = workspaceIdentity(source);
    if (!folders.has(identity)) folders.set(identity, name);
  };
  sources.forEach(register);
  tasks.forEach(register);
  return assignFolderAvatars(folders);
}

export type WorkspaceIconChoice = 'default' | 'custom' | WorkspaceGlyph;
export type WorkspaceIconPreference = {
  choice: WorkspaceIconChoice;
  image?: string;
};

const defaultIcon: WorkspaceIconPreference = { choice: 'default' };
const legacyGlyphs = new Map<string, WorkspaceIconChoice>([
  ['monogram', 'default'],
  ['orbit', 'compass'],
  ['stack', 'layers'],
  ['mosaic', 'dashboard'],
  ['facet', 'package'],
]);
const imagePattern = /^data:image\/(?:webp|png);base64,[a-z0-9+/]+=*$/i;

const iconStorageKey = (path?: string | null) => {
  const identity = chatWorkspaceKey(path);
  return identity ? 'eterx_workspace_icon:' + identity : '';
};

function parseIconPreference(raw: string | null): WorkspaceIconPreference {
  if (!raw) return defaultIcon;
  try {
    const stored = JSON.parse(raw);
    const image = typeof stored?.image === 'string' && stored.image.length <= 250_000 && imagePattern.test(stored.image)
      ? stored.image as string : undefined;
    const savedChoice = stored?.choice;
    const choice = typeof savedChoice?.style === 'string' ? legacyGlyphs.get(savedChoice.style) : savedChoice;
    if (choice === 'custom' && image) return { choice, image };
    if (isWorkspaceGlyph(choice)) return { choice, image };
    return image ? { choice: 'default', image } : defaultIcon;
  } catch {
    return defaultIcon;
  }
}

const noIconSnapshot = () => null;

export function useWorkspaceIcon(path?: string | null) {
  const key = iconStorageKey(path);
  const subscribe = useCallback((onChange: () => void) => (
    key ? subscribeAppStorageKeys([key], onChange) : () => {}
  ), [key]);
  const read = useCallback(() => key ? appStorage.getItem(key) : null, [key]);
  const raw = useSyncExternalStore(subscribe, read, noIconSnapshot);
  return useMemo(() => parseIconPreference(raw), [raw]);
}

export function updateWorkspaceIcon(path: string, update: (current: WorkspaceIconPreference) => WorkspaceIconPreference) {
  const key = iconStorageKey(path);
  if (!key) return;
  const raw = appStorage.getItem(key);
  const next = update(parseIconPreference(raw));
  if (next.choice === 'default' && !next.image) {
    if (raw) appStorage.removeItem(key);
  } else {
    appStorage.setItem(key, JSON.stringify(next));
  }
}

export function WorkspaceAvatar({ workspace, descriptor, preference, size }: {
  workspace: WorkspaceIdentity;
  descriptor?: IdentityAvatarDescriptor;
  preference: WorkspaceIconPreference;
  size: number;
}) {
  const { choice, image } = preference;
  if (choice === 'custom' && image) {
    return (
      <span className={styles.avatar} style={{ width: size, height: size }} aria-hidden="true">
        {/* The resized local image is already a small, self-contained avatar. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" />
      </span>
    );
  }
  if (isWorkspaceGlyph(choice)) {
    const { icon: Icon } = workspaceGlyphs[choice];
    return (
      <span className={styles.glyph} style={{ width: size, height: size }} aria-hidden="true">
        <Icon size={Math.round(size * 0.75)} strokeWidth={1.8} />
      </span>
    );
  }
  return (
    <IdentityAvatar identity={workspace.identity} name={workspace.name} descriptor={descriptor} size={size} shape="rounded" />
  );
}
