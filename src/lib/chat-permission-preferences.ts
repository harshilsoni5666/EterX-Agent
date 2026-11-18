import { appStorage, FOLDER_STORAGE_READY_EVENT } from './client-storage';
import { normalizeChatPermissionMode, type ChatPermissionMode } from './chat-permissions';

const MODE_KEY = 'eterx_chat_permission_mode';
const SETTINGS_KEY = 'eterx_settings';
const STORAGE_UPDATE = 'eterx-folder-storage-updated';

export function readChatPermissionPreference(): ChatPermissionMode | 'always-full' {
  try {
    const settings = JSON.parse(appStorage.getItem(SETTINGS_KEY) || '{}');
    if (settings?.alwaysFullAccess === true) return 'always-full';
  } catch { /* Use the saved composer mode if the general settings are unreadable. */ }
  return normalizeChatPermissionMode(appStorage.getItem(MODE_KEY));
}

export function readEffectiveChatPermissionMode(): ChatPermissionMode {
  return normalizeChatPermissionMode(readChatPermissionPreference());
}

export function writeChatPermissionMode(mode: ChatPermissionMode) {
  appStorage.setItem(MODE_KEY, mode);
}

export function subscribeChatPermissionPreference(listener: () => void): () => void {
  const onStorage = (event: Event) => {
    const key = (event as CustomEvent).detail?.key;
    if (!key || key === SETTINGS_KEY || key === MODE_KEY) listener();
  };
  window.addEventListener(STORAGE_UPDATE, onStorage);
  window.addEventListener(FOLDER_STORAGE_READY_EVENT, listener);
  return () => {
    window.removeEventListener(STORAGE_UPDATE, onStorage);
    window.removeEventListener(FOLDER_STORAGE_READY_EVENT, listener);
  };
}
