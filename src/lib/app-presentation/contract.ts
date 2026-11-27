import { isConcreteModelId, isEmbeddedModelLabel, isModelProvider, modelEntryKey } from '../agent/model-selector-store';
import type { MainAgentProvider } from '../agent/model-routing';

export const PRESENTATION_FLAG = 'eterx-app-presentation-v1';
export const ANNOUNCEMENT_WIDTH = { min: 420, default: 620, max: 1_040 } as const;
export const MAX_ANNOUNCEMENT_TITLE = 100;
export const MAX_ANNOUNCEMENT_BODY = 180_000;
export const MAX_ANNOUNCEMENT_IMAGE = 124_000;
export const MAX_PRESENTATION_BYTES = 220_000;
export const MAX_MODEL_BADGE_ROWS = 1_000;
export const MODEL_BADGES = ['new', 'recommended'] as const;
export const MODEL_BADGE_LABELS = { new: 'New', recommended: 'Recommended' } as const;
export const MAX_CUSTOM_BADGE_LENGTH = 20;
export const MAX_ANNOUNCEMENT_VERSIONS = 30;
export const MAX_ANNOUNCEMENT_SECTIONS = 8;

export type ModelBadge = string;
export type BadgeRow = { provider: MainAgentProvider; modelId: string; badges: ModelBadge[] };
export type AnnouncementSection = { title: string; format: 'markdown' | 'html'; body: string };
export type AnnouncementDraft = AnnouncementSection & { width: number; versions: string[]; sections: AnnouncementSection[] };
export type Announcement = AnnouncementDraft & { id: string; publishedAt: string; paused: boolean };
export type AppPresentation = { schema: 1; badges: BadgeRow[]; disabledProviders: MainAgentProvider[]; announcement: Announcement | null };
export const EMPTY_PRESENTATION: AppPresentation = { schema: 1, badges: [], disabledProviders: [], announcement: null };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function modelIdentity(provider: unknown, id: unknown) {
  if (!isModelProvider(provider) || typeof id !== 'string') return null;
  const modelId = id.trim();
  if (modelId.length > 250 || CONTROL_CHARS.test(modelId) || !isConcreteModelId(modelId) || isEmbeddedModelLabel(modelId)) return null;
  try {
    return { provider, modelId, key: modelEntryKey(provider, modelId) };
  } catch {
    return null;
  }
}

export function decodeBadges(value: unknown): ModelBadge[] | null {
  if (!Array.isArray(value) || value.length > MODEL_BADGES.length + 1) return null;
  const badges = new Set<string>();
  let custom: string | undefined;
  for (const raw of value) {
    const badge = parseModelBadge(raw);
    if (!badge || badges.has(badge.toLowerCase())) return null;
    badges.add(badge.toLowerCase());
    if (badge !== 'new' && badge !== 'recommended') {
      if (custom) return null;
      custom = badge;
    }
  }
  return [...MODEL_BADGES.filter(badge => badges.has(badge)), ...(custom ? [custom] : [])];
}

export function parseModelBadge(value: unknown): ModelBadge | null {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value)) return null;
  const text = value.trim().replace(/ +/g, ' ');
  const lower = text.toLowerCase();
  if (lower === 'new' || lower === 'recommended') return lower;
  return text.length <= MAX_CUSTOM_BADGE_LENGTH && /^[\p{L}\p{N}][\p{L}\p{N} .&+_-]*$/u.test(text) ? text : null;
}

export function modelBadgeLabel(badge: ModelBadge) {
  return badge === 'new' || badge === 'recommended' ? MODEL_BADGE_LABELS[badge] : badge;
}

export function isAnnouncementId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function releaseVersion(value: unknown) {
  if (typeof value !== 'string') return null;
  const tag = value.trim().replace(/^v(?=\d)/i, '');
  return tag.length <= 80 && /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/.test(tag)
    ? tag : null;
}

export function decodeDisabledProviders(value: unknown): MainAgentProvider[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200 || !value.every(isModelProvider)) return null;
  return Array.from(new Set<MainAgentProvider>(value)).sort();
}

