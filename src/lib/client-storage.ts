type StorageValues = Record<string, string>;

const PREFERENCES_ENDPOINT = '/api/preferences';
const PREFERENCES_CHANNEL = 'eterx-preferences';
export const FOLDER_STORAGE_READY_EVENT = 'eterx-folder-storage-ready';
const SENSITIVE_KEYS = new Set([
  'eterx_api_keys',
  'eterx_model_api_keys',
]);

// AppData is the only durable store. This map is an in-process view used by
// the renderer; it is intentionally never backed by browser localStorage.
const memory = new Map<string, string>();
const pendingRemovals = new Set<string>();
const pendingMutations = new Map<string, string | null>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<boolean> = Promise.resolve(true);
let storageHydrated = false;
let storageLoadFailed = false;
let persistRequestedDuringHydration = false;
let storageRefreshPromise: Promise<boolean> | null = null;
let storageRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let storageRecoveryAttempt = 0;
const durableFlushers = new Set<() => Promise<boolean | void> | boolean | void>();

const isBrowser = typeof window !== 'undefined';
const isSensitive = (key: string) => SENSITIVE_KEYS.has(key);

type DesktopPreferencesApi = {
  getRendererPreferences?: () => Promise<{ ok?: boolean; values?: unknown; error?: string }>;
  updateRendererPreferences?: (update: { values: StorageValues; remove: string[] }) => Promise<{ ok?: boolean; error?: string }>;
};

const getDesktopPreferencesApi = (): DesktopPreferencesApi | null => {
  if (!isBrowser) return null;
  const api = (window as typeof window & { electronAPI?: DesktopPreferencesApi }).electronAPI;
  return api && typeof api.getRendererPreferences === 'function' && typeof api.updateRendererPreferences === 'function'
    ? api
    : null;
};

const normalizeStoredValues = (raw: unknown): StorageValues | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => !isSensitive(key) && typeof value === 'string')
      .map(([key, value]) => [key, value as string]),
  );
};

const loadStoredValues = async (): Promise<StorageValues | null> => {
  const desktopApi = getDesktopPreferencesApi();
  if (desktopApi?.getRendererPreferences) {
    const payload = await desktopApi.getRendererPreferences();
    if (payload?.ok === false) throw new Error(payload.error || 'Desktop preference read failed.');
    return normalizeStoredValues(payload?.values);
  }

  const response = await fetch(PREFERENCES_ENDPOINT, { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || `Preference read failed: ${response.status}`);
  return normalizeStoredValues(payload.values);
};

const saveStoredValues = async (values: StorageValues, remove: string[]): Promise<void> => {
  const desktopApi = getDesktopPreferencesApi();
  if (desktopApi?.updateRendererPreferences) {
    const payload = await desktopApi.updateRendererPreferences({ values, remove });
    if (!payload?.ok) throw new Error(payload?.error || 'Desktop preference write failed.');
    return;
  }

  const response = await fetch(PREFERENCES_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values, remove }),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`Preference write failed: ${response.status}`);
};

const getPendingPersistableMutations = () => {
  const values: StorageValues = {};
  const remove: string[] = [];
  const snapshot = new Map<string, string | null>();
  for (const [key, value] of pendingMutations.entries()) {
    if (isSensitive(key)) continue;
    snapshot.set(key, value);
    if (value === null) remove.push(key);
    else values[key] = value;
  }
  return { values, remove, snapshot };
};

