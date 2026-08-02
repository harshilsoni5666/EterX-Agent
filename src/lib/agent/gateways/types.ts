export type GatewayPlatform = 'telegram' | 'whatsapp' | 'discord' | 'signal' | 'generic';

export type GatewayEventKind = 'message' | 'edit' | 'reaction' | 'delivery' | 'system';

export interface GatewayAttachment {
  id?: string;
  type: 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'unknown';
  name?: string;
  mimeType?: string;
  url?: string;
}

export interface GatewayActor {
  id: string;
  displayName?: string;
  username?: string;
  isBot?: boolean;
}

/** Stable input contract consumed by the agent runtime, regardless of transport. */
export interface GatewayAgentInput {
  id: string;
  dedupeKey: string;
  platform: GatewayPlatform;
  kind: GatewayEventKind;
  conversationId: string;
  threadId?: string;
  externalMessageId: string;
  text: string;
  actor: GatewayActor;
  attachments: GatewayAttachment[];
  receivedAt: number;
  replyTarget: Record<string, string>;
  metadata: Record<string, unknown>;
}

export interface GatewayConversationRecord {
  id: string;
  platform: GatewayPlatform;
  externalId: string;
  title: string;
  lastMessageAt: number;
  lastMessagePreview: string;
  unreadCount: number;
  messageCount: number;
}

export interface GatewayPlatformConfig {
  enabled: boolean;
  mode?: 'webhook' | 'polling' | 'gateway' | 'bridge';
  token?: string;
  webhookSecret?: string;
  appSecret?: string;
  publicKey?: string;
  accountId?: string;
  apiVersion?: string;
  endpoint?: string;
}

export interface GatewayDaemonConfig {
  enabled: boolean;
  keepRunningOnClose: boolean;
  keepActiveChatsOnClose: boolean;
  runScheduledTasksInBackground: boolean;
  launchAtLogin: boolean;
  host: string;
  port: number;
  autoDispatch: boolean;
  platforms: Record<GatewayPlatform, GatewayPlatformConfig>;
}

export interface GatewayDaemonStatus {
  running: boolean;
  startedAt: number | null;
  host: string;
  port: number;
  eventCount: number;
  conversationCount: number;
  lastEventAt: number | null;
  lastError: string | null;
  platforms: Record<string, { enabled: boolean; state: string; lastError?: string }>;
}

export interface GatewayAdapter {
  id: string;
  normalize(payload: unknown): GatewayAgentInput[];
  send?(target: Record<string, string>, text: string, config: GatewayPlatformConfig): Promise<unknown>;
}
