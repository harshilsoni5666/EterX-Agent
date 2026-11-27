'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { Check, ChevronDown, FolderClosed, ImagePlus, RefreshCw, Upload } from 'lucide-react';
import { appStorage, subscribeAppStorageKeys } from '../../lib/client-storage';
import { chatMatchesScope, type ChatScope } from '../../lib/chat-scope';
import { isAbsolutePathLike } from '../../lib/path-utils';
import { DEFAULT_WORKSPACE_PATH_KEY, projectFolderName, readRecentProjects, RECENT_PROJECTS_KEY } from '../../lib/project-folders';
import { SCHEDULED_TASKS_STORAGE_KEY } from '../../lib/scheduled-tasks';
import type { IdentityAvatarDescriptor } from '../ui/identity-avatar';
import {
  assignWorkspaceAvatars, generateWorkspaceIcons, sameWorkspaceIcon, updateWorkspaceIcon, useWorkspaceIcon,
  WorkspaceAvatar, workspaceIdentity, type WorkspaceIconChoice, type WorkspaceIdentity, type WorkspaceSource,
} from '../ui/workspace-avatar';
import { ProjectFolderPicker, useProjectFolderBrowse } from './project-folder-picker';
import styles from './appearance-controls.module.css';

const noSnapshot = () => null;
const subscribeDefaultFolder = (onChange: () => void) => subscribeAppStorageKeys([DEFAULT_WORKSPACE_PATH_KEY], onChange);
const subscribeRecentFolders = (onChange: () => void) => subscribeAppStorageKeys([RECENT_PROJECTS_KEY], onChange);
const subscribeTaskFolders = (onChange: () => void) => subscribeAppStorageKeys([SCHEDULED_TASKS_STORAGE_KEY], onChange);
const readDefaultFolder = () => appStorage.getItem(DEFAULT_WORKSPACE_PATH_KEY);
const readRecentFolders = () => appStorage.getItem(RECENT_PROJECTS_KEY);
const readTaskFolders = () => appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY);

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
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRevision = useRef(0);

  useEffect(() => () => { uploadRevision.current += 1; }, []);

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
  const originalSelected = preference.choice === 'default';
  const customSelected = preference.choice === 'custom';
  const choices = generateWorkspaceIcons(workspace, batch);

  return (
    <div className={styles.workspaceSection} data-settings-search-target="focus-sidebar-icon" tabIndex={-1}>
      <div className={styles.iconHeader}>
        <WorkspaceAvatar workspace={workspace} descriptor={descriptor} preference={preference} size={42} />
        <div className={styles.settingText}>
          <div className={styles.title}>Focus sidebar icon</div>
          <p>Current icon for {workspace.name}</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label="Upload workspace icon"
          onChange={event => void onUpload(event)}
        />
        {preference.image && (
          <button type="button" className={styles.action} disabled={uploading} onClick={() => inputRef.current?.click()}>
            <Upload size={14} aria-hidden="true" />
            {uploading ? 'Preparing image…' : 'Replace image'}
          </button>
        )}
      </div>
      <div className={styles.iconSources} role="group" aria-label="Original and custom icons">
        <button
          type="button"
          className={styles.sourceOption}
          aria-pressed={originalSelected}
          disabled={uploading}
          onClick={() => chooseIcon('default')}
        >
          <WorkspaceAvatar workspace={workspace} descriptor={descriptor} preference={{ choice: 'default' }} size={28} />
          <span>Original</span>
          {originalSelected && <Check className={styles.selectionIcon} size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={styles.sourceOption}
          aria-pressed={preference.image ? customSelected : undefined}
          disabled={uploading}
          onClick={() => preference.image ? chooseIcon('custom') : inputRef.current?.click()}
        >
          {preference.image ? (
            <WorkspaceAvatar workspace={workspace} preference={{ ...preference, choice: 'custom' }} size={28} />
          ) : (
            <span className={styles.controlIcon}><ImagePlus size={15} aria-hidden="true" /></span>
          )}
          <span>{preference.image ? 'Custom image' : uploading ? 'Preparing image…' : 'Upload image'}</span>
          {customSelected && <Check className={styles.selectionIcon} size={14} aria-hidden="true" />}
        </button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.generatedPanel}>
        <div className={styles.iconToolbar}>
          <span>Generated icons</span>
          <button type="button" className={styles.action} onClick={() => setBatch(value => value + 1)} aria-label="Refresh generated icons">
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        </div>
        <div className={styles.iconGrid} role="group" aria-label="Generated icons">
          {choices.map(({ label, choice }) => {
            const selected = sameWorkspaceIcon(preference.choice, choice);
            return (
              <button
                key={label}
                type="button"
                className={styles.iconOption}
                disabled={uploading}
                aria-pressed={selected}
                onClick={() => chooseIcon(choice)}
              >
                {selected && <Check className={styles.tileCheck} size={12} aria-hidden="true" />}
                <WorkspaceAvatar workspace={workspace} descriptor={descriptor} preference={{ choice }} size={34} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
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
  const path = (defaultFolder ?? recents.find(project => isAbsolutePathLike(project.path))?.path)?.trim() || null;
  const name = path ? projectFolderName(path) : 'Choose a folder';
  const workspace = workspaceIdentity({ workspacePath: path });
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
            <p>{!defaultFolder && path ? 'Last used folder. Select it to use it for new chats.' : 'Choose the folder for new chats.'}</p>
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
            <span className={styles.controlIcon}><FolderClosed size={16} aria-hidden="true" /></span>
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
