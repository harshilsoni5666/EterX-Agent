import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import * as dns from 'dns';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

dns.setDefaultResultOrder?.('ipv4first');

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const { agentRegistry } = require('./src/lib/agent/agent-registry');
const { cancelAgent } = require('./src/lib/agent/roles/sub_agent');
const { apiKeyPool } = require('./src/lib/agent/api-key-pool');

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken || botToken === 'YOUR_ACTUAL_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('Error: set TELEGRAM_BOT_TOKEN in .env.local before starting the bot.');
  process.exit(1);
}

const bot = new Telegraf(botToken, {
  handlerTimeout: 24 * 60 * 60 * 1000,
});

const MAX_TELEGRAM_TEXT = 3900;
const POLL_INTERVAL_MS = 250;
const STATUS_EDIT_INTERVAL_MS = 1000;
const TYPING_INTERVAL_MS = 4000;
const STATUS_SHIMMER_FRAMES = ['', '.', '..', '...'];
const MAX_DOWNLOAD_BYTES = 45 * 1024 * 1024;
const MAX_SENDABLE_ARTIFACT_BYTES = 45 * 1024 * 1024;
const TELEGRAM_MEMORY_MAX_TURNS = 30;
const TELEGRAM_MEMORY_PROMPT_TURNS = 12;
const TELEGRAM_MEMORY_MAX_TEXT = 9000;
const ALLOWED_UPDATES = ['message'] as const;
const DROP_PENDING_UPDATES = process.env.TELEGRAM_DROP_PENDING_UPDATES !== 'false';

const DELIVERABLE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
  '.html', '.md', '.txt', '.zip', '.mp3', '.wav', '.mp4',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.sass',
  '.py', '.json', '.yml', '.yaml', '.toml', '.xml', '.sql', '.env',
  '.go', '.rs', '.java', '.kt', '.swift', '.php', '.rb', '.c', '.cpp', '.h',
  '.cs', '.vue', '.svelte'
]);
const OFFICE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']);
const PRIMARY_DOCUMENT_EXTENSIONS = new Set([...OFFICE_DOCUMENT_EXTENSIONS, '.csv']);
const LOW_VALUE_ARTIFACT_EXTENSIONS = new Set(['.txt', '.md', '.json']);
const RICH_DELIVERABLE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.html',
  '.zip', '.mp3', '.wav', '.mp4'
]);
const HELPER_ARTIFACT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.yml', '.yaml', '.toml', '.xml', '.sql'
]);
const INTERNAL_ARTIFACT_NAME_PATTERNS = [
  /^\.?agent_task_tracker\.(md|json)$/i,
  /^research_\d+\.md$/i,
  /^result_\d+\.txt$/i,
  /^chunk_log\d*\.txt$/i,
  /^(create|generate|build|render|convert|compile|process|temp|tmp)[_-].*\.(py|js|ts|mjs|cjs)$/i,
  /^.*\.(png|jpg|jpeg|webp|gif|svg)\.(py|js|ts|mjs|cjs)$/i,
];
const ARTIFACT_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\n\r"'`<>|]+|(?:\.{1,2}[\\/])?[^\n\r"'`<>|]+)\.(pdf|docx|doc|xlsx|xls|pptx|ppt|csv|png|jpg|jpeg|webp|gif|svg|html|zip|mp3|wav|mp4)\b/ig;
const ARTIFACT_PATH_KEYS = new Set([
  'path', 'filepath', 'filePath', 'outputPath', 'savedPath',
  'imagePath', 'scriptPath', 'documentPath', 'spreadsheetPath',
  'presentationPath', 'htmlPath', 'zipPath', 'artifactPath',
  'savedTo', 'exportPath', 'downloadPath', 'resultPath',
  'documentFile', 'spreadsheetFile', 'presentationFile',
]);
const ARTIFACT_CONTAINER_KEYS = [
  'files', 'file', 'artifacts', 'artifact', 'artifactPaths', 'artifactsGenerated',
  'result', 'results', 'output', 'outputs', 'data', 'documents', 'spreadsheets',
  'presentations', 'downloads', 'exports', 'savedFiles', 'generatedFiles',
];

type TelegramAttachment = {
  name: string;
  path: string;
  mimeType: string;
};

type TelegramParsedMessage = {
  prompt: string;
  attachments: TelegramAttachment[];
};

type TelegramMemoryTurn = {
  timestamp: number;
  user: string;
  assistant: string;
  files: string[];
};

type TelegramChatMemory = {
  chatId: string;
  updatedAt: number;
  turns: TelegramMemoryTurn[];
};

type RunningTelegramTask = {
  telegramChatId: number;
  agentChatId: string;
  messageId: number;
  startedAt: number;
  title: string;
  lastStatus: string;
  stopRequested?: boolean;
};

const runningTasks = new Map<string, RunningTelegramTask>();

function telegramTaskKeyFor(telegramChatId: number | string) {
  return `telegram-${telegramChatId}`;
}

function agentExecutionIdFor(telegramChatId: number | string, messageId: number | string) {
  return `${telegramTaskKeyFor(telegramChatId)}-${messageId}-${Date.now()}`;
}

function safeName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 140) || `telegram_${Date.now()}`;
}

function plainText(value: unknown) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function truncate(value: unknown, max = 90) {
  const clean = plainText(value).replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInlineMarkdown(line: string) {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>');
}

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isMarkdownTableStart(lines: string[], index: number) {
  return Boolean(lines[index]?.includes('|') && lines[index + 1] && isMarkdownTableSeparator(lines[index + 1]));
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function consumeMarkdownTable(lines: string[], startIndex: number) {
  const rows: string[][] = [];
  let index = startIndex;

  while (index < lines.length && lines[index].includes('|')) {
    if (!isMarkdownTableSeparator(lines[index])) {
      rows.push(splitMarkdownTableRow(lines[index]));
    }
    index++;
  }

  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, col) =>
    Math.min(32, Math.max(3, ...rows.map((row) => String(row[col] || '').length)))
  );

  const rendered = rows.map((row) =>
    row.map((cell, col) => String(cell || '').padEnd(widths[col], ' ')).join('  ')
  ).join('\n');

  return {
    html: `<pre>${escapeHtml(rendered)}</pre>`,
    nextIndex: index,
  };
}