function decodeSection(value: unknown): AnnouncementSection | null {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.body !== 'string'
    || (value.format !== 'markdown' && value.format !== 'html')) return null;
  const title = value.title.trim();
  const body = value.body.trim();
  if (!title || title.length > MAX_ANNOUNCEMENT_TITLE || CONTROL_CHARS.test(title) || body.length > MAX_ANNOUNCEMENT_BODY) return null;
  return { title, body, format: value.format };
}

export function decodeAnnouncementDraft(value: unknown): AnnouncementDraft | null {
  if (!isRecord(value) || typeof value.width !== 'number' || !Number.isInteger(value.width)
    || value.width < ANNOUNCEMENT_WIDTH.min || value.width > ANNOUNCEMENT_WIDTH.max) return null;
  const primary = decodeSection(value);
  if (!primary) return null;
  const rawSections = value.sections ?? [];
  if (!Array.isArray(rawSections) || rawSections.length > MAX_ANNOUNCEMENT_SECTIONS) return null;
  const sections: AnnouncementSection[] = [];
  let total = bytes(primary.body);
  for (const input of rawSections) {
    const section = decodeSection(input);
    if (!section?.body) return null;
    total += bytes(section.body);
    sections.push(section);
  }
  if ((!primary.body && sections.length === 0) || total > MAX_ANNOUNCEMENT_BODY) return null;
  const list = value.versions ?? [];
  if (!Array.isArray(list) || list.length > MAX_ANNOUNCEMENT_VERSIONS) return null;
  const versions: string[] = [];
  for (const raw of list) {
    const version = releaseVersion(raw);
    if (!version) return null;
    if (!versions.includes(version)) versions.push(version);
  }
  return { ...primary, width: value.width, versions, sections };
}

export function decodePresentation(value: unknown): AppPresentation | null {
  if (typeof value === 'string') {
    if (value.length > MAX_PRESENTATION_BYTES || bytes(value) > MAX_PRESENTATION_BYTES) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.badges) || value.badges.length > MAX_MODEL_BADGE_ROWS) return null;
  const badgeRows = new Map<string, BadgeRow>();
  for (const row of value.badges) {
    if (!isRecord(row)) return null;
    const model = modelIdentity(row.provider, row.modelId);
    const badges = decodeBadges(row.badges);
    if (!model || !badges?.length || badgeRows.has(model.key)) return null;
    badgeRows.set(model.key, { provider: model.provider, modelId: model.modelId, badges });
  }
  let announcement: Announcement | null = null;
  if (value.announcement !== null) {
    const raw = value.announcement;
    const draft = decodeAnnouncementDraft(raw);
    if (!isRecord(raw) || !draft || !isAnnouncementId(raw.id) || typeof raw.publishedAt !== 'string'
      || raw.publishedAt.length > 30 || !Number.isFinite(Date.parse(raw.publishedAt))) return null;
    if (raw.paused !== undefined && typeof raw.paused !== 'boolean') return null;
    announcement = { ...draft, id: raw.id, publishedAt: raw.publishedAt, paused: raw.paused === true };
  }
  const disabledProviders = decodeDisabledProviders(value.disabledProviders);
  if (!disabledProviders) return null;
  const data: AppPresentation = { schema: 1, badges: [...badgeRows.values()], disabledProviders, announcement };
  return bytes(JSON.stringify(data)) <= MAX_PRESENTATION_BYTES ? data : null;
}

export function announcementImageSource(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_ANNOUNCEMENT_IMAGE) return;
  if (!/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) return;
  const data = value.slice(value.indexOf(',') + 1);
  if (data.length % 4 === 0 && (
    (value.startsWith('data:image/png') && data.startsWith('iVBORw0KGgo'))
    || (value.startsWith('data:image/jpeg') && data.startsWith('/9j/'))
    || (value.startsWith('data:image/webp') && data.startsWith('UklGR'))
  )) return value;
}

export function announcementLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048 || CONTROL_CHARS.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Invalid links are rendered as text. */ }
}
