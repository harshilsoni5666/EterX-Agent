export const IMPORT_PROVIDERS = ['codex', 'claude', 'cursor'] as const;
export type ImportProvider = typeof IMPORT_PROVIDERS[number];
export const IMPORT_CATEGORIES = ['chats', 'instructions', 'skills', 'agents', 'mcp'] as const;
export type ImportCategory = typeof IMPORT_CATEGORIES[number];
export interface ImportSourceFile { name: string; content: string; encoding?: 'base64' }
export const IMPORT_LABELS: Record<ImportProvider, string> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };
export const CATEGORY_LABELS: Record<ImportCategory, string> = {
  chats: 'Chats & projects', instructions: 'Instructions & memory', skills: 'Skills', agents: 'Custom agents', mcp: 'MCP servers',
};
export type ImportSelection = Record<ImportCategory, boolean> & {
  /** null follows all conversations, including newly discovered ones. */
  chatIds: string[] | null;
  projectPaths?: string[];
  excludedIds?: string[];
};
export const DEFAULT_IMPORT_SELECTION: ImportSelection = {
  chats: true, instructions: true, skills: true, agents: true, mcp: false, chatIds: null,
};
export interface ImportOrigin {
  provider: ImportProvider;
  sourceId: string;
  importedAt: number;
  syncedAt: number;
  sourceUpdatedAt: number;
  sourceTitle: string;
  sourceWorkspace?: string;
}
export interface ImportItemSummary {
  id: string;
  category: ImportCategory;
  name: string;
  detail: string;
  workspace?: string;
  updatedAt: number;
  count?: number;
  compatibilityNote?: string;
}
export interface ImportPreview {
  id: string;
  provider: ImportProvider;
  roots: string[];
  items: ImportItemSummary[];
  warnings: string[];
  createdAt: number;
  uploaded: boolean;
}
export interface ImportReport {
  provider: ImportProvider;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  setup: number;
  warnings: string[];
  chatIds: string[];
  savedAt: number;
  completedAt: number;
}
export interface ImportSourceState {
  provider: ImportProvider;
  roots: string[];
  selection: ImportSelection;
  enabled: boolean;
  uploaded: boolean;
  folder?: string | null;
  lastSyncAt?: number;
  lastError?: string;
  lastReport?: ImportReport;
}
export interface ImportStatus {
  autoSync: boolean;
  sources: Partial<Record<ImportProvider, ImportSourceState>>;
  available: Record<ImportProvider, { roots: string[]; detected: boolean }>;
  activeJob?: ImportJob;
  pendingPreview?: ImportPreview;
  folders: string[];
  setup: ImportedSetupEntry[];
}
export interface ImportedSetupEntry {
  id: string;
  provider: ImportProvider;
  category: Exclude<ImportCategory, 'chats'>;
  name: string;
  destination: string;
  enabled: boolean;
  workspace?: string;
  compatibilityNote?: string;
}
export interface ImportJob {
  id: string;
  provider: ImportProvider;
  kind: 'scan' | 'import' | 'sync';
  status: 'running' | 'complete' | 'failed';
  phase: string;
  processed: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  preview?: ImportPreview;
  report?: ImportReport;
}
export function isImportProvider(value: unknown): value is ImportProvider {
  return typeof value === 'string' && (IMPORT_PROVIDERS as readonly string[]).includes(value);
}
export function normalizeImportSelection(value: unknown): ImportSelection {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    ...Object.fromEntries(IMPORT_CATEGORIES.map(key => [key, input[key] === true])) as Record<ImportCategory, boolean>,
    chatIds: Array.isArray(input.chatIds) ? [...new Set(input.chatIds.filter((id): id is string => typeof id === 'string' && id.length < 200))].slice(0, 20000) : null,
    projectPaths: Array.isArray(input.projectPaths) ? input.projectPaths.filter((value): value is string => typeof value === 'string' && value.length < 4096).slice(0, 500) : [],
    excludedIds: Array.isArray(input.excludedIds) ? input.excludedIds.filter((value): value is string => typeof value === 'string' && value.length < 200).slice(0, 20000) : [],
  };
}