function renderTelegramHtml(text: string) {
  const lines = plainText(text).split('\n');
  const rendered: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        rendered.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const table = consumeMarkdownTable(lines, index);
      rendered.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      rendered.push(`<b>${renderInlineMarkdown(heading[1])}</b>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index++;
      }
      index--;
      rendered.push(`<blockquote>${escapeHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      rendered.push(`${escapeHtml(bullet[1])}&#8226; ${renderInlineMarkdown(bullet[2])}`);
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      rendered.push(`${escapeHtml(numbered[1])}${numbered[2]}. ${renderInlineMarkdown(numbered[3])}`);
      continue;
    }

    rendered.push(renderInlineMarkdown(line));
  }

  if (inCodeBlock && codeBuffer.length > 0) {
    rendered.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }

  return rendered.join('\n');
}

function splitTextForTelegram(text: string, maxLength = 3200) {
  const clean = normalizeTelegramAnswerText(text) || '(empty response)';
  const chunks: string[] = [];
  let current = '';

  for (const part of clean.split(/\n{2,}/)) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    if (part.length <= maxLength) {
      current = part;
      continue;
    }

    for (let i = 0; i < part.length; i += maxLength) {
      chunks.push(part.slice(i, i + maxLength));
    }
    current = '';
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : ['(empty response)'];
}

