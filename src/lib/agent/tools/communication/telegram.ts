import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import fs from 'fs-extra';
import path from 'path';

let TelegramClient: any = null;
let StringSession: any = null;
let telegramAvailable = false;

try {
  const dynamicRequire = eval('require');
  const telegram = dynamicRequire('telegram');
  const sessions = dynamicRequire('telegram/sessions');
  TelegramClient = telegram.TelegramClient;
  StringSession = sessions.StringSession;
  telegramAvailable = true;
} catch {
  console.warn('[Telegram] GramJS package not installed. User-account Telegram actions will be unavailable.');
}

const SESSION_FILE = path.resolve(process.cwd(), '.workspaces', '.telegram_session');
let stringSession: any = telegramAvailable ? new StringSession('') : null;
let tgClient: any = null;
let tgReady = false;

const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : 2040;
const apiHash = process.env.TELEGRAM_API_HASH || '';

let resolvePhone: ((phone: string) => void) | null = null;
let resolveCode: ((code: string) => void) | null = null;
let resolvePassword: ((pw: string) => void) | null = null;
let authState = 'NOT_STARTED';

async function getTelegramBotToken(): Promise<string | null> {
  try {
    const connectorsFile = path.resolve(process.cwd(), '.workspaces', '.connectors.json');
    if (await fs.pathExists(connectorsFile)) {
      const connectors = await fs.readJson(connectorsFile);
      if (connectors?.telegram?.botToken) return connectors.telegram.botToken;
    }
  } catch { }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'YOUR_ACTUAL_TELEGRAM_BOT_TOKEN_HERE') return null;
  return token;
}

async function telegramApi(method: string, payload: any, isForm = false) {
  const token = await getTelegramBotToken();
  if (!token) {
    return { success: false, status: 'Telegram bot is not connected. Set TELEGRAM_BOT_TOKEN in .env.local.' };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, isForm
    ? { method: 'POST', body: payload }
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    return { success: false, status: data.description || `Telegram API error: HTTP ${response.status}`, results: data };
  }
  return { success: true, status: 'Telegram API request completed.', results: data.result };
}

