"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelSelect as ModernSelect } from './channel-select';
import styles from './channels.module.css';
import * as Dialog from '@radix-ui/react-dialog';
import { selectChannelProfile } from '../../lib/agent/gateways/routing.cjs';
import { ArrowLeft, CheckCircle2, ChevronRight, Copy, Eye, EyeOff, Loader2, MessageCircle, Radio, RefreshCw, Save, Search, Server, Settings2, ShieldCheck, Activity, Wifi, WifiOff, Undo2, Redo2 } from 'lucide-react';
import { PremiumAgent } from '../ui/premium-icons';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import { appStorage } from '../../lib/client-storage';
import { createLazyPanel } from '../ui/lazy-panel';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { requestJson } from '../../lib/request-json';

const ConnectAsBot = createLazyPanel('Connect as bot', () => import('./connect-as-bot').then(mod => mod.ConnectAsBot));

type PlatformId = 'telegram' | 'whatsapp' | 'messenger' | 'email' | 'discord' | 'signal' | 'generic';
type PlatformConfig = { enabled: boolean; mode: string; configured?: boolean; credentials?: Record<string, boolean>; token?: string; password?: string; webhookSecret?: string; appSecret?: string; publicKey?: string; accountId?: string; apiVersion?: string; endpoint?: string; emailAddress?: string; imapHost?: string; smtpHost?: string; imapPort?: number; smtpPort?: number; pollInterval?: number; imapSecure?: boolean; smtpSecure?: boolean; accessPolicy?: 'open' | 'allowlist' | 'pairing'; allowlist?: string[]; groupSessionsPerUser?: boolean };
type ChannelAgentProfile = { id: string; name: string; role: 'sales' | 'support' | 'operations' | 'custom'; objective: string; instructions: string; channels: PlatformId[]; operatingMode: 'manual' | 'assist' | 'autonomous'; readPolicy: 'on-demand' | 'unread' | 'all'; sendPolicy: 'draft-only' | 'direct' | 'autonomous'; escalationRules: string; responseStyle: string; pollIntervalMinutes: number };
type ChannelAgentConfig = { enabled: boolean; defaultProfileId: string; profiles: ChannelAgentProfile[] };
type GatewayMode = 'communication' | 'agents' | 'mcp' | 'skills';
type GatewayConfig = { enabled: boolean; keepRunningOnClose: boolean; keepActiveChatsOnClose: boolean; runScheduledTasksInBackground: boolean; launchAtLogin: boolean; autoDispatch: boolean; busyInputMode: 'queue' | 'steer' | 'interrupt'; mcpBridgeEnabled: boolean; host: string; port: number; channelAgent: ChannelAgentConfig; platforms: Record<PlatformId, PlatformConfig> };
type GatewayStatus = { running: boolean; conversationCount: number; eventCount: number; lastEventAt: number | null; mcpEndpoint?: string | null; lastError?: string; pendingDeliveryCount?: number; failedDeliveryCount?: number; lastDeliveryError?: string | null; bots?: Array<{ id: string; enabled: boolean; paired: boolean }>; platforms: Record<string, { enabled: boolean; state: string; lastError?: string }> };
type GatewayApproval = { id: string; platform: PlatformId; displayName: string; code?: string; status: string };
type GatewayConversation = { id: string; platform: PlatformId; title: string; lastMessageAt: number; lastMessagePreview: string; unreadCount: number; messageCount: number };
type ConnectorCatalogItem = { id: string; label: string; description: string; setup: string; transport: string; credential: string; kind: 'native' | 'mcp' | 'pathway'; logo?: string; guideUrl?: string };

const PLATFORMS: Array<{ id: PlatformId; label: string; description: string; logo: string; mode: string; credential: string }> = [
  { id: 'telegram', label: 'Telegram', description: 'Bot messages and groups', logo: '/icons/connectors/telegram.svg', mode: 'polling', credential: 'Bot token' },
  { id: 'whatsapp', label: 'WhatsApp Cloud', description: 'Meta Cloud API messages', logo: '/icons/connectors/whatsapp.svg', mode: 'webhook', credential: 'Access token' },
  { id: 'messenger', label: 'Messenger', description: 'Facebook Page messages', logo: '/icons/connectors/messenger.svg', mode: 'webhook', credential: 'Page access token' },
  { id: 'email', label: 'Email', description: 'IMAP inbox and SMTP replies', logo: '/icons/connectors/email.svg', mode: 'polling', credential: 'App password' },
  { id: 'discord', label: 'Discord', description: 'Channels through a bot', logo: '/icons/connectors/discord.svg', mode: 'gateway', credential: 'Bot token' },
  { id: 'signal', label: 'Signal', description: 'Optional local signal-cli bridge', logo: '/icons/connectors/signal.svg', mode: 'bridge', credential: 'Account number' },
  { id: 'generic', label: 'Custom webhook', description: 'Connect another messaging app', logo: '/icons/ui/channel-chain-icons8.png', mode: 'webhook', credential: 'Webhook secret' },
];

const CONNECTOR_LOGOS: Record<string, string> = { matrix: '/icons/connectors/matrix.svg', mattermost: '/icons/connectors/mattermost.svg', slack: '/icons/connectors/slack.svg', line: '/icons/connectors/line.svg', email: '/icons/connectors/email.svg', sms: '/icons/connectors/sms.svg', dingtalk: '/icons/connectors/dingtalk.svg', feishu: '/icons/connectors/feishu.svg', irc: '/icons/connectors/irc.svg', 'google-chat': '/icons/connectors/google_calendar.svg', 'homeassistant': '/icons/connectors/homeassistant.svg', mcp: '/icons/connectors/linear.svg', skills: '/icons/connectors/linear.svg' };

const CONNECTOR_REQUIREMENTS: Record<string, { setup: string; credential: string }> = {
  telegram: { setup: '1. Create a bot with @BotFather. 2. Paste the complete token (for example 123456789:AA...), not only the bot ID or @username. 3. Add allowed user IDs if you use pairing or an allowlist. 4. Save and send a test message.', credential: 'Complete BotFather token; optional allowed user IDs' },
  whatsapp: { setup: '1. Create a Meta app with WhatsApp enabled. 2. Add the webhook URL and verify token. 3. Add the phone number ID, access token, and app secret. 4. Subscribe to messages and send a test message.', credential: 'Access token; phone number ID; app secret; verify token' },
  messenger: { setup: '1. Create a Meta app with Messenger enabled. 2. Connect a Facebook Page and copy its Page access token. 3. Add the webhook URL and verify token. 4. Subscribe to messages and send a test message.', credential: 'Page access token; Page ID; app secret; verify token' },
  discord: { setup: '1. Create a Discord application and bot. 2. Enable Message Content Intent. 3. Copy the bot token. 4. Invite the bot with message permissions and save.', credential: 'Bot token; optional interactions public key' },
  signal: { setup: '1. Run signal-cli daemon on loopback. 2. Register or link the account. 3. Enter the bridge endpoint and account number. 4. Send a test message from Signal.', credential: 'signal-cli endpoint; account number' },
  generic: { setup: '1. Create a webhook in the source app. 2. Point it at the generated EterX URL. 3. Use the signing secret or bearer token. 4. POST a normalized message to verify the connection.', credential: 'Webhook secret; source app callback' },
  slack: { setup: '1. Create a Slack app from a manifest. 2. Enable Socket Mode. 3. Add bot and app-level tokens. 4. Subscribe to message events, invite the bot, then test a DM.', credential: 'Bot token xoxb; app token xapp; signing secret' },
  mattermost: { setup: '1. Create a Mattermost bot account. 2. Copy its token and server URL. 3. Configure WebSocket access and allowed channels. 4. Invite the bot and send a test message.', credential: 'Bot token; server URL; channel allowlist' },
  matrix: { setup: '1. Choose a homeserver. 2. Create a dedicated Matrix user. 3. Create an access token. 4. Add the bot to a room and verify sync permissions.', credential: 'Homeserver URL; access token; room IDs' },
  bluebubbles: { setup: '1. Install BlueBubbles Server on a Mac signed into iMessage. 2. Enable its private API. 3. Copy the server URL and password. 4. Add a test chat.', credential: 'Private API URL; password; Mac host' },
  homeassistant: { setup: '1. Create a long-lived access token in Home Assistant. 2. Enter the instance URL. 3. Choose the webhook or conversation endpoint. 4. Send an Assist test event.', credential: 'Instance URL; long-lived access token' },
  email: { setup: '1. Use a dedicated agent mailbox. 2. Enable IMAP and create an app password. 3. Add IMAP/SMTP hosts and an allowed-sender policy. 4. Send one test email and confirm the threaded reply.', credential: 'Mailbox; app password; IMAP/SMTP hosts' },
  sms: { setup: '1. Create a Twilio account and phone number. 2. Copy Account SID and Auth Token. 3. Set the inbound webhook. 4. Send a test SMS.', credential: 'Account SID; auth token; Twilio number' },
  dingtalk: { setup: '1. Create a DingTalk custom bot. 2. Copy its webhook URL and signing secret. 3. Configure keyword or signature validation. 4. Send a test group message.', credential: 'Webhook URL; signing secret; keywords' },
  feishu: { setup: '1. Create a Feishu/Lark app. 2. Enable bot capability and event subscriptions. 3. Add app ID, app secret, and verification token. 4. Publish the app and test.', credential: 'App ID; app secret; verification token' },
  'google-chat': { setup: '1. Create a Google Chat app in Google Cloud. 2. Select an HTTPS endpoint. 3. Configure service-account authentication. 4. Add the app to a space and test.', credential: 'Google Cloud project; service account; HTTPS URL' },
  'wecom-group': { setup: '1. Add a WeCom group robot. 2. Copy webhook key and optional IP restrictions. 3. Configure signature validation. 4. Send a group test.', credential: 'Webhook key; optional IP allowlist' },
  'wecom-app': { setup: '1. Create a WeCom application. 2. Configure callback URL and token. 3. Add Corp ID and secret. 4. Publish and test a direct message.', credential: 'Corp ID; agent ID; secret; callback token' },
  weixin: { setup: '1. Run an approved local WeChat bridge. 2. Pair the account. 3. Enter the bridge endpoint and secret. 4. Send a private test message.', credential: 'Bridge endpoint; pairing secret' },
  qq: { setup: '1. Create a QQ bot application. 2. Configure intents and callback URL. 3. Add App ID and secret. 4. Invite the bot and test.', credential: 'App ID; app secret; callback URL' },
  yuanbao: { setup: '1. Start a supported Yuanbao bridge. 2. Pair the account. 3. Enter its endpoint and credentials. 4. Send a test conversation.', credential: 'Bridge endpoint; bridge credentials' },
  'api-server': { setup: '1. Keep the gateway bound to loopback. 2. Use the generated bearer token. 3. Call the control API or MCP endpoint. 4. Confirm with a channels_list request.', credential: 'Gateway URL; bearer token' },
  webhooks: { setup: '1. Copy the custom webhook URL. 2. Add it to the source app. 3. Sign requests with the webhook secret. 4. POST a normalized event and confirm it appears in EterX.', credential: 'Webhook URL; HMAC secret or bearer token' },
  photon: { setup: '1. Install Photon on macOS. 2. Pair it with Messages. 3. Enter the local bridge URL and password. 4. Send a test iMessage.', credential: 'Photon bridge URL; password; macOS host' },
  irc: { setup: '1. Choose an IRC server and TLS port. 2. Create a dedicated nick and optional SASL credentials. 3. Add channel allowlist. 4. Join and test.', credential: 'Server; TLS port; nick; SASL credentials' },
  line: { setup: '1. Create a LINE Messaging API channel. 2. Copy the channel access token and secret. 3. Set the webhook URL. 4. Verify the webhook and send a test.', credential: 'Channel access token; channel secret' },
  mcp: { setup: '1. Enable the gateway MCP bridge. 2. Start the background companion. 3. Copy the authenticated client configuration. 4. Paste it into your MCP client and call tools/list.', credential: 'MCP URL; bearer token' },
};

