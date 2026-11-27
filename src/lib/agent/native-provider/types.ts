import type { MainAgentThinkingLevel } from '../model-routing';
import type { ProjectContext } from '../schemas';
import type { NativeLimitSignal, NativeProviderModel, NativeUsageWindow } from '../../native-provider-contract';
import type { NativeAgentTool, NativeMcp } from './tools';

export type NativeAttachment = { name?: string; path?: string; mimeType: string; data?: string; inlineData?: { data?: string } | string };

export type NativeProfile = {
  id: string;
  label: string;
  directory: string;
  binaryPath?: string;
  method: 'browser' | 'api-key';
};

export type NativeToolEvent = {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'error';
  kind?: 'read' | 'edit' | 'command';
  filename?: string;
};

export type NativeTurn = {
  cwd: string;
  model: NativeProviderModel;
  prompt: string;
  signal: AbortSignal;
  thinking?: MainAgentThinkingLevel;
  files: NativeAttachment[];
  context?: ProjectContext;
  tools: NativeAgentTool[];
  mcp?: NativeMcp;
  onlyEterxTools?: boolean;
  onText: (text: string) => void;
  onThought?: (text: string) => void;
  onTool?: (event: NativeToolEvent) => void;
  onContext?: (used: number, size: number) => void;
  onLimit?: (limit: NativeLimitSignal) => void;
};

export type NativeTurnResult = {
  text: string;
  usage?: Record<string, unknown>;
  limits?: NativeUsageWindow[];
};

export type NativeInspection = { models: NativeProviderModel[]; limits?: NativeUsageWindow[] };
export type SignIn = {
  signal: AbortSignal;
  apiKey?: string;
  authorize: (url: string, deviceCode?: string) => void;
};

export type NativeAdapter = {
  version(binaryPath: string, signal: AbortSignal): Promise<string | null>;
  signIn(profile: NativeProfile, options: SignIn): Promise<NativeInspection>;
  inspect(profile: NativeProfile, signal: AbortSignal): Promise<NativeInspection>;
  signOut(profile: NativeProfile, signal: AbortSignal): Promise<void>;
  run(profile: NativeProfile, turn: NativeTurn): Promise<NativeTurnResult>;
  isAuthError?(error: unknown): boolean;
  limitFromError?(error: unknown): NativeLimitSignal | undefined;
};

export class NativeProviderSetupError extends Error {}
export class NativeProviderAuthError extends NativeProviderSetupError {}