export const telegramUserControllerTool: ToolDefinition = {
  name: 'telegram_user_controller',
  description: `Full-power Telegram integration.

Bot-token actions:
- bot_status: Check bot connection.
- send: Send a Telegram message to a chat ID or username.
- upload: Upload a local file/document to a Telegram chat.

User-account MTProto actions:
- init: Start login for a personal Telegram account.
- provide_phone, provide_code, provide_password: Complete MTProto login.
- status: Check user-account connection state.
- dialogs: List recent chats.
- read: Read recent messages from a chat.

For inbound mobile requests, telegram-bot.ts automatically forwards every Telegram message to the main EterX agent.`,
  category: 'communication',
  inputSchema: z.object({
    action: z.enum(['bot_status', 'init', 'status', 'provide_phone', 'provide_code', 'provide_password', 'dialogs', 'send', 'upload', 'read']),
    data: z.string().optional().describe('Phone/code/password, or Telegram chat ID/username target'),
    message: z.string().optional().describe('Text message or upload caption'),
    file_path: z.string().optional().describe('Local absolute or relative file path for upload'),
    filename: z.string().optional().describe('Optional upload filename'),
    limit: z.number().optional().default(10),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.string(),
    state: z.string().optional(),
    results: z.any().optional(),
  }),
  execute: async (input: any) => {
    try {
      if (input.action === 'bot_status') {
        const result = await telegramApi('getMe', {});
        if (!result.success) return result;
        return {
          success: true,
          status: `Telegram bot connected: @${result.results?.username || 'unknown'}`,
          results: result.results,
        };
      }

      if (input.action === 'send') {
        if (!input.data || !input.message) return { success: false, status: 'Missing target(data) or message.' };
        const botResult = await telegramApi('sendMessage', {
          chat_id: input.data,
          text: input.message,
          disable_web_page_preview: false,
        });
        if (botResult.success || !telegramAvailable) {
          return botResult.success
            ? { success: true, status: `Message sent to Telegram chat ${input.data}.`, results: botResult.results }
            : botResult;
        }
      }

      if (input.action === 'upload') {
        if (!input.data || !input.file_path) return { success: false, status: 'Missing target(data) or file_path.' };
        const absolutePath = path.isAbsolute(input.file_path) ? input.file_path : path.resolve(process.cwd(), input.file_path);
        if (!await fs.pathExists(absolutePath)) return { success: false, status: `File not found: ${input.file_path}` };

        const form = new FormData();
        form.append('chat_id', input.data);
        form.append('document', new Blob([await fs.readFile(absolutePath)]), input.filename || path.basename(absolutePath));
        if (input.message) form.append('caption', input.message);

        const result = await telegramApi('sendDocument', form, true);
        return result.success
          ? { success: true, status: `Uploaded ${path.basename(absolutePath)} to Telegram chat ${input.data}.`, results: result.results }
          : result;
      }

      if (!tgClient && await fs.pathExists(SESSION_FILE)) {
        const saved = await fs.readFile(SESSION_FILE, 'utf-8');
        stringSession = new StringSession(saved);
      }

      if (!telegramAvailable) {
        return { success: false, status: 'GramJS is not installed. Run: npm install telegram' };
      }

      if (!tgClient && (input.action === 'init' || input.action === 'status')) {
        tgClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
      }

      if (input.action === 'init') {
        if (tgReady) return { success: true, status: 'Telegram user account is already connected.', state: authState };

        authState = 'CONNECTING';
        tgClient!.start({
          phoneNumber: async () => {
            authState = 'WAITING_FOR_PHONE';
            return new Promise((resolve) => { resolvePhone = resolve as any; });
          },
          password: async () => {
            authState = 'WAITING_FOR_PASSWORD';
            return new Promise((resolve) => { resolvePassword = resolve as any; });
          },
          phoneCode: async () => {
            authState = 'WAITING_FOR_CODE';
            return new Promise((resolve) => { resolveCode = resolve as any; });
          },
          onError: (err: any) => console.log('[Telegram Auth Error]', err),
        }).then(async () => {
          tgReady = true;
          authState = 'CONNECTED';
          await fs.writeFile(SESSION_FILE, tgClient!.session.save() as unknown as string, 'utf-8');
        }).catch(() => {
          authState = 'FAILED';
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { success: true, status: 'Telegram user-account initialization started.', state: authState };
      }

      if (input.action === 'status') {
        return { success: true, status: `Current Telegram user-account state: ${authState}`, state: authState };
      }

      if (input.action === 'provide_phone') {
        if (authState !== 'WAITING_FOR_PHONE' || !resolvePhone) return { success: false, status: `Wrong state: ${authState}` };
        if (!input.data) return { success: false, status: 'Missing phone in data field.' };
        resolvePhone(input.data);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { success: true, status: 'Phone submitted.', state: authState };
      }

      if (input.action === 'provide_code') {
        if (authState !== 'WAITING_FOR_CODE' || !resolveCode) return { success: false, status: `Wrong state: ${authState}` };
        if (!input.data) return { success: false, status: 'Missing code in data field.' };
        resolveCode(input.data);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { success: true, status: 'Code submitted.', state: authState };
      }

      if (input.action === 'provide_password') {
        if (authState !== 'WAITING_FOR_PASSWORD' || !resolvePassword) return { success: false, status: `Wrong state: ${authState}` };
        if (!input.data) return { success: false, status: 'Missing password in data field.' };
        resolvePassword(input.data);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { success: true, status: 'Password submitted.', state: authState };
      }

      if (!tgReady || !tgClient) {
        return { success: false, status: `Telegram user account is not authenticated. Current state: ${authState}` };
      }

      if (input.action === 'dialogs') {
        const dialogs = await tgClient.getDialogs({ limit: input.limit || 15 });
        return {
          success: true,
          status: 'Dialogs retrieved.',
          results: dialogs.map((d: any) => ({
            id: d.id?.toString(),
            title: d.title,
            isGroup: d.isGroup,
            unread: d.unreadCount,
          })),
        };
      }

      if (input.action === 'send') {
        await tgClient.sendMessage(input.data, { message: input.message });
        return { success: true, status: `Message sent to ${input.data}` };
      }

      if (input.action === 'read') {
        if (!input.data) return { success: false, status: 'Missing target chat in data parameter.' };
        const history = await tgClient.getMessages(input.data, { limit: input.limit || 10 });
        return {
          success: true,
          status: `Read ${history.length} items from ${input.data}.`,
          results: history.map((m: any) => ({
            id: m.id,
            text: m.message,
            sender: m.senderId?.toString(),
            date: new Date(m.date * 1000).toISOString(),
          })),
        };
      }

      return { success: false, status: `Unknown action: ${input.action}` };
    } catch (err: any) {
      return { success: false, status: `Telegram Error: ${err.message}` };
    }
  },
};
