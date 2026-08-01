'use strict';

const crypto = require('crypto');

const clean = (value) => String(value == null ? '' : value).trim();
const nowFromSeconds = (value) => Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.now();
const stableId = (...parts) => crypto.createHash('sha256').update(parts.map(clean).join(':')).digest('hex').slice(0, 32);

function attachmentType(value) {
  const type = clean(value).toLowerCase();
  if (type.includes('image') || type === 'photo') return 'image';
  if (type.includes('audio') || type === 'voice') return 'audio';
  if (type.includes('video')) return 'video';
  if (type.includes('document') || type.includes('file')) return 'document';
  if (type.includes('sticker')) return 'sticker';
  return 'unknown';
}

function base(platform, externalMessageId, conversationId, actor, text, receivedAt, extra = {}) {
  const messageId = clean(externalMessageId) || stableId(platform, conversationId, actor.id, text, receivedAt);
  return {
    id: `${platform}_${stableId(platform, messageId)}`,
    dedupeKey: `${platform}:${messageId}`,
    platform,
    kind: extra.kind || 'message',
    conversationId: `${platform}:${clean(conversationId)}`,
    threadId: extra.threadId ? clean(extra.threadId) : undefined,
    externalMessageId: messageId,
    text: clean(text),
    actor: { id: clean(actor.id), displayName: clean(actor.displayName) || undefined, username: clean(actor.username) || undefined, isBot: Boolean(actor.isBot) },
    attachments: extra.attachments || [],
    receivedAt: Number(receivedAt) || Date.now(),
    replyTarget: extra.replyTarget || {},
    metadata: extra.metadata || {},
  };
}

function normalizeTelegram(payload) {
  const message = payload.message || payload.edited_message || payload.channel_post || payload.edited_channel_post || payload.business_message;
  if (!message) return [];
  const chat = message.chat || {};
  const from = message.from || {};
  const attachments = [];
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    attachments.push({ id: clean(photo.file_id), type: 'image' });
  }
  for (const key of ['audio', 'voice', 'video', 'document', 'sticker']) {
    if (!message[key]) continue;
    attachments.push({ id: clean(message[key].file_id), type: attachmentType(key), name: clean(message[key].file_name) || undefined, mimeType: clean(message[key].mime_type) || undefined });
  }
  return [base('telegram', payload.update_id || message.message_id, chat.id, {
    id: from.id || chat.id,
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || chat.title,
    username: from.username,
    isBot: from.is_bot,
  }, message.text || message.caption, nowFromSeconds(message.date), {
    kind: payload.edited_message || payload.edited_channel_post ? 'edit' : 'message',
    threadId: message.message_thread_id,
    attachments,
    replyTarget: { chatId: clean(chat.id), messageId: clean(message.message_id) },
    metadata: { updateId: payload.update_id, chatType: chat.type },
  })];
}

function normalizeWhatsApp(payload) {
  const output = [];
  for (const entry of payload.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    const contacts = new Map((value.contacts || []).map((c) => [clean(c.wa_id), c]));
    for (const message of value.messages || []) {
      const contact = contacts.get(clean(message.from)) || {};
      const content = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.image?.caption || message.video?.caption || message.document?.caption || '';
      const media = message[message.type];
      const attachments = media && message.type !== 'text' ? [{ id: clean(media.id), type: attachmentType(message.type), name: clean(media.filename) || undefined, mimeType: clean(media.mime_type) || undefined }] : [];
      output.push(base('whatsapp', message.id, message.from, {
        id: message.from,
        displayName: contact.profile?.name,
      }, content, nowFromSeconds(message.timestamp), {
        attachments,
        replyTarget: { phoneNumberId: clean(value.metadata?.phone_number_id), to: clean(message.from), messageId: clean(message.id) },
        metadata: { displayPhoneNumber: value.metadata?.display_phone_number, context: message.context },
      }));
    }
  }
  return output;
}

function normalizeDiscord(payload) {
  const event = payload.d || payload;
  const eventName = clean(payload.t || payload.type).toUpperCase();
  if (eventName && !['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(eventName)) return [];
  if (!event.id || (!event.channel_id && !event.channelId)) return [];
  const author = event.author || {};
  const attachments = (event.attachments || []).map((item) => ({
    id: clean(item.id), type: attachmentType(item.content_type || item.filename), name: clean(item.filename) || undefined,
    mimeType: clean(item.content_type) || undefined, url: clean(item.url) || undefined,
  }));
  const channelId = event.channel_id || event.channelId;
  return [base('discord', event.id, channelId, {
    id: author.id,
    displayName: author.global_name || event.member?.nick || author.username,
    username: author.username,
    isBot: author.bot,
  }, event.content, event.timestamp ? Date.parse(event.timestamp) : Date.now(), {
    kind: eventName === 'MESSAGE_UPDATE' ? 'edit' : 'message',
    threadId: event.thread?.id,
    attachments,
    replyTarget: { channelId: clean(channelId), messageId: clean(event.id) },
    metadata: { guildId: event.guild_id, sequence: payload.s },
  })];
}

function normalizeSignal(payload) {
  const params = payload.params || payload;
  const envelope = params.envelope || params.result?.envelope || payload.envelope || {};
  const data = envelope.dataMessage || envelope.syncMessage?.sentMessage || {};
  if (!envelope.timestamp && !data.timestamp) return [];
  const source = envelope.sourceNumber || envelope.source || data.destinationNumber || data.destination;
  const groupId = data.groupInfo?.groupId || data.groupInfo?.groupIdV2;
  const attachments = (data.attachments || []).map((item) => ({ id: clean(item.id), type: attachmentType(item.contentType || item.filename), name: clean(item.filename) || undefined, mimeType: clean(item.contentType) || undefined }));
  return [base('signal', envelope.timestamp || data.timestamp, groupId || source, {
    id: source,
    displayName: envelope.sourceName,
  }, data.message, Number(envelope.timestamp || data.timestamp), {
    attachments,
    replyTarget: { recipient: clean(source), groupId: clean(groupId), account: clean(params.account || payload.account) },
    metadata: { sourceUuid: envelope.sourceUuid, sourceDevice: envelope.sourceDevice },
  })];
}

function normalizeGeneric(payload) {
  const message = payload.message || payload;
  return [base('generic', message.id, message.conversationId || message.channelId || message.chatId, {
    id: message.actor?.id || message.userId || message.senderId,
    displayName: message.actor?.displayName || message.senderName,
    username: message.actor?.username,
    isBot: message.actor?.isBot,
  }, message.text || message.content, message.timestamp ? Date.parse(message.timestamp) || Number(message.timestamp) : Date.now(), {
    threadId: message.threadId,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    replyTarget: message.replyTarget || {},
    metadata: message.metadata || {},
  })];
}

function normalizeGatewayPayload(platform, payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (platform === 'telegram') return normalizeTelegram(payload);
  if (platform === 'whatsapp') return normalizeWhatsApp(payload);
  if (platform === 'discord') return normalizeDiscord(payload);
  if (platform === 'signal') return normalizeSignal(payload);
  return normalizeGeneric(payload);
}

module.exports = { normalizeGatewayPayload, stableId };
