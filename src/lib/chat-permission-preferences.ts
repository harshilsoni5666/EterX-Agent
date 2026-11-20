import { appStorage, FOLDER_STORAGE_READY_EVENT } from './client-storage';
import { isChatPermissionMode, normalizeChatPermissionMode, type ChatPermissionMode } from './chat-permissions';

const MODE_KEY = 'eterx_chat_permission_mode';
const SETTINGS_KEY = 'eterx_settings';
const STORAGE_UPDATE = 'eterx-folder-storage-updated';
const modeKey = (chatId?: string | null) => `${MODE_KEY}:${chatId ? `chat:${chatId}` : 'draft'}`;

export function readChatPermissionPreference(chatId?: string | null): ChatPermissionMode {
  const saved = appStorage.getItem(modeKey(chatId));
  if (isChatPermissionMode(saved)) return saved;
  try {
    const settings = JSON.parse(appStorage.getItem(SETTINGS_KEY) || '{}');
    if (settings?.alwaysFullAccess === true) return 'full';
  } catch { /* Fall back to the legacy default. */ }
  return normalizeChatPermissionMode(appStorage.getItem(MODE_KEY));
}

export function writeChatPermissionMode(chatId: string | null | undefined, mode: ChatPermissionMode) {
  appStorage.setItem(modeKey(chatId), mode);
}

export function rememberChatPermissionMode(chatId: string, mode: ChatPermissionMode) {
  if (!isChatPermissionMode(appStorage.getItem(modeKey(chatId)))) writeChatPermissionMode(chatId, mode);
}

export function clearDraftChatPermissionMode() {
  appStorage.removeItem(modeKey(null));
}

export function subscribeChatPermissionPreference(listener: () => void): () => void {
  const onStorage = (event: Event) => {
    const key = (event as CustomEvent).detail?.key;
    if (!key || key === SETTINGS_KEY || key === MODE_KEY || key.startsWith(`${MODE_KEY}:`)) listener();
  };
  window.addEventListener(STORAGE_UPDATE, onStorage);
  window.addEventListener(FOLDER_STORAGE_READY_EVENT, listener);
  return () => {
    window.removeEventListener(STORAGE_UPDATE, onStorage);
    window.removeEventListener(FOLDER_STORAGE_READY_EVENT, listener);
  };
}