const CONNECTOR_GUIDES: Record<string, string> = {
  telegram: 'https://core.telegram.org/bots/tutorial', whatsapp: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started', messenger: 'https://developers.facebook.com/docs/messenger-platform/get-started', discord: 'https://discord.com/developers/docs/quick-start/getting-started', signal: 'https://github.com/AsamK/signal-cli', generic: 'https://docs.openclaw.ai/channels/webhook', slack: 'https://docs.slack.dev/tools/bolt-js/concepts/socket-mode', mattermost: 'https://developers.mattermost.com/integrate/reference/bot-accounts/', matrix: 'https://spec.matrix.org/latest/client-server-api/', bluebubbles: 'https://bluebubbles.app/install', email: 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email', sms: 'https://www.twilio.com/docs/usage/webhooks/getting-started-twilio-webhooks', dingtalk: 'https://open.dingtalk.com/document/orgapp/custom-robot-access', feishu: 'https://open.feishu.cn/document/home/index', 'google-chat': 'https://developers.google.com/workspace/chat/quickstart', 'wecom-group': 'https://developer.work.weixin.qq.com/document/path/91770', 'wecom-app': 'https://developer.work.weixin.qq.com/document/path/90236', weixin: 'https://developers.weixin.qq.com/doc/', qq: 'https://bot.q.qq.com/wiki/', yuanbao: 'https://platform.tencent.com/', 'api-server': 'https://docs.openclaw.ai/gateway', webhooks: 'https://docs.openclaw.ai/channels/webhook', photon: 'https://github.com/RichardBronosky/photon', irc: 'https://modern.ircdocs.horse/', line: 'https://developers.line.biz/en/docs/messaging-api/getting-started/', mcp: 'https://modelcontextprotocol.io/docs/concepts/architecture'
};

const CONNECTOR_CATALOG: ConnectorCatalogItem[] = ([
  ...PLATFORMS.map((platform) => ({ id: platform.id, label: platform.label, description: platform.description, setup: 'Paste the credential, enable the connection, then click Save. EterX verifies it and starts the live adapter.', transport: platform.mode, credential: platform.credential, kind: 'native' as const, logo: platform.logo })),
  { id: 'slack', label: 'Slack', description: 'Workspaces, DMs, channels, and threads', setup: 'Create a Slack app with Socket Mode, then add the bot and app tokens.', transport: 'WebSocket', credential: 'Bot token + app token', kind: 'pathway' },
  { id: 'mattermost', label: 'Mattermost', description: 'Self-hosted team messaging', setup: 'Create a bot account and connect the Mattermost WebSocket endpoint.', transport: 'WebSocket', credential: 'Bot token + server URL', kind: 'pathway' },
  { id: 'matrix', label: 'Matrix', description: 'Federated rooms and private messages', setup: 'Add a Matrix user, homeserver, and access token.', transport: 'Sync API', credential: 'Homeserver + access token', kind: 'pathway' },
  { id: 'bluebubbles', label: 'BlueBubbles (iMessage)', description: 'iMessage bridge for macOS', setup: 'Run BlueBubbles Server on a Mac and provide its private API URL.', transport: 'HTTP bridge', credential: 'Server URL + password', kind: 'pathway' },
  { id: 'homeassistant', label: 'Home Assistant', description: 'Assist conversations and automations', setup: 'Create a long-lived Home Assistant access token.', transport: 'REST + webhook', credential: 'Instance URL + token', kind: 'pathway' },
  { id: 'sms', label: 'SMS (Twilio)', description: 'SMS messages through Twilio', setup: 'Add a Twilio number and signed webhook.', transport: 'REST + webhook', credential: 'Account SID + auth token', kind: 'pathway' },
  { id: 'dingtalk', label: 'DingTalk', description: 'DingTalk bot messages', setup: 'Create a DingTalk custom bot and configure its signing secret.', transport: 'Webhook', credential: 'Webhook URL + secret', kind: 'pathway' },
  { id: 'feishu', label: 'Feishu / Lark', description: 'Workplace chats and events', setup: 'Create a Feishu app with event subscriptions.', transport: 'Webhook', credential: 'App ID + app secret', kind: 'pathway' },
  { id: 'google-chat', label: 'Google Chat', description: 'Spaces and direct messages', setup: 'Create a Google Chat app with an HTTPS endpoint.', transport: 'Webhook', credential: 'Service account', kind: 'pathway' },
  { id: 'wecom-group', label: 'WeCom group bot', description: 'WeCom group robot messages', setup: 'Add a WeCom group bot and signing key.', transport: 'Webhook', credential: 'Webhook key', kind: 'pathway' },
  { id: 'wecom-app', label: 'WeCom app', description: 'WeCom application messages', setup: 'Create a WeCom application and callback.', transport: 'Webhook', credential: 'Corp ID + secret', kind: 'pathway' },
  { id: 'weixin', label: 'Weixin / WeChat', description: 'Personal WeChat bridge', setup: 'Connect an approved local WeChat bridge.', transport: 'Bridge', credential: 'Bridge endpoint', kind: 'pathway' },
  { id: 'qq', label: 'QQ Bot', description: 'QQ bot conversations', setup: 'Create a QQ bot application and callback endpoint.', transport: 'Webhook', credential: 'App ID + secret', kind: 'pathway' },
  { id: 'yuanbao', label: 'Yuanbao', description: 'Yuanbao conversations', setup: 'Provide the supported Yuanbao bridge endpoint.', transport: 'Bridge', credential: 'Bridge credentials', kind: 'pathway' },
  { id: 'api-server', label: 'API server', description: 'Bring your own client or service', setup: 'Use the authenticated gateway control API.', transport: 'HTTP', credential: 'Bearer token', kind: 'pathway' },
  { id: 'webhooks', label: 'Webhooks', description: 'Receive normalized events from any app', setup: 'Post signed JSON to the custom webhook URL.', transport: 'HTTP webhook', credential: 'Signing secret', kind: 'pathway' },
  { id: 'photon', label: 'iMessage via Photon', description: 'iMessage through a local Photon bridge', setup: 'Run Photon on macOS and provide its local bridge URL.', transport: 'Bridge', credential: 'Bridge URL', kind: 'pathway' },
  { id: 'irc', label: 'IRC', description: 'Channels and direct messages', setup: 'Provide the IRC server, nick, and channel allowlist.', transport: 'IRC', credential: 'Server + nick', kind: 'pathway' },
  { id: 'line', label: 'LINE', description: 'LINE Official Account messages', setup: 'Create a LINE Messaging API channel and webhook.', transport: 'Webhook', credential: 'Channel access token', kind: 'pathway' },
  { id: 'skills', label: 'Skills', description: 'Reusable agent skills and workflows', setup: 'Choose the skills this gateway may expose to connected conversations.', transport: 'Agent runtime', credential: 'Enabled skills and permissions', kind: 'pathway' },
  { id: 'mcp', label: 'MCP server', description: 'Expose EterX tools to an MCP client', setup: 'Enable the gateway MCP bridge and copy the client configuration.', transport: 'Streamable HTTP', credential: 'Gateway bearer token', kind: 'mcp' },
] as ConnectorCatalogItem[]).map((connector) => ({ ...connector, ...CONNECTOR_REQUIREMENTS[connector.id], guideUrl: CONNECTOR_GUIDES[connector.id], logo: connector.logo || CONNECTOR_LOGOS[connector.id] || '/icons/ui/channel-chain-icons8.png' }));

