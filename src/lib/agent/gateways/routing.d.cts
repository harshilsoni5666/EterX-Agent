export function selectChannelProfile<T extends { id: string; channels?: string[] }>(config: { profiles: T[]; defaultProfileId?: string } | null | undefined, platform?: string, profileId?: string): T | null;
export function canDispatchChannel(config: unknown, event: unknown): boolean;
