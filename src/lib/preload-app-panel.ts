'use client';

const loaders = {
  agents: () => import('../components/agents/agents-view'),
  channels: () => import('../components/channels/agent-channels-view'),
  projects: () => import('../components/projects/projects-view'),
  settings: () => import('../components/layout/settings-panel'),
};

export type AppPanel = keyof typeof loaders;
const requested = new Set<AppPanel>();

/** Warm only the intended screen; importing never mounts its effects. */
export function preloadAppPanel(panel: AppPanel): void {
  if (typeof window === 'undefined' || requested.has(panel)) return;
  requested.add(panel);
  void loaders[panel]().catch(() => {
    // A failed speculative download must not prevent a later navigation retry.
    requested.delete(panel);
  });
}