const defaultChannelAgentProfile = (): ChannelAgentProfile => ({ id: 'channel-operator', name: 'Channel operator', role: 'custom', objective: 'Help me inspect and act on connected conversations when I ask.', instructions: '', channels: [], operatingMode: 'manual', readPolicy: 'on-demand', sendPolicy: 'direct', escalationRules: 'Escalate pricing commitments, legal or security issues, angry customers, and anything outside the objective.', responseStyle: 'Clear, concise, human, and appropriate for the channel.', pollIntervalMinutes: 5 });
const defaultConfig = (): GatewayConfig => ({ enabled: false, keepRunningOnClose: true, keepActiveChatsOnClose: true, runScheduledTasksInBackground: true, launchAtLogin: false, autoDispatch: false, busyInputMode: 'queue', mcpBridgeEnabled: true, host: '127.0.0.1', port: 47821, channelAgent: { enabled: true, defaultProfileId: 'channel-operator', profiles: [defaultChannelAgentProfile()] }, platforms: { telegram: { enabled: false, mode: 'polling', accessPolicy: 'pairing', allowlist: [], groupSessionsPerUser: true }, whatsapp: { enabled: false, mode: 'webhook', apiVersion: 'v23.0', accessPolicy: 'pairing', allowlist: [], groupSessionsPerUser: true }, messenger: { enabled: false, mode: 'webhook', apiVersion: 'v23.0', accessPolicy: 'pairing', allowlist: [], groupSessionsPerUser: true }, email: { enabled: false, mode: 'polling', accessPolicy: 'pairing', allowlist: [], groupSessionsPerUser: false, imapPort: 993, smtpPort: 587, pollInterval: 15, imapSecure: true, smtpSecure: false }, discord: { enabled: false, mode: 'gateway', accessPolicy: 'pairing', allowlist: [], groupSessionsPerUser: true }, signal: { enabled: false, mode: 'bridge', endpoint: 'http://127.0.0.1:8080', accessPolicy: 'pairing', allowlist: [], groupSessionsPerUser: true }, generic: { enabled: false, mode: 'webhook', accessPolicy: 'allowlist', allowlist: [], groupSessionsPerUser: true } } });

const Toggle = ({ checked, onChange, disabled = false, label = 'Toggle setting' }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }) => <button type="button" role="switch" aria-label={label} aria-checked={checked} title={`${label}: ${checked ? 'enabled' : 'disabled'}`} disabled={disabled} onClick={() => onChange(!checked)} className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full p-1 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--muted-foreground)] ${checked ? 'justify-end bg-[#1d8cff]' : 'justify-start bg-black/15 dark:bg-white/15'} ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}><span className="block h-4 w-4 shrink-0 rounded-full bg-white shadow-none transition-transform" /></button>;