function normalizeTelegramAnswerText(text: string) {
  return plainText(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

function messageKind(msg: any) {
  if (!msg) return 'unknown';
  if (msg.text) return msg.text.startsWith('/') ? 'command' : 'text';
  if (msg.document) return 'document';
  if (msg.photo?.length) return 'photo';
  if (msg.video) return 'video';
  if (msg.audio) return 'audio';
  if (msg.voice) return 'voice';
  if (msg.animation) return 'animation';
  return 'message';
}

function telegramTaskTitle(prompt: string, attachments: TelegramAttachment[]) {
  const text = truncate(prompt, 78);
  if (text) return text;

  if (attachments.length === 1) {
    return `Attachment: ${attachments[0].name}`;
  }

  if (attachments.length > 1) {
    return `${attachments.length} attachments`;
  }

  return 'Telegram request';
}

function log(message: string, meta?: Record<string, unknown>) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[TelegramBot] ${message}${suffix}`);
}

async function sendTyping(ctx: any) {
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      log(`${label} failed`, { attempt, attempts, error: error.message || String(error) });
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

async function sendLongText(ctx: any, text: string) {
  for (const chunk of splitTextForTelegram(text, MAX_TELEGRAM_TEXT - 500)) {
    const replyOptions = {
      parse_mode: 'HTML' as const,
    };

    try {
      await ctx.reply(renderTelegramHtml(chunk), replyOptions);
    } catch (error: any) {
      log('html render fallback', { error: error.message || String(error) });
      await ctx.reply(chunk);
    }
  }
}

function telegramMemoryDir() {
  return path.resolve(process.cwd(), '.workspaces', '.telegram-memory');
}

function telegramMemoryPath(chatId: number | string) {
  return path.join(telegramMemoryDir(), `${String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

async function loadTelegramMemory(chatId: number | string): Promise<TelegramChatMemory> {
  const memoryPath = telegramMemoryPath(chatId);
  try {
    const raw = await fsp.readFile(memoryPath, 'utf8');
    const parsed = JSON.parse(raw);
    const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
    return {
      chatId: String(chatId),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
      turns: turns
        .filter((turn: any) => turn && typeof turn.user === 'string' && typeof turn.assistant === 'string')
        .map((turn: any) => ({
          timestamp: Number(turn.timestamp) || Date.now(),
          user: truncate(turn.user, 900),
          assistant: truncate(turn.assistant, 1200),
          files: Array.isArray(turn.files) ? turn.files.map((file: unknown) => truncate(file, 220)).slice(0, 12) : [],
        }))
        .slice(-TELEGRAM_MEMORY_MAX_TURNS),
    };
  } catch {
    return { chatId: String(chatId), updatedAt: Date.now(), turns: [] };
  }
}

async function saveTelegramMemory(memory: TelegramChatMemory) {
  await fsp.mkdir(telegramMemoryDir(), { recursive: true });
  const cleanMemory: TelegramChatMemory = {
    chatId: memory.chatId,
    updatedAt: Date.now(),
    turns: memory.turns.slice(-TELEGRAM_MEMORY_MAX_TURNS),
  };
  await fsp.writeFile(telegramMemoryPath(memory.chatId), JSON.stringify(cleanMemory, null, 2), 'utf8');
}

function shouldUseTelegramMemory(prompt: string, quickAnswer: boolean) {
  const text = plainText(prompt);
  if (!text) return false;
  if (!quickAnswer) return true;
  return /\b(continue|more|again|same|that|those|previous|last|earlier|it|this|work more|add more|fix it|update it|improve it|where was|what did)\b/i.test(text);
}

function shouldPersistTelegramMemory(prompt: string, answer: string, files: string[]) {
  const userText = plainText(prompt);
  const answerText = sanitizeFinalAnswer(answer);
  if (!userText || !answerText) return false;
  if (files.length > 0) return true;
  if (/\b(create|make|build|write|generate|download|send|share|convert|analyze|research|code|file|pdf|docx|xlsx|pptx|continue|previous|last|same)\b/i.test(userText)) return true;
  if (userText.split(/\s+/).filter(Boolean).length <= 3 && answerText.length < 180) return false;
  return true;
}

function buildTelegramMemoryBlock(memory: TelegramChatMemory, includeMemory: boolean) {
  if (!includeMemory || memory.turns.length === 0) return '';

  const lines: string[] = [
    '[TELEGRAM CHAT MEMORY]',
    `Scope: only this Telegram chat id ${memory.chatId}. Use it only when it helps answer the current message.`,
  ];

  for (const turn of memory.turns.slice(-TELEGRAM_MEMORY_PROMPT_TURNS)) {
    const when = new Date(turn.timestamp).toISOString();
    lines.push(`- ${when}`);
    lines.push(`  User: ${truncate(turn.user, 420)}`);
    lines.push(`  Assistant: ${truncate(turn.assistant, 520)}`);
    if (turn.files.length) {
      lines.push(`  Files: ${turn.files.map((file) => path.basename(file)).join(', ')}`);
    }
  }

  const block = lines.join('\n');
  return block.length > TELEGRAM_MEMORY_MAX_TEXT
    ? `${block.slice(0, TELEGRAM_MEMORY_MAX_TEXT)}\n[END TRUNCATED TELEGRAM CHAT MEMORY]`
    : block;
}

function shouldUseQuickAnswer(prompt: string, attachments: TelegramAttachment[]) {
  if (attachments.length > 0) return false;

  const text = plainText(prompt);
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  if (shouldUseTelegramMemory(text, true)) return false;

  if (words.length <= 6 && !/\b(create|make|build|write|generate|download|send|share|convert|analyze|research|code|file|pdf|docx|xlsx|pptx)\b/i.test(lower)) return true;
  if (words.length <= 18 && /^(what|who|when|where|why|how|define|explain)\b/i.test(lower)) return true;
  if (words.length <= 30 && /\b(latest|current|today|news|price|weather|score|schedule|meaning|ein)\b/i.test(lower)) return true;

  return false;
}

function buildTelegramPrompt(ctx: any, parsed: TelegramParsedMessage, userName: string, quickAnswer: boolean, memoryBlock = '') {
  const baseRules = [
    '[TELEGRAM MAIN AGENT CONTRACT]',
    'You are the single main EterX agent responding through Telegram.',
    'Use this Telegram message, its attachments, this Telegram chat session memory, and tool results from this run.',
    'Memory scope: only use memory from this exact Telegram chat id. Never use memory from another Telegram chat, browser/UI chat, global learned preferences, old project state, or unrelated prior runs.',
    'For short casual messages, answer the current message only unless the same Telegram chat memory is directly relevant.',
    'Never claim you worked in the background, initialized a project, or continued a project unless that happened in this run.',
    'If the user only greets you or sends a short casual message, answer that message only. Do not mention projects, files, background work, or previous state.',
    'Do not spawn sub-agents or parallel workers unless the user explicitly asks for agents, delegation, or parallel work.',
    'Do not read task trackers, old task stores, browser session summaries, background queues, or planning files unless this exact Telegram message asks for those files.',
    'Do not mention internal planning, trace collection, task tracker state, tool names, or bridge mechanics in the final answer.',
    'Use the workspace, files, folders, and target paths the user actually names. If no path is named, use the project/app defaults instead of inventing an unrelated default folder.',
      'Telegram presentation: keep replies short, direct, polished, and point-to-point. Answer only what the user asked. Use bullets only when they genuinely improve clarity.',
      'Do not introduce yourself, list capabilities, or use marketing language unless the user explicitly asks for a capability overview.',
    'Do not dump raw transcripts, logs, base64, temporary scripts, generated helper markdown, or internal tool output into chat.',
    'Final deliverable rule: send or mention the real final product only. Drafts, conversion scripts, scratch markdown, chart scripts, and result transcripts are internal unless the user explicitly asks for them.',
    'Completion rule: once the exact requested result is ready, stop. Do not keep researching, polishing, preparing extra documents, making alternate formats, or doing follow-up work unless the user explicitly asked for it.',
    'Keep internal working files inside .workspaces or another private scratch folder. Put final user-facing deliverables in a clear output location with final names, and only expose those final files.',
    'When asked for a document/report, prefer a real .docx or .pdf. When asked for a spreadsheet, prefer .xlsx. When asked for slides, prefer .pptx. When asked for charts/images, send the image. When asked for code/project work, return the actual source files or a zip when there are many.',
    'If multiple final products are genuinely required, include every final file, not just the first one. Mention only those final file names. Do not say that any bridge, bot, or system will upload/attach files later.',
    'Telegram file delivery is agent-selected: when you create final user-facing files, append one private machine-readable line at the very end exactly as <ETERX_TELEGRAM_FILES>["absolute/or/relative/path.ext"]</ETERX_TELEGRAM_FILES>. Include only final deliverables the user should receive. Exclude helper scripts, scratch research, transcripts, task trackers, logs, temporary files, and intermediate conversion files. If no file should be sent, omit this line.',
    'Browser/computer-use requests: use browser_control directly. After browser_control returns recovery/nextAction, follow that nextAction instead of repeating the same failed click/type.',
    'Irreversible web-action safety: you may search, compare, fill harmless details, and prepare the final page, but never confirm a paid transaction, booking, order, legal submission, account deletion, irreversible reservation, or sensitive change without explicit final confirmation from the user in this Telegram chat.',
    'Never claim a browser task is completed, submitted, paid, booked, ordered, or changed unless the page actually confirmed it. If required details are missing, continue with useful safe progress when possible, then ask only for the exact missing detail.',
  ];

  const scopeRules = quickAnswer
    ? [
      '[TELEGRAM DIRECT ANSWER]',
      'Answer only the current Telegram message.',
      'Do not inspect, mention, edit, or continue any local project/workspace unless this exact message asks for project/workspace work.',
      'For latest/current/today/news/price/weather/schedule questions, use Tavily web grounding before answering and state the concrete date when useful.',
      'Your name is EterX. Answer identity questions naturally.',
      'Keep the response concise, factual, professional, and AI-generated from the current request.',
      'Do not add extra explanation, suggestions, or continuation text unless the user asked for it.',
    ]
    : [
      '[TELEGRAM WORK REQUEST]',
      'Serve only the current Telegram request. Never continue an old portfolio/project task unless this exact message asks you to continue it.',
      'Perform code, file, terminal, or workspace actions only when the current message explicitly asks for that work.',
      'If asked to create a real document, spreadsheet, presentation, image, report, or other file, create the requested real file on disk. Do not create or send helper transcripts unless the user requested them.',
      'Use private scratch files for research/planning/scripts, then produce one clean final deliverable outside the scratch area when the task needs a file.',
      'Prefer the main requested deliverable over extra files. If multiple files are genuinely useful, make the final answer state exactly which files were produced.',
      'If the task was to send, share, download, upload, convert, or create one file, stop after that exact file is ready. Do not start research or create a new document/report unless the user explicitly asked for that too.',
      'For latest/current/today/news/price/weather/schedule questions, use web_search before answering and state the concrete date.',
      'Return a concise final answer with generated file names when files were created.',
      'Keep the final answer short and limited to the requested outcome.',
    ];

  return [
    ...baseRules,
    '',
    ...scopeRules,
    '',
    `Telegram chat id: ${ctx.chat.id}`,
    `Telegram chat type: ${ctx.chat.type || 'unknown'}`,
    `Telegram user: ${userName}`,
    memoryBlock ? `\n${memoryBlock}` : '',
    '',
    '[USER MESSAGE]',
    parsed.prompt,
  ].join('\n');
}

function buildTelegramRunContext(ctx: any, parsed: TelegramParsedMessage, quickAnswer: boolean) {
  return {
    source: 'telegram',
    forceFastMode: true,
    disableMemoryHydration: true,
    disableLongTermMemory: true,
    disableSessionPersistence: true,
    disableSkillAutoLoad: true,
    disableOverdelivery: true,
    persistSession: false,
    exportTranscript: false,
    disableSubAgents: true,
    disableSharedCache: true,
    disableWorkspaceContext: true,
    disablePlannerTools: true,
    disableVisualMemory: true,
    disableTaskStore: true,
    disableWorkspaceInit: true,
    telegram: {
      chatId: String(ctx.chat.id),
      messageId: ctx.message?.message_id,
      quickAnswer,
      attachmentNames: parsed.attachments.map((attachment) => attachment.name),
    },
  };
}

async function downloadFile(ctx: any, fileId: string, fallbackName: string, mimeType: string): Promise<TelegramAttachment | null> {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.toString());

  if (!res.ok) {
    throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  }

  const sizeHeader = Number(res.headers.get('content-length') || '0');
  if (sizeHeader > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File is too large for the bot bridge (${Math.round(sizeHeader / 1024 / 1024)}MB).`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File is too large for the bot bridge (${Math.round(buffer.byteLength / 1024 / 1024)}MB).`);
  }

  const dir = path.resolve(process.cwd(), '.workspaces', 'temp', 'telegram');
  await fsp.mkdir(dir, { recursive: true });

  const finalName = safeName(fallbackName);
  const filePath = path.join(dir, `${Date.now()}_${finalName}`);
  await fsp.writeFile(filePath, buffer);

  return { name: finalName, path: filePath, mimeType };
}

async function extractMessage(ctx: any): Promise<TelegramParsedMessage> {
  const msg = ctx.message as any;
  const attachments: TelegramAttachment[] = [];
  const prompt = plainText(msg.text || msg.caption || '');

  if (msg.document) {
    attachments.push((await downloadFile(
      ctx,
      msg.document.file_id,
      msg.document.file_name || `document_${msg.message_id}`,
      msg.document.mime_type || 'application/octet-stream'
    ))!);
  }

  if (msg.photo?.length) {
    const photo = msg.photo[msg.photo.length - 1];
    attachments.push((await downloadFile(
      ctx,
      photo.file_id,
      `photo_${msg.message_id}.jpg`,
      'image/jpeg'
    ))!);
  }

  if (msg.video) {
    attachments.push((await downloadFile(
      ctx,
      msg.video.file_id,
      msg.video.file_name || `video_${msg.message_id}.mp4`,
      msg.video.mime_type || 'video/mp4'
    ))!);
  }

  if (msg.audio) {
    attachments.push((await downloadFile(
      ctx,
      msg.audio.file_id,
      msg.audio.file_name || `audio_${msg.message_id}.mp3`,
      msg.audio.mime_type || 'audio/mpeg'
    ))!);
  }

  if (msg.voice) {
    attachments.push((await downloadFile(
      ctx,
      msg.voice.file_id,
      `voice_${msg.message_id}.ogg`,
      msg.voice.mime_type || 'audio/ogg'
    ))!);
  }

  if (msg.animation) {
    attachments.push((await downloadFile(
      ctx,
      msg.animation.file_id,
      msg.animation.file_name || `animation_${msg.message_id}.mp4`,
      msg.animation.mime_type || 'video/mp4'
    ))!);
  }

  return {
    prompt: prompt || (attachments.length ? 'Analyze the attached file and respond clearly.' : ''),
    attachments,
  };
}

function buildStatusMessage(_taskTitle: string, _status: string, frame = 0) {
  const suffix = STATUS_SHIMMER_FRAMES[frame % STATUS_SHIMMER_FRAMES.length];
  return `<b>${escapeHtml(`Thinking${suffix}`)}</b>`;
}

function buildPublicTaskStatus(task: RunningTelegramTask, resultStatus?: string) {
  return [
    `Status: ${resultStatus || 'running'}`,
    `Task: ${truncate(task.title, 82)}`,
    `Current: ${task.lastStatus || 'Thinking'}`,
    `Elapsed: ${formatDuration(Date.now() - task.startedAt)}`,
  ].join('\n');
}

function statusTextFromTrace(trace: any, task: RunningTelegramTask) {
  if (!trace) return null;
  task.lastStatus = 'Thinking';
  return null;
}

async function sendOrEditStatusMessage(
  ctx: any,
  statusMessageId: number | null,
  text: string
) {
  if (statusMessageId == null) {
    return ctx.reply(text, { parse_mode: 'HTML' as const });
  }

  return ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMessageId,
    undefined,
    text,
    { parse_mode: 'HTML' as const }
  );
}

