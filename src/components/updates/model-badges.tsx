'use client';

import { createContext, useContext } from 'react';
import { modelEntryKey } from '../../lib/agent/model-selector-store';
import { modelBadgeLabel, type ModelBadge } from '../../lib/app-presentation/contract';

export const ModelBadgesContext = createContext<ReadonlyMap<string, readonly ModelBadge[]>>(new Map());
export const PausedProvidersContext = createContext<ReadonlySet<string>>(new Set());

export const usePausedProviders = () => useContext(PausedProvidersContext);

export function ModelBadges({ provider, modelId }: { provider: string; modelId: string }) {
  const badges = useContext(ModelBadgesContext).get(modelEntryKey(provider, modelId));
  if (!badges?.length) return null;
  return <span className="eterx-model-badges">{badges.map(badge => (
    <span key={badge} className="eterx-model-badge" title={modelBadgeLabel(badge)}>{modelBadgeLabel(badge)}</span>
  ))}</span>;
}
