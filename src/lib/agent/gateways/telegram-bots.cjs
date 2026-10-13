'use strict';

// Telegram is a transport for the existing EterX runtime, not another agent.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { normalizeGatewayPayload } = require('./normalizers.cjs');
const { telegramApi, telegramFetch } = require('./telegram-api.cjs');
const { formatTelegramText, renderTelegramText } = require('./telegram-presentation.cjs');

const COMMANDS = [
  ['start', 'Meet your bot'], ['help', 'Commands and capabilities'],
  ['new', 'Start a separate conversation'], ['chats', 'List conversations'],
  ['switch', 'Switch conversation by number'], ['status', 'Current work and model'],
  ['stop', 'Stop the current task'], ['settings', 'Bot and device settings'],
  ['peek', 'Show the latest work update'],
  ['steer', 'Give guidance while a question is waiting'],
  ['quiet', 'Only send results and necessary questions'], ['updates', 'Show work updates again'],
];
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const replyParameters = target => {
  const messageId = Number(target?.messageId);
  return Number.isSafeInteger(messageId) && messageId > 0 ? { message_id: messageId, allow_sending_without_reply: true } : undefined;
};
function normalizeBots(value) {
  const ids = new Set();
  return (Array.isArray(value) ? value : []).slice(0, 30).flatMap(raw => {
    const id = String(raw?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!id || ids.has(id)) return [];
    ids.add(id);
    return [{ id, name: String(raw.name || 'My bot').trim().slice(0, 64),
      token: String(raw.token || '').trim(), username: String(raw.username || '').slice(0, 64),
      telegramId: String(raw.telegramId || ''), enabled: raw.enabled === true,
      instructions: String(raw.instructions || '').slice(0, 16000),
      model: { provider: String(raw.model?.provider || ''), modelId: String(raw.model?.modelId || '').slice(0, 200) },
      agentType: ['general', 'coding-lite', 'coding-heavy'].includes(raw.agentType) || /^custom:[a-zA-Z0-9_-]{1,100}$/.test(String(raw.agentType)) ? raw.agentType : 'general',
      workspacePath: String(raw.workspacePath || '').slice(0, 2000),
      allowBrowserControl: raw.allowBrowserControl !== false, allowHostControl: raw.allowHostControl === true,
      thinkingLevel: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(raw.thinkingLevel) ? raw.thinkingLevel : 'low',
    }];
  });
}
const publicBot = bot => { const { token, ...rest } = bot; return { ...rest, configured: Boolean(token) }; };