function normalizeArtifactPath(candidate: unknown) {
  if (typeof candidate !== 'string') return null;
  const clean = candidate.trim();
  if (!clean || /^[a-z]+:\/\//i.test(clean)) return null;
  return path.isAbsolute(clean) ? clean : path.resolve(process.cwd(), clean);
}

function addArtifactCandidate(paths: Set<string>, candidate: unknown, depth = 0) {
  if (depth > 7 || candidate == null) return;

  if (Array.isArray(candidate)) {
    candidate.forEach((item) => addArtifactCandidate(paths, item, depth + 1));
    return;
  }

  if (candidate && typeof candidate === 'object') {
    const objectValue = candidate as Record<string, unknown>;
    for (const key of ARTIFACT_PATH_KEYS) {
      addArtifactCandidate(paths, objectValue[key], depth + 1);
    }

    for (const key of ARTIFACT_CONTAINER_KEYS) {
      addArtifactCandidate(paths, objectValue[key], depth + 1);
    }

    for (const [key, value] of Object.entries(objectValue)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.includes('path') ||
        normalizedKey.includes('file') ||
        normalizedKey.includes('artifact') ||
        normalizedKey.includes('saved') ||
        normalizedKey.includes('output') ||
        normalizedKey.includes('result') ||
        normalizedKey.includes('document') ||
        normalizedKey.includes('spreadsheet') ||
        normalizedKey.includes('presentation') ||
        normalizedKey.includes('export') ||
        normalizedKey.includes('download')
      ) {
        addArtifactCandidate(paths, value, depth + 1);
      }
    }
    return;
  }

  if (typeof candidate === 'string') {
    ARTIFACT_PATH_PATTERN.lastIndex = 0;
    const matches = candidate.match(ARTIFACT_PATH_PATTERN);
    if (matches?.length) {
      for (const match of matches) {
        const normalized = normalizeArtifactPath(match);
        if (normalized) paths.add(normalized);
      }
    }
  }

  const normalized = normalizeArtifactPath(candidate);
  if (normalized) paths.add(normalized);
}