function NativeSetupFields({ platform, item, patchPlatform, revealed, setRevealed }: { platform: typeof PLATFORMS[number]; item: PlatformConfig; patchPlatform: (id: PlatformId, patch: Partial<PlatformConfig>) => void; revealed: Record<string, boolean>; setRevealed: React.Dispatch<React.SetStateAction<Record<string, boolean>>> }) {
  const [allowlistText, setAllowlistText] = useState((item.allowlist || []).join(', '));
  useEffect(() => {
    setAllowlistText(current => JSON.stringify(current.split(/[;,\n]/).map(value => value.trim()).filter(Boolean)) === JSON.stringify(item.allowlist || []) ? current : (item.allowlist || []).join(', '));
  }, [item.allowlist, platform.id]);
  const fields: Array<{ key: keyof PlatformConfig; label: string; placeholder?: string; secret?: boolean; type?: string }> = [];
  if (['telegram', 'whatsapp', 'messenger', 'discord'].includes(platform.id)) fields.push({ key: 'token', label: platform.credential, secret: true });
  if (platform.id === 'whatsapp' || platform.id === 'messenger') fields.push(
    { key: 'accountId', label: platform.id === 'whatsapp' ? 'Phone number ID' : 'Page ID' },
    { key: 'appSecret', label: 'Meta app secret', secret: true },
    { key: 'webhookSecret', label: 'Webhook verification token', secret: true },
    { key: 'apiVersion', label: 'Graph API version', placeholder: 'v23.0' },
  );
  if (platform.id === 'email') fields.push(
    { key: 'emailAddress', label: 'Agent mailbox', placeholder: 'agent@example.com', type: 'email' },
    { key: 'password', label: 'App password', secret: true },
    { key: 'imapHost', label: 'IMAP host', placeholder: 'imap.example.com' },
    { key: 'smtpHost', label: 'SMTP host', placeholder: 'smtp.example.com' },
    { key: 'imapPort', label: 'IMAP port', type: 'number' },
    { key: 'smtpPort', label: 'SMTP port', type: 'number' },
    { key: 'pollInterval', label: 'Poll interval (seconds)', type: 'number' },
  );
  if (platform.id === 'discord') fields.push({ key: 'publicKey', label: 'Interactions public key (optional)' });
  if (platform.id === 'signal') fields.push({ key: 'endpoint', label: 'signal-cli bridge URL', placeholder: 'http://127.0.0.1:8080' }, { key: 'accountId', label: 'Account number', placeholder: '+15551234567' });
  if (platform.id === 'generic') fields.push({ key: 'webhookSecret', label: 'Webhook signing secret', secret: true }, { key: 'endpoint', label: 'Reply endpoint (optional)', placeholder: 'https://your-bridge.example/replies' });
  return <div className={styles.fields}>
    <label className={styles.field}>Who can message the agent<ModernSelect label="Channel access policy" value={item.accessPolicy || 'pairing'} onChange={value => patchPlatform(platform.id, { accessPolicy: value as PlatformConfig['accessPolicy'] })} options={[{ value: 'pairing', label: 'Approve each new person' }, { value: 'allowlist', label: 'Only listed people' }, { value: 'open', label: 'Anyone on this channel' }]} /></label>
    {item.accessPolicy === 'allowlist' && <label className={styles.field}>Allowed sender IDs<input value={allowlistText} onChange={event => { setAllowlistText(event.target.value); patchPlatform(platform.id, { allowlist: event.target.value.split(/[;,\n]/).map(value => value.trim()).filter(Boolean) }); }} placeholder="Comma-separated IDs, usernames or emails" /><small className={styles.muted}>An empty list allows nobody.</small></label>}
    {fields.map(field => {
      const revealKey = `${platform.id}:${field.key}`;
      const stored = Boolean(item.credentials?.[field.key]);
      return <label key={field.key} className={styles.field}>{field.label}<span className="relative block"><input autoComplete="off" spellCheck={false} type={field.secret ? revealed[revealKey] ? 'text' : 'password' : field.type || 'text'} min={field.type === 'number' ? 1 : undefined} max={field.key.endsWith('Port') ? 65535 : undefined} value={String(item[field.key] ?? '')} placeholder={stored ? 'Saved securely · enter to replace' : field.placeholder || field.label} onChange={event => patchPlatform(platform.id, { [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value })} style={field.secret ? { paddingRight: 42 } : undefined} />{field.secret && <button type="button" className="absolute inset-y-0 right-0 flex w-10 items-center justify-center opacity-60" aria-label={`${revealed[revealKey] ? 'Hide' : 'Show'} ${field.label.toLowerCase()}`} onClick={() => setRevealed(current => ({ ...current, [revealKey]: !current[revealKey] }))}>{revealed[revealKey] ? <EyeOff size={15} /> : <Eye size={15} />}</button>}</span></label>;
    })}
    {platform.id === 'email' && <><div className={styles.setting}><span>IMAP over TLS</span><Toggle label="IMAP TLS" checked={item.imapSecure !== false} onChange={imapSecure => patchPlatform(platform.id, { imapSecure })} /></div><div className={styles.setting}><span>SMTP implicit TLS<small>Use for port 465; port 587 uses STARTTLS.</small></span><Toggle label="SMTP implicit TLS" checked={item.smtpSecure === true} onChange={smtpSecure => patchPlatform(platform.id, { smtpSecure })} /></div></>}
    <div className={`${styles.setting} ${styles.wide}`}><span>Separate people in group conversations<small>Keep each sender’s working history separate.</small></span><Toggle label="Separate group sessions per person" checked={item.groupSessionsPerUser !== false} onChange={groupSessionsPerUser => patchPlatform(platform.id, { groupSessionsPerUser })} /></div>
    {platform.id === 'generic' && <p className={`${styles.muted} ${styles.wide}`}>Replies POST JSON with target, text and deliveryId to your configured endpoint, signed with the webhook secret. Without a reply endpoint, this channel only receives messages.</p>}
  </div>;
}
const ROLE_TEMPLATES: Record<ChannelAgentProfile['role'], Pick<ChannelAgentProfile, 'name' | 'objective' | 'instructions' | 'escalationRules' | 'responseStyle'>> = {
  sales: { name: 'Sales agent', objective: 'Review inbound leads, identify intent and fit, answer approved product questions, and move qualified prospects toward the next step.', instructions: 'Prioritize new and high-intent leads. Ask only the minimum qualifying questions. Never invent pricing, availability, discounts, customer references, or product capabilities.', escalationRules: 'Escalate custom pricing, discounts, contracts, security reviews, procurement requests, complaints, and commitments outside approved information.', responseStyle: 'Warm, concise, consultative, and focused on a clear next step.' },
  support: { name: 'Support agent', objective: 'Triage customer issues, use available evidence to provide accurate help, and escalate cases that require a human or privileged action.', instructions: 'Acknowledge the issue, gather missing facts, avoid repeated troubleshooting, and distinguish observed evidence from hypotheses.', escalationRules: 'Escalate security, billing disputes, data loss, legal threats, account access changes, repeated failures, and incidents affecting multiple customers.', responseStyle: 'Calm, empathetic, precise, and action-oriented.' },
  operations: { name: 'Operations agent', objective: 'Monitor operational conversations, extract requests and deadlines, coordinate follow-ups, and keep work moving across connected channels.', instructions: 'Capture owner, deadline, dependency, and requested outcome. Do not make policy or financial commitments without approval.', escalationRules: 'Escalate blocked deadlines, production impact, security concerns, financial commitments, and requests without a clear owner.', responseStyle: 'Direct, structured, and brief, with explicit owners and next actions.' },
  custom: { name: 'Channel operator', objective: 'Help me inspect and act on connected conversations when I ask.', instructions: '', escalationRules: 'Escalate pricing commitments, legal or security issues, angry customers, and anything outside the objective.', responseStyle: 'Clear, concise, human, and appropriate for the channel.' },
};

function ChannelAgentsPanel({ value, onChange, conversations }: { value: ChannelAgentConfig; onChange: (value: ChannelAgentConfig) => void; conversations: GatewayConversation[] }) {
  const profiles = value.profiles.length ? value.profiles : [defaultChannelAgentProfile()];
  const [editingId, setEditingId] = useState(value.defaultProfileId);
  const profile = profiles.find(item => item.id === editingId) || profiles.find(item => item.id === value.defaultProfileId) || profiles[0];
  const patchProfile = (patch: Partial<ChannelAgentProfile>) => onChange({ ...value, profiles: profiles.map(item => item.id === profile.id ? { ...item, ...patch } : item) });
  const addProfile = () => {
    const next = { ...defaultChannelAgentProfile(), id: `channel-agent-${crypto.randomUUID()}`, name: 'New channel agent' };
    onChange({ ...value, profiles: [...profiles, next] }); setEditingId(next.id);
  };
  const removeProfile = () => {
    if (profiles.length === 1) return;
    const next = profiles.filter(item => item.id !== profile.id);
    onChange({ ...value, defaultProfileId: value.defaultProfileId === profile.id ? next[0].id : value.defaultProfileId, profiles: next });
    setEditingId(next[0].id);
  };
  const boundConversations = conversations.filter(item => profile.channels.length === 0 || profile.channels.includes(item.platform));
  return <section className={styles.card}>
    <div className={styles.row}><div><h2>Channel agent profiles</h2><p className={styles.muted}>A channel-specific profile takes priority. An unrestricted default handles other channels.</p></div><Toggle label="Enable channel agent profiles" checked={value.enabled} onChange={enabled => onChange({ ...value, enabled })} /></div>
    <div className={`${styles.row} my-5`}><div className="min-w-[200px] flex-1"><ModernSelect label="Profile to edit" value={profile.id} onChange={setEditingId} options={profiles.map(item => ({ value: item.id, label: `${item.name}${item.id === value.defaultProfileId ? ' · Default' : ''}` }))} /></div><div className={styles.actions}><button type="button" className={styles.button} onClick={addProfile}>Add profile</button>{value.defaultProfileId !== profile.id && <button type="button" className={styles.button} onClick={() => onChange({ ...value, defaultProfileId: profile.id })}>Set as default</button>}<button type="button" className={styles.button} disabled={profiles.length === 1} onClick={removeProfile}>Remove profile</button></div></div>
    <div className={styles.fields}>
      <label className={styles.field}>Profile name<input value={profile.name} onChange={event => patchProfile({ name: event.target.value })} /></label>
      <label className={styles.field}>Role template<ModernSelect label="Role template" value={profile.role} onChange={role => patchProfile({ role: role as ChannelAgentProfile['role'], ...ROLE_TEMPLATES[role as ChannelAgentProfile['role']] })} options={[{ value: 'custom', label: 'Custom' }, { value: 'sales', label: 'Sales' }, { value: 'support', label: 'Support' }, { value: 'operations', label: 'Operations' }]} /></label>
      <label className={`${styles.field} ${styles.wide}`}>Objective<textarea rows={2} value={profile.objective} onChange={event => patchProfile({ objective: event.target.value })} /></label>
      <label className={`${styles.field} ${styles.wide}`}>Working instructions<textarea rows={4} placeholder="Product facts, workflow, trusted sources and tasks this agent should handle…" value={profile.instructions} onChange={event => patchProfile({ instructions: event.target.value })} /></label>
      <div className={`${styles.field} ${styles.wide}`}>Channels<div className={styles.actions}><button type="button" aria-pressed={!profile.channels.length} className={`${styles.button} ${!profile.channels.length ? styles.primary : ''}`} onClick={() => patchProfile({ channels: [] })}>All enabled</button>{PLATFORMS.map(platform => { const active = profile.channels.includes(platform.id); return <button type="button" key={platform.id} aria-pressed={active} className={`${styles.button} ${active ? styles.primary : ''}`} onClick={() => patchProfile({ channels: active ? profile.channels.filter(id => id !== platform.id) : [...profile.channels, platform.id] })}>{platform.label}</button>; })}</div><small className={styles.muted}>If multiple profiles name the same channel, the first matching profile is used.</small></div>
      <label className={styles.field}>Incoming messages<ModernSelect label="Operating mode" value={profile.operatingMode} onChange={mode => patchProfile({ operatingMode: mode as ChannelAgentProfile['operatingMode'] })} options={[{ value: 'manual', label: 'Manual · work only when asked' }, { value: 'assist', label: 'Assist · prepare a draft' }, { value: 'autonomous', label: 'Autonomous · handle messages' }]} /></label>
      <label className={styles.field}>Reply policy<ModernSelect label="Reply policy" value={profile.sendPolicy} onChange={policy => patchProfile({ sendPolicy: policy as ChannelAgentProfile['sendPolicy'] })} options={[{ value: 'draft-only', label: 'Draft only' }, { value: 'direct', label: 'Send when requested' }, { value: 'autonomous', label: 'Send automatically in Autonomous mode' }]} /></label>
      <label className={styles.field}>Inbox reading<ModernSelect label="Inbox reading" value={profile.readPolicy} onChange={policy => patchProfile({ readPolicy: policy as ChannelAgentProfile['readPolicy'] })} options={[{ value: 'on-demand', label: 'On demand' }, { value: 'unread', label: 'Unread first' }, { value: 'all', label: 'All matching conversations' }]} /></label>
      <label className={styles.field}>Recovery interval (minutes)<input type="number" min={1} max={1440} value={profile.pollIntervalMinutes} onChange={event => patchProfile({ pollIntervalMinutes: Number(event.target.value) || 1 })} /><small className={styles.muted}>Live messages arrive immediately. This interval recovers missed events.</small></label>
      <label className={styles.field}>Escalation rules<textarea rows={4} value={profile.escalationRules} onChange={event => patchProfile({ escalationRules: event.target.value })} /></label>
      <label className={styles.field}>Reply style<textarea rows={4} value={profile.responseStyle} onChange={event => patchProfile({ responseStyle: event.target.value })} /></label>
    </div>
    <div className={styles.setup}><strong>How the agent gets context</strong>Each message is routed to its own conversation. The agent loads this profile and the recent channel history before drafting. Automatic delivery requires both Autonomous mode and the automatic reply policy. Keep automatic replies off to review drafts in EterX.<div className="mt-2">{boundConversations.length} stored conversations match this profile. Telegram bot teammates keep their own model and agent settings in Connect as bot.</div></div>
  </section>;
}
type McpServerDraft = { id: string; name: string; transport: 'stdio' | 'streamable-http'; endpoint: string; command: string; args: string[]; status: 'ready' | 'connected'; lastError?: string };
const publicMcpServer = (server: any): McpServerDraft => ({ id: String(server.id), name: String(server.name), transport: server.transport, endpoint: server.endpoint || '', command: server.command || '', args: Array.isArray(server.args) ? server.args : [], status: server.enabled && server.lastCheckedAt && !server.lastError ? 'connected' : 'ready', lastError: server.lastError });

function McpGatewayPanel({ endpoint, enabled, running, onToggle, onCopy, onNotice, servers, setServers }: { baseUrl: string; endpoint: string; enabled: boolean; running: boolean; onToggle: (value: boolean) => void; onCopy: () => void; onNotice: (value: string) => void; servers: McpServerDraft[]; setServers: React.Dispatch<React.SetStateAction<McpServerDraft[]>> }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpServerDraft['transport']>('streamable-http');
  const [serverEndpoint, setServerEndpoint] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void fetch('/api/connectors/mcp').then(response => { if (!response.ok) throw new Error('Could not load MCP servers.'); return response.json(); }).then(payload => {
      if (active) setServers((payload.servers || []).map(publicMcpServer));
    }).catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [setServers]);
  const saveDraft = async () => {
    if (busy) return;
    setError('');
    try {
      if (!name.trim()) throw new Error('Enter a server name.');
      if (transport === 'streamable-http') {
        const url = new URL(serverEndpoint);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS endpoint without credentials in the URL.');
      } else if (!command.trim()) throw new Error('Enter the command that starts the MCP server.');
      const parseMap = (text: string, label: string) => {
        if (!text.trim()) return undefined;
        const value = JSON.parse(text);
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must be a JSON object of string values.`);
        return value;
      };
      // One argument per line preserves spaces in Windows paths without shell parsing.
      const argumentsList = args.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const request = { id: editingId, name: name.trim(), transport, endpoint: serverEndpoint.trim(), command: command.trim(), args: argumentsList, headers: parseMap(headers, 'Headers'), env: parseMap(env, 'Environment variables'), verify: true };
      setBusy('save');
      const response = await fetch('/api/connectors/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const payload = await response.json();
      if (payload.server) setServers(current => [...current.filter(item => item.id !== payload.server.id), publicMcpServer(payload.server)]);
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'The MCP server could not be connected.');
      setName(''); setServerEndpoint(''); setCommand(''); setArgs(''); setHeaders(''); setEnv(''); setEditingId(undefined); setAdding(false);
      onNotice('MCP server connected. Its discovered tools are available through the agent’s connector tools.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save MCP server.'); }
    finally { setBusy(''); }
  };
  const remove = async (id: string) => {
    setBusy(id); setError('');
    try {
      const response = await fetch('/api/connectors/mcp', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Could not remove MCP server.');
      setServers((payload.servers || []).map(publicMcpServer));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove server.'); }
    finally { setBusy(''); }
  };
  return <div>
    <section className={styles.card}><div className={styles.row}><div><h2>Expose EterX to an MCP client</h2><p className={styles.muted}>Let another client read gateway conversations and use channel tools.</p></div><div className={styles.actions}><span className={`${styles.status} ${running ? styles.online : ''}`}>{running ? 'Listening' : enabled ? 'Gateway offline' : 'Off'}</span><Toggle label="MCP gateway bridge" checked={enabled} onChange={onToggle} /></div></div><div className={styles.endpoint}><code>{endpoint}</code><button type="button" className={styles.button} disabled={!running} onClick={onCopy}><Copy />Copy client config</button></div><p className={`${styles.muted} mt-3`}>Save gateway changes before connecting. The copied configuration includes the private access token.</p></section>
    <section className={styles.card}><div className={styles.row}><div><h2>Give EterX tools from MCP servers</h2><p className={styles.muted}>Connect a remote endpoint or a local server. Tools are discovered when you connect. When editing, blank header and environment fields keep their saved values.</p></div><button type="button" className={styles.button} disabled={Boolean(busy)} onClick={() => { setAdding(current => !current); setEditingId(undefined); setName(""); setServerEndpoint(""); setCommand(""); setArgs(""); setHeaders(""); setEnv(""); }}>{adding ? 'Close editor' : 'Add server'}</button></div>
      {error && <div role="alert" className={`${styles.notice} ${styles.error} mt-4`}>{error}</div>}
      {adding && <fieldset disabled={Boolean(busy)} className="mt-5 min-w-0 border-0 p-0"><div className={styles.fields}>
        <label className={styles.field}>Server name<input value={name} onChange={event => setName(event.target.value)} placeholder="My tool server" /></label>
        <label className={styles.field}>Transport<ModernSelect label="MCP transport" value={transport} onChange={value => setTransport(value as McpServerDraft['transport'])} options={[{ value: 'streamable-http', label: 'Streamable HTTP' }, { value: 'stdio', label: 'Local stdio' }]} /></label>
        {transport === 'streamable-http' ? <><label className={`${styles.field} ${styles.wide}`}>Server endpoint<input value={serverEndpoint} onChange={event => setServerEndpoint(event.target.value)} placeholder="https://example.com/mcp" /></label><label className={`${styles.field} ${styles.wide}`}>Headers (optional JSON)<textarea autoComplete="off" rows={3} value={headers} onChange={event => setHeaders(event.target.value)} placeholder={'{"Authorization": "Bearer …"}'} /></label></> : <><label className={styles.field}>Command<input value={command} onChange={event => setCommand(event.target.value)} placeholder="npx" /></label><label className={styles.field}>Arguments · one per line<textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} placeholder={'-y\nserver-package\nC:\\My Documents'} /></label><label className={`${styles.field} ${styles.wide}`}>Environment variables (optional JSON)<textarea rows={3} autoComplete="off" value={env} onChange={event => setEnv(event.target.value)} placeholder={'{"API_KEY": "…"}'} /></label></>}
      </div><button type="button" className={`${styles.button} ${styles.primary} mt-4`} onClick={() => void saveDraft()}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Server />}{busy === 'save' ? 'Connecting…' : 'Connect server'}</button></fieldset>}
      <div className={styles.inbox}>{servers.map(server => <div key={server.id} className={styles.inboxRow}><div className={styles.row}><div><strong className="text-sm">{server.name}</strong><p>{server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.endpoint}</p></div><div className={styles.actions}><span className={`${styles.status} ${server.status === 'connected' ? styles.online : ''}`}>{server.status === 'connected' ? 'Connected' : 'Needs attention'}</span><button type="button" className={styles.button} disabled={Boolean(busy)} onClick={() => { setEditingId(server.id); setName(server.name); setTransport(server.transport); setServerEndpoint(server.endpoint); setCommand(server.command); setArgs(server.args.join("\n")); setHeaders(""); setEnv(""); setAdding(true); }}>Edit</button><button type="button" className={styles.button} disabled={Boolean(busy)} onClick={() => void remove(server.id)}>{busy === server.id ? 'Removing…' : 'Remove'}</button></div></div>{server.lastError && <p className={styles.error}>{server.lastError}</p>}</div>)}{!servers.length && <p className={styles.muted}>No MCP servers connected yet.</p>}</div>
    </section>
  </div>;
}
type LiveSkill = { id: string; name: string; description: string; editable?: boolean };
function LiveSkillsGatewayPanel() {
  const [skills, setSkills] = useState<LiveSkill[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'rename' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = skills.find(skill => skill.id === selectedId);
  const dirty = content !== savedContent;
  const notify = (value: string, error = false) => { setMessage(value); setMessageError(error); };
  const request = async (url: string, options?: RequestInit) => {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.rejected?.map((item: any) => `${item.name}: ${item.reason}`).join(' ') || 'The skill could not be updated.');
    return result;
  };
  const loadCatalog = async (nextId?: string) => {
    setCatalogLoading(true);
    try {
      const result = await request('/api/skills');
      const next: LiveSkill[] = result.skills || [];
      setSkills(next);
      setSelectedId(current => next.some(skill => skill.id === (nextId || current)) ? (nextId || current) : next[0]?.id || '');
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'Could not load skills.', true); }
    finally { setCatalogLoading(false); }
  };
  useEffect(() => { void loadCatalog(); }, []);
  useEffect(() => {
    if (!selectedId) { setContent(''); setSavedContent(''); return; }
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    void request(`/api/skills/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setContent(result.content || ''); setSavedContent(result.content || ''); setUndoStack([]); setRedoStack([]);
    }).catch(reason => { if (!controller.signal.aborted) setLoadError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId]);
  const save = async () => {
    if (!selected?.editable || !dirty || busy || loading) return;
    setBusy(true);
    try {
      await request(`/api/skills/${encodeURIComponent(selectedId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
      setSavedContent(content); notify('Skill saved. Future agent requests can load the updated instructions.');
      await loadCatalog(selectedId);
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'Could not save skill.', true); }
    finally { setBusy(false); }
  };
  const mutate = async () => {
    setBusy(true);
    try {
      const creating = dialog === 'create';
      const result = await request(creating ? '/api/skills' : `/api/skills/${encodeURIComponent(selectedId)}`, {
        method: creating ? 'POST' : dialog === 'rename' ? 'PATCH' : 'DELETE', headers: { 'content-type': 'application/json' },
        body: dialog === 'delete' ? undefined : JSON.stringify(creating ? { createName: name } : { name }),
      });
      setContent(''); setSavedContent(''); setSelectedId(''); setDialog(null);
      notify(dialog === 'delete' ? 'Skill removed.' : dialog === 'rename' ? 'Skill renamed.' : 'Skill created. Add its instructions below.');
      await loadCatalog(result.id);
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'Could not update skill.', true); }
    finally { setBusy(false); }
  };
  const importSkills = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const payload = await Promise.all(files.map(async file => ({ name: file.name, content: await file.text() })));
      const result = await request('/api/skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: payload }) });
      const failures = (result.rejected || []).map((item: any) => `${item.name}: ${item.reason}`).join(' ');
      notify(`${result.imported?.length || 0} skills imported.${failures ? ` ${failures}` : ''}`, Boolean(failures));
      await loadCatalog();
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'Could not import skills.', true); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const edit = (next: string) => { setUndoStack(current => [...current.slice(-99), content]); setRedoStack([]); setContent(next); };
  const visible = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <section className={styles.card}><div className={styles.row}><div><h2>Agent skills</h2><p className={styles.muted}>Saved workflows the agent can discover and load when relevant. Bundled skills are read-only.</p></div><div className={styles.actions}><button type="button" disabled={busy || dirty} className={styles.button} onClick={() => { setName(''); setDialog('create'); }}>New skill</button><button type="button" disabled={busy || dirty} className={styles.button} onClick={() => fileInput.current?.click()}>Import .md</button><button type="button" disabled={busy || dirty || catalogLoading} className={styles.button} onClick={() => void loadCatalog()} aria-label="Refresh skills"><RefreshCw className={catalogLoading ? 'animate-spin' : ''} /></button></div></div><input type="file" ref={fileInput} hidden multiple accept=".md,text/markdown" onChange={event => void importSkills(Array.from(event.target.files || []))} /></section>
    {message && <div role={messageError ? 'alert' : 'status'} className={`${styles.notice} ${messageError ? styles.error : ''}`}>{message}</div>}
    <section className={styles.connections}><aside className={styles.rail}><label className={styles.search}><Search size={15} /><input aria-label="Search skills" placeholder="Search skills" value={query} onChange={event => setQuery(event.target.value)} /></label><div className={styles.railList}>{visible.map(skill => <button type="button" key={skill.id} disabled={busy || loading} className={styles.connector} aria-current={selectedId === skill.id ? 'true' : undefined} onClick={() => { if (dirty) { notify('Save or discard your edits before selecting another skill.'); return; } setSelectedId(skill.id); }}><span><strong>{skill.name}</strong><small>{skill.editable ? 'Your skill' : 'Built in'}</small></span></button>)}{!visible.length && <p className={`${styles.muted} p-3`}>{catalogLoading ? 'Loading skills…' : 'No matching skills.'}</p>}</div></aside>
      <div className={styles.connectorBody}>{selected ? <><div className={styles.row}><div><h2 className="text-lg font-semibold">{selected.name}</h2><p className={styles.muted}>{dirty ? 'Unsaved changes' : selected.editable ? 'Saved' : 'Read only'}</p></div><div className={styles.actions}>
        <button type="button" className={styles.button} aria-label="Undo skill edit" disabled={!undoStack.length || busy || loading} onClick={() => { const previous = undoStack.at(-1)!; setUndoStack(current => current.slice(0, -1)); setRedoStack(current => [...current, content]); setContent(previous); }}><Undo2 /></button>
        <button type="button" className={styles.button} aria-label="Redo skill edit" disabled={!redoStack.length || busy || loading} onClick={() => { const next = redoStack.at(-1)!; setRedoStack(current => current.slice(0, -1)); setUndoStack(current => [...current, content]); setContent(next); }}><Redo2 /></button>
        {selected.editable && <><button type="button" className={styles.button} disabled={busy || dirty || loading} onClick={() => { setName(selected.name); setDialog('rename'); }}>Rename</button><button type="button" className={styles.button} disabled={busy || loading} onClick={() => setDialog('delete')}>Delete</button></>}
      </div></div>{loadError ? <div role="alert" className={`${styles.notice} ${styles.error} mt-4`}>{loadError}</div> : <label className={`${styles.field} mt-5`}><span className="sr-only">Skill Markdown instructions</span><textarea className={styles.skillEditor} spellCheck={false} readOnly={!selected.editable || loading || busy} value={loading ? 'Loading skill…' : content} onChange={event => edit(event.target.value)} /></label>}
      {selected.editable && <div className={`${styles.actions} mt-4`}><button type="button" className={`${styles.button} ${styles.primary}`} disabled={!dirty || busy || loading || Boolean(loadError)} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />}Save skill</button><button type="button" className={styles.button} disabled={!dirty || busy} onClick={() => { setContent(savedContent); setUndoStack([]); setRedoStack([]); }}>Discard edits</button></div>}</> : <p className={styles.muted}>Select a skill, create one, or import a Markdown skill file.</p>}</div>
    </section>
    <Dialog.Root open={Boolean(dialog)} onOpenChange={open => { if (!open && !busy) setDialog(null); }}><Dialog.Portal><Dialog.Overlay className={styles.dialogOverlay} /><Dialog.Content className={styles.dialog}>
      <Dialog.Title className="text-lg font-semibold">{dialog === 'delete' ? 'Delete skill' : dialog === 'rename' ? 'Rename skill' : 'Create skill'}</Dialog.Title>
      <Dialog.Description className={`${styles.muted} mt-2`}>{dialog === 'delete' ? `Remove “${selected?.name}” and its local instructions?` : 'Use a clear name that describes when the agent should use this workflow.'}</Dialog.Description>
      {dialog !== 'delete' && <label className={`${styles.field} mt-4`}>Skill name<input autoFocus disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="Customer support workflow" /></label>}
      {messageError && <p role="alert" className={`${styles.error} mt-3 text-xs`}>{message}</p>}
      <div className={`${styles.actions} mt-5`}><button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy || (dialog !== 'delete' && !name.trim())} onClick={() => void mutate()}>{busy ? 'Saving…' : dialog === 'delete' ? 'Delete skill' : dialog === 'rename' ? 'Rename' : 'Create'}</button><Dialog.Close asChild><button type="button" className={styles.button} disabled={busy}>Cancel</button></Dialog.Close></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
const LegacyAgentChannelsView = React.memo(() => {
  const [screen, setScreen] = useState<'landing' | 'gateway' | 'bots'>('landing');
  const [config, setConfig] = useState<GatewayConfig>(defaultConfig);
  const [savedConfig, setSavedConfig] = useState('');
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [conversations, setConversations] = useState<GatewayConversation[]>([]);
  const [externalConnectorStatus, setExternalConnectorStatus] = useState<Record<string, any>>({});
  const [approvals, setApprovals] = useState<GatewayApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [connectorSearch, setConnectorSearch] = useState('');
  const [selectedConnector, setSelectedConnector] = useState('telegram');
  const [gatewayMode, setGatewayMode] = useState<GatewayMode>('communication');
  const [mcpServers, setMcpServers] = useState<McpServerDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);
  const [secureStorage, setSecureStorage] = useState(true);
  const [pathwayProfiles, setPathwayProfiles] = useState<Record<string, Record<string, string>>>({});
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : null;
  const dirty = useMemo(() => Boolean(savedConfig && JSON.stringify(config) !== savedConfig), [config, savedConfig]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const baseUrl = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
  const communicationCatalog = CONNECTOR_CATALOG.filter(connector => connector.id !== 'mcp' && connector.id !== 'skills');
  const selected = communicationCatalog.find(connector => connector.id === selectedConnector) || communicationCatalog[0];
  const selectedNative = PLATFORMS.find(platform => platform.id === selected.id);
  const selectedItem = selectedNative ? config.platforms[selectedNative.id] : null;
  const visibleConnectors = communicationCatalog.filter(connector => `${connector.label} ${connector.description}`.toLowerCase().includes(connectorSearch.trim().toLowerCase()));
  const selectedStatus = selectedNative ? status?.platforms?.[selectedNative.id] : undefined;
  const pendingApprovals = approvals.filter(item => item.status === 'pending');
  const notify = (message: string, error = false) => { setNotice(message); setNoticeError(error); };
  const mergeState = (raw: Partial<GatewayConfig>): GatewayConfig => {
    const defaults = defaultConfig();
    return { ...defaults, ...raw, busyInputMode: raw.busyInputMode === 'steer' ? 'steer' : 'queue', channelAgent: raw.channelAgent || defaults.channelAgent, platforms: Object.fromEntries(PLATFORMS.map(platform => [platform.id, { ...defaults.platforms[platform.id], ...raw.platforms?.[platform.id] }])) as GatewayConfig['platforms'] };
  };
  const loadState = useCallback(async (discard = false) => {
    setLoading(true);
    try {
      if (!api?.getGatewayState) { setSecureStorage(false); return; }
      const state = await api.getGatewayState();
      if (!state?.config) throw new Error('The desktop gateway is not ready. Try refreshing in a moment.');
      if (!dirtyRef.current || discard) {
        const next = mergeState(state.config);
        setConfig(next);
        setSavedConfig(JSON.stringify(next));
      }
      setStatus(state.status || null);
      setConversations(Array.isArray(state.conversations) ? state.conversations : []);
      setApprovals(await api.listGatewayApprovals?.() || []);
      setSecureStorage(state.available !== false);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not load gateway state.'); setNoticeError(true); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void loadState(); }, [loadState]);
  useEffect(() => {
    const openBots = () => setScreen('bots');
    const back = () => setScreen('landing');
    window.addEventListener('eterx_connect_as_bot', openBots);
    window.addEventListener('eterx_gateway_back', back);
    return () => { window.removeEventListener('eterx_connect_as_bot', openBots); window.removeEventListener('eterx_gateway_back', back); };
  }, []);
  useEffect(() => {
    // Legacy body selectors hid controls and imposed viewport-sized panels.
    // This workspace owns its layout; the shared header uses the screen event.
    window.dispatchEvent(new CustomEvent('eterx_gateway_screen', { detail: screen === 'gateway' }));
    return () => { window.dispatchEvent(new CustomEvent('eterx_gateway_screen', { detail: false })); };
  }, [screen]);
  useEffect(() => {
    const off = api?.onGatewayStatus?.((next: GatewayStatus) => {
      setStatus(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    });
    return () => { if (typeof off === 'function') off(); };
  }, [api]);
  useEffect(() => {
    if (screen !== 'gateway') return;
    let active = true;
    let refreshing = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (!active || refreshing || !isAppVisible()) return;
      refreshing = true;
      try {
        const results = await Promise.allSettled([
          api?.getGatewayState?.(), api?.listGatewayApprovals?.(),
          requestJson('/api/connectors/status', { signal: controller.signal }, 15_000).then(response => { if (!response.ok) throw new Error('Could not load connector status.'); return response.json(); }),
        ]);
        if (!active) return;
        const [state, permissions, connectors] = results;
        if (state.status === 'fulfilled' && state.value) {
          const nextStatus = state.value.status || null;
          const nextConversations = Array.isArray(state.value.conversations) ? state.value.conversations : [];
          setStatus(previous => JSON.stringify(previous) === JSON.stringify(nextStatus) ? previous : nextStatus);
          setConversations(previous => JSON.stringify(previous) === JSON.stringify(nextConversations) ? previous : nextConversations);
        }
        if (permissions.status === 'fulfilled' && Array.isArray(permissions.value)) {
          const nextApprovals = permissions.value;
          setApprovals(previous => JSON.stringify(previous) === JSON.stringify(nextApprovals) ? previous : nextApprovals);
        }
        if (connectors.status === 'fulfilled') {
          const nextConnectors = connectors.value.connectors || {};
          setExternalConnectorStatus(previous => JSON.stringify(previous) === JSON.stringify(nextConnectors) ? previous : nextConnectors);
        }
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onRefresh = () => void refresh();
    const unsubscribeVisibility = subscribeAppVisibility(onRefresh);
    window.addEventListener('eterx_connector_status_refresh', onRefresh);
    return () => {
      active = false;
      controller.abort();
      unsubscribeVisibility();
      window.clearInterval(timer);
      window.removeEventListener('eterx_connector_status_refresh', onRefresh);
    };
  }, [api, screen]);
  const patchPlatform = (id: PlatformId, patch: Partial<PlatformConfig>) => setConfig(current => ({ ...current, platforms: { ...current.platforms, [id]: { ...current.platforms[id], ...patch } } }));
  const save = async () => {
    if (savingRef.current) return;
    if (!api?.saveGatewayConfig || !savedConfig) return notify('Open the desktop app and load the gateway before saving.', true);
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) return notify('Use a gateway port between 1024 and 65535.', true);
    savingRef.current = true;
    setSaving(true); setNotice(null);
    try {
      const result = await api.saveGatewayConfig(config);
      if (!result?.ok) throw new Error(result?.error || 'Could not save gateway configuration.');
      const next = mergeState(result.config || config);
      setConfig(next); setSavedConfig(JSON.stringify(next)); setStatus(result.status || null);
      setRevealed({});
      appStorage.setItem('eterx_background_active_chats', String(Boolean(next.enabled && next.keepActiveChatsOnClose)));
      appStorage.setItem('eterx_background_scheduled_tasks', String(Boolean(next.enabled && next.runScheduledTasksInBackground)));
      window.dispatchEvent(new CustomEvent('eterx-background-settings-updated', { detail: next }));
      const problems = Object.values(result.status?.platforms || {}).some((item: any) => item.enabled && item.lastError);
      notify(problems ? 'Settings saved. A connection needs attention; select it to see the error.' : result.status?.running ? 'Settings saved. The gateway is running; each connection reports its live status below.' : 'Settings saved. The gateway is off.', problems);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save gateway configuration.', true); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const copyMcpConfig = async () => {
    try {
      if (!status?.running || !status.mcpEndpoint) throw new Error('Enable the gateway and MCP bridge, then save before copying the connection.');
      const connection = await api?.getGatewayMcpConnection?.();
      if (!connection) throw new Error('The desktop gateway connection is unavailable.');
      const copied = await safeCopyTextToClipboard(JSON.stringify({ mcpServers: { 'eterx-gateway': { url: connection.url, headers: connection.headers } } }, null, 2));
      notify(copied ? 'MCP connection copied.' : 'Could not copy MCP connection.', !copied);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not copy MCP connection.', true); }
  };
  const resolveApproval = async (id: string, approved: boolean) => {
    setApprovalBusy(id);
    try {
      const resolved = await api?.resolveGatewayApproval?.(id, approved);
      if (!resolved) throw new Error('This approval could not be updated. Refresh and try again.');
      setApprovals(current => current.map(item => item.id === id ? { ...item, status: approved ? 'approved' : 'denied' } : item));
      notify(approved ? 'Person approved. Ask them to send their message again to start the conversation.' : 'Connection request denied.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not update approval.', true); }
    finally { setApprovalBusy(null); }
  };
  const stateLabel = (id: string) => {
    const native = PLATFORMS.some(platform => platform.id === id);
    if (!native) return externalConnectorStatus[id]?.connected ? 'API available' : externalConnectorStatus[id]?.lastError ? 'Needs attention' : 'API setup';
    const live = status?.platforms?.[id];
    if (!live?.enabled) return 'Not connected';
    if (!status?.running) return 'Gateway off';
    return ({ listening: 'Listening', connected: 'Connected', connecting: 'Connecting', retrying: 'Reconnecting', 'needs-configuration': 'Setup required', conflict: 'Connection conflict', stopped: 'Stopped', external: 'Other instance', disabled: 'Not connected' } as Record<string, string>)[live.state] || live.state;
  };
  const matchedProfile = selectChannelProfile(config.channelAgent, selected.id);
  const routeDescription = !config.autoDispatch || !config.channelAgent.enabled || !matchedProfile || matchedProfile.operatingMode === 'manual'
    ? 'Messages stay in the inbox until you ask the agent to read them.'
    : matchedProfile.operatingMode === 'autonomous' && matchedProfile.sendPolicy === 'autonomous'
      ? 'New approved messages start the agent. Its completed answer returns to this conversation.'
      : 'New approved messages start the agent and create a draft in EterX. Replies are not sent automatically.';

  if (screen === 'bots') return <ConnectAsBot onBack={() => setScreen('landing')} onChanged={() => void loadState()} />;
  if (screen === 'landing') {
    const features = [
      { icon: ShieldCheck, title: 'Your agent, connected', text: 'Bring your EterX agent to the conversations that matter.' },
      { icon: MessageCircle, title: 'Context per conversation', text: 'Keep messages and replies together, with separate working histories.' },
      { icon: Settings2, title: 'You choose the workflow', text: 'Read on request, prepare drafts, or enable automatic replies.' },
      { icon: Activity, title: 'Stay in control', text: 'See connection status and approve who can reach your agent.' },
    ];
    return <div className={styles.surface}><div className={styles.landing}>
      <div className={styles.illustration} aria-hidden="true">
        <div className={styles.phone} />
        <div className={styles.identity}><span className={styles.avatar}><PremiumAgent className="h-6 w-6 brightness-0" /></span><div><strong>EterX <CheckCircle2 size={15} className="text-blue-500" /></strong><small>Your agent, wherever you work</small></div></div>
        {([['whatsapp', '0s'], ['telegram', '-1.65s'], ['messenger', '-3.3s']] as const).map(([id, delay]) => <span key={id} className={styles.orbitIcon} data-platform={id} style={{ '--orbit-delay': delay } as React.CSSProperties}><img src={`/icons/connectors/${id}.svg`} alt="" /></span>)}
      </div>
      <h1 className={styles.headline}>One agent. Every conversation.</h1>
      <p className={styles.subtitle}>Work with your agent on Telegram, or connect your team’s channels through the EterX gateway.</p>
      <div className={styles.landingActions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setScreen('bots')}><img src="/icons/connectors/telegram.svg" alt="" className="h-[18px] w-[18px]" />Connect as bot{(status?.bots?.length || 0) > 0 && <span className={styles.count}>{status?.bots?.length}</span>}<ChevronRight /></button>
        <button type="button" className={styles.button} onClick={() => setScreen('gateway')}><Radio />Go to gateway<ChevronRight /></button>
      </div>
      <div className={styles.features}>{features.map(({ icon: Icon, title, text }) => <article key={title} className={styles.feature}><Icon /><h2>{title}</h2><p>{text}</p></article>)}</div>
    </div></div>;
  }
  return <div className={styles.surface}><div className={styles.workspace}>
    <header className={styles.header}>
      <div className={styles.actions}><button type="button" className={styles.button} aria-label="Back to Channels" onClick={() => setScreen('landing')}><ArrowLeft /></button><div><h1>Gateway</h1><p>Connect channels, choose a workflow, and manage incoming messages.</p></div></div>
      <div className={styles.actions}>
        {dirty && <span className={styles.muted}>Unsaved changes</span>}
        <button type="button" className={styles.button} disabled={loading || saving} onClick={() => void loadState(dirty)}>{dirty ? <Undo2 /> : <RefreshCw className={loading ? 'animate-spin' : ''} />}{dirty ? 'Discard edits' : 'Refresh'}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={saving || loading || !savedConfig || !api?.saveGatewayConfig} onClick={() => void save()}>{saving ? <Loader2 className="animate-spin" /> : <Save />}{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </header>
    {notice && <div role={noticeError ? 'alert' : 'status'} className={`${styles.notice} ${noticeError ? styles.error : ''}`}>{notice}</div>}
    {!secureStorage && <div className={styles.notice}>Channel credentials require EterX desktop secure storage. Open this workspace in the desktop app to connect.</div>}
    {status?.lastError && <div role="alert" className={`${styles.notice} ${styles.error}`}>{status.lastError}</div>}
    {status?.lastDeliveryError && <div role="alert" className={`${styles.notice} ${styles.error}`}>Reply delivery: {status.lastDeliveryError}</div>}<div className={styles.tabs} aria-label="Gateway sections">{([{ id: 'communication', label: 'Connections' }, { id: 'agents', label: 'Agent routing' }, { id: 'mcp', label: 'MCP' }, { id: 'skills', label: 'Skills' }] as const).map(tab => <button type="button" key={tab.id} aria-pressed={gatewayMode === tab.id} onClick={() => setGatewayMode(tab.id)}>{tab.label}</button>)}</div>
    <fieldset disabled={saving || loading || !savedConfig} className="min-w-0 border-0 p-0">
      <section className={styles.card}>
        <div className={styles.row}>
          <div className={styles.actions}>{status?.running ? <Wifi size={19} className="text-emerald-500" /> : <WifiOff size={19} />}<div><h2>Background gateway</h2><p className={styles.muted}>Keep EterX running and this computer awake to receive messages.</p></div></div>
          <div className={styles.actions}><span className={`${styles.status} ${status?.running ? styles.online : ''}`}><span className={styles.dot} />{status?.running ? 'Running' : 'Offline'}</span><Toggle checked={config.enabled} onChange={enabled => setConfig(current => ({ ...current, enabled }))} label="Background gateway" /></div>
        </div>
        <div className={styles.settingsGrid}>
          <div className={styles.setting}><span>Run after closing the window<small>EterX stays available in the system tray.</small></span><Toggle checked={config.keepRunningOnClose} onChange={keepRunningOnClose => setConfig(current => ({ ...current, keepRunningOnClose }))} label="Run after closing" /></div>
          <div className={styles.setting}><span>Start at sign-in<small>Start the gateway when you sign in.</small></span><Toggle checked={config.launchAtLogin} onChange={launchAtLogin => setConfig(current => ({ ...current, launchAtLogin }))} label="Start at sign-in" /></div>
        </div>
        <details className="mt-4"><summary className="cursor-pointer text-xs font-medium">Advanced settings</summary><div className={styles.fields} style={{ marginTop: 16 }}>
          <label className={styles.field}>Gateway port<input type="number" min={1024} max={65535} value={config.port} onChange={event => setConfig(current => ({ ...current, port: Number(event.target.value) }))} /></label>
          <label className={styles.field}>Messages arriving during a task<ModernSelect label="Messages during a task" value={config.busyInputMode} onChange={busyInputMode => setConfig(current => ({ ...current, busyInputMode: busyInputMode as GatewayConfig['busyInputMode'] }))} options={[{ value: 'queue', label: 'Queue for the next task' }, { value: 'steer', label: 'Add to the current task' }]} /></label>
        </div><p className={`${styles.muted} mt-3`}>Listener: {baseUrl}. Public webhook providers need an HTTPS tunnel or reverse proxy.</p></details>
      </section>
      {pendingApprovals.length > 0 && <section className={styles.card}><h2>People waiting for approval <span className={styles.count}>{pendingApprovals.length}</span></h2><p className={styles.muted}>Approve only the person whose channel identity and pairing code you recognize.</p><div className={styles.inbox}>{pendingApprovals.map(item => <div key={item.id} className={`${styles.inboxRow} ${styles.row}`}><div><strong className="text-xs">{item.displayName}</strong><p>{item.platform}{item.code ? ` · ${item.code}` : ''}</p></div><div className={styles.actions}><button type="button" className={styles.button} disabled={Boolean(approvalBusy)} onClick={() => void resolveApproval(item.id, false)}>Deny</button><button type="button" className={styles.button} disabled={Boolean(approvalBusy)} onClick={() => void resolveApproval(item.id, true)}>{approvalBusy === item.id ? 'Updating…' : 'Approve'}</button></div></div>)}</div></section>}
      {gatewayMode === 'agents' && <>
        <section className={styles.card}><div className={styles.row}><div><h2>Run agents on incoming messages</h2><p className={styles.muted}>Manual profiles stay on demand. Assist creates drafts; Autonomous can send completed replies.</p></div><Toggle label="Run agents on incoming messages" checked={config.autoDispatch} onChange={autoDispatch => setConfig(current => ({ ...current, autoDispatch }))} /></div><div className={styles.flow}><span>Approved sender</span><ChevronRight /><span>Matching profile</span><ChevronRight /><span>EterX agent</span><ChevronRight /><span>Draft or channel reply</span></div></section>
        <ChannelAgentsPanel value={config.channelAgent} onChange={channelAgent => setConfig(current => ({ ...current, channelAgent }))} conversations={conversations} />
      </>}
      {gatewayMode === 'communication' && <section className={styles.connections}>
        <aside className={styles.rail}><label className={styles.search}><Search size={15} /><input aria-label="Search connections" placeholder="Search connections" value={connectorSearch} onChange={event => setConnectorSearch(event.target.value)} /></label><nav className={styles.railList} aria-label="Connections">{visibleConnectors.map(connector => <button type="button" key={connector.id} className={styles.connector} aria-current={selected.id === connector.id ? 'true' : undefined} onClick={() => setSelectedConnector(connector.id)}>{connector.logo ? <img src={connector.logo} alt="" /> : <Server size={23} />}<span><strong>{connector.label}</strong><small>{stateLabel(connector.id)}</small></span></button>)}{!visibleConnectors.length && <p className={`${styles.muted} p-3`}>No matching connections.</p>}</nav></aside>
        <div className={styles.connectorBody}>
          <div className={styles.row}><div className={styles.connectorHeading}>{selected.logo && <img src={selected.logo} alt="" />}<div><h2>{selected.label}</h2><p className={styles.muted}>{selected.description}</p></div></div><div className={styles.actions}><span className={`${styles.status} ${['Connected', 'Listening', 'API available'].includes(stateLabel(selected.id)) ? styles.online : ''}`}>{stateLabel(selected.id)}</span>{selectedNative && selectedItem && <Toggle label={`Enable ${selected.label}`} checked={selectedItem.enabled} onChange={enabled => patchPlatform(selectedNative.id, { enabled })} />}</div></div>
          {selectedNative && selectedItem ? <>
            <div className={styles.setup}><strong>Connect {selected.label}</strong>{selected.setup}{selected.guideUrl && <div className="mt-2"><a href={selected.guideUrl} target="_blank" rel="noreferrer">Setup guide ↗</a></div>}</div>
            {selectedNative.id === 'telegram' && <div className={styles.setup}><strong>Looking for your personal Telegram agent?</strong>Use Connect as bot to select its model, pair your account, and send it tasks. Use a separate bot token for this channel gateway.<button type="button" className={`${styles.button} mt-3`} onClick={() => setScreen('bots')}>Connect as bot<ChevronRight /></button></div>}
            <NativeSetupFields key={selectedNative.id} platform={selectedNative} item={selectedItem} patchPlatform={patchPlatform} revealed={revealed} setRevealed={setRevealed} />
            {selectedNative.mode === 'webhook' && <><div className={styles.endpoint}><code>{baseUrl}/webhooks/{selectedNative.id}</code><button type="button" className={styles.button} aria-label="Copy local webhook URL" onClick={() => void safeCopyTextToClipboard(`${baseUrl}/webhooks/${selectedNative.id}`).then(ok => notify(ok ? 'Local webhook URL copied.' : 'Could not copy URL.', !ok))}><Copy /></button></div><p className={`${styles.muted} mt-2`}>This is a local address. Use your public HTTPS forwarding address in the provider’s webhook settings.</p></>}
            {selectedStatus?.lastError && <div role="alert" className={`${styles.notice} ${styles.error} mt-4`}>{selectedStatus.lastError}</div>}
            <div className={styles.setup}><strong>{matchedProfile ? `Routes to ${matchedProfile.name}` : 'No matching agent profile'}</strong>{routeDescription}<div className="mt-3"><button type="button" className={styles.button} onClick={() => setGatewayMode('agents')}>Configure agent routing<ChevronRight /></button></div></div>
            <div className={styles.row}><p className={styles.muted}>Changes apply when you save. Credentials stay encrypted on this computer.</p><button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void save()}><Save />Save changes</button></div>
          </> : <>
            <div className={styles.setup}><strong>Agent API connection</strong>This gives the agent access to the service API. Receiving messages automatically requires a native channel above or a bridge that forwards events to Custom webhook.</div>
            <PathwaySetup key={selected.id} connector={selected} profile={pathwayProfiles[selected.id] || {}} saved={externalConnectorStatus[selected.id]} onChange={(key, value) => setPathwayProfiles(current => ({ ...current, [selected.id]: { ...(current[selected.id] || {}), [key]: value } }))} onSaved={() => setPathwayProfiles(current => ({ ...current, [selected.id]: {} }))} />
          </>}
        </div>
      </section>}
      {gatewayMode === 'mcp' && <McpGatewayPanel baseUrl={baseUrl} endpoint={status?.mcpEndpoint || `${baseUrl}/mcp`} enabled={config.mcpBridgeEnabled} running={Boolean(status?.running && status?.mcpEndpoint)} onToggle={mcpBridgeEnabled => setConfig(current => ({ ...current, mcpBridgeEnabled }))} onCopy={() => void copyMcpConfig()} onNotice={setNotice} servers={mcpServers} setServers={setMcpServers} />}
    </fieldset>
    {gatewayMode === 'communication' && <section className={`${styles.card} mt-5`}><div className={styles.row}><h2>Recent conversations</h2><span className={styles.muted}>{status?.pendingDeliveryCount || 0} pending · {status?.failedDeliveryCount || 0} failed replies</span></div><div className={styles.inbox}>{conversations.filter(item => item.platform === selected.id).slice(0, 6).map(item => <div key={item.id} className={styles.inboxRow}><div className={styles.row}><strong className="text-xs">{item.title}</strong><span className={styles.muted}>{item.unreadCount ? `${item.unreadCount} unread` : `${item.messageCount} messages`}</span></div><p>{item.lastMessagePreview}</p></div>)}{!conversations.some(item => item.platform === selected.id) && <p className={styles.muted}>No messages received here yet. Connect the channel, save, and send a message from an approved account.</p>}</div></section>}
    <div hidden={gatewayMode !== 'skills'} className={styles.skills}><LiveSkillsGatewayPanel /></div>
  </div></div>;
});
function PathwaySetup({ connector, profile, saved, onChange, onSaved }: { connector: ConnectorCatalogItem; profile: Record<string, string>; saved?: { connected?: boolean; baseUrl?: string; healthPath?: string; authHeader?: string; tokenPrefix?: string; lastError?: string }; onChange: (key: string, value: string) => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const connect = async () => {
    if (saving) return;
    setSaving(true); setMessage(''); setFailed(false);
    try {
      const configuredUrl = (profile.baseUrl ?? saved?.baseUrl ?? '').trim();
      const url = new URL(configuredUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter an HTTP or HTTPS API base URL without a password, query or fragment.');
      const healthPath = (profile.healthPath ?? saved?.healthPath ?? '').trim();
      if (!healthPath) throw new Error('Enter an authenticated identity endpoint such as /v1/me. A public home page cannot verify API access.');
      const response = await fetch('/api/connectors/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: connector.id, baseUrl: configuredUrl, healthPath, authHeader: profile.authHeader ?? saved?.authHeader ?? 'Authorization', tokenPrefix: profile.tokenPrefix ?? saved?.tokenPrefix ?? 'Bearer', credentials: profile.apiToken?.trim() ? { token: profile.apiToken.trim() } : undefined }) });
      const result = await response.json();
      window.dispatchEvent(new CustomEvent('eterx_connector_status_refresh'));
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not connect to the API.');
      setMessage('API access verified. The agent can call this service through connector tools. Incoming message delivery still needs a native channel or webhook bridge.');
      onSaved();
    } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : 'Connection failed.'); }
    finally { setSaving(false); }
  };
  const disconnect = async () => {
    setSaving(true); setMessage(''); setFailed(false);
    try {
      const response = await fetch('/api/connectors/status', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: connector.id }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not disconnect API.');
      window.dispatchEvent(new CustomEvent('eterx_connector_status_refresh')); onSaved(); setMessage('API connection removed.');
    } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : 'Could not disconnect.'); }
    finally { setSaving(false); }
  };
  return <fieldset disabled={saving} className="min-w-0 border-0 p-0">
    {connector.guideUrl && <a href={connector.guideUrl} target="_blank" rel="noreferrer" className="mb-4 inline-block text-xs underline underline-offset-4">Service setup guide ↗</a>}
    <div className={styles.fields}>
      <label className={styles.field}>API base URL<input value={profile.baseUrl ?? saved?.baseUrl ?? ''} onChange={event => onChange('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label className={styles.field}>Identity endpoint<input value={profile.healthPath ?? saved?.healthPath ?? ''} onChange={event => onChange('healthPath', event.target.value)} placeholder="/me" /><small className={styles.muted}>A read-only endpoint that requires the credential.</small></label>
      <label className={`${styles.field} ${styles.wide}`}>API credential<input type="password" autoComplete="off" value={profile.apiToken || ''} onChange={event => onChange('apiToken', event.target.value)} placeholder={saved ? 'Saved securely · enter to replace' : 'API token'} /></label>
      <label className={styles.field}>Authentication header<input value={profile.authHeader ?? saved?.authHeader ?? 'Authorization'} onChange={event => onChange('authHeader', event.target.value)} placeholder="Authorization" /></label>
      <label className={styles.field}>Token prefix<ModernSelect label="API credential prefix" value={(profile.tokenPrefix ?? saved?.tokenPrefix) === '' ? 'none' : profile.tokenPrefix || saved?.tokenPrefix || 'Bearer'} onChange={value => onChange('tokenPrefix', value === 'none' ? '' : value)} options={[{ value: 'Bearer', label: 'Bearer' }, { value: 'Bot', label: 'Bot' }, { value: 'Basic', label: 'Basic (encoded credentials)' }, { value: 'none', label: 'No prefix' }]} /></label>
    </div>
    <div className={`${styles.actions} mt-5`}><button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void connect()}>{saving ? <Loader2 className="animate-spin" /> : <Wifi />}{saving ? 'Connecting…' : 'Connect API'}</button>{saved && <button type="button" className={styles.button} onClick={() => void disconnect()}>Disconnect</button>}</div>
    {(message || saved?.lastError) && <div role={failed || !message ? 'alert' : 'status'} className={`${styles.notice} ${failed || !message ? styles.error : ''} mt-4`}>{message || saved?.lastError}</div>}
  </fieldset>;
}
LegacyAgentChannelsView.displayName = 'LegacyAgentChannelsView';

// Keep the established Channels experience as the public entry point. The
// gateway screen inside it owns the connector rail and per-connector setup
// pathway, so navigation does not reset the existing UI state.
export const AgentChannelsView = LegacyAgentChannelsView;
export default AgentChannelsView;
