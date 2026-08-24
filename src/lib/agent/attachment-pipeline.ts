import path from 'path';
import { providerModelSupportsVision } from './provider-runtime';

export type RuntimeAttachment = {
  path: string;
  mimeType: string;
  name?: string;
  fileUri?: string;
  data?: string;
  inlineData?: { data?: string; mimeType?: string } | string;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.jsonl', '.csv', '.tsv', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.html', '.htm', '.css', '.scss', '.xml', '.yaml',
  '.yml', '.env', '.log', '.ini', '.cfg', '.sh', '.bat', '.ps1', '.sql', '.rb', '.go', '.rs',
  '.php', '.swift', '.kt', '.r', '.m', '.lua', '.toml', '.conf', '.gitignore', '.dockerignore',
  '.editorconfig', '.prettierrc', '.eslintrc',
]);

export function normalizeAttachmentMime(name: string, suppliedMime?: string): string {
  const clean = String(suppliedMime || '').trim().toLowerCase();
  if (clean && clean !== 'application/octet-stream' && clean !== 'binary/octet-stream') {
    return clean === 'image/jpg' ? 'image/jpeg' : clean;
  }
  return MIME_BY_EXTENSION[path.extname(String(name || '')).toLowerCase()] || clean || 'application/octet-stream';
}

export function isReadableAttachment(file: Pick<RuntimeAttachment, 'name' | 'path' | 'mimeType'>): boolean {
  const name = file.name || file.path || '';
  const ext = path.extname(name).toLowerCase();
  const mime = normalizeAttachmentMime(name, file.mimeType);
  return mime === 'application/pdf'
    || mime.startsWith('text/')
    || ['application/json', 'application/xml'].includes(mime)
    || ['.docx', '.pptx', '.xlsx'].includes(ext)
    || TEXT_EXTENSIONS.has(ext);
}

export function providerAcceptsDirectImage(provider: string, modelName: string): boolean {
  const model = String(modelName || '').toLowerCase();
  if (provider === 'openai') return /\b(gpt-4o|gpt-4\.1|gpt-5|o[134](?:\b|-)|chatgpt)/.test(model);
  if (provider === 'mistral') return /(pixtral|vision|ministral|mistral-(?:small|medium)-3)/.test(model);
  if (provider === 'groq') return /(qwen\/qwen3\.6|qwen.*(?:vl|vision)|llama-4-(?:scout|maverick)|vision)/.test(model);
  if (provider === 'openrouter') {
    return /(gemini|claude|gpt-4o|gpt-4\.1|gpt-5|grok|pixtral|qwen.*(?:3\.6|vl|vision)|llama-4-(?:scout|maverick)|vision)/.test(model);
  }
  return providerModelSupportsVision(provider as any, modelName);
}

/**
 * Video is intentionally narrower than image support. Gemini's native media
 * API accepts video files; OpenRouter can expose video-capable Gemini models
 * through its compatible route. Other providers receive the stable filename
 * context but no unsupported video content part.
 */
export function providerAcceptsDirectVideo(provider: string, modelName: string): boolean {
  const model = String(modelName || '').toLowerCase();
  if (provider === 'gemini') return true;
  if (provider === 'openrouter') return /gemini|video|veo/.test(model);
  return false;
}

export type ProviderAttachmentKind = 'image' | 'pdf' | 'audio' | 'video' | 'document';

export function classifyProviderAttachment(name: string, mimeType?: string): ProviderAttachmentKind {
  const mime = normalizeAttachmentMime(name, mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export function providerAcceptsNativeAttachment(
  provider: string,
  modelName: string,
  name: string,
  mimeType?: string,
  advertisedCapabilities: string[] = [],
): boolean {
  const kind = classifyProviderAttachment(name, mimeType);
  const capabilities = advertisedCapabilities.map(value => String(value || '').toLowerCase());
  const advertised = (pattern: RegExp) => capabilities.some(value => pattern.test(value));
  if (kind === 'image' && advertised(/(?:^|[_.:-])(?:image|vision)(?:$|[_.:-])/)) return true;
  if (provider === 'gemini') return true;
  if (provider === 'anthropic') return kind === 'image' || kind === 'pdf' || kind === 'document';
  if (provider === 'openai') return kind === 'image' || kind === 'pdf' || kind === 'document';
  if (provider === 'openrouter') {
    return kind === 'pdf'
      || (kind === 'image' && providerAcceptsDirectImage(provider, modelName))
      || (kind === 'video' && providerAcceptsDirectVideo(provider, modelName));
  }
  return kind === 'image' && providerAcceptsDirectImage(provider, modelName);
}

export function assertProviderAttachmentsSupported(
  provider: string,
  modelName: string,
  files: Array<Pick<RuntimeAttachment, 'name' | 'path' | 'mimeType'>>,
  advertisedCapabilities: string[] = [],
): void {
  const unsupported = files.filter(file => !providerAcceptsNativeAttachment(
    provider,
    modelName,
    file.name || file.path,
    file.mimeType,
    advertisedCapabilities,
  ));
  if (unsupported.length === 0) return;
  const names = unsupported.map(file => file.name || path.basename(file.path || 'attachment')).join(', ');
  throw new Error(
    `ATTACHMENT_UNSUPPORTED: ${provider}/${modelName} has no verified native input transport for: ${names}. Select a compatible model/provider.`,
  );
}
