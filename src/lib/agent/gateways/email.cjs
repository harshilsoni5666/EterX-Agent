'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const AUTOMATED_HEADERS = ['auto-submitted', 'precedence', 'list-unsubscribe'];

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function firstAddress(value) {
  const address = Array.isArray(value) ? value[0] : value;
  if (!address) return { address: '', name: '' };
  return { address: clean(address.address).toLowerCase(), name: clean(address.name) };
}

function normalizeAddress(value) {
  return firstAddress(value).address;
}

function safeFileName(value) {
  return clean(value || 'attachment').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120) || 'attachment';
}

function attachmentType(value) {
  const type = clean(value).toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.includes('pdf') || type.includes('document') || type.includes('text/')) return 'document';
  return 'file';
}

function stripHtml(value) {
  return clean(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

function normalizedSubject(value) {
  return clean(value).replace(/^(?:(?:re|fw|fwd):\s*)+/i, '').toLowerCase() || '(no subject)';
}

function isAutomated(parsed, ownAddress) {
  const sender = normalizeAddress(parsed.from);
  if (!sender || sender === ownAddress) return true;
  const local = sender.split('@')[0] || '';
  if (/^(?:no[-_]?reply|noreply|mailer-daemon|bounce|notifications?)$/i.test(local)) return true;
  return AUTOMATED_HEADERS.some((header) => clean(parsed.headers?.get(header)).length > 0);
}

function parseAllowedUsers(settings) {
  const raw = Array.isArray(settings.allowlist)
    ? settings.allowlist
    : clean(settings.allowedUsers || '').split(',');
  return new Set(raw.map((item) => clean(item).toLowerCase()).filter(Boolean));
}

function isAllowedByEmailPolicy(address, settings) {
  if (settings.emailAllowAllUsers === true || settings.accessPolicy === 'open') return true;
  const allowed = parseAllowedUsers(settings);
  return allowed.has(address.toLowerCase());
}

class EmailGatewayAdapter {
  constructor({ dataDir, settings, onMessage, onState }) {
    this.dataDir = dataDir;
    this.settings = settings || {};
    this.onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.abortController = null;
    this.client = null;
    this.started = false;
    this.running = false;
  }

  updateSettings(settings) {
    this.settings = settings || {};
  }

  state(state, lastError) {
    this.onState({ state, ...(lastError ? { lastError } : {}) });
  }

  imapOptions() {
    const settings = this.settings;
    const password = settings.password || settings.appPassword || settings.emailPassword;
    if (!settings.emailAddress || !password || !settings.imapHost || !settings.smtpHost) {
      throw new Error('Email needs an address, app password, IMAP host, and SMTP host.');
    }
    return {
      host: settings.imapHost,
      port: Number(settings.imapPort) || 993,
      secure: settings.imapSecure !== false,
      auth: { user: settings.emailAddress, pass: password },
      logger: false,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    while (this.running && !this.abortController.signal.aborted) {
      try {
        await this.runConnection();
      } catch (error) {
        if (!this.running || this.abortController.signal.aborted) break;
        this.state('retrying', error?.message || String(error));
        await this.delay(5000);
      }
    }
  }

  async runConnection() {
    const client = new ImapFlow(this.imapOptions());
    this.client = client;
    this.state('connecting');
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      this.state('connected');
      if (!this.started) {
        await this.markExistingMessagesSeen(client);
        this.started = true;
      }
      while (this.running && !this.abortController.signal.aborted) {
        await this.pollOnce(client);
        await this.delay(Math.max(5, Number(this.settings.pollInterval) || 15) * 1000);
      }
    } finally {
      lock.release();
      try { await client.logout(); } catch { }
      if (this.client === client) this.client = null;
    }
  }

  async markExistingMessagesSeen(client) {
    const unseen = await client.search({ seen: false });
    if (unseen.length) await client.messageFlagsAdd(unseen, ['\\Seen'], { uid: true });
  }

  async pollOnce(client) {
    const unseen = await client.search({ seen: false });
    for (const uid of unseen) {
      try {
        let parsed;
        for await (const item of client.fetch(uid, { uid: true, source: true, internalDate: true })) {
          if (item.source) parsed = await simpleParser(item.source);
        }
        if (parsed) await this.handleMessage(parsed, uid);
      } finally {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
      }
    }
  }

  async handleMessage(parsed, uid) {
    const ownAddress = normalizeAddress(this.settings.emailAddress);
    if (isAutomated(parsed, ownAddress)) return;
    const sender = firstAddress(parsed.from);
    if (!sender.address) return;
    if (!isAllowedByEmailPolicy(sender.address, this.settings) && this.settings.accessPolicy !== 'pairing') return;
    const subject = clean(parsed.subject) || '(no subject)';
    const body = clean(parsed.text) || stripHtml(parsed.html);
    if (!body && !parsed.attachments?.length) return;
    const receivedAt = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.getTime() : Date.now();
    const messageId = clean(parsed.messageId) || `uid-${uid}-${crypto.createHash('sha1').update(`${sender.address}:${subject}:${receivedAt}`).digest('hex').slice(0, 16)}`;
    const conversationId = `email:${sender.address}:${normalizedSubject(subject)}`;
    const attachments = await this.cacheAttachments(parsed.attachments || [], uid);
    const isReply = /^(?:re|fw|fwd):/i.test(subject);
    const text = `${!isReply ? `[Subject: ${subject}]\n\n` : ''}${body || '[Attachment]'}`.trim();
    await this.onMessage({
      message: {
        id: messageId,
        conversationId,
        text,
        timestamp: receivedAt,
        actor: { id: sender.address, displayName: sender.name || sender.address, username: sender.address },
        attachments,
        replyTarget: {
          to: sender.address,
          from: ownAddress,
          subject,
          messageId,
          references: Array.isArray(parsed.references) ? parsed.references.join(' ') : clean(parsed.references),
        },
        metadata: {
          subject,
          messageId,
          inReplyTo: clean(parsed.inReplyTo),
          references: Array.isArray(parsed.references) ? parsed.references : [],
          to: (parsed.to?.value || []).map((item) => item.address).filter(Boolean),
          cc: (parsed.cc?.value || []).map((item) => item.address).filter(Boolean),
        },
      },
    });
  }

  async cacheAttachments(attachments, uid) {
    if (this.settings.skipAttachments === true) return [];
    const root = path.join(this.dataDir, 'email-attachments');
    const maxBytes = Math.max(1, Number(this.settings.maxAttachmentBytes) || 15 * 1024 * 1024);
    const result = [];
    for (const [index, attachment] of attachments.entries()) {
      if (!attachment?.content || attachment.content.length > maxBytes) continue;
      fs.mkdirSync(root, { recursive: true });
      const name = `${uid}-${index}-${safeFileName(attachment.filename || attachment.contentType || 'attachment')}`;
      const target = path.join(root, name);
      fs.writeFileSync(target, attachment.content, { mode: 0o600 });
      result.push({
        id: `email-${uid}-${index}`,
        type: attachmentType(attachment.contentType),
        name: clean(attachment.filename) || name,
        mimeType: clean(attachment.contentType) || undefined,
        size: attachment.content.length,
        path: target,
      });
    }
    return result;
  }

  async stop() {
    this.running = false;
    this.abortController?.abort();
    try { await this.client?.logout(); } catch { }
    this.client = null;
    this.state('stopped');
  }

  delay(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      this.abortController?.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

async function sendEmailMessage(target, text, settings) {
  const password = settings.password || settings.appPassword || settings.emailPassword;
  if (!settings.emailAddress || !password || !settings.smtpHost) throw new Error('Email needs an address, app password, and SMTP host.');
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort) || 587,
    secure: settings.smtpSecure === true,
    auth: { user: settings.emailAddress, pass: password },
  });
  const subject = clean(target.subject) || '(no subject)';
  const replySubject = /^(?:re|fw|fwd):/i.test(subject) ? subject : `Re: ${subject}`;
  const headers = {};
  if (target.messageId) headers['In-Reply-To'] = target.messageId;
  const references = [clean(target.references), clean(target.messageId)].filter(Boolean).join(' ');
  if (references) headers.References = references;
  return transporter.sendMail({
    from: settings.emailAddress,
    to: target.to,
    subject: replySubject,
    text,
    headers,
  });
}

module.exports = { EmailGatewayAdapter, sendEmailMessage };
