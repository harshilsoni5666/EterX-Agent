'use client';

import { useCallback, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { appStorage, subscribeAppStorageKeys } from '../../lib/client-storage';
import { chatWorkspaceKey, chatWorkspaceName } from '../../lib/chat-scope';
import { assignFolderAvatars, IdentityAvatar, type IdentityAvatarDescriptor } from './identity-avatar';
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

const DESIGNS = [
  { style: 'monogram', label: 'Monogram' },
  { style: 'orbit', label: 'Orbit' },
  { style: 'stack', label: 'Stack' },
  { style: 'mosaic', label: 'Mosaic' },
  { style: 'facet', label: 'Facet' },
] as const;

const HUES = [214, 159, 28, 270, 331, 193, 44, 234, 101];
type GeneratedIcon = { style: typeof DESIGNS[number]['style']; hue: number; variant: 0 | 1 };
export type WorkspaceIconChoice = 'default' | 'custom' | GeneratedIcon;
export type WorkspaceIconPreference = {
  choice: WorkspaceIconChoice;
  image?: string;
};

const defaultIcon: WorkspaceIconPreference = { choice: 'default' };
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
    const choice = stored?.choice;
    if (choice === 'custom' && image) return { choice, image };
    if (
      choice && typeof choice === 'object' &&
      DESIGNS.some(design => design.style === choice.style) &&
      HUES.includes(choice.hue) && (choice.variant === 0 || choice.variant === 1)
    ) return { choice: { style: choice.style, hue: choice.hue, variant: choice.variant }, image };
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

export function generateWorkspaceIcons({ identity, name }: WorkspaceIdentity, batch: number) {
  let hash = 2166136261;
  for (const character of `${identity}:${name.normalize('NFKC')}`) {
    hash = Math.imul(hash ^ (character.codePointAt(0) || 0), 16777619);
  }
  const seed = hash >>> 0;
  return DESIGNS.map(({ style, label }, index) => ({
    label,
    choice: {
      style,
      hue: HUES[(seed + index * 2 + batch) % HUES.length],
      variant: ((seed + index + batch) % 2) as 0 | 1,
    },
  }));
}

export function sameWorkspaceIcon(a: WorkspaceIconChoice, b: WorkspaceIconChoice) {
  return typeof a === 'object' && typeof b === 'object'
    ? a.style === b.style && a.hue === b.hue && a.variant === b.variant
    : a === b;
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
  if (typeof choice === 'object') {
    return (
      <span
        className={`${styles.avatar} ${styles.generated}`}
        data-design={choice.style}
        data-variant={choice.variant}
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.38),
          '--workspace-icon-hue': choice.hue,
        } as CSSProperties}
      >
        <span className={styles.pattern} />
        {choice.style === 'monogram' && <span className={styles.initials}>{descriptor?.initials ?? Array.from(workspace.name).slice(0, 2).join('').toUpperCase()}</span>}
      </span>
    );
  }
  return (
    <IdentityAvatar identity={workspace.identity} name={workspace.name} descriptor={descriptor} size={size} shape="rounded" />
  );
}
