export type LocalFileLink = { start: number; end: number; label: string; url: string; image: boolean; path: string | null; local: boolean };
export type TelegramText = { text: string; entities: Array<{ type: string; offset: number; length: number; url?: string; language?: string }> };
export function localPathFromHref(value: unknown): string | null;
export function localFileKey(value: unknown): string;
export function localFileLinks(value: unknown): LocalFileLink[];
export function replaceLocalFileLinks(value: unknown, replace: (link: LocalFileLink) => string): string;
export function cleanText(value: unknown): string;
export function renderTelegramText(value: unknown): TelegramText;
export function formatTelegramText(value: unknown, limit?: number): TelegramText[];