const enqueuePersist = (): Promise<boolean> => {
  const write = async () => {
    const { values, remove, snapshot } = getPendingPersistableMutations();
    if (snapshot.size === 0) return true;

    // A desktop update or shutdown must not lose the last settings mutation to
    // a transient localhost restart. Keep the whole write in the same serial
    // queue as normal debounced writes and retry a few times while the server
    // is still alive.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await saveStoredValues(values, remove);
        snapshot.forEach((value, key) => {
          if (pendingMutations.get(key) !== value) return;
          pendingMutations.delete(key);
          if (value === null) pendingRemovals.delete(key);
        });
        notifyPreferencesCommitted();
        return true;
      } catch {
        if (attempt < 2) {
          await new Promise(resolve => window.setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
    }
    return false;
  };

  persistChain = persistChain.then(write, write);
  return persistChain;
};

const dispatchStorageUpdate = (key: string, removed = false) => {
  if (!isBrowser) return;
  window.dispatchEvent(new CustomEvent('eterx-folder-storage-updated', {
    detail: { key, removed },
  }));
};

const notifyPreferencesCommitted = () => {
  if (!isBrowser || typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(PREFERENCES_CHANNEL);
    channel.postMessage({ type: 'preferences-committed', at: Date.now() });
    channel.close();
  } catch { }
};

export function registerDurableFlush(flush: () => Promise<boolean | void> | boolean | void): () => void {
  durableFlushers.add(flush);
  return () => durableFlushers.delete(flush);
}

export async function flushDurableState(): Promise<boolean> {
  const flushers = Array.from(durableFlushers);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const results = await Promise.allSettled(flushers.map(flush => Promise.resolve().then(flush)));
    if (results.every(result => result.status === 'fulfilled' && result.value !== false)) return true;
    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return false;
}

const persist = () => {
  if (!isBrowser) return;
  if (!storageHydrated) {
    persistRequestedDuringHydration = true;
    return;
  }
  if (storageLoadFailed) {
    persistRequestedDuringHydration = true;
    return;
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void enqueuePersist();
  }, 120);
};

export const appStorage = {
  get length() {
    return memory.size;
  },
  clear() {
    const keys = Array.from(memory.keys());
    memory.clear();
    keys.forEach(key => {
      pendingRemovals.add(key);
      pendingMutations.set(key, null);
    });
    persist();
    keys.forEach(key => dispatchStorageUpdate(key, true));
  },
  getItem(key: string) {
    return memory.get(String(key)) ?? null;
  },
  key(index: number) {
    return Array.from(memory.keys())[index] ?? null;
  },
  removeItem(key: string) {
    const normalizedKey = String(key);
    memory.delete(normalizedKey);
    pendingRemovals.add(normalizedKey);
    pendingMutations.set(normalizedKey, null);
    persist();
    dispatchStorageUpdate(normalizedKey, true);
  },
  setItem(key: string, value: string) {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    // Periodic live-status refreshes often write the same value. Avoid an
    // unnecessary AppData rewrite, cross-window refresh, and renderer event.
    if (
      memory.get(normalizedKey) === normalizedValue
      && !pendingRemovals.has(normalizedKey)
    ) return;
    memory.set(normalizedKey, normalizedValue);
    pendingRemovals.delete(normalizedKey);
    pendingMutations.set(normalizedKey, normalizedValue);
    if (!isSensitive(normalizedKey)) persist();
    dispatchStorageUpdate(normalizedKey);
  },
  setItems(values: Record<string, string>) {
    const changed: string[] = [];
    Object.entries(values).forEach(([key, value]) => {
      const normalizedKey = String(key);
      const normalizedValue = String(value);
      if (
        memory.get(normalizedKey) === normalizedValue
        && !pendingRemovals.has(normalizedKey)
      ) return;
      memory.set(normalizedKey, normalizedValue);
      pendingRemovals.delete(normalizedKey);
      pendingMutations.set(normalizedKey, normalizedValue);
      changed.push(normalizedKey);
    });
    if (changed.some(key => !isSensitive(key))) persist();
    // Notify only after the complete snapshot is visible to every reader.
    changed.forEach(key => dispatchStorageUpdate(key));
  },
};

