'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocketClient = globalThis.WebSocket || require('ws');
const { GatewayStore } = require('./store.cjs');
const { GatewayAdapterRegistry } = require('./registry.cjs');
const { buildGatewaySessionKey, GatewaySessionLanes } = require('./session.cjs');
const { GatewayHookBus } = require('./hooks.cjs');
const { EmailGatewayAdapter, sendEmailMessage } = require('./email.cjs');
const { TelegramBots, normalizeBots, publicBot } = require('./telegram-bots.cjs');
const { selectChannelProfile, canDispatchChannel } = require('./routing.cjs');
const { normalizeTelegramToken } = require('./telegram-token.cjs');
const { telegramApi } = require('./telegram-api.cjs');
const { formatTelegramText } = require('./telegram-presentation.cjs');

const PLATFORMS = ['telegram', 'whatsapp', 'messenger', 'email', 'discord', 'signal', 'generic'];
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  keepRunningOnClose: true,
  keepActiveChatsOnClose: true,
  runScheduledTasksInBackground: true,
  launchAtLogin: false,
  host: '127.0.0.1',
  port: 47821,
  autoDispatch: false,
  busyInputMode: 'queue',
  mcpBridgeEnabled: true,
  telegramBots: [],
  channelAgent: {
    enabled: true,
    defaultProfileId: 'channel-operator',
    profiles: [{
      id: 'channel-operator',
      name: 'Channel operator',
      role: 'custom',
      objective: 'Help the user inspect and act on connected conversations when asked.',
      instructions: '',
      channels: [],
      operatingMode: 'manual',
      readPolicy: 'on-demand',
      sendPolicy: 'direct',
      escalationRules: 'Escalate pricing commitments, legal or security issues, angry customers, and anything outside the configured objective.',
      responseStyle: 'Clear, concise, human, and appropriate for the channel.',
      pollIntervalMinutes: 5,
    }],
  },
  platforms: {
    telegram: { enabled: false, mode: 'polling', accessPolicy: 'pairing', groupSessionsPerUser: true, allowlist: [] },
    whatsapp: { enabled: false, mode: 'webhook', apiVersion: 'v23.0', accessPolicy: 'pairing', groupSessionsPerUser: true, allowlist: [] },
    messenger: { enabled: false, mode: 'webhook', apiVersion: 'v23.0', accessPolicy: 'pairing', groupSessionsPerUser: true, allowlist: [] },
    email: { enabled: false, mode: 'polling', accessPolicy: 'pairing', groupSessionsPerUser: false, allowlist: [], imapPort: 993, smtpPort: 587, pollInterval: 15, imapSecure: true, smtpSecure: false },
    discord: { enabled: false, mode: 'gateway', accessPolicy: 'pairing', groupSessionsPerUser: true, allowlist: [] },
    signal: { enabled: false, mode: 'bridge', endpoint: 'http://127.0.0.1:8080', accessPolicy: 'pairing', groupSessionsPerUser: true, allowlist: [] },
    generic: { enabled: false, mode: 'webhook', accessPolicy: 'allowlist', groupSessionsPerUser: true, allowlist: [] },
  },
});

const MCP_TOOLS = [
  ['conversations_list', 'List persistent gateway conversations.', { platform: { type: 'string' }, search: { type: 'string' } }],
  ['conversation_get', 'Get one conversation and its recent messages.', { conversation_id: { type: 'string' } }, ['conversation_id']],
  ['messages_read', 'Read recent messages from a conversation.', { conversation_id: { type: 'string' }, limit: { type: 'number' } }, ['conversation_id']],
  ['attachments_fetch', 'List attachments from one stored message.', { message_id: { type: 'string' } }, ['message_id']],
  ['events_poll', 'Poll normalized gateway events after a cursor.', { after_cursor: { type: 'number' }, limit: { type: 'number' } }],
  ['events_wait', 'Wait for the next normalized gateway event.', { after_cursor: { type: 'number' }, timeout_ms: { type: 'number' } }],
  ['messages_send', 'Send a text message through a connected platform.', { platform: { type: 'string' }, target: { type: 'object' }, text: { type: 'string' } }, ['platform', 'target', 'text']],
  ['channels_list', 'List configured messaging transports and their connection state.', {}],
  ['permissions_list_open', 'List pending gateway pairing approvals.', {}],
  ['permissions_respond', 'Approve or deny a pending pairing request.', { identity_id: { type: 'string' }, approved: { type: 'boolean' } }, ['identity_id', 'approved']],
  ['agent_profile_get', 'Load an on-demand channel-agent profile and its operating policy.', { profile_id: { type: 'string' }, platform: { type: 'string' } }],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false } }));

