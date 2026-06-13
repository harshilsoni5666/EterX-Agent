import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import { enforceToolCapability } from '../security/tool_policy';
import { loadOptionalModule } from './optional_module';
import { requireOutboundApproval } from './outbound_approval';

// Lazy-load whatsapp-web.js — webpack-invisible dynamic require
let Client: any = null;
let LocalAuth: any = null;
let qrcode: any = null;
let whatsappAvailable = false;
let whatsappLoadAttempted = false;

function ensureWhatsAppSdk(): boolean {
  if (Client && LocalAuth && qrcode) return true;
  if (whatsappLoadAttempted) return false;
  whatsappLoadAttempted = true;

  const wwebjs = loadOptionalModule<any>('whatsapp-web.js');
  qrcode = loadOptionalModule<any>('qrcode-terminal');
  Client = wwebjs?.Client || null;
  LocalAuth = wwebjs?.LocalAuth || null;
  whatsappAvailable = Boolean(Client && LocalAuth && qrcode);
  if (!whatsappAvailable) console.warn('[WhatsApp] whatsapp-web.js package not installed. WhatsApp tool will be unavailable.');
  return whatsappAvailable;
}

/**
 * Native WhatsApp Web Controller
 * Runs a headless browser to control the user's personal WhatsApp account.
 */

// Singleton client to keep session alive across tool calls
let waClient: any = null;
let waReady = false;
let qrCodeText = '';

export const whatsappControllerTool: ToolDefinition = {
  name: 'whatsapp_controller',
  description: `Native WhatsApp Controller — automates your personal WhatsApp account.
  
  Actions:
  - init: Start the WhatsApp client. It will generate a QR code in the terminal (or return the raw text) for you to scan with the WhatsApp app to log in.
  - status: Check if WhatsApp is connected and ready.
  - contacts: Get a list of your contacts/chats to find their exact ID.
  - send: Send a text message to a specific contact (requires their contact ID or phone number in international format, e.g., "1234567890@c.us").
  - read: Read recent messages from a specific chat.`,
  category: 'communication',
  inputSchema: z.object({
    action: z.enum(['init', 'status', 'contacts', 'send', 'read']),
    to: z.string().optional().describe('Phone number with country code (e.g. 1234567890@c.us) or Group ID'),
    message: z.string().optional().describe('Text message to send'),
    confirm: z.boolean().optional().describe('Required true for sending WhatsApp messages'),
    limit: z.number().optional().default(10).describe('Limit for contacts or messages to read')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.string(),
    data: z.any().optional()
  }),
  execute: async (input: any, context?: any) => {
    try {
      const decision = enforceToolCapability('whatsapp_controller', input, context);
      if (!decision.allowed) {
        return { success: false, status: decision.reason || 'WhatsApp access is not allowed' };
      }

      if (!ensureWhatsAppSdk()) {
        return { success: false, status: 'whatsapp-web.js package is not installed. Run: npm install whatsapp-web.js qrcode-terminal' };
      }

      if (input.action === 'init') {
        if (waClient && waReady) return { success: true, status: 'WhatsApp is already connected and ready.' };
        if (waClient && !waReady && qrCodeText) return { success: true, status: 'Waiting for QR scan. Scan the code printed in the terminal, or render this raw string as a QR:', data: qrCodeText };
        
        console.log('[WhatsApp] Initializing headless client...');
        const authPath = path.resolve(process.cwd(), '.workspaces', '.whatsapp_auth');

        waClient = new (Client as any)({
          authStrategy: new (LocalAuth as any)({ dataPath: authPath }),
          puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] } // Works in local env
        });

        waClient.on('qr', (qr: string) => {
          qrCodeText = qr;
          console.log('\n=========================================');
          console.log('📱 WHATSAPP LOGIN REQUIRED 📱');
          console.log('Please scan this QR code with your WhatsApp app:');
          qrcode.generate(qr, { small: true });
          console.log('=========================================\n');
        });

        waClient.on('ready', () => {
          console.log('[WhatsApp] Client is READY! Connection established.');
          waReady = true;
          qrCodeText = '';
        });

        waClient.initialize();
        return { success: true, status: 'WhatsApp client is starting up. Check the terminal for the QR code to scan.' };
      }

      if (input.action === 'status') {
        const state = waClient ? (waReady ? 'CONNECTED' : (qrCodeText ? 'WAITING_FOR_QR_SCAN' : 'STARTING')) : 'NOT_INITIALIZED';
        return { success: true, status: `Current State: ${state}`, data: { ready: waReady, requiresScan: !!qrCodeText } };
      }

      // The following commands require the client to be ready
      if (!waClient || !waReady) {
        return { success: false, status: 'WhatsApp client is not ready. Call "init" first and wait for connection.' };
      }

      if (input.action === 'contacts') {
        const chats = await waClient.getChats();
        // Return recent chats up to limit
        const list = chats.slice(0, input.limit || 10).map((c: any) => ({
          id: c.id._serialized,
          name: c.name,
          isGroup: c.isGroup,
          unread: c.unreadCount
        }));
        return { success: true, status: `Retrieved ${list.length} recent chats.`, data: list };
      }

      if (input.action === 'send') {
        const approval = await requireOutboundApproval('WhatsApp', 'send', input, context, input.to, input.message);
        if (approval) return approval;
        if (!input.to || !input.message) return { success: false, status: 'Missing "to" or "message" parameter.' };
        // Ensure format is correct for standard numbers if user didn't add @c.us
        let toChatId = input.to;
        if (!toChatId.includes('@')) {
           const digits = toChatId.replace(/\D/g, '');
           if (digits.length < 8 || digits.length > 15) return { success: false, status: 'Invalid WhatsApp phone number. Use international digits or a full chat ID.' };
           toChatId = `${digits}@c.us`; // strip non-digits and append @c.us
        }
        
        await waClient.sendMessage(toChatId, input.message);
        return { success: true, status: `Message successfully sent to ${toChatId}` };
      }

      if (input.action === 'read') {
        if (!input.to) return { success: false, status: 'Missing "to" parameter (chat ID).' };
        let toChatId = input.to;
        if (!toChatId.includes('@')) toChatId = `${toChatId.replace(/\D/g, '')}@c.us`;

        const chat = await waClient.getChatById(toChatId);
        const messages = await chat.fetchMessages({ limit: input.limit || 10 });
        
        const formatMsgs = messages.map((m: any) => ({
          fromMe: m.fromMe,
          body: m.body,
          timestamp: new Date(m.timestamp * 1000).toLocaleString()
        }));
        
        return { success: true, status: `Read ${formatMsgs.length} messages from ${chat.name}`, data: formatMsgs };
      }

      return { success: false, status: 'Unknown action' };
    } catch (err: any) {
      return { success: false, status: `WhatsApp Error: ${err.message}` };
    }
  }
};