export const appStorageReady = (async () => {
  if (!isBrowser) {
    storageHydrated = true;
    return true;
  }

  let storedValues: StorageValues = {};
  let loaded = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const values = await loadStoredValues();
      if (values) {
        storedValues = values;
        loaded = true;
        break;
      }
    } catch { }
    if (attempt < 2) {
      await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  // Do not replace newer in-memory values when the initial request races a
  // user action. If the read failed, retain pending mutations and prohibit
  // writes until a later refresh succeeds; this prevents an empty renderer
  // map from overwriting a healthy AppData preferences file.
  if (loaded) {
    const storedKeys = new Set(Object.keys(storedValues));
    for (const key of Array.from(memory.keys())) {
      if (isSensitive(key) || storedKeys.has(key) || pendingMutations.has(key)) continue;
      memory.delete(key);
      dispatchStorageUpdate(key, true);
    }
    Object.entries(storedValues).forEach(([key, value]) => memory.set(key, value));
  }
  for (const [key, value] of pendingMutations.entries()) {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  storageLoadFailed = !loaded;
  storageHydrated = true;
  if (persistRequestedDuringHydration && loaded) {
    persistRequestedDuringHydration = false;
    persist();
  }
  window.dispatchEvent(new CustomEvent(FOLDER_STORAGE_READY_EVENT, { detail: { loaded } }));
  return loaded;
})();

export async function refreshAppStorage(): Promise<boolean> {
  if (!isBrowser) return true;
  if (storageRefreshPromise) return storageRefreshPromise;

  storageRefreshPromise = (async () => {
    let storedValues: StorageValues | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        storedValues = await loadStoredValues();
        if (storedValues) break;
      } catch { }
      if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
    }

    if (!storedValues) return false;
    const storedKeys = new Set(Object.keys(storedValues));
    for (const key of Array.from(memory.keys())) {
      if (isSensitive(key) || storedKeys.has(key) || pendingMutations.has(key)) continue;
      memory.delete(key);
      dispatchStorageUpdate(key, true);
    }
    Object.entries(storedValues).forEach(([key, value]) => memory.set(key, value));
    for (const [key, value] of pendingMutations.entries()) {
      if (value === null) memory.delete(key);
      else memory.set(key, value);
    }
    storageLoadFailed = false;
    storageHydrated = true;
    storageRecoveryAttempt = 0;
    if (storageRecoveryTimer) {
      clearTimeout(storageRecoveryTimer);
      storageRecoveryTimer = null;
    }
    const hadPendingWrites = persistRequestedDuringHydration;
    persistRequestedDuringHydration = false;
    window.dispatchEvent(new CustomEvent(FOLDER_STORAGE_READY_EVENT, { detail: { loaded: true } }));
    const pendingWriteSaved = !hadPendingWrites || await enqueuePersist();
    if (!pendingWriteSaved) persistRequestedDuringHydration = true;
    return pendingWriteSaved;
  })().finally(() => {
    storageRefreshPromise = null;
  });

  return storageRefreshPromise;
}

const scheduleStorageRecovery = () => {
  if (!isBrowser || !storageLoadFailed || storageRecoveryTimer) return;
  const delay = Math.min(15_000, 2_000 * (2 ** storageRecoveryAttempt));
  storageRecoveryTimer = setTimeout(() => {
    storageRecoveryTimer = null;
    void refreshAppStorage().then(ok => {
      if (ok || !storageLoadFailed) {
        storageRecoveryAttempt = 0;
        return;
      }
      storageRecoveryAttempt = Math.min(storageRecoveryAttempt + 1, 4);
      scheduleStorageRecovery();
    });
  }, delay);
};

if (isBrowser) {
  window.addEventListener('focus', () => {
    if (storageLoadFailed) {
      storageRecoveryAttempt = 0;
      void refreshAppStorage().then(ok => {
        if (!ok) scheduleStorageRecovery();
      });
    }
  });
  void appStorageReady.then(() => {
    if (storageLoadFailed) scheduleStorageRecovery();
  });
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(PREFERENCES_CHANNEL);
      channel.onmessage = event => {
        if (event?.data?.type !== 'preferences-committed') return;
        void refreshAppStorage();
      };
      const flushOnPageExit = () => {
        // keepalive=true in enqueuePersist lets direct localhost/browser use
        // the same AppData store as Electron even when the document is being
        // torn down. Electron also performs an awaited IPC flush.
        void flushAppStorage();
        channel.close();
      };
      window.addEventListener('pagehide', flushOnPageExit, { once: true });
      window.addEventListener('beforeunload', flushOnPageExit, { once: true });
    } catch { }
  } else {
    const flushOnPageExit = () => { void flushAppStorage(); };
    window.addEventListener('pagehide', flushOnPageExit, { once: true });
    window.addEventListener('beforeunload', flushOnPageExit, { once: true });
  }
}

/** Flush all pending AppData preference writes before a desktop update/quit. */
export async function flushAppStorage(): Promise<boolean> {
  if (!isBrowser) return true;
  await appStorageReady;
  if (storageLoadFailed && !await refreshAppStorage()) return false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return enqueuePersist();
}