function normalizeChannelAgent(raw = {}) {
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : DEFAULT_CONFIG.channelAgent.profiles).slice(0, 50).map((item, index) => {
    const fallback = DEFAULT_CONFIG.channelAgent.profiles[0];
    const id = String(item?.id || `channel-agent-${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || `channel-agent-${index + 1}`;
    return {
      id,
      name: String(item?.name || id).trim().slice(0, 120),
      role: ['sales', 'support', 'operations', 'custom'].includes(item?.role) ? item.role : 'custom',
      objective: String(item?.objective || fallback.objective).trim().slice(0, 4000),
      instructions: String(item?.instructions || '').trim().slice(0, 12000),
      channels: Array.isArray(item?.channels) ? [...new Set(item.channels.map((value) => String(value).trim().toLowerCase()).filter((value) => PLATFORMS.includes(value)))].slice(0, PLATFORMS.length) : [],
      operatingMode: ['manual', 'assist', 'autonomous'].includes(item?.operatingMode) ? item.operatingMode : 'manual',
      readPolicy: ['on-demand', 'unread', 'all'].includes(item?.readPolicy) ? item.readPolicy : 'on-demand',
      // Older ask-before-send profiles migrate to direct sending. Pairing
      // approval remains separate from message delivery authorization.
      sendPolicy: item?.sendPolicy === 'draft-only' ? 'draft-only' : item?.sendPolicy === 'autonomous' ? 'autonomous' : 'direct',
      escalationRules: String(item?.escalationRules || fallback.escalationRules).trim().slice(0, 4000),
      responseStyle: String(item?.responseStyle || fallback.responseStyle).trim().slice(0, 2000),
      pollIntervalMinutes: Math.max(1, Math.min(1440, Number(item?.pollIntervalMinutes) || 5)),
    };
  });
  const safeProfiles = profiles.length ? profiles : DEFAULT_CONFIG.channelAgent.profiles.map((item) => ({ ...item }));
  const requestedDefault = String(raw.defaultProfileId || '').trim();
  return {
    enabled: raw.enabled !== false,
    defaultProfileId: safeProfiles.some((item) => item.id === requestedDefault) ? requestedDefault : safeProfiles[0].id,
    profiles: safeProfiles,
  };
}

function mergeConfig(raw = {}) {
  const port = Number(raw.port);
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    enabled: Boolean(raw.enabled),
    keepRunningOnClose: raw.keepRunningOnClose !== false,
    keepActiveChatsOnClose: raw.keepActiveChatsOnClose !== false,
    runScheduledTasksInBackground: raw.runScheduledTasksInBackground !== false,
    launchAtLogin: Boolean(raw.launchAtLogin),
    autoDispatch: raw.autoDispatch === true,
    busyInputMode: raw.busyInputMode === 'steer' ? 'steer' : 'queue',
    mcpBridgeEnabled: raw.mcpBridgeEnabled !== false,
    // Connector credentials have their own encrypted AppData vault. Never
    // duplicate them into gateway configuration or return them to a renderer.
    connectorProfiles: {},
    channelAgent: normalizeChannelAgent(raw.channelAgent || {}),
    telegramBots: normalizeBots(raw.telegramBots),
    controlToken: typeof raw.controlToken === 'string' && raw.controlToken.length >= 32 ? raw.controlToken : crypto.randomBytes(32).toString('hex'),
    host: raw.host === '0.0.0.0' || raw.host === '::' ? raw.host : '127.0.0.1',
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    platforms: {},
  };
  for (const platform of PLATFORMS) {
    config.platforms[platform] = { ...DEFAULT_CONFIG.platforms[platform], ...(raw.platforms?.[platform] || {}) };
    delete config.platforms[platform].configured;
    delete config.platforms[platform].credentials;
    config.platforms[platform].enabled = Boolean(config.platforms[platform].enabled);
    config.platforms[platform].accessPolicy = ['open', 'allowlist', 'pairing'].includes(config.platforms[platform].accessPolicy) ? config.platforms[platform].accessPolicy : DEFAULT_CONFIG.platforms[platform].accessPolicy;
    config.platforms[platform].allowlist = Array.isArray(config.platforms[platform].allowlist) ? config.platforms[platform].allowlist.map(String).slice(0, 1000) : [];
    config.platforms[platform].groupSessionsPerUser = config.platforms[platform].groupSessionsPerUser !== false;
  }
  return config;
}

function platformConfigurationError(id, settings = {}) {
  const has = key => Boolean(String(settings[key] || '').trim());
  const missing = (fields) => fields.filter(([key]) => !has(key)).map(([, label]) => label);
  let required = [];
  if (['telegram', 'discord'].includes(id)) required = [['token', 'bot token']];
  if (['whatsapp', 'messenger'].includes(id)) required = [['token', 'access token'], ['accountId', id === 'whatsapp' ? 'phone number ID' : 'Page ID'], ['appSecret', 'Meta app secret'], ['webhookSecret', 'verification token']];
  if (id === 'email') required = [['emailAddress', 'mailbox address'], ['imapHost', 'IMAP host'], ['smtpHost', 'SMTP host']];
  if (id === 'signal') required = [['endpoint', 'bridge URL'], ['accountId', 'account number']];
  if (id === 'generic') required = [['webhookSecret', 'webhook signing secret']];
  const fields = missing(required);
  if (id === 'email' && !has('password') && !has('appPassword') && !has('emailPassword')) fields.push('app password');
  if (fields.length) return `Add ${fields.join(', ')} before enabling ${id}.`;
  if (id === 'telegram') {
    try { normalizeTelegramToken(settings.token); } catch { return 'Paste a complete Telegram bot token from BotFather.'; }
  }
  if (id === 'email') {
    for (const key of ['imapPort', 'smtpPort']) {
      if (!Number.isInteger(Number(settings[key])) || Number(settings[key]) < 1 || Number(settings[key]) > 65535) return 'Email ports must be between 1 and 65535.';
    }
  }
  if (has('endpoint')) {
    try {
      const url = new URL(settings.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'Use an HTTP or HTTPS bridge URL without credentials in the address.';
    } catch { return 'Enter a complete HTTP or HTTPS bridge URL.'; }
  }
  return null;
}

function validateGatewayConfig(config) {
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a gateway port between 1024 and 65535.');
  if (!config.enabled) return;
  for (const id of PLATFORMS) {
    const settings = config.platforms?.[id];
    if (!settings?.enabled) continue;
    const error = platformConfigurationError(id, settings);
    if (error) throw new Error(error);
    if (id === 'telegram') {
      const token = normalizeTelegramToken(settings.token);
      if ((config.telegramBots || []).some(bot => bot.enabled && bot.token === token)) throw new Error('This Telegram token is already used by Connect as bot. Use a different bot token for the channel gateway.');
      settings.token = token;
    }
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readPlatformResponse(response, label) {
  let data;
  try { data = await response.json(); } catch { data = { error: `${label} returned a non-JSON response.` }; }
  if (!response.ok || data?.ok === false || data?.error) {
    const message = data?.description || data?.error?.message || data?.error || `${label} request failed (${response.status}).`;
    throw new Error(String(message));
  }
  return data;
}

function probeExistingGateway(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = http.get({
      hostname: host,
      port,
      path: '/health',
      headers: { accept: 'application/json' },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish(null);
          return;
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const isGateway = payload?.running === true
            && Number(payload.port) === Number(port)
            && payload.platforms
            && typeof payload.platforms === 'object';
          finish(isGateway ? payload : null);
        } catch {
          finish(null);
        }
      });
    });

    request.on('timeout', () => request.destroy());
    request.on('error', () => finish(null));
  });
}

class GatewayDaemon {
  constructor({ dataDir, config, onEvent, onStatus }) {
    this.config = mergeConfig(config);
    this.registry = new GatewayAdapterRegistry();
    this.lanes = new GatewaySessionLanes();
    this.hooks = new GatewayHookBus();
    this.store = new GatewayStore(dataDir);
    this.dataDir = dataDir;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.server = null;
    this.externalRunning = false;
    this.startedAt = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.pollAbort = null;
    this.telegramPollingTask = null;
    this.emailAdapter = null;
    this.telegramLockFd = null;
    this.telegramLockPath = null;
    this.configureTail = Promise.resolve();
    this.signalAbort = null;
    this.telegramOffset = 0;
    this.discordSocket = null;
    this.discordHeartbeat = null;
    this.discordReconnect = null;
    this.discordSequence = null;
    this.discordSessionId = null;
    this.discordResumeUrl = null;
    this.deliveryTimer = null;
    this.platformState = Object.fromEntries(PLATFORMS.map((id) => [id, { state: 'disabled' }]));
    this.telegramBots = new TelegramBots(this);
    this.persistControlToken();
  }

  persistControlToken() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, 'control-token'), this.config.controlToken, { encoding: 'utf8', mode: 0o600 });
      fs.writeFileSync(path.join(this.dataDir, 'control.json'), JSON.stringify({
        url: `http://${this.config.host}:${this.config.port}/control/call`,
        mcpUrl: `http://${this.config.host}:${this.config.port}/mcp`,
        token: this.config.controlToken,
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) { console.warn('[gateway] Could not persist local control token:', error?.message || error); }
  }

  publicConfig() {
    const platforms = {};
    for (const id of PLATFORMS) {
      const source = this.config.platforms[id];
      platforms[id] = {
        enabled: source.enabled,
        mode: source.mode,
        configured: !platformConfigurationError(id, source),
        credentials: Object.fromEntries(['token', 'webhookSecret', 'appSecret', 'publicKey', 'password'].map(key => [key, Boolean(source[key] || (key === 'password' && (source.appPassword || source.emailPassword)))])),
        accountId: source.accountId || '',
        apiVersion: source.apiVersion || '',
        endpoint: id === 'signal' || id === 'generic' ? source.endpoint || '' : '',
        emailAddress: id === 'email' ? source.emailAddress || '' : '',
        imapHost: id === 'email' ? source.imapHost || '' : '',
        smtpHost: id === 'email' ? source.smtpHost || '' : '',
        imapPort: id === 'email' ? Number(source.imapPort) || 993 : undefined,
        smtpPort: id === 'email' ? Number(source.smtpPort) || 587 : undefined,
        pollInterval: id === 'email' ? Number(source.pollInterval) || 15 : undefined,
        imapSecure: id === 'email' ? source.imapSecure !== false : undefined,
        smtpSecure: id === 'email' ? source.smtpSecure === true : undefined,
        accessPolicy: source.accessPolicy || 'open',
        allowlist: source.allowlist || [],
        groupSessionsPerUser: source.groupSessionsPerUser !== false,
      };
    }
    const { controlToken, connectorProfiles, ...publicSettings } = this.config;
    return { ...publicSettings, telegramBots: this.config.telegramBots.map(publicBot), mcpConfigured: Boolean(controlToken), platforms };
  }

  status() {
    return {
      running: Boolean(this.server?.listening || this.externalRunning),
      bots: this.telegramBots.status(),
      owner: this.externalRunning ? 'external' : this.server?.listening ? 'local' : 'none',
      startedAt: this.startedAt,
      host: this.config.host,
      port: this.config.port,
      eventCount: this.store.eventCount,
      conversationCount: this.store.conversations.size,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      activeSessionLanes: this.lanes.activeCount,
      pendingApprovalCount: this.store.listApprovals().filter((item) => item.status === 'pending').length,
      pendingDeliveryCount: [...this.store.deliveries.values()].filter(item => ['pending', 'sending', 'retrying'].includes(item.status)).length,
      failedDeliveryCount: [...this.store.deliveries.values()].filter(item => item.status === 'failed').length,
      lastDeliveryError: [...this.store.deliveries.values()].reverse().find(item => ['retrying', 'failed'].includes(item.status) && item.error)?.error || null,
      mcpEndpoint: this.config.mcpBridgeEnabled ? `http://${this.config.host}:${this.config.port}/mcp` : null,
      platforms: Object.fromEntries(PLATFORMS.map((id) => [id, {
        enabled: this.config.platforms[id].enabled,
        state: this.platformState[id]?.state || 'disabled',
        lastError: this.platformState[id]?.lastError,
      }])),
    };
  }

  publishStatus() { this.onStatus(this.status()); }

  canDispatch(event) { return canDispatchChannel(this.config, event); }

  async deliverAgentReply({ eventId, profileId, runId, text }) {
    const event = this.store.eventIndex.get(String(eventId || ''));
    if (!event || event.botId || event.direction === 'outbound') throw new Error('The original channel message could not be found.');
    if (!String(runId || '').trim()) throw new Error('A run identity is required for channel reply delivery.');
    const profile = selectChannelProfile(this.config.channelAgent, event.platform);
    if (!this.canDispatch(event) || !profile || profile.id !== profileId || profile.operatingMode !== 'autonomous' || profile.sendPolicy !== 'autonomous') {
      return { ok: true, suppressed: true, reason: 'The current channel policy keeps this reply as a draft.' };
    }
    const settings = this.config.platforms[event.platform];
    if (!this.store.authorize(event, settings.accessPolicy, settings.allowlist).authorized) return { ok: true, suppressed: true, reason: 'This sender is no longer approved.' };
    return this.deliverMessage(event.platform, event.replyTarget, text, { source: 'channel-agent', eventId: event.id, profileId: profile.id, conversationId: event.conversationId, deliveryKey: `agent-run:${String(runId)}` });
  }

  configure(raw) {
    const run = async () => {
      const nextConfig = mergeConfig(raw);
      const transportConfig = config => ({ enabled: config.enabled, host: config.host, port: config.port, platforms: config.platforms });
      const previousTransportConfig = transportConfig(this.config);
      const nextTransportConfig = transportConfig(nextConfig);
      if (this.server?.listening && !Object.values(this.platformState).some(state => ['conflict', 'needs-configuration'].includes(state.state)) && JSON.stringify(previousTransportConfig) === JSON.stringify(nextTransportConfig)) {
        this.config = nextConfig;
        await this.telegramBots.reconfigure();
        this.publishStatus();
        return { config: this.publicConfig(), status: this.status() };
      }
      const wasRunning = Boolean(this.server?.listening || this.externalRunning);
      await this.stop({ releaseExternal: true });
      this.config = nextConfig;
      this.persistControlToken();
      if (wasRunning || this.config.enabled) await this.start();
      this.publishStatus();
      return { config: this.publicConfig(), status: this.status() };
    };
    const next = this.configureTail.then(run, run);
    this.configureTail = next.catch(() => undefined);
    return next;
  }

  async start() {
    if (this.server?.listening || this.externalRunning || !this.config.enabled) return this.status();
    this.lastError = null;
    this.server = http.createServer((request, response) => void this.handleRequest(request, response));
    let attachedToExisting = false;
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server?.off('listening', onListen); reject(error); };
      const onListen = () => { this.server?.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListen);
      this.server.listen(this.config.port, this.config.host);
    }).catch(async (error) => {
      this.lastError = error.message;
      this.server = null;
      if (error?.code === 'EADDRINUSE') {
        const existing = await probeExistingGateway(this.config.host, this.config.port);
        if (existing) {
          // A background companion or another launch already owns the gateway.
          // Reuse it instead of starting duplicate platform pollers or failing
          // the desktop boot sequence. This process must never stop that owner.
          this.externalRunning = true;
          this.startedAt = Number(existing.startedAt) || Date.now();
          this.lastError = null;
          for (const id of PLATFORMS) {
            this.platformState[id] = this.config.platforms[id].enabled ? { state: 'external' } : { state: 'disabled' };
          }
          attachedToExisting = true;
          return;
        }
      }
      throw error;
    });
    if (attachedToExisting) {
      this.publishStatus();
      return this.status();
    }
    this.startedAt = Date.now();
    this.telegramBots.start();
    for (const id of PLATFORMS) {
      const settings = this.config.platforms[id];
      const error = settings.enabled ? platformConfigurationError(id, settings) : null;
      this.platformState[id] = !settings.enabled ? { state: 'disabled' } : error ? { state: 'needs-configuration', lastError: error } : { state: settings.mode === 'webhook' ? 'listening' : 'connecting' };
    }
    if (this.config.platforms.telegram.enabled && this.config.platforms.telegram.mode === 'polling') {
      const pollingTask = this.startTelegramPolling();
      this.telegramPollingTask = pollingTask;
      void pollingTask.catch((error) => {
        this.platformState.telegram = { state: 'retrying', lastError: error?.message || String(error) };
        this.publishStatus();
      });
    }
    if (this.config.platforms.email.enabled && this.config.platforms.email.mode === 'polling') {
      const emailSettings = this.config.platforms.email;
      const emailPassword = emailSettings.password || emailSettings.appPassword || emailSettings.emailPassword;
      if (!emailSettings.emailAddress || !emailPassword || !emailSettings.imapHost || !emailSettings.smtpHost) {
        this.platformState.email = { state: 'needs-configuration', lastError: 'Email address, app password, IMAP host, and SMTP host are required.' };
      } else {
      this.emailAdapter = new EmailGatewayAdapter({
        dataDir: this.dataDir,
        settings: emailSettings,
        onMessage: async (payload) => this.accept('email', payload),
        onState: (state) => { this.platformState.email = state; this.publishStatus(); },
      });
      void this.emailAdapter.start().catch((error) => {
        this.platformState.email = { state: 'retrying', lastError: error?.message || String(error) };
        this.publishStatus();
      });
      }
    }
    if (this.config.platforms.discord.enabled && this.config.platforms.discord.mode === 'gateway') void this.startDiscordGateway();
    if (this.config.platforms.signal.enabled && this.config.platforms.signal.mode === 'bridge') void this.startSignalBridge();
    this.deliveryTimer = setInterval(() => void this.retryDeliveries(), 15000);
    this.deliveryTimer.unref?.();
    void this.retryDeliveries();
    void this.hooks.emit('gateway:startup', { status: this.status() });
    this.publishStatus();
    return this.status();
  }

  async stop(options = {}) {
    if (this.externalRunning && options.releaseExternal !== true) {
      // This instance attached to another EterX process. Do not make a local
      // stop request look successful when it cannot own or close that server.
      this.lastError = 'Gateway is owned by another EterX process.';
      this.publishStatus();
      return this.status();
    }
    this.externalRunning = false;
    await this.telegramBots.stop();
    const pollingTask = this.telegramPollingTask;
    const emailAdapter = this.emailAdapter;
    this.emailAdapter = null;
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.signalAbort?.abort();
    this.signalAbort = null;
    if (emailAdapter) await emailAdapter.stop();
    clearInterval(this.deliveryTimer);
    this.deliveryTimer = null;
    clearInterval(this.discordHeartbeat);
    clearTimeout(this.discordReconnect);
    this.discordHeartbeat = null;
    this.discordReconnect = null;
    if (this.discordSocket) {
      try { this.discordSocket.close(1000, 'EterX gateway stopped'); } catch { }
      this.discordSocket = null;
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (pollingTask) {
      await Promise.race([pollingTask.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (this.telegramPollingTask === pollingTask) this.telegramPollingTask = null;
    }
    this.startedAt = null;
    void this.hooks.emit('gateway:shutdown', {});
    for (const id of PLATFORMS) this.platformState[id] = { state: this.config.platforms[id].enabled ? 'stopped' : 'disabled' };
    this.publishStatus();
  }

  telegramLockFile(token) {
    const digest = crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32);
    return path.join(this.dataDir, `telegram-${digest}.lock`);
  }

  acquireTelegramLock(token) {
    const lockPath = this.telegramLockFile(token);
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
      this.telegramLockFd = fd;
      this.telegramLockPath = lockPath;
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const pid = Number(metadata?.pid);
        if (!pid) stale = true;
        else {
          try { process.kill(pid, 0); } catch (probeError) { stale = probeError?.code === 'ESRCH'; }
        }
      } catch { stale = true; }
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch { }
        return this.acquireTelegramLock(token);
      }
      return false;
    }
  }

  releaseTelegramLock() {
    const lockPath = this.telegramLockPath;
    if (this.telegramLockFd !== null) {
      try { fs.closeSync(this.telegramLockFd); } catch { }
      this.telegramLockFd = null;
    }
    this.telegramLockPath = null;
    if (lockPath) {
      try { fs.unlinkSync(lockPath); } catch { }
    }
  }

  accept(platform, payload) {
    if (!this.config.enabled || !this.config.platforms[platform]?.enabled) return { accepted: 0, received: 0 };
    const events = this.registry.normalize(platform, payload);
    let accepted = 0;
    for (const event of events) {
      if (event.actor?.isBot) continue;
      const platformConfig = this.config.platforms[platform] || {};
      const externalConversationId = event.conversationId;
      event.externalConversationId = externalConversationId;
      event.sessionKey = buildGatewaySessionKey(event, platformConfig);
      event.conversationId = event.sessionKey;
      const authorization = this.store.authorize(event, platformConfig.accessPolicy, platformConfig.allowlist);
      if (!authorization.authorized) {
        if (authorization.reason === 'pairing-required' && authorization.approval && !authorization.approval.notifiedAt) {
          authorization.approval.notifiedAt = Date.now();
          this.store.flushCollection(this.store.identitiesPath, this.store.identities);
          if (platform !== 'generic' || platformConfig.endpoint) void this.deliverMessage(platform, event.replyTarget, `EterX pairing required. Your approval code is ${authorization.approval.code}. Approve this request in Channels → Gateway.`, { kind: 'pairing' }).catch(() => {});
        }
        void this.hooks.emit('authorization:denied', { event, authorization });
        continue;
      }
      const stored = this.store.append(event);
      if (!stored.accepted) continue;
      accepted += 1;
      this.lastEventAt = event.receivedAt;
      void this.lanes.enqueue(event.sessionKey, async () => {
        await this.hooks.emit('message:accepted', event);
        this.onEvent(event);
      });
    }
    this.publishStatus();
    return { accepted, received: events.length };
  }

  verify(platform, headers, rawBody) {
    const settings = this.config.platforms[platform] || {};
    if (platform === 'telegram' && settings.webhookSecret) {
      return safeEqual(headers['x-telegram-bot-api-secret-token'], settings.webhookSecret);
    }
    if (platform === 'whatsapp' && settings.appSecret) {
      const expected = `sha256=${crypto.createHmac('sha256', settings.appSecret).update(rawBody).digest('hex')}`;
      return safeEqual(headers['x-hub-signature-256'], expected);
    }
    if (platform === 'messenger' && settings.appSecret) {
      const expected = `sha256=${crypto.createHmac('sha256', settings.appSecret).update(rawBody).digest('hex')}`;
      return safeEqual(headers['x-hub-signature-256'], expected);
    }
    if (platform === 'discord' && settings.publicKey) {
      try {
        const signature = Buffer.from(String(headers['x-signature-ed25519'] || ''), 'hex');
        const timestamp = Buffer.from(String(headers['x-signature-timestamp'] || ''));
        const key = Buffer.from(settings.publicKey, 'hex');
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
        return crypto.verify(null, Buffer.concat([timestamp, rawBody]), { key: Buffer.concat([spkiPrefix, key]), format: 'der', type: 'spki' }, signature);
      } catch { return false; }
    }
    if (settings.webhookSecret) {
      return safeEqual(headers.authorization, `Bearer ${settings.webhookSecret}`) || safeEqual(headers['x-eterx-signature'], crypto.createHmac('sha256', settings.webhookSecret).update(rawBody).digest('hex'));
    }
    return this.config.host === '127.0.0.1';
  }

  verifyControl(headers) {
    const token = String(headers.authorization || '').replace(/^Bearer\s+/i, '') || String(headers['x-eterx-gateway-token'] || '');
    return safeEqual(token, this.config.controlToken);
  }

  async callBridgeTool(name, args = {}) {
    if (name === 'bot_access_check') return { bot: publicBot(this.telegramBots.authorizedTarget(args.target || {})) };
    if (name === 'bot_routine_event') {
      const bot = this.telegramBots.authorizedTarget(args.target || {});
      const owner = this.telegramBots.data.owners[bot.id];
      if (!/^tbot_[a-f0-9]{40}$/.test(String(args.conversation_id || ''))) throw new Error('Invalid routine conversation.');
      const id = `tbot_${bot.id}_${String(args.occurrence_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 65)}`;
      const event = { id, dedupeKey: id, botId: bot.id, platform: 'telegram', kind: 'message', conversationId: args.conversation_id, sessionKey: args.conversation_id, actor: { id: owner.id, displayName: owner.name }, text: String(args.text || '').slice(0, 16000), attachments: [], receivedAt: Date.now(), replyTarget: args.target, metadata: { routine: true } };
      this.store.append(event);
      return { eventId: id };
    }
    // Internal dispatch reads accepted events, never trusts a renderer-supplied
    // prompt, bot profile, recipient or token.
    if (name === 'bot_event_get') {
      const candidate = this.store.eventIndex.get(String(args.event_id || ''));
      const event = candidate?.botId ? candidate : null;
      const bot = event && this.config.telegramBots.find(item => item.id === event.botId && item.enabled);
      if (!event) throw Object.assign(new Error('Bot event is no longer available.'), { statusCode: 410, code: 'BOT_EVENT_GONE' });
      if (!bot) throw Object.assign(new Error('This bot is paused or disconnected.'), { statusCode: 403, code: 'BOT_DISABLED' });
      this.telegramBots.authorizedTarget(event.replyTarget);
      return { event, bot: publicBot(bot) };
    }
    if (name === 'bot_event_ack') return this.store.acknowledge(String(args.event_id || ''));
    if (name === 'bot_steering_received') {
      // Older in-flight runtimes may still acknowledge admission. Admission
      // is not comprehension; never turn it into an automatic reaction.
      await this.callBridgeTool('bot_event_get', args);
      return { ok: true };
    }
    if (name === 'bot_attachments') {
      const { event } = await this.callBridgeTool('bot_event_get', args);
      return this.telegramBots.download(event);
    }
    if (name === 'bot_typing') return this.telegramBots.typing(args.target || {});
    if (name === 'bot_progress') return this.telegramBots.progress(args.target || {}, args.text, args.message_id, args);
    if (name === 'bot_question') return this.telegramBots.question(args.target || {}, args.question || {}, args.conversation_id);
    if (name === 'bot_question_resolved') return this.telegramBots.resolveQuestion(args.target || {}, args.response_key);
    if (name === 'files_send') return args.file_paths
      ? this.telegramBots.sendFiles(args.target || {}, args.file_paths, String(args.caption || ''), args.as_photo === true, args.media_type)
      : this.telegramBots.sendFile(args.target || {}, String(args.file_path || ''), String(args.caption || ''), args.as_photo === true, args.media_type);
    if (name === 'conversations_list') {
      const platform = String(args.platform || '').toLowerCase();
      const search = String(args.search || '').toLowerCase();
      return this.store.listConversations().filter((item) => (!platform || item.platform === platform) && (!search || `${item.title} ${item.id}`.toLowerCase().includes(search)));
    }
    if (name === 'conversation_get') {
      const item = this.store.conversations.get(String(args.conversation_id || ''));
      return item ? { ...item, messages: this.store.listMessages(item.id, 50) } : null;
    }
    if (name === 'messages_read') return this.store.listMessages(String(args.conversation_id || ''), Number(args.limit) || 100);
    if (name === 'attachments_fetch') {
      const event = this.store.listEvents(500).find((item) => item.id === String(args.message_id || '') || item.externalMessageId === String(args.message_id || ''));
      return event ? { messageId: event.id, attachments: event.attachments || [] } : null;
    }
    if (name === 'events_poll') return this.store.pollEvents(Number(args.after_cursor) || 0, Number(args.limit) || 100);
    if (name === 'events_wait') {
      const after = Number(args.after_cursor) || 0;
      const timeout = Math.max(100, Math.min(30000, Number(args.timeout_ms) || 30000));
      const deadline = Date.now() + timeout;
      do {
        const result = this.store.pollEvents(after, 100);
        if (result.events.length) return result;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      return { events: [], cursor: after };
    }
    if (name === 'messages_send') {
      const source = [...this.store.eventIndex.values()].reverse().find(event => event.direction !== 'outbound' && event.platform === args.platform && JSON.stringify(event.replyTarget) === JSON.stringify(args.target));
      return this.deliverMessage(String(args.platform || ''), args.target || {}, String(args.text || ''), { source: 'mcp', deliveryKey: args.delivery_key, conversationId: source?.conversationId });
    }
    if (name === 'channels_list') return PLATFORMS.map((id) => ({ id, ...this.status().platforms[id] }));
    if (name === 'agent_profile_get') {
      const profile = selectChannelProfile(this.config.channelAgent, args.platform, args.profile_id);
      return {
        enabled: this.config.channelAgent.enabled,
        defaultProfileId: this.config.channelAgent.defaultProfileId,
        profile,
        availableProfiles: this.config.channelAgent.profiles.map((item) => ({ id: item.id, name: item.name, role: item.role, channels: item.channels })),
      };
    }
    if (name === 'permissions_list_open') return this.store.listApprovals().filter((item) => item.status === 'pending');
    if (name === 'permissions_respond') return { resolved: this.store.resolveApproval(String(args.identity_id || ''), Boolean(args.approved)) };
    throw new Error(`Unknown gateway bridge tool: ${name}`);
  }

  async handleMcpRequest(payload) {
    const id = payload?.id;
    const method = String(payload?.method || '');
    if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'eterx-gateway', version: '1.0.0' } } };
    if (method === 'notifications/initialized') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    if (method === 'tools/call') {
      try {
        const value = await this.callBridgeTool(String(payload.params?.name || ''), payload.params?.arguments || {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: { result: value }, isError: false } };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error?.message || String(error) }], isError: true } };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  async handleRequest(request, response) {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/health') return send(200, this.status());
      if (request.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/control/call')) {
        if (url.pathname === '/mcp' && !this.config.mcpBridgeEnabled) return send(404, { error: 'MCP bridge is disabled' });
        if (!this.verifyControl(request.headers)) return send(401, { error: 'Invalid gateway control token' });
        const rawBody = await readBody(request);
        const payload = JSON.parse(rawBody.toString('utf8'));
        if (url.pathname === '/control/call') return send(200, await this.callBridgeTool(String(payload.name || ''), payload.arguments || {}));
        const result = await this.handleMcpRequest(payload);
        if (!result) { response.writeHead(202); response.end(); return; }
        response.setHeader('mcp-protocol-version', '2025-06-18');
        return send(200, result);
      }
      if (request.method === 'GET' && (url.pathname === '/webhooks/whatsapp' || url.pathname === '/webhooks/messenger')) {
        const platform = url.pathname.endsWith('messenger') ? 'messenger' : 'whatsapp';
        const valid = url.searchParams.get('hub.mode') === 'subscribe' && safeEqual(url.searchParams.get('hub.verify_token'), this.config.platforms[platform].webhookSecret);
        response.writeHead(valid ? 200 : 403, { 'content-type': 'text/plain' });
        response.end(valid ? url.searchParams.get('hub.challenge') || '' : 'Forbidden');
        return;
      }
      const match = url.pathname.match(/^\/webhooks\/(telegram|whatsapp|messenger|discord|signal|generic)$/);
      if (request.method !== 'POST' || !match) return send(404, { error: 'Not found' });
      const platform = match[1];
      if (!this.config.platforms[platform].enabled) return send(409, { error: `${platform} is disabled` });
      const rawBody = await readBody(request);
      if (!this.verify(platform, request.headers, rawBody)) return send(401, { error: 'Invalid webhook signature' });
      const payload = JSON.parse(rawBody.toString('utf8'));
      if (platform === 'discord' && payload.type === 1) return send(200, { type: 1 });
      return send(202, this.accept(platform, payload));
    } catch (error) {
      this.lastError = error.message;
      this.publishStatus();
      return send(error.statusCode || 400, { error: error.message, code: error.code });
    }
  }

  async startTelegramPolling() {
    const settings = this.config.platforms.telegram;
    try { settings.token = normalizeTelegramToken(settings.token); }
    catch {
      this.platformState.telegram = { state: 'needs-configuration', lastError: 'Paste the complete bot token from BotFather.' };
      return this.publishStatus();
    }
    if (!this.acquireTelegramLock(settings.token)) {
      this.platformState.telegram = { state: 'conflict', lastError: 'Another EterX process is using this bot token. Stop it before reconnecting.' };
      return this.publishStatus();
    }
    const pollAbort = new AbortController();
    this.pollAbort = pollAbort;
    const offsetsPath = path.join(this.dataDir, 'telegram-channel-offsets.json');
    const tokenKey = crypto.createHash('sha256').update(settings.token).digest('hex');
    let offsets = {};
    try { const saved = JSON.parse(fs.readFileSync(offsetsPath, 'utf8')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) offsets = saved; } catch { }
    this.telegramOffset = Number(offsets[tokenKey]) || 0;
    let verified = false;
    try {
      while (!pollAbort.signal.aborted && this.config.enabled && settings.enabled) {
        try {
          if (!verified) {
            this.platformState.telegram = { state: 'connecting' }; this.publishStatus();
            await telegramApi(settings.token, 'getMe', {}, pollAbort.signal);
            const webhook = await telegramApi(settings.token, 'getWebhookInfo', {}, pollAbort.signal);
            if (webhook.url) {
              this.platformState.telegram = { state: 'conflict', lastError: 'This bot already has a webhook. Remove it in the service that owns it, or use a separate bot token.' };
              this.publishStatus(); break;
            }
            verified = true;
          }
          const updates = await telegramApi(settings.token, 'getUpdates', { timeout: 25, offset: this.telegramOffset, allowed_updates: ['message', 'edited_message', 'channel_post', 'business_message'] }, pollAbort.signal);
          for (const update of updates) {
            // Store the accepted event before advancing the durable cursor.
            this.accept('telegram', update);
            this.telegramOffset = Math.max(this.telegramOffset, Number(update.update_id) + 1);
          }
          if (updates.length) {
            offsets[tokenKey] = this.telegramOffset;
            const temporary = `${offsetsPath}.tmp-${process.pid}`;
            fs.writeFileSync(temporary, JSON.stringify(offsets), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporary, offsetsPath);
          }
          this.platformState.telegram = { state: 'connected' }; this.publishStatus();
        } catch (error) {
          if (pollAbort.signal.aborted) break;
          if (error.code === 401 || error.code === 404) {
            this.platformState.telegram = { state: 'needs-configuration', lastError: 'Telegram rejected the bot credential. Replace it with the current token from BotFather.' };
            this.publishStatus(); break;
          }
          if (error.code === 409) {
            this.platformState.telegram = { state: 'conflict', lastError: 'Another process is receiving updates for this bot. Stop that connection, then save to reconnect.' };
            this.publishStatus(); break;
          }
          this.platformState.telegram = { state: 'retrying', lastError: error?.message || 'Telegram connection interrupted.' };
          this.publishStatus();
          await new Promise(resolve => {
            const complete = () => { clearTimeout(timer); pollAbort.signal.removeEventListener('abort', complete); resolve(); };
            const timer = setTimeout(complete, Math.max(3000, Number(error.retryAfter || 0) * 1000));
            pollAbort.signal.addEventListener('abort', complete, { once: true });
          });
        }
      }
    } finally {
      if (this.pollAbort === pollAbort) this.pollAbort = null;
      this.releaseTelegramLock();
    }
  }
  async startDiscordGateway() {
    const settings = this.config.platforms.discord;
    if (!settings.token) {
      this.platformState.discord = { state: 'needs-configuration', lastError: 'Bot token is required.' };
      return this.publishStatus();
    }
    const endpoint = `${this.discordResumeUrl || 'wss://gateway.discord.gg'}?v=10&encoding=json`;
    const socket = new WebSocketClient(endpoint);
    this.discordSocket = socket;
    this.platformState.discord = { state: 'connecting' };
    this.publishStatus();
    socket.addEventListener('message', (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.s != null) this.discordSequence = payload.s;
      if (payload.op === 10) {
        clearInterval(this.discordHeartbeat);
        const heartbeat = () => socket.send(JSON.stringify({ op: 1, d: this.discordSequence }));
        setTimeout(heartbeat, Math.random() * payload.d.heartbeat_interval);
        this.discordHeartbeat = setInterval(heartbeat, payload.d.heartbeat_interval);
        const data = this.discordSessionId
          ? { op: 6, d: { token: settings.token, session_id: this.discordSessionId, seq: this.discordSequence } }
          : {
              op: 2,
              d: {
                token: settings.token,
                intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15),
                properties: { os: process.platform, browser: 'eterx', device: 'eterx' },
              },
            };
        socket.send(JSON.stringify(data));
      } else if (payload.op === 1) socket.send(JSON.stringify({ op: 1, d: this.discordSequence }));
      else if (payload.op === 7) socket.close(4000, 'Reconnect requested');
      else if (payload.op === 9) { this.discordSessionId = null; this.discordSequence = null; socket.close(4000, 'Invalid session'); }
      else if (payload.op === 0 && payload.t === 'READY') {
        this.discordSessionId = payload.d.session_id;
        this.discordResumeUrl = payload.d.resume_gateway_url;
        this.platformState.discord = { state: 'connected' };
        this.publishStatus();
      } else if (payload.op === 0) this.accept('discord', payload);
    });
    socket.addEventListener('error', () => { this.platformState.discord = { state: 'retrying', lastError: 'Gateway socket error' }; this.publishStatus(); });
    socket.addEventListener('close', () => {
      clearInterval(this.discordHeartbeat);
      if (this.discordSocket === socket) this.discordSocket = null;
      if (this.config.enabled && settings.enabled) this.discordReconnect = setTimeout(() => void this.startDiscordGateway(), 5000 + Math.random() * 3000);
    });
  }

  async startSignalBridge() {
    const settings = this.config.platforms.signal;
    const endpoint = String(settings.endpoint || 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.signalAbort = new AbortController();
    while (!this.signalAbort.signal.aborted && this.config.enabled && settings.enabled) {
      try {
        this.platformState.signal = { state: 'connecting' };
        this.publishStatus();
        const response = await fetch(`${endpoint}/api/v1/events`, {
          headers: { accept: 'text/event-stream' },
          signal: this.signalAbort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`signal-cli event stream failed (${response.status})`);
        this.platformState.signal = { state: 'connected' };
        this.publishStatus();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!this.signalAbort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (!data) continue;
            try { this.accept('signal', JSON.parse(data)); } catch { }
          }
        }
      } catch (error) {
        if (this.signalAbort?.signal.aborted) break;
        this.platformState.signal = { state: 'retrying', lastError: error.message };
        this.publishStatus();
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  }

  async deliverMessage(platform, target, text, metadata = {}) {
    const normalized = String(text || '').trim();
    if (!normalized) throw new Error('A reply cannot be empty.');
    const delivery = this.store.createDelivery(platform, target, normalized, metadata);
    if (delivery.status === 'delivered') return { ok: true, deliveryId: delivery.id, result: delivery.result };
    if (delivery.status === 'suppressed') return { ok: true, suppressed: true, deliveryId: delivery.id };
    if (delivery.status === 'failed') return { ok: false, deliveryId: delivery.id, error: delivery.error || 'Delivery failed.' };
    if (delivery.status === 'sending') return { ok: false, retrying: true, deliveryId: delivery.id };
    if (delivery.status === 'retrying' && delivery.nextAttemptAt > Date.now()) return { ok: false, retrying: true, deliveryId: delivery.id, error: delivery.error };
    if (['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY'].includes(normalized.toUpperCase())) {
      this.store.updateDelivery(delivery.id, { status: 'suppressed', deliveredAt: Date.now() });
      return { ok: true, suppressed: true, deliveryId: delivery.id };
    }
    return this.attemptDelivery(delivery);
  }

  async attemptDelivery(delivery) {
    // A renderer retry and the background retry timer can overlap.
    if (delivery.status === 'sending') return { ok: false, retrying: true, deliveryId: delivery.id };
    if (delivery.metadata?.source === 'channel-agent') {
      const event = this.store.eventIndex.get(delivery.metadata.eventId);
      const profile = selectChannelProfile(this.config.channelAgent, delivery.platform);
      const settings = this.config.platforms[delivery.platform];
      if (!event || !this.canDispatch(event) || profile?.id !== delivery.metadata.profileId || profile.operatingMode !== 'autonomous' || profile.sendPolicy !== 'autonomous' || !this.store.authorize(event, settings.accessPolicy, settings.allowlist).authorized) {
        this.store.updateDelivery(delivery.id, { status: 'suppressed', deliveredAt: Date.now() });
        this.publishStatus();
        return { ok: true, suppressed: true, deliveryId: delivery.id };
      }
    }
    const attempts = Number(delivery.attempts || 0) + 1;
    this.store.updateDelivery(delivery.id, { status: 'sending', attempts, lastAttemptAt: Date.now() });
    await this.hooks.emit('delivery:attempt', { ...delivery, attempts });
    try {
      const result = await this.sendRawMessage(delivery.platform, delivery.target, delivery.text, delivery);
      this.store.updateDelivery(delivery.id, { status: 'delivered', deliveredAt: Date.now(), result });
      if (delivery.metadata?.conversationId) {
        try {
          this.store.append({ id: `sent_${delivery.id}`, dedupeKey: `outbound:${delivery.id}`, platform: delivery.platform, direction: 'outbound', kind: 'message', conversationId: delivery.metadata.conversationId, actor: { id: 'eterx', displayName: 'EterX', isBot: true }, text: delivery.text, replyTarget: delivery.target, attachments: [], receivedAt: Date.now() });
        } catch { console.warn('[gateway] Reply delivered, but conversation history could not be updated.'); }
      }
      await this.hooks.emit('delivery:delivered', { delivery, result });
      this.publishStatus();
      return { ok: true, deliveryId: delivery.id, result };
    } catch (error) {
      const terminal = attempts >= 10;
      let safeError = String(error?.message || 'The channel reply could not be delivered.');
      const settings = this.config.platforms[delivery.platform] || {};
      for (const key of ['token', 'webhookSecret', 'appSecret', 'password', 'appPassword', 'emailPassword']) {
        const secret = String(settings[key] || '');
        if (secret.length >= 4) safeError = safeError.split(secret).join('[redacted]');
      }
      const retryDelay = Math.max(Number(error?.retryAfter || 0) * 1000, Math.min(15 * 60 * 1000, 5000 * (2 ** Math.min(attempts - 1, 8))));
      this.store.updateDelivery(delivery.id, {
        status: terminal ? 'failed' : 'retrying',
        error: safeError.slice(0, 600),
        nextAttemptAt: terminal ? null : Date.now() + retryDelay,
      });
      await this.hooks.emit('delivery:failed', { delivery, error, terminal });
      this.publishStatus();
      if (terminal) throw new Error(safeError.slice(0, 600));
      return { ok: false, retrying: true, deliveryId: delivery.id, error: safeError.slice(0, 600) };
    }
  }

  async retryDeliveries() {
    for (const delivery of this.store.listPendingDeliveries(25)) await this.attemptDelivery(delivery).catch(() => {});
  }

  async sendRawMessage(platform, target, text, delivery) {
    if (platform === 'telegram' && target?.botId) return this.telegramBots.send(target, text, delivery);
    const settings = this.config.platforms[platform] || {};
    if (!settings.enabled) throw new Error(`${platform} is disabled`);
    const registeredAdapter = this.registry.get(platform);
    if (!PLATFORMS.includes(platform) && typeof registeredAdapter?.send === 'function') {
      return registeredAdapter.send(target, text, settings);
    }
    if (platform === 'telegram') {
      if (!delivery.telegramChunks) this.store.updateDelivery(delivery.id, { telegramChunks: formatTelegramText(text), telegramSentCount: 0 });
      const results = Array.isArray(delivery.telegramResults) ? [...delivery.telegramResults] : [];
      for (let index = Number(delivery.telegramSentCount) || 0; index < delivery.telegramChunks.length; index += 1) {
        const chunk = delivery.telegramChunks[index];
        const result = await telegramApi(settings.token, 'sendMessage', { chat_id: target.chatId, text: chunk.text, entities: chunk.entities, message_thread_id: target.threadId ? Number(target.threadId) : undefined, reply_parameters: target.messageId ? { message_id: Number(target.messageId), allow_sending_without_reply: true } : undefined });
        results.push({ message_id: result.message_id });
        this.store.updateDelivery(delivery.id, { telegramSentCount: index + 1, telegramResults: results });
      }
      return results;
    }
    if (platform === 'whatsapp') {
      const version = settings.apiVersion || 'v23.0';
      const response = await fetch(`https://graph.facebook.com/${version}/${target.phoneNumberId || settings.accountId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: target.to, type: 'text', text: { body: text } }) });
      return readPlatformResponse(response, 'WhatsApp');
    }
    if (platform === 'messenger') {
      const version = settings.apiVersion || 'v23.0';
      const response = await fetch(`https://graph.facebook.com/${version}/me/messages`, { method: 'POST', headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ recipient: { id: target.recipientId || target.to }, message: { text } }) });
      return readPlatformResponse(response, 'Messenger');
    }
    if (platform === 'email') return sendEmailMessage(target, text, settings);
    if (platform === 'discord') {
      const response = await fetch(`https://discord.com/api/v10/channels/${target.channelId}/messages`, { method: 'POST', headers: { authorization: `Bot ${settings.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: text, message_reference: target.messageId ? { message_id: target.messageId } : undefined }) });
      return readPlatformResponse(response, 'Discord');
    }
    if (platform === 'signal') {
      const endpoint = `${String(settings.endpoint || 'http://127.0.0.1:8080').replace(/\/$/, '')}/api/v1/rpc`;
      const params = { message: text, recipient: target.recipient ? [target.recipient] : undefined, groupId: target.groupId || undefined, account: target.account || settings.accountId || undefined };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'send', params }) });
      return readPlatformResponse(response, 'signal-cli');
    }
    if (platform === 'generic') {
      if (!settings.endpoint) throw new Error('Custom webhook is receive-only until a reply endpoint is configured.');
      const endpoint = new URL(settings.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid custom reply endpoint.');
      const body = JSON.stringify({ target, text, deliveryId: delivery.id });
      const signature = crypto.createHmac('sha256', String(settings.webhookSecret)).update(body).digest('hex');
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-eterx-signature': `sha256=${signature}`, 'idempotency-key': delivery.id }, body, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Custom reply endpoint returned HTTP ${response.status}.`);
      return { accepted: true, status: response.status };
    }
    throw new Error(`Outbound messages are not implemented for ${platform}`);
  }
}

module.exports = { GatewayDaemon, DEFAULT_CONFIG, mergeConfig, validateGatewayConfig, PLATFORMS };
