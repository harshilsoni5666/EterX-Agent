import { useLayoutEffect, useRef, useState } from 'react';

export interface LiveOrbTheme {
  id: string;
  primary: string;
  deep: string;
  accent: string;
  highlight: string;
  controlGradient: string;
  controlText: string;
  statusStart: string;
  statusMid: string;
  statusEnd: string;
  border: string;
}

// Curated color families keep every random choice visible in the volumetric
// shader and in the small controls below the orb.
export const LIVE_ORB_THEMES: readonly LiveOrbTheme[] = [
  {
    id: 'blue', primary: '#3158ec', deep: '#0b2a92', accent: '#668ff4', highlight: '#eef6ff',
    controlGradient: 'linear-gradient(145deg, #668ff4, #3158ec)', controlText: '#ffffff',
    statusStart: '#dbeafe', statusMid: '#ffffff', statusEnd: '#93c5fd', border: 'rgba(219, 234, 254, 0.72)',
  },
  {
    id: 'light-gray', primary: '#9ca3af', deep: '#4b5563', accent: '#d1d5db', highlight: '#f8fafc',
    controlGradient: 'linear-gradient(145deg, #d1d5db, #6b7280)', controlText: '#111827',
    statusStart: '#374151', statusMid: '#f9fafb', statusEnd: '#6b7280', border: 'rgba(255, 255, 255, 0.78)',
  },
  {
    id: 'black', primary: '#262626', deep: '#000000', accent: '#525252', highlight: '#d4d4d4',
    controlGradient: 'linear-gradient(145deg, #525252, #090909)', controlText: '#ffffff',
    statusStart: '#a3a3a3', statusMid: '#ffffff', statusEnd: '#737373', border: 'rgba(255, 255, 255, 0.66)',
  },
  {
    id: 'green', primary: '#16a34a', deep: '#14532d', accent: '#4ade80', highlight: '#dcfce7',
    controlGradient: 'linear-gradient(145deg, #4ade80, #15803d)', controlText: '#052e16',
    statusStart: '#bbf7d0', statusMid: '#ffffff', statusEnd: '#86efac', border: 'rgba(220, 252, 231, 0.74)',
  },
  {
    id: 'yellow', primary: '#eab308', deep: '#854d0e', accent: '#facc15', highlight: '#fef9c3',
    controlGradient: 'linear-gradient(145deg, #fde047, #ca8a04)', controlText: '#422006',
    statusStart: '#fef08a', statusMid: '#fff7ed', statusEnd: '#f59e0b', border: 'rgba(254, 249, 195, 0.82)',
  },
  {
    id: 'red', primary: '#dc2626', deep: '#7f1d1d', accent: '#f87171', highlight: '#fee2e2',
    controlGradient: 'linear-gradient(145deg, #f87171, #b91c1c)', controlText: '#ffffff',
    statusStart: '#fecaca', statusMid: '#ffffff', statusEnd: '#fca5a5', border: 'rgba(254, 226, 226, 0.76)',
  },
  {
    id: 'purple', primary: '#9333ea', deep: '#581c87', accent: '#c084fc', highlight: '#f3e8ff',
    controlGradient: 'linear-gradient(145deg, #c084fc, #7e22ce)', controlText: '#ffffff',
    statusStart: '#e9d5ff', statusMid: '#ffffff', statusEnd: '#d8b4fe', border: 'rgba(243, 232, 255, 0.76)',
  },
  {
    id: 'orange', primary: '#ea580c', deep: '#7c2d12', accent: '#fb923c', highlight: '#ffedd5',
    controlGradient: 'linear-gradient(145deg, #fb923c, #c2410c)', controlText: '#ffffff',
    statusStart: '#fed7aa', statusMid: '#ffffff', statusEnd: '#fdba74', border: 'rgba(255, 237, 213, 0.76)',
  },
] as const;

export const DEFAULT_LIVE_ORB_THEME = LIVE_ORB_THEMES[0];

export function pickLiveOrbTheme(previousId?: string): LiveOrbTheme {
  const choices = previousId
    ? LIVE_ORB_THEMES.filter(theme => theme.id !== previousId)
    : LIVE_ORB_THEMES;
  return choices[Math.floor(Math.random() * choices.length)] || DEFAULT_LIVE_ORB_THEME;
}

export function liveOrbFallback(theme: LiveOrbTheme = DEFAULT_LIVE_ORB_THEME): string {
  return `
    radial-gradient(circle at 62% 72%, rgba(255,255,255,0.96) 0 15%, ${theme.highlight} 34%, transparent 58%),
    linear-gradient(180deg, ${theme.primary} 0%, ${theme.accent} 54%, ${theme.highlight} 100%)
  `;
}

/** Pick once on mount, then pick a different family at each new live session. */
export function useLiveOrbTheme(isActive: boolean): LiveOrbTheme {
  const [theme, setTheme] = useState<LiveOrbTheme>(() => (
    isActive ? pickLiveOrbTheme() : DEFAULT_LIVE_ORB_THEME
  ));
  const wasActiveRef = useRef(isActive);

  useLayoutEffect(() => {
    if (isActive && !wasActiveRef.current) {
      setTheme(current => pickLiveOrbTheme(current.id));
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  return theme;
}
