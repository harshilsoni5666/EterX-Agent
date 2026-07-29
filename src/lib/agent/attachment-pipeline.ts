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