function isLikelyDeliverable(filePath: string) {
  const baseName = path.basename(filePath).toLowerCase();
  const ext = path.extname(baseName).toLowerCase();

  if (!DELIVERABLE_EXTENSIONS.has(ext)) return false;
  if (INTERNAL_ARTIFACT_NAME_PATTERNS.some((pattern) => pattern.test(baseName))) return false;
  if (/^result_\d+\.txt$/.test(baseName)) return false;
  if (baseName.endsWith('_visual_memory.json')) return false;
  if (filePath.includes(`${path.sep}.workspaces${path.sep}temp${path.sep}telegram${path.sep}`)) return false;

  return true;
}

function isSafeAgentSelectedFile(filePath: string) {
  const baseName = path.basename(filePath).toLowerCase();
  if (INTERNAL_ARTIFACT_NAME_PATTERNS.some((pattern) => pattern.test(baseName))) return false;
  if (baseName.endsWith('_visual_memory.json')) return false;
  if (filePath.includes(`${path.sep}.workspaces${path.sep}temp${path.sep}telegram${path.sep}`)) return false;
  return true;
}

function artifactSortScore(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const order = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.html', '.md', '.txt', '.zip', '.mp4', '.mp3', '.wav', '.gif', '.svg'];
  const index = order.indexOf(ext);
  return index === -1 ? order.length : index;
}

function collectAgentSelectedArtifactPaths(answer: string) {
  const files = new Set<string>();
  const manifestPattern = /<ETERX_TELEGRAM_FILES>([\s\S]*?)<\/ETERX_TELEGRAM_FILES>/gi;
  let match: RegExpExecArray | null;

  while ((match = manifestPattern.exec(answer))) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      addArtifactCandidate(files, parsed);
    } catch {
      addArtifactCandidate(files, raw);
    }
  }

  return Array.from(files).filter((filePath) => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && isSafeAgentSelectedFile(filePath);
    } catch {
      return false;
    }
  });
}

