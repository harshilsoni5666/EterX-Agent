'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { Check, ChevronDown, FolderClosed, Image as ImageIcon, ImageUp, LoaderCircle, RefreshCw, Type } from 'lucide-react';
import { appStorage, subscribeAppStorageKeys } from '../../lib/client-storage';
import { chatMatchesScope, type ChatScope } from '../../lib/chat-scope';
import { isAbsolutePathLike } from '../../lib/path-utils';
import { DEFAULT_WORKSPACE_PATH_KEY, projectFolderName, readRecentProjects, RECENT_PROJECTS_KEY } from '../../lib/project-folders';
import { SCHEDULED_TASKS_STORAGE_KEY } from '../../lib/scheduled-tasks';
import { listWorkspaceFolderChildren, type WorkspaceFolderEntry } from '../../lib/workspace-folder-list';
import type { IdentityAvatarDescriptor } from '../ui/identity-avatar';
import { Tooltip } from '../ui/tooltip';
import {
  assignWorkspaceAvatars, updateWorkspaceIcon, useWorkspaceIcon,
  WorkspaceAvatar, workspaceIdentity, type WorkspaceIconChoice, type WorkspaceIdentity, type WorkspaceSource,
} from '../ui/workspace-avatar';
import { suggestWorkspaceIcons, workspaceGlyphs } from '../ui/workspace-icon-suggestions';
import { ProjectFolderPicker, useProjectFolderBrowse } from './project-folder-picker';
import styles from './appearance-controls.module.css';

const noSnapshot = () => null;
const subscribeDefaultFolder = (onChange: () => void) => subscribeAppStorageKeys([DEFAULT_WORKSPACE_PATH_KEY], onChange);
const subscribeRecentFolders = (onChange: () => void) => subscribeAppStorageKeys([RECENT_PROJECTS_KEY], onChange);
const subscribeTaskFolders = (onChange: () => void) => subscribeAppStorageKeys([SCHEDULED_TASKS_STORAGE_KEY], onChange);
const readDefaultFolder = () => appStorage.getItem(DEFAULT_WORKSPACE_PATH_KEY);
const readRecentFolders = () => appStorage.getItem(RECENT_PROJECTS_KEY);
const readTaskFolders = () => appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY);
const emptyFolderEntries: readonly Pick<WorkspaceFolderEntry, 'name' | 'type'>[] = [];

function resolveTaskFolders(raw: string | null): WorkspaceSource[] {
  try {
    const records: unknown = JSON.parse(raw || '[]');
    return Array.isArray(records)
      ? records.filter(record => typeof record?.id === 'string')
      : [];
  } catch { return []; }
}

async function resizeWorkspaceImage(file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.');
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    throw new Error('Choose a PNG, JPG, or WebP image.');
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Could not read that image. Choose a different file.'); });
  try {
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the workspace icon.');
    const crop = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, size, size);
    return canvas.toDataURL('image/webp', 0.9);
  } finally {
    bitmap.close();
  }
}