class TelegramBots {
  constructor(daemon) {
    this.daemon = daemon;
    this.workers = new Map();
    this.states = {};
    this.pairings = new Map();
    this.capabilities = new Map();
    this.albumTimers = new Map();
    this.progressRequests = new Map();
    this.file = path.join(daemon.dataDir, 'telegram-bots-state.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    this.data.owners ||= {};
    this.data.offsets ||= {};
    this.data.sessions ||= {};
    this.data.questions ||= {};
    this.data.replies ||= {};
    this.data.progress ||= {};
    this.data.mediaGroups ||= {};
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  get(id) { return this.daemon.config.telegramBots.find(bot => bot.id === id); }
  status() {
    return this.daemon.config.telegramBots.map(bot => ({ ...publicBot(bot),
      state: !bot.enabled ? 'paused' : this.states[bot.id]?.state || 'offline',
      lastError: this.states[bot.id]?.lastError,
      paired: Boolean(this.data.owners[bot.id]),
      ownerName: this.data.owners[bot.id]?.name || '',
      conversationCount: Object.entries(this.data.sessions).filter(([key]) => key.startsWith(`${bot.id}:`)).reduce((n, [, value]) => n + value.chats.length, 0),
    }));
  }
  pairing(id) {
    const bot = this.get(id);
    if (!bot?.username) throw new Error('Save a valid bot token first.');
    if (this.data.owners[id]) throw new Error('This bot is already paired. Disconnect it before pairing another account.');
    const code = crypto.randomBytes(24).toString('base64url');
    this.pairings.set(id, { hash: digest(code), expiresAt: Date.now() + 10 * 60 * 1000 });
    return { url: `https://t.me/${bot.username}?start=pair_${code}`, expiresAt: Date.now() + 10 * 60 * 1000 };
  }
  setState(id, state, lastError) { this.states[id] = { state, lastError }; this.daemon.publishStatus(); }
  start() {
    for (const bot of this.daemon.config.telegramBots) {
      if (!bot.enabled || this.workers.has(bot.id)) continue;
      const controller = new AbortController();
      const worker = { controller, promise: null, config: JSON.stringify(bot) };
      this.workers.set(bot.id, worker);
      worker.promise = this.poll(bot, controller.signal).catch(error => this.setState(bot.id, 'error', error.message));
    }
  }
  async reconfigure() {
    // Updating one identity must not tear down other bots or transports.
    for (const [id, worker] of this.workers) {
      const bot = this.get(id);
      if (bot?.enabled && worker.config === JSON.stringify(bot) && !['error', 'needs-attention'].includes(this.states[id]?.state)) continue;
      worker.controller.abort();
      await worker.promise;
      this.workers.delete(id);
      delete this.states[id];
      this.capabilities.delete(id);
    }
    this.start();
  }
  async stop() {
    for (const timer of this.albumTimers.values()) clearTimeout(timer);
    this.albumTimers.clear();
    const workers = [...this.workers.values()];
    workers.forEach(worker => worker.controller.abort());
    await Promise.allSettled(workers.map(worker => worker.promise));
    this.workers.clear();
    this.states = {};
  }
  async poll(bot, signal) {
    const lockFile = path.join(os.tmpdir(), `eterx-telegram-${digest(bot.token).slice(0, 24)}.lock`);
    let lock;
    try {
      try { lock = fs.openSync(lockFile, 'wx', 0o600); }
      catch {
        let active = true;
        try { const pid = Number(fs.readFileSync(lockFile, 'utf8')); process.kill(pid, 0); } catch (error) { active = error.code !== 'ESRCH'; }
        if (active) throw new Error('This bot is connected in another EterX process. Close that connection first.');
        fs.unlinkSync(lockFile);
        lock = fs.openSync(lockFile, 'wx', 0o600);
      }
      fs.writeFileSync(lock, String(process.pid));
      let ready = false;
      while (!signal.aborted) {
        try {
          if (!ready) {
            this.setState(bot.id, 'connecting');
            this.capabilities.set(bot.id, await telegramApi(bot.token, 'getMe', {}, signal));
            const webhook = await telegramApi(bot.token, 'getWebhookInfo', {}, signal);
            if (webhook.url) throw Object.assign(new Error('This bot has an active webhook. Remove its previous connection before connecting to EterX.'), { code: 409 });
            await telegramApi(bot.token, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }, signal);
            ready = true;
            for (const [key, group] of Object.entries(this.data.mediaGroups)) if (group.event.botId === bot.id) this.scheduleAlbum(key);
          }
          this.setState(bot.id, 'connected');
          const updates = await telegramApi(bot.token, 'getUpdates', { offset: this.data.offsets[bot.id] || 0, timeout: 25, allowed_updates: ['message', 'callback_query', 'poll_answer'] }, signal);
          for (const update of updates) {
            if (signal.aborted) break;
            await this.receive(bot, update);
            this.data.offsets[bot.id] = Number(update.update_id) + 1;
            this.persist();
          }
        } catch (error) {
          if (signal.aborted) break;
          this.setState(bot.id, [401, 404, 409].includes(error.code) ? 'needs-attention' : 'reconnecting', error.message);
          if ([401, 404, 409].includes(error.code)) break;
          await new Promise(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, Math.min(60000, Math.max(3000, (error.retryAfter || 0) * 1000))); signal.addEventListener('abort', done, { once: true }); });
        }
      }
    } finally {
      if (lock !== undefined) { fs.closeSync(lock); try { fs.unlinkSync(lockFile); } catch {} }
    }
  }
  session(bot, message) {
    const key = `${bot.id}:${message.chat.id}:${message.message_thread_id || 0}`;
    if (!this.data.sessions[key]) this.data.sessions[key] = { active: 1, chats: [{ number: 1, id: crypto.randomUUID(), title: 'First conversation' }] };
    return this.data.sessions[key];
  }
  rememberReply(target, messageId, extra = {}) {
    if (!messageId || !target.conversationId) return;
    const key = `${target.botId}:${target.chatId}:${messageId}`;
    this.data.replies[key] = { conversationId: target.conversationId, target, ...extra };
    const keys = Object.keys(this.data.replies);
    for (const old of keys.slice(0, Math.max(0, keys.length - 5000))) delete this.data.replies[old];
    this.persist();
  }
  async receive(bot, update) {
    if (update.callback_query || update.poll_answer) return this.receiveAnswer(bot, update);
    const message = update.message;
    // Local computer access is restricted to the explicitly paired private user.
    if (!message || message.from?.is_bot || message.chat?.type !== 'private') return;
    const target = { botId: bot.id, chatId: String(message.chat.id), threadId: message.message_thread_id ? String(message.message_thread_id) : undefined };
    const text = String(message.text || message.caption || '').trim();
    const owner = this.data.owners[bot.id];
    const pairing = this.pairings.get(bot.id);
    if (!owner && text.startsWith('/start pair_') && pairing?.expiresAt > Date.now() && digest(text.slice(12)) === pairing.hash) {
      this.data.owners[bot.id] = { id: String(message.from.id), chatId: String(message.chat.id), name: [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') };
      this.pairings.delete(bot.id);
      this.persist();
      await this.send(target, `You’re connected to ${bot.name}. Send me a task, photo, or document. I work with EterX on your computer. Use /new for another conversation or /help for commands.`);
      this.daemon.publishStatus();
      return;
    }
    if (!owner || owner.id !== String(message.from.id)) return;
    const session = this.session(bot, message);
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.replace(new RegExp(`@${bot.username}$`, 'i'), '');
    if (['/start', '/help'].includes(command)) {
      await this.send(target, `${bot.name}\n${bot.instructions ? bot.instructions.slice(0, 500) + '\n\n' : ''}Send a task, image, or file. I use your selected EterX agent and its connected tools on your computer.\n\n${COMMANDS.map(([name, label]) => `/${name} — ${label}`).join('\n')}\n\nKeep this computer awake, online, and EterX running. Conversations live here; private working context is saved on your computer.`); return;
    }
    if (command === '/settings') { await this.send(target, `${bot.name}\nModel: ${bot.model.provider} / ${bot.model.modelId}\nAgent: ${bot.agentType}\nDevice: ${os.hostname()} (${os.platform()})\nEdit in EterX → Channels → Connect as bot.`); return; }
    if (command === '/steer' && !rest.length) { await this.send(target, 'Use /steer followed by your guidance to change direction while a question is waiting. Otherwise, just send a message while I work.'); return; }
    if (command === '/new') {
      if (this.capabilities.get(bot.id)?.has_topics_enabled) {
        const name = rest.join(' ').slice(0, 128) || 'New conversation';
        const topic = await telegramApi(bot.token, 'createForumTopic', { chat_id: target.chatId, name });
        this.session(bot, { chat: message.chat, message_thread_id: topic.message_thread_id }).chats[0].title = name;
        this.persist();
        await this.send({ ...target, threadId: String(topic.message_thread_id) }, `Ready when you are. What would you like to work on?`);
        return;
      }
      if (session.chats.length >= 100) { await this.send(target, 'This bot has 100 conversations. Use /chats and /switch to continue an existing one.'); return; }
      const number = Math.max(...session.chats.map(chat => chat.number)) + 1;
      session.chats.push({ number, id: crypto.randomUUID(), title: rest.join(' ').slice(0, 80) || `Conversation ${number}` });
      session.active = number; this.persist();
      await this.send(target, `Started conversation ${number}: ${session.chats.at(-1).title}. Earlier work continues in its own conversation. Use /switch ${number} to return here.`); return;
    }
    if (command === '/chats') { await this.send(target, session.chats.map(chat => `${chat.number === session.active ? '→ ' : ''}${chat.number}. ${chat.title}`).join('\n') + '\n\nUse /switch followed by a number.'); return; }
    if (command === '/switch') {
      const chat = session.chats.find(item => item.number === Number(rest[0]));
      if (chat) { session.active = chat.number; this.persist(); }
      await this.send(target, chat ? `Switched to ${chat.number}. ${chat.title}` : 'Conversation not found. Use /chats to see available numbers.'); return;
    }
    const active = session.chats.find(chat => chat.number === session.active);
    const [event] = normalizeGatewayPayload('telegram', update);
    if (!event || (!text && !event.attachments.length)) return;
    event.id = `tbot_${bot.id}_${update.update_id}`;
    event.dedupeKey = event.id;
    event.botId = bot.id;
    event.conversationId = `tbot_${digest(`${bot.id}:${message.from.id}:${message.message_thread_id || 0}:${active.id}`).slice(0, 40)}`;
    event.sessionKey = event.conversationId;
    event.replyTarget = { ...target, conversationNumber: String(active.number), conversationId: event.conversationId };
    event.metadata = { ...event.metadata, botId: bot.id, telegramMessageId: message.message_id, conversationNumber: active.number, conversationTitle: active.title,
      ...(message.quote?.text ? { quotedText: String(message.quote.text).slice(0, 2000) } : {}),
      ...(message.media_group_id ? { mediaGroupId: String(message.media_group_id) } : {}) };
    if (command !== rawCommand) event.text = [command, ...rest].join(' ');
    if (command === '/steer') { event.text = rest.join(' '); event.metadata.forceSteering = true; }
    const reply = this.data.replies[`${bot.id}:${target.chatId}:${message.reply_to_message?.message_id}`];
    if (reply) {
      event.conversationId = reply.conversationId; event.sessionKey = reply.conversationId; event.replyTarget = reply.target;
      if (reply.responseKey) event.metadata.responseKey = reply.responseKey;
      if (reply.deliveredFile) event.metadata.replyFile = reply.deliveredFile;
    }
    const question = Object.values(this.data.questions).find(item => item.botId === bot.id && item.messageId === message.reply_to_message?.message_id);
    if (question) { event.conversationId = question.conversationId; event.sessionKey = question.conversationId; event.metadata.responseKey = question.responseKey; event.replyTarget = question.target; }
    // Native replies identify the task without inserting conversation labels
    // into the bot's prose. A reply can still route to an older virtual chat.
    event.replyTarget = { ...event.replyTarget, messageId: String(event.replyTarget.threadId || '') === String(target.threadId || '') ? String(message.message_id) : undefined };
    if (message.media_group_id && event.attachments.length) {
      const key = `${bot.id}:${target.chatId}:${message.media_group_id}`;
      const group = this.data.mediaGroups[key];
      if (group) {
        if (!group.eventIds.includes(event.id)) {
          group.eventIds.push(event.id);
          group.event.attachments.push(...event.attachments.filter(item => !group.event.attachments.some(existing => existing.id === item.id)));
          if (event.text && !group.captions.includes(event.text)) { group.captions.push(event.text); group.event.text = group.captions.join('\n\n'); }
          // Captions/replies may arrive on a later member of the same album.
          if (reply || question) { group.event.conversationId = event.conversationId; group.event.sessionKey = event.sessionKey; group.event.replyTarget = event.replyTarget; group.event.metadata.responseKey = event.metadata.responseKey; if (event.metadata.replyFile) group.event.metadata.replyFile = event.metadata.replyFile; }
          group.updatedAt = Date.now();
        }
      } else this.data.mediaGroups[key] = { event, eventIds: [event.id], captions: event.text ? [event.text] : [], createdAt: Date.now(), updatedAt: Date.now() };
      // Persist before the update offset advances; a restart resumes assembly.
      this.persist(); this.scheduleAlbum(key); return;
    }
    if (this.daemon.store.append(event).accepted) { this.daemon.onEvent(event); this.daemon.lastEventAt = Date.now(); }
  }
  scheduleAlbum(key) {
    if (this.albumTimers.has(key)) clearTimeout(this.albumTimers.get(key));
    const group = this.data.mediaGroups[key];
    if (!group) return;
    const delay = Math.max(0, Math.min(group.updatedAt + 1200, group.createdAt + 4000) - Date.now());
    const timer = setTimeout(() => {
      this.albumTimers.delete(key);
      const buffered = this.data.mediaGroups[key];
      if (!buffered || this.workers.get(buffered.event.botId)?.controller.signal.aborted) return;
      try {
        this.authorizedTarget(buffered.event.replyTarget);
        if (this.daemon.store.append(buffered.event).accepted) { this.daemon.onEvent(buffered.event); this.daemon.lastEventAt = Date.now(); }
        delete this.data.mediaGroups[key]; this.persist();
      } catch (error) {
        if (!['BOT_DISABLED', 'BOT_NOT_PAIRED'].includes(error.code)) {
          buffered.updatedAt = Date.now(); buffered.createdAt = Date.now(); this.scheduleAlbum(key);
        }
      }
    }, delay);
    timer.unref?.(); this.albumTimers.set(key, timer);
  }
  authorizedTarget(target) {
    const bot = this.get(String(target.botId));
    const owner = this.data.owners[bot?.id];
    if (!bot?.enabled) throw Object.assign(new Error('This bot is paused or disconnected.'), { statusCode: 403, code: 'BOT_DISABLED' });
    if (!owner || String(owner.chatId) !== String(target.chatId)) throw Object.assign(new Error('This Telegram recipient is not paired.'), { statusCode: 403, code: 'BOT_NOT_PAIRED' });
    return bot;
  }
  async send(target, text, delivery) {
    const bot = this.authorizedTarget(target);
    const results = [];
    let sent = Number(delivery?.metadata?.telegramPartsSent) || 0;
    let parts = delivery?.metadata?.telegramFormattedParts;
    if (!Array.isArray(parts)) {
      // Preserve the unsent remainder of deliveries created by older builds.
      const remaining = sent ? Array.from(String(text)).slice(sent * 3500).join('') : String(text);
      parts = formatTelegramText(remaining);
      sent = 0;
      if (delivery) this.daemon.store.updateDelivery(delivery.id, { metadata: { ...delivery.metadata, telegramFormattedParts: parts, telegramPartsSent: 0 } });
    }
    for (let i = sent; i < parts.length; i++) {
      const result = await this.sendText(bot, 'sendMessage', { chat_id: target.chatId, message_thread_id: target.threadId ? Number(target.threadId) : undefined, ...parts[i], link_preview_options: { is_disabled: true }, ...(i === 0 ? { reply_parameters: replyParameters(target) } : {}) });
      results.push(result);
      this.rememberReply(target, result.message_id);
      if (delivery) this.daemon.store.updateDelivery(delivery.id, { metadata: { ...delivery.metadata, telegramPartsSent: i + 1 } });
    }
    return results;
  }
  async typing(target) { const bot = this.authorizedTarget(target); return telegramApi(bot.token, 'sendChatAction', { chat_id: target.chatId, action: 'typing', message_thread_id: target.threadId ? Number(target.threadId) : undefined }); }
  async sendText(bot, method, body) {
    try { return await telegramApi(bot.token, method, body); }
    catch (error) {
      if (Number(error.code) !== 400 || !/can't parse entities|unsupported url protocol|entity bounds|entity length/i.test(error.message)) throw error;
      // Formatting must never strand an otherwise valid answer. Telegram
      // rejected this request before accepting it, so plain-text fallback is safe.
      return telegramApi(bot.token, method, { ...body, entities: [] });
    }
  }
  async progress(target, text, messageId, options = {}) {
    const key = `${target.botId}:${target.chatId}:${target.conversationId}:${options.progress_key || messageId || 'progress'}`;
    const previous = this.progressRequests.get(key) || Promise.resolve();
    const request = previous.catch(() => undefined).then(() => this.updateProgress(target, text, messageId, options));
    this.progressRequests.set(key, request);
    try { return await request; }
    finally { if (this.progressRequests.get(key) === request) this.progressRequests.delete(key); }
  }
  async updateProgress(target, text, messageId, options = {}) {
    const bot = this.authorizedTarget(target);
    const key = options.progress_key ? digest(`${bot.id}:${target.chatId}:${target.conversationId}:${options.progress_key}`) : null;
    const ids = [...(key && this.data.progress[key]?.ids || options.message_ids || (messageId ? [messageId] : []))];
    const parts = options.clear ? [] : formatTelegramText(String(text));
    const remember = () => {
      if (!key) return;
      this.data.progress[key] = { ids, updatedAt: Date.now() };
      const keys = Object.keys(this.data.progress).sort((a, b) => this.data.progress[a].updatedAt - this.data.progress[b].updatedAt);
      for (const old of keys.slice(0, Math.max(0, keys.length - 400))) delete this.data.progress[old];
      this.persist();
    };
    for (let i = 0; i < parts.length; i++) {
      const reply_markup = options.controls && i === parts.length - 1 ? { inline_keyboard: [[{ text: 'Latest update', callback_data: 'work:peek' }, { text: 'Stop', callback_data: 'work:stop' }]] } : { inline_keyboard: [] };
      const body = { chat_id: target.chatId, ...parts[i], reply_markup, link_preview_options: { is_disabled: true },
        ...(ids[i] ? { message_id: ids[i] } : { message_thread_id: target.threadId ? Number(target.threadId) : undefined, disable_notification: true, ...(i === 0 ? { reply_parameters: replyParameters(target) } : {}) }) };
      try {
        const result = await this.sendText(bot, ids[i] ? 'editMessageText' : 'sendMessage', body);
        ids[i] = result.message_id;
      } catch (error) {
        if (/message is not modified/i.test(error.message)) continue;
        // Deleted/old bubbles can be replaced; network failures must not create duplicates.
        if (!ids[i] || !/message to edit not found|message can't be edited/i.test(error.message)) throw error;
        delete body.message_id;
        const result = await this.sendText(bot, 'sendMessage', { ...body, message_thread_id: target.threadId ? Number(target.threadId) : undefined, disable_notification: true, ...(i === 0 ? { reply_parameters: replyParameters(target) } : {}) });
        ids[i] = result.message_id;
      }
      this.rememberReply(target, ids[i], options.run_id ? { runId: options.run_id } : {}); remember();
    }
    for (const old of ids.slice(parts.length)) {
      await telegramApi(bot.token, 'deleteMessage', { chat_id: target.chatId, message_id: old }).catch(async () => {
        await telegramApi(bot.token, 'editMessageText', { chat_id: target.chatId, message_id: old, text: options.clear ? 'Work status closed. See the latest message below.' : 'Update continued above.', reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      });
    }
    ids.length = parts.length; remember();
    return { message_id: ids[0], message_ids: ids };
  }
  async question(target, question, conversationId) {
    const bot = this.authorizedTarget(target);
    const existing = Object.entries(this.data.questions).find(([, item]) => item.botId === bot.id && item.responseKey === question.responseKey && item.expiresAt > Date.now());
    if (existing) { await this.ensureQuestionSubmit(bot, existing[1], existing[0]); return { message_id: existing[1].messageId }; }
    const key = crypto.randomBytes(12).toString('hex');
    const options = question.mode === 'confirm' ? [{ label: 'Approve', value: 'yes' }, { label: 'Decline', value: 'no' }] : (question.options || []).slice(0, 8);
    const heading = renderTelegramText(question.question || 'A few details before I continue').text || 'A few details before I continue';
    let result;
    const details = [question.context, ...options.filter(item => item.description).map(item => `${item.label}: ${item.description}`)].filter(Boolean).join('\n\n');
    const usePoll = (question.mode === 'multi_select' || question.mode === 'choice' && options.length > 5)
      && options.length >= 2 && heading.length <= 300 && options.every(item => String(item.label).length <= 100);
    if (usePoll) {
      if (details) await this.send(target, details);
      result = await telegramApi(bot.token, 'sendPoll', { chat_id: target.chatId, message_thread_id: target.threadId ? Number(target.threadId) : undefined, reply_parameters: replyParameters(target), question: heading, options: options.map(item => ({ text: String(item.label).slice(0, 100) })), is_anonymous: false, allows_multiple_answers: question.mode === 'multi_select', open_period: 300 });
    } else {
      const groups = (question.questions || []).map((item, index) => `${index + 1}. ${item.question}${item.context ? '\n' + item.context : ''}${item.options?.length ? '\n' + item.options.map(option => `${option.label}${option.description ? ': ' + option.description : ''}`).join(' / ') : ''}`).join('\n\n');
      const content = `${heading}${details ? '\n\n' + details : ''}${groups ? '\n\n' + groups : ''}${question.mode === 'multi_select' ? '\n\n' + options.map((item, index) => `${index + 1}. ${item.label}`).join('\n') : ''}\n\n${options.length && question.mode !== 'multi_select' ? 'Tap an option or reply with your answer.' : `Reply to this message${groups ? ' with one answer per line' : question.mode === 'multi_select' ? ' with the option numbers, separated by commas' : ' with your answer'}.`}`;
      const parts = formatTelegramText(content);
      for (let i = 0; i < parts.length; i++) {
        result = await this.sendText(bot, 'sendMessage', { chat_id: target.chatId, message_thread_id: target.threadId ? Number(target.threadId) : undefined, ...parts[i], link_preview_options: { is_disabled: true }, ...(i === 0 ? { reply_parameters: replyParameters(target) } : {}),
          ...(i === parts.length - 1 ? { reply_markup: options.length && question.mode !== 'multi_select' ? { inline_keyboard: options.map((item, index) => [{ text: Array.from(String(item.label)).slice(0, 64).join(''), callback_data: `q:${key}:${index}` }]) } : { force_reply: true, selective: true, input_field_placeholder: groups ? 'One answer per line' : 'Your answer' } } : {}),
        });
        this.rememberReply({ ...target, conversationId }, result.message_id, { responseKey: question.responseKey });
      }
    }
    for (const [id, value] of Object.entries(this.data.questions)) if (value.expiresAt < Date.now()) delete this.data.questions[id];
    this.data.questions[key] = { botId: bot.id, conversationId, responseKey: question.responseKey, target, options, mode: question.mode, messageId: result.message_id, pollId: result.poll?.id, expiresAt: Date.now() + 5 * 60 * 1000 };
    this.rememberReply({ ...target, conversationId }, result.message_id, { responseKey: question.responseKey });
    await this.ensureQuestionSubmit(bot, this.data.questions[key], key);
    this.persist();
    return result;
  }
  async ensureQuestionSubmit(bot, question, key) {
    if (!question.pollId || question.mode !== 'multi_select' || question.selectionMessageId || question.answered) return;
    const target = question.target;
    const submit = await telegramApi(bot.token, 'sendMessage', { chat_id: target.chatId, message_thread_id: target.threadId ? Number(target.threadId) : undefined, text: 'Select your answers in the poll, then tap Submit answers. You can also reply here in your own words.', reply_markup: { inline_keyboard: [[{ text: 'Submit answers', callback_data: `q:${key}:done` }]] } });
    question.selectionMessageId = submit.message_id;
    this.rememberReply({ ...target, conversationId: question.conversationId }, submit.message_id, { responseKey: question.responseKey });
    this.persist();
  }
  async receiveAnswer(bot, update) {
    const callback = update.callback_query;
    const vote = update.poll_answer;
    const owner = this.data.owners[bot.id];
    const actor = callback?.from || vote?.user;
    if (!owner || String(actor?.id) !== owner.id) return;
    if (callback && String(callback.message?.chat?.id) !== String(owner.chatId)) return;
    if (callback && /^work:(peek|stop)$/.test(callback.data || '')) {
      const reply = this.data.replies[`${bot.id}:${owner.chatId}:${callback.message?.message_id}`];
      await telegramApi(bot.token, 'answerCallbackQuery', { callback_query_id: callback.id, text: reply ? 'Request received' : 'Use /peek or /stop in the conversation.' });
      if (!reply) return;
      const event = { id: `tbot_${bot.id}_${update.update_id}`, dedupeKey: `tbot_${bot.id}_${update.update_id}`, botId: bot.id, platform: 'telegram', kind: 'message',
        conversationId: reply.conversationId, sessionKey: reply.conversationId, actor: { id: owner.id, displayName: owner.name }, text: callback.data === 'work:stop' ? '/stop' : '/peek',
        receivedAt: Date.now(), attachments: [], replyTarget: reply.target, metadata: { botId: bot.id, updateId: update.update_id, targetRunId: reply.runId } };
      if (this.daemon.store.append(event).accepted) this.daemon.onEvent(event);
      return;
    }
    const [, key, index] = String(callback?.data || '').split(':');
    const question = callback ? this.data.questions[key] : Object.values(this.data.questions).find(item => item.pollId === vote?.poll_id);
    const active = question && question.botId === bot.id && !question.answered && question.expiresAt > Date.now();
    if (!active) {
      if (callback) await telegramApi(bot.token, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'This question was answered or expired. Send a message to continue.' });
      return;
    }
    if (vote && question.mode === 'multi_select') { question.selection = vote.option_ids || []; this.persist(); return; }
    const selected = index === 'done' ? (question.selection || []).map(i => question.options[i]).filter(Boolean) : [question.options[callback ? Number(index) : vote.option_ids?.[0]]].filter(Boolean);
    if (callback) await telegramApi(bot.token, 'answerCallbackQuery', { callback_query_id: callback.id, text: selected.length ? 'Answer received' : 'Choose an answer in the poll first.' });
    if (!selected.length) return;
    const option = selected[0];
    const event = { id: `tbot_${bot.id}_${update.update_id}`, dedupeKey: `tbot_${bot.id}_${update.update_id}`, botId: bot.id, platform: 'telegram', kind: 'message',
      conversationId: question.conversationId, sessionKey: question.conversationId, actor: { id: owner.id, displayName: owner.name },
      text: selected.map(item => String(item.value || item.label)).join(', '), receivedAt: Date.now(), attachments: [], replyTarget: question.target,
      metadata: { responseKey: question.responseKey, selectedOption: question.mode === 'multi_select' ? selected : option, botId: bot.id } };
    if (this.daemon.store.append(event).accepted) this.daemon.onEvent(event);
  }
  async resolveQuestion(target, responseKey) {
    const bot = this.authorizedTarget(target);
    const question = Object.values(this.data.questions).find(item => item.botId === bot.id && item.responseKey === responseKey);
    if (!question || question.closed) return { ok: true };
    question.answered = true; this.persist();
    const alreadyClosed = error => { if (!/already closed|message is not modified|message to edit not found|message with poll to stop not found/i.test(error.message)) throw error; };
    if (question.pollId) await telegramApi(bot.token, 'stopPoll', { chat_id: target.chatId, message_id: question.messageId }).catch(alreadyClosed);
    if (!question.pollId || question.selectionMessageId) await telegramApi(bot.token, 'editMessageReplyMarkup', { chat_id: target.chatId, message_id: question.selectionMessageId || question.messageId, reply_markup: { inline_keyboard: [] } }).catch(alreadyClosed);
    question.closed = true; this.persist();
    return { ok: true };
  }
  async download(event) {
    const bot = this.authorizedTarget(event.replyTarget);
    const folder = path.join(this.daemon.dataDir, 'bot-attachments', bot.id);
    fs.mkdirSync(folder, { recursive: true });
    const attachments = [];
    for (const item of event.attachments || []) {
      const info = await telegramApi(bot.token, 'getFile', { file_id: item.id });
      if (Number(info.file_size) > 20 * 1024 * 1024) throw new Error('Telegram bot downloads are limited to 20 MB. Send a smaller file.');
      if (!info.file_path || !/^[a-zA-Z0-9_./-]+$/.test(info.file_path)) throw new Error('Telegram returned an invalid file path.');
      const response = await telegramFetch(`https://api.telegram.org/file/bot${bot.token}/${info.file_path}`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw new Error('Could not download the Telegram attachment.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Attachment exceeds 20 MB.'); chunks.push(chunk); }
      const name = String(item.name || path.basename(info.file_path)).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-120);
      const localPath = path.join(folder, `${digest(item.id).slice(0, 20)}-${name}`);
      fs.writeFileSync(localPath, Buffer.concat(chunks), { mode: 0o600 });
      attachments.push({ ...item, name, path: localPath, localPath, size, mimeType: item.mimeType || (item.type === 'image' ? 'image/jpeg' : undefined) });
    }
    return attachments;
  }
  async sendFile(target, filePath, caption = '', asPhoto = false, mediaType = 'document') {
    const bot = this.authorizedTarget(target);
    const file = await this.prepareFile(filePath, asPhoto, mediaType);
    const form = new FormData();
    form.set('chat_id', String(target.chatId));
    if (target.threadId) form.set('message_thread_id', String(target.threadId));
    if (replyParameters(target)) form.set('reply_parameters', JSON.stringify(replyParameters(target)));
    const captions = formatTelegramText(caption, 1000);
    if (captions[0]) { form.set('caption', captions[0].text); form.set('caption_entities', JSON.stringify(captions[0].entities)); }
    form.set(file.kind, new Blob([file.bytes]), path.basename(filePath));
    if (file.kind === 'video') form.set('supports_streaming', 'true');
    let result;
    try { result = await telegramApi(bot.token, { photo: 'sendPhoto', document: 'sendDocument', video: 'sendVideo', audio: 'sendAudio' }[file.kind], form); }
    catch (error) {
      if (file.kind !== 'photo' || !/PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID/i.test(error.message)) throw error;
      form.delete('photo'); form.set('document', new Blob([file.bytes]), path.basename(filePath));
      result = await telegramApi(bot.token, 'sendDocument', form);
    }
    const deliveredFile = { path: filePath, size: file.size, mtimeMs: file.mtimeMs, messageId: result.message_id };
    this.rememberReply(target, result.message_id, { deliveredFile });
    return { ...result, eterx_file: deliveredFile, caption_truncated: captions.length > 1 };
  }
  async prepareFile(filePath, asPhoto, mediaType) {
    if (!path.isAbsolute(filePath)) throw new Error('Provide an absolute file path.');
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error('Choose a file of at most 50 MB for Telegram.');
    const photo = asPhoto && stat.size <= 10 * 1024 * 1024 && /\.(png|jpe?g|webp)$/i.test(filePath);
    const kind = photo ? 'photo' : mediaType === 'video' && /\.mp4$/i.test(filePath) ? 'video' : mediaType === 'audio' && /\.(mp3|m4a)$/i.test(filePath) ? 'audio' : 'document';
    const bytes = await fs.promises.readFile(filePath);
    if (bytes.length > 50 * 1024 * 1024 || bytes.length !== stat.size) throw new Error('The file changed while preparing it. Finish saving it before sharing.');
    return { path: filePath, kind, bytes, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  async sendFiles(target, filePaths, caption = '', asPhoto = false, mediaType = 'document') {
    const bot = this.authorizedTarget(target);
    if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > 10) throw new Error('Provide one to ten absolute file paths.');
    if (filePaths.length === 1) return [await this.sendFile(target, filePaths[0], caption, asPhoto, mediaType)];
    const files = [];
    // Validate the whole album before any upload, with a bounded memory budget.
    let total = 0;
    for (const filePath of filePaths) {
      const file = await this.prepareFile(String(filePath), asPhoto, mediaType);
      total += file.size;
      if (total > 100 * 1024 * 1024) throw new Error('Keep each album under 100 MB. Send large files individually.');
      files.push(file);
    }
    const types = new Set(files.map(file => file.kind));
    if (types.size > 1 && (types.has('document') || types.has('audio'))) throw new Error('Group documents or audio with files of the same type. Send previews separately, or use as_photo=false and media_type=document for all originals.');
    const form = new FormData();
    form.set('chat_id', String(target.chatId));
    if (target.threadId) form.set('message_thread_id', String(target.threadId));
    if (replyParameters(target)) form.set('reply_parameters', JSON.stringify(replyParameters(target)));
    const captions = formatTelegramText(caption, 1000);
    form.set('media', JSON.stringify(files.map((file, i) => {
      form.set(`file${i}`, new Blob([file.bytes]), path.basename(file.path));
      return { type: file.kind, media: `attach://file${i}`, ...(i === 0 && captions[0] ? { caption: captions[0].text, caption_entities: captions[0].entities } : {}), ...(file.kind === 'video' ? { supports_streaming: true } : {}) };
    })));
    const messages = await telegramApi(bot.token, 'sendMediaGroup', form);
    return messages.map((message, i) => {
      const deliveredFile = { path: files[i].path, size: files[i].size, mtimeMs: files[i].mtimeMs, messageId: message.message_id };
      this.rememberReply(target, message.message_id, { deliveredFile });
      return { ...message, eterx_file: deliveredFile, caption_truncated: i === 0 && captions.length > 1 };
    });
  }
}

module.exports = { TelegramBots, normalizeBots, publicBot, telegramApi };