function collectArtifactPaths(traces: any[]) {
  const candidates = new Set<string>();

  for (const trace of traces) {
    addArtifactCandidate(candidates, trace);
    addArtifactCandidate(candidates, trace?.data?.artifactsGenerated || trace?.artifactsGenerated);
    addArtifactCandidate(candidates, trace?.data?.artifactPaths);
    addArtifactCandidate(candidates, trace?.data?.artifactPath);
    addArtifactCandidate(candidates, trace?.data?.outputPath);
    addArtifactCandidate(candidates, trace?.data?.savedPath);
    addArtifactCandidate(candidates, trace?.data?.filePath || trace?.data?.filepath);
    addArtifactCandidate(candidates, trace?.data?.result?.filePath || trace?.data?.result?.filepath);
    addArtifactCandidate(candidates, trace?.data?.result?.path);

    const previewPath = trace?.filepath || trace?.path;
    addArtifactCandidate(candidates, previewPath);
  }

  let files = Array.from(candidates).filter((filePath) => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && isLikelyDeliverable(filePath);
    } catch {
      return false;
    }
  });

  const hasOfficeDocument = files.some((filePath) => OFFICE_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const hasPrimaryDocument = files.some((filePath) => PRIMARY_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const hasRichDeliverable = files.some((filePath) => RICH_DELIVERABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const hasUserFacingDeliverable = hasRichDeliverable || hasPrimaryDocument;

  if (hasOfficeDocument) {
    files = files.filter((filePath) => OFFICE_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  } else if (hasPrimaryDocument) {
    files = files.filter((filePath) => PRIMARY_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  } else if (hasRichDeliverable) {
    files = files.filter((filePath) => !HELPER_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  } else if (!hasUserFacingDeliverable) {
    files = files.filter((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const base = path.basename(filePath).toLowerCase();
      if (!HELPER_ARTIFACT_EXTENSIONS.has(ext)) return true;
      if (/\b(source|code|script|project|implementation|component|bot|api)\b/i.test(base)) return true;
      return false;
    });
  } else if (files.length > 12) {
    files = files.filter((filePath) => !LOW_VALUE_ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  }

  return files.sort((a, b) => artifactSortScore(a) - artifactSortScore(b) || path.basename(a).localeCompare(path.basename(b)));
}

async function sendArtifacts(ctx: any, files: string[]) {
  const sent = new Set<string>();
  const sentFiles: string[] = [];

  for (const filePath of files) {
    const dedupeKey = path.resolve(filePath).toLowerCase();
    if (sent.has(dedupeKey)) continue;
    sent.add(dedupeKey);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (stat.size <= 0 || stat.size > MAX_SENDABLE_ARTIFACT_BYTES) {
      log('artifact skipped', { file: filePath, size: stat.size });
      continue;
    }

    try {
      await ctx.telegram.sendChatAction(ctx.chat.id, 'upload_document').catch(() => {});
      await ctx.replyWithDocument({
        source: filePath,
        filename: path.basename(filePath),
      });
      sentFiles.push(filePath);
    } catch (error: any) {
      log('artifact send failed', { file: filePath, error: error.message || String(error) });
    }
  }

  return sentFiles;
}

function sentFileLabel(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return `${path.basename(filePath)} (${formatBytes(stat.size)})`;
  } catch {
    return path.basename(filePath);
  }
}

function formatTelegramAnswer(answer: string, sentFiles: string[]) {
  const clean = sanitizeFinalAnswer(answer);
  if (sentFiles.length === 0) return clean;

  const fileList = sentFiles.map((filePath) => `- ${sentFileLabel(filePath)}`).join('\n');
  if (/files?\s+(sent|attached|uploaded):/i.test(clean) || /\bsent files?\b/i.test(clean)) {
    return clean;
  }

  return `${clean}\n\nFiles sent:\n${fileList}`;
}

function sanitizeFinalAnswer(answer: string) {
  const lines = plainText(answer)
    .replace(/<ETERX_TELEGRAM_FILES>[\s\S]*?<\/ETERX_TELEGRAM_FILES>/gi, '')
    .split('\n')
    .filter((line) => !/\btelegram\s+(bridge|bot)\b.*\b(upload|attach|send|share)/i.test(line))
    .filter((line) => !/\bwill\s+(now\s+)?(upload|attach|send|share)\b/i.test(line))
    .filter((line) => !/\b(agent|bridge)\s+(trace|log|task tracker|internal)/i.test(line))
    .filter((line) => !/\bdeep work initiated\b/i.test(line))
    .filter((line) => !/\blet me know if you need\b/i.test(line))
    .filter((line) => !/\bneed any further\b/i.test(line));

  return normalizeTelegramAnswerText(lines.join('\n')) || 'Done.';
}

async function waitForAgent(ctx: any, agentChatId: string, statusMessageId: number | null, task: RunningTelegramTask) {
  let cursor = -1;
  let lastStatusEdit = 0;
  let allTraces: any[] = [];
  let activeStatusText = statusMessageId == null ? '' : 'Thinking';
  let lastRenderedStatusText = '';
  let shimmerFrame = 0;
  let liveStatusMessageId: number | null = statusMessageId;
  let sawRunning = false;
  let lastTraceAt = Date.now();

  while (true) {
    const result = agentRegistry.getTraces(agentChatId, cursor);
    const now = Date.now();
    if (result.status === 'running') sawRunning = true;

    if (result.traces?.length) {
      allTraces = allTraces.concat(result.traces);
      cursor = result.maxIndex ?? cursor;
      lastTraceAt = now;

      for (const trace of result.traces) statusTextFromTrace(trace, task);
    }

    if (result.status === 'running' && now - lastTraceAt > 8000) {
      activeStatusText = 'Thinking';
      task.lastStatus = activeStatusText;
    }

    if (activeStatusText && now - lastStatusEdit >= STATUS_EDIT_INTERVAL_MS) {
      const renderedStatus = buildStatusMessage(task.title, activeStatusText, shimmerFrame++);
      if (renderedStatus !== lastRenderedStatusText) {
        lastStatusEdit = now;
        lastRenderedStatusText = renderedStatus;
        const sent = await sendOrEditStatusMessage(ctx, liveStatusMessageId, renderedStatus).catch(() => null);
        if (liveStatusMessageId == null && sent?.message_id) {
          liveStatusMessageId = sent.message_id;
        }
      }
    }

    if (result.status === 'idle' && sawRunning) {
      return {
        result: {
          ...result,
          status: 'failed',
          error: 'Agent state was lost before completion. Please retry the request.',
          finalAnswer: 'Agent state was lost before completion. Please retry the request.',
        },
        traces: allTraces,
        statusMessageId: liveStatusMessageId,
      };
    }

    if (result.status !== 'running' && result.status !== 'idle') {
      // Give AgentRegistry one extra tick to append terminal "done" traces and artifact paths.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const finalSweep = agentRegistry.getTraces(agentChatId, cursor);
      if (finalSweep.traces?.length) {
        allTraces = allTraces.concat(finalSweep.traces);
      }
      return { result: finalSweep.status === 'idle' ? result : finalSweep, traces: allTraces, statusMessageId: liveStatusMessageId };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function keepTypingWhileRunning(ctx: any, task: RunningTelegramTask) {
  const taskKey = telegramTaskKeyFor(task.telegramChatId);
  while (runningTasks.get(taskKey)?.agentChatId === task.agentChatId) {
    await sendTyping(ctx);
    await new Promise((resolve) => setTimeout(resolve, TYPING_INTERVAL_MS));
  }
}

bot.start(async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
});

bot.command('help', async (ctx) => {
  await ctx.reply([
    'EterX commands',
    '',
    '/status - current task',
    '/stop - stop task',
    '/help - commands',
    '',
    'Send a message or attach a file with a short instruction.',
  ].join('\n'));
});

bot.command('ping', async (ctx) => {
  await ctx.reply(`pong ${new Date().toLocaleTimeString()}`);
});

bot.command('status', (ctx) => {
  const taskKey = telegramTaskKeyFor(ctx.chat.id);
  const running = runningTasks.get(taskKey);
  const agentChatId = running?.agentChatId;
  if (!agentChatId) {
    ctx.reply('Status: idle\nRunning: no');
    return;
  }
  const result = agentRegistry.getTraces(agentChatId, -1);
  ctx.reply(buildPublicTaskStatus(running, result.status));
});

bot.command('stop', async (ctx) => {
  const taskKey = telegramTaskKeyFor(ctx.chat.id);
  const running = runningTasks.get(taskKey);
  if (!running) {
    await ctx.reply('No running EterX task for this chat.');
    return;
  }

  running.stopRequested = true;
  const stopped = agentRegistry.stopAgent(running.agentChatId);
  cancelAgent(running.agentChatId);
  runningTasks.delete(taskKey);
  await ctx.reply(stopped ? 'Stopped current EterX task.' : 'No running EterX task for this chat.');
});

bot.on(['text', 'document', 'photo', 'video', 'audio', 'voice', 'animation'], async (ctx: any) => {
  const msg = ctx.message as any;
  if (msg?.text?.startsWith('/')) return;

  const taskKey = telegramTaskKeyFor(ctx.chat.id);

  log('inbound message', {
    chatId: ctx.chat.id,
    chatType: ctx.chat.type,
    user: ctx.from?.username || ctx.from?.first_name || 'unknown',
    kind: messageKind(msg),
    text: truncate(msg?.text || msg?.caption || msg?.document?.file_name || msg?.video?.file_name || msg?.audio?.file_name),
  });

  if (runningTasks.has(taskKey)) {
    await ctx.reply('One task is already running for this Telegram chat. Send /stop to cancel it, or wait for it to finish.');
    return;
  }

  let parsed: TelegramParsedMessage;
  try {
    parsed = await extractMessage(ctx);
  } catch (error: any) {
    await ctx.reply(`Could not read the Telegram attachment: ${error.message}`);
    return;
  }

  if (!parsed.prompt && parsed.attachments.length === 0) {
    await ctx.reply('Send a text request, image, document, audio, or video.');
    return;
  }

  const quickAnswer = shouldUseQuickAnswer(parsed.prompt, parsed.attachments);
  const statusMessagePromise = quickAnswer
    ? Promise.resolve(null)
    : sendOrEditStatusMessage(ctx, null, buildStatusMessage('', 'Thinking')).catch(() => null);
  if (!quickAnswer) void sendTyping(ctx);

  const taskTitle = telegramTaskTitle(parsed.prompt, parsed.attachments);
  const task: RunningTelegramTask = {
    telegramChatId: ctx.chat.id,
    agentChatId: agentExecutionIdFor(ctx.chat.id, msg.message_id),
    messageId: msg.message_id,
    startedAt: Date.now(),
    title: taskTitle,
    lastStatus: 'Thinking',
  };

  runningTasks.set(taskKey, task);
  log('agent task queued', {
    chatId: ctx.chat.id,
    agentChatId: task.agentChatId,
    title: truncate(task.title, 60),
  });

  if (!quickAnswer) void keepTypingWhileRunning(ctx, task).catch(() => {});
  void runAgentTask(ctx, parsed, task, quickAnswer, statusMessagePromise).catch((error: any) => {
    runningTasks.delete(taskKey);
    console.error('[TelegramBot] Background task error:', error);
  });
});

async function runAgentTask(ctx: any, parsed: TelegramParsedMessage, task: RunningTelegramTask, quickAnswer: boolean, statusMessagePromise?: Promise<any | null>) {
  const taskKey = telegramTaskKeyFor(task.telegramChatId);
  const userId = `telegram-user-${ctx.from?.id || 'unknown'}`;
  const userName = ctx.from?.username || ctx.from?.first_name || 'Telegram user';
  const history: any[] = [];

  try {
    const includeMemory = shouldUseTelegramMemory(parsed.prompt, quickAnswer);
    let telegramMemory = includeMemory
      ? await loadTelegramMemory(ctx.chat.id)
      : { chatId: String(ctx.chat.id), updatedAt: Date.now(), turns: [] };
    const memoryBlock = buildTelegramMemoryBlock(telegramMemory, includeMemory);
    const telegramPrompt = buildTelegramPrompt(ctx, parsed, userName, quickAnswer, memoryBlock);
    const telegramRunContext = buildTelegramRunContext(ctx, parsed, quickAnswer);
    const agentMode = 'fast';

    const start = agentRegistry.startAgent(
      task.agentChatId,
      telegramPrompt,
      history,
      agentMode,
      userId,
      telegramRunContext,
      parsed.attachments,
      userName
    );

    log('agent start requested', {
      chatId: ctx.chat.id,
      agentChatId: task.agentChatId,
      status: start.status,
      mode: agentMode,
      attachments: parsed.attachments.length,
      promptChars: parsed.prompt.length,
    });

    if (start.status === 'no_keys') {
      const statusMessage = await statusMessagePromise;
      if (statusMessage?.message_id) await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
      await ctx.reply('All agent API keys are busy. Try again in a moment.');
      return;
    }

    if (start.status === 'already_running') {
      const statusMessage = await statusMessagePromise;
      if (statusMessage?.message_id) await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
      await ctx.reply('This Telegram chat already has a running agent.');
      return;
    }

    const statusMessage = await statusMessagePromise;
    const { result, traces, statusMessageId } = await waitForAgent(ctx, task.agentChatId, statusMessage?.message_id ?? null, task);
    if (statusMessageId != null) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMessageId).catch(() => {});
    }

    log('agent finished', {
      chatId: ctx.chat.id,
      agentChatId: task.agentChatId,
      status: result.status,
      traces: traces.length,
      finalAnswerChars: plainText(result.finalAnswer).length,
    });

    if (result.status === 'completed') {
      const agentSelectedPaths = collectAgentSelectedArtifactPaths(result.finalAnswer || '');
      const artifactPaths = agentSelectedPaths.length
        ? agentSelectedPaths
        : Array.from(new Set(collectArtifactPaths(traces)));
      const sentFiles = await sendArtifacts(ctx, artifactPaths);
      await sendLongText(ctx, formatTelegramAnswer(result.finalAnswer || 'Done.', sentFiles));
      if (shouldPersistTelegramMemory(parsed.prompt, result.finalAnswer || 'Done.', sentFiles)) {
        if (!includeMemory) {
          telegramMemory = await loadTelegramMemory(ctx.chat.id);
        }
        telegramMemory.turns.push({
          timestamp: Date.now(),
          user: parsed.prompt,
          assistant: sanitizeFinalAnswer(result.finalAnswer || 'Done.'),
          files: sentFiles,
        });
        await saveTelegramMemory(telegramMemory).catch((error: any) => log('telegram memory save failed', { error: error.message || String(error) }));
      }
    } else if (result.status === 'stopped') {
      if (!task.stopRequested) await ctx.reply('Stopped by user.');
    } else {
      await sendLongText(ctx, `Agent failed: ${result.error || result.finalAnswer || 'unknown error'}`);
    }
  } catch (error: any) {
    await ctx.reply(`Telegram agent error: ${error.message}`).catch(() => {});
    console.error('[TelegramBot] Error:', error);
  } finally {
    if (runningTasks.get(taskKey)?.agentChatId === task.agentChatId) {
      runningTasks.delete(taskKey);
    }
  }
}

bot.catch((err) => {
  console.error('[TelegramBot] Unhandled Telegraf error:', err);
});

async function preflightTelegram() {
  const me = await withRetry('getMe', () => bot.telegram.getMe());
  bot.botInfo = me;

  const webhook = await withRetry('getWebhookInfo', () => bot.telegram.getWebhookInfo());
  if (webhook.url) {
    log('existing webhook detected; deleting before polling', {
      urlHost: new URL(webhook.url).host,
      pendingUpdates: webhook.pending_update_count,
    });
    await withRetry('deleteWebhook', () => bot.telegram.deleteWebhook({ drop_pending_updates: DROP_PENDING_UPDATES }));
  }

  log('connected to Telegram', {
    bot: `@${me.username}`,
    id: me.id,
    pendingUpdates: webhook.pending_update_count,
  });
}

async function configureTelegramProfile() {
  await withRetry('setMyName', () => bot.telegram.setMyName('EterX'), 2).catch((error) => log('setMyName failed', { error: error.message }));
  await withRetry('setMyShortDescription', () => bot.telegram.setMyShortDescription('Fast AI agent for chat, files, and local tasks.'), 2).catch((error) => log('setMyShortDescription failed', { error: error.message }));
  await withRetry('setMyDescription', () => bot.telegram.setMyDescription('Send a message or file. EterX replies directly and handles requested work without extra setup.'), 2).catch((error) => log('setMyDescription failed', { error: error.message }));
  await withRetry('setMyCommands', () => bot.telegram.setMyCommands([
    { command: 'status', description: 'Current task' },
    { command: 'stop', description: 'Stop task' },
    { command: 'help', description: 'Commands' },
  ]), 2).catch((error) => log('setMyCommands failed', { error: error.message }));
  await withRetry('setChatMenuButton', () => bot.telegram.setChatMenuButton({
    menuButton: { type: 'commands' },
  }), 2).catch((error) => log('setChatMenuButton failed', { error: error.message }));
}

async function launch() {
  log('starting polling bridge');
  apiKeyPool.initialize();
  await preflightTelegram();

  log('polling launch requested', {
    bot: bot.botInfo?.username ? `@${bot.botInfo.username}` : 'unknown',
    dropPendingUpdates: DROP_PENDING_UPDATES,
  });
  await withRetry('launch polling', () => bot.launch({
    dropPendingUpdates: DROP_PENDING_UPDATES,
    allowedUpdates: [...ALLOWED_UPDATES],
  }, () => {
    log('polling live; message your bot from mobile', { bot: bot.botInfo?.username ? `@${bot.botInfo.username}` : 'unknown' });
  }));

  void configureTelegramProfile().catch((error) => log('telegram profile setup failed', { error: error.message || String(error) }));
}

launch().catch((error) => {
  console.error('[TelegramBot] Launch failed:', error);
  const message = String(error?.message || error || '');
  if (message.includes('409') || /terminated by other getUpdates request/i.test(message)) {
    console.error('[TelegramBot] Another copy of this bot is already polling. Stop the old terminal/process, then run npm run telegram-start again.');
  }
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('[TelegramBot] Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('[TelegramBot] Uncaught exception:', error);
});

process.on('beforeExit', (code) => {
  console.warn('[TelegramBot] beforeExit: event loop drained unexpectedly', { code });
});

process.on('exit', (code) => {
  console.warn('[TelegramBot] exit', { code });
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