function WorkspaceIconOptions({ workspace, path, descriptor }: {
  workspace: WorkspaceIdentity;
  path: string;
  descriptor?: IdentityAvatarDescriptor;
}) {
  const preference = useWorkspaceIcon(path);
  const [batch, setBatch] = useState(0);
  const [entries, setEntries] = useState<typeof emptyFolderEntries | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRevision = useRef(0);

  useEffect(() => () => { uploadRevision.current += 1; }, []);

  useEffect(() => {
    if (!isAbsolutePathLike(path)) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setEntries(emptyFolderEntries);
      controller.abort();
    }, 2000);
    void listWorkspaceFolderChildren(path, false, controller.signal)
      .then(items => {
        if (!controller.signal.aborted) setEntries(items.map(({ name, type }) => ({ name, type })));
      })
      .catch(() => {
        if (!controller.signal.aborted) setEntries(emptyFolderEntries);
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [path]);

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const revision = ++uploadRevision.current;
    setUploading(true);
    setError('');
    try {
      const image = await resizeWorkspaceImage(file);
      if (uploadRevision.current === revision) updateWorkspaceIcon(path, () => ({ choice: 'custom', image }));
    } catch (error) {
      if (uploadRevision.current === revision) setError(error instanceof Error ? error.message : 'Could not load the workspace icon.');
    } finally {
      if (uploadRevision.current === revision) setUploading(false);
    }
  };

  const chooseIcon = (choice: WorkspaceIconChoice) => {
    setError('');
    updateWorkspaceIcon(path, current => ({ ...current, choice }));
  };
  const currentLabel = preference.choice === 'default'
    ? 'Initials'
    : preference.choice === 'custom' ? 'Custom image' : workspaceGlyphs[preference.choice].label;
  const loadingSuggestions = entries === null && isAbsolutePathLike(path);
  const choices = useMemo(
    () => suggestWorkspaceIcons(workspace, entries ?? emptyFolderEntries, batch),
    [workspace, entries, batch],
  );
  const openImagePicker = () => inputRef.current?.click();

  return (
    <div className={styles.workspaceSection} data-settings-search-target="focus-sidebar-icon" tabIndex={-1}>
      <div className={styles.iconHeader}>
        <span className={styles.currentIcon}>
          <WorkspaceAvatar workspace={workspace} descriptor={descriptor} preference={preference} size={26} />
        </span>
        <div className={styles.settingText}>
          <div className={styles.title}>Focus sidebar icon</div>
          <p>Current · {currentLabel}</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label="Upload workspace icon"
          onChange={event => void onUpload(event)}
        />
        <div className={styles.iconActions}>
          <button
            type="button"
            className={styles.action}
            aria-pressed={preference.choice === 'default'}
            disabled={uploading}
            onClick={() => chooseIcon('default')}
          >
            <Type size={14} aria-hidden="true" />
            Initials
          </button>
          {preference.image ? (
            <>
              <button
                type="button"
                className={styles.action}
                aria-pressed={preference.choice === 'custom'}
                disabled={uploading}
                onClick={() => chooseIcon('custom')}
              >
                <ImageIcon size={14} aria-hidden="true" />
                Custom
              </button>
              <Tooltip text="Replace image" showOnFocus>
                <button type="button" className={styles.action} aria-label="Replace image" disabled={uploading} onClick={openImagePicker}>
                  <ImageUp size={15} aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          ) : (
            <button type="button" className={styles.action} disabled={uploading} onClick={openImagePicker}>
              <ImageUp size={14} aria-hidden="true" />
              Upload image
            </button>
          )}
        </div>
      </div>
      {uploading && <p className={styles.iconStatus} role="status">Preparing image…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.suggestions}>
        <div className={styles.iconToolbar}>
          <span>Suggested icons</span>
          <button type="button" className={styles.action} disabled={loadingSuggestions} onClick={() => setBatch(value => value + 1)} aria-label="Refresh suggested icons">
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        </div>
        {loadingSuggestions ? (
          <div className={`${styles.iconGrid} ${styles.iconLoading}`} role="status">
            <LoaderCircle className="motion-safe:animate-spin" size={15} aria-hidden="true" />
            Finding icons…
          </div>
        ) : (
          <div className={styles.iconGrid} role="group" aria-label="Suggested icons">
            {choices.map(choice => {
              const { icon: Icon, label } = workspaceGlyphs[choice];
              const selected = preference.choice === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  className={styles.iconOption}
                  disabled={uploading}
                  aria-pressed={selected}
                  onClick={() => chooseIcon(choice)}
                >
                  {selected && <Check className={styles.tileCheck} size={12} aria-hidden="true" />}
                  <Icon className={styles.suggestedIcon} size={19} strokeWidth={1.8} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        )}
        <span className="sr-only" role="status">{batch > 0 && `Suggested icons: ${choices.map(choice => workspaceGlyphs[choice].label).join(', ')}`}</span>
      </div>
    </div>
  );
}

export function WorkspaceFolderSettings({ sources, scope }: { sources?: readonly WorkspaceSource[]; scope?: ChatScope }) {
  const defaultFolder = useSyncExternalStore(subscribeDefaultFolder, readDefaultFolder, noSnapshot);
  const recentSnapshot = useSyncExternalStore(subscribeRecentFolders, readRecentFolders, noSnapshot);
  const taskSnapshot = useSyncExternalStore(subscribeTaskFolders, readTaskFolders, noSnapshot);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState('');
  const pickerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  const recents = useMemo(() => readRecentProjects(recentSnapshot), [recentSnapshot]);
  const path = defaultFolder?.trim() || recents.find(project => isAbsolutePathLike(project.path))?.path.trim() || null;
  const name = path ? projectFolderName(path) : 'Choose a folder';
  const workspace = useMemo(() => workspaceIdentity({ workspacePath: path }), [path]);
  const descriptor = useMemo(() => {
    const known = sources ?? recents.map(project => ({ workspacePath: project.path }));
    const visible = scope ? known.filter(source => chatMatchesScope(source, scope)) : known;
    return assignWorkspaceAvatars(
      [...visible, { workspacePath: path }],
      resolveTaskFolders(taskSnapshot),
    ).get(workspace.identity);
  }, [path, recents, scope, sources, taskSnapshot, workspace.identity]);

  const selectFolder = (folder: string | null) => {
    if (!isAbsolutePathLike(folder)) {
      setError('Choose a folder or enter its full path.');
      return;
    }
    setError('');
    appStorage.setItem(DEFAULT_WORKSPACE_PATH_KEY, folder.trim());
  };

  const browse = useProjectFolderBrowse('appearance', path, false, selectFolder, () => {
    setError('Could not open the folder picker. Try entering the full path.');
  }, isAbsolutePathLike);

  const closePicker = () => {
    setPickerOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <div className={styles.workspaceSection} data-settings-search-target="workspace-folder" tabIndex={-1}>
        <div className={styles.folderRow}>
          <div className={styles.settingText}>
            <div className={styles.title}>Workspace folder</div>
            <p>{!defaultFolder?.trim() && path ? 'Last used folder. Select it to use it for new chats.' : 'Choose the folder for new chats.'}</p>
          </div>
          <button
            ref={trigger}
            type="button"
            className={styles.folderButton}
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? pickerId : undefined}
            aria-label={`Workspace folder, ${name}`}
            title={path ?? undefined}
            onClick={() => setPickerOpen(value => !value)}
          >
            <FolderClosed className={styles.folderSymbol} size={18} strokeWidth={1.8} aria-hidden="true" />
            <span className={styles.folderLabel}>
              <strong>{name}</strong>
              {path && <small>{path}</small>}
            </span>
            <ChevronDown className={styles.folderChevron} size={14} aria-hidden="true" />
          </button>
        </div>
        {pickerOpen && (
          <div id={pickerId}>
            <ProjectFolderPicker
              workspacePath={path}
              workspaceName={name}
              locked={false}
              onSelect={selectFolder}
              onBrowse={() => void browse()}
              onClose={closePicker}
              className={styles.folderMenu}
              appearance
            />
          </div>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
      {path ? (
        <WorkspaceIconOptions key={workspace.identity} workspace={workspace} path={path} descriptor={descriptor} />
      ) : (
        <p className={`${styles.workspaceSection} ${styles.emptyIcon}`} data-settings-search-target="focus-sidebar-icon" tabIndex={-1}>
          Select a folder to customize its Focus sidebar icon.
        </p>
      )}
    </>
  );
}
