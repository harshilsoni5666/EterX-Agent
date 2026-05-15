import React from 'react';

// Each icon: isLive=true → animation plays; isLive=false → static
interface IconProps { isLive?: boolean; size?: number; color?: string; }

const S = `
  @keyframes ai-spin { to { transform: rotate(360deg); } }
  @keyframes ai-pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
  @keyframes ai-dash { to { stroke-dashoffset: 0; } }
  @keyframes ai-blink { 0%,100%{opacity:.2; filter: drop-shadow(0 0 0px currentColor);} 50%{opacity:1; filter: drop-shadow(0 0 3px currentColor);} }
  @keyframes ai-bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-2px)} }
  @keyframes ai-write { 0%{stroke-dasharray: 0 20;} 100%{stroke-dasharray: 20 0;} }
  @keyframes ai-type { 0% { stroke-dashoffset: 20; opacity: 0.3; } 100% { stroke-dashoffset: 0; opacity: 1; } }
  @keyframes ai-scan { 0%{transform:translateY(-3px); filter: drop-shadow(0 0 1px currentColor);} 50%{transform:translateY(3px); filter: drop-shadow(0 0 4px currentColor);} 100%{transform:translateY(-3px); filter: drop-shadow(0 0 1px currentColor);} }
  @keyframes ai-wave { 0%,100%{d:path("M2 8 Q5 5 8 8 Q11 11 14 8")} 50%{d:path("M2 8 Q5 11 8 8 Q11 5 14 8")} }
  @keyframes ai-float { 0%,100%{transform:translateY(0) scale(1); filter: drop-shadow(0 0 1px currentColor);} 50%{transform:translateY(-1.5px) scale(1.05); filter: drop-shadow(0 0 4px currentColor);} }
  @keyframes ai-draw-path { 0% { stroke-dashoffset: 30; opacity: 0.1; } 50% { filter: drop-shadow(0 0 3px currentColor); } 100% { stroke-dashoffset: 0; opacity: 1; } }
  @keyframes ai-brain-pulse { 0%,100%{transform:scale(1); opacity:0.6;} 50%{transform:scale(1.03); opacity:1; filter: drop-shadow(0 0 6px currentColor);} }
`;

// Terminal / command execution - Typing line effect
export const TerminalIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <rect x="1" y="2" width="14" height="12" rx="2" stroke={color} strokeWidth="1.2" fill="none"/>
    <path d="M4 6l3 2-3 2" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 10h3" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeDasharray="10" strokeDashoffset="10"
      style={isLive ? { animation: 'ai-type 0.6s ease-out infinite alternate', filter: 'drop-shadow(0 0 3px currentColor)' } : { strokeDashoffset: 0 }} />
  </svg>
);

// File read - Scanning line effect
export const ReadIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <rect x="3" y="1" width="10" height="14" rx="1.5" stroke={color} strokeWidth="1.2" fill="none"/>
    <path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" stroke={color} strokeWidth="1.1" strokeLinecap="round" opacity=".4"/>
    {isLive && <line x1="3.5" y1="5" x2="12.5" y2="5" stroke={color} strokeWidth="1" strokeLinecap="round" style={{ animation: 'ai-scan 2s ease-in-out infinite' }} />}
  </svg>
);

// File write / create - Drawing line effect
export const WriteIcon = ({ isLive, size = 16, color = '#3fb950' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M9 2H4a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V7" stroke={color} strokeWidth="1.2" fill="none" strokeLinecap="round"/>
    <path d="M11 1.5l2 2L8 8.5 6 9l.5-2z" stroke={color} strokeWidth="1.1" strokeLinejoin="round"
      style={isLive ? { filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-float 1.5s ease-in-out infinite' } : {}} />
    {isLive && <path d="M5 11h3" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeDasharray="10" strokeDashoffset="10" style={{ animation: 'ai-draw-path 1.2s ease-out infinite' }} />}
  </svg>
);

// File edit / patch - Pen moving
export const EditIcon = ({ isLive, size = 16, color = '#4FC1FF' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M2 12.5V14h1.5l7-7-1.5-1.5-7 7z" stroke={color} strokeWidth="1.1" strokeLinejoin="round"
      style={isLive ? { filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-bounce 1.2s ease-in-out infinite' } : {}} />
    <path d="M11.5 2.5l1.5 1.5" stroke={color} strokeWidth="1.3" strokeLinecap="round"/>
    <path d="M5 5.5h-2M5 8H2.5M5 10.5H3" stroke={color} strokeWidth="1" strokeLinecap="round" opacity=".4"/>
    {isLive && <path d="M5 8h4" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeDasharray="10" strokeDashoffset="10" style={{ animation: 'ai-draw-path 1.5s ease-out infinite' }} />}
  </svg>
);

// Web search / research - Radar spin
export const SearchIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <circle cx="7" cy="7" r="4.5" stroke={color} strokeWidth="1.2" />
    <path d="M10.5 10.5l3 3" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
    {isLive && (
      <>
        <circle cx="7" cy="7" r="2.5" stroke={color} strokeWidth="0.8" opacity="0.4" style={{ animation: 'ai-pulse 1s ease-in-out infinite alternate' }} />
        <path d="M7 7l3.5-3.5" stroke={color} strokeWidth="1.5" opacity="0.8" strokeLinecap="round"
          style={{ filter: 'drop-shadow(0 0 3px currentColor)', animation: 'ai-spin 1.2s linear infinite', transformOrigin: '7px 7px' }} />
      </>
    )}
  </svg>
);

// Web scrape / globe - Orbiting node
export const GlobeIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.2"/>
    <path d="M8 2c-2 2-2 8 0 12M8 2c2 2 2 8 0 12" stroke={color} strokeWidth="1" opacity=".7"/>
    <path d="M2 8h12" stroke={color} strokeWidth="1" opacity=".7" />
    {isLive && <circle cx="8" cy="2" r="1.5" fill={color} style={{ filter: 'drop-shadow(0 0 4px currentColor)', animation: 'ai-spin 1.5s linear infinite', transformOrigin: '8px 8px' }} />}
  </svg>
);

// Folder scan / directory - Moving dot
export const FolderIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h3L8 5h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5V5z" stroke={color} strokeWidth="1.2" fill="none"/>
    <path d="M5 9h6" stroke={color} strokeWidth="1" strokeLinecap="round" opacity="0.3" />
    {isLive && <circle cx="5" cy="9" r="1" fill={color} style={{ animation: 'ai-type 1.5s ease-in-out infinite alternate', strokeDasharray: 6, strokeDashoffset: 6 }} />}
  </svg>
);

// Code / analyze - Typing brackets
export const CodeIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M5.5 5L2 8l3.5 3" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      style={isLive ? { filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-float 2s ease-in-out infinite' } : {}} />
    <path d="M10.5 5L14 8l-3.5 3" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      style={isLive ? { filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-float 2s ease-in-out infinite 1s' } : {}} />
    <path d="M9.5 3.5l-3 9" stroke={color} strokeWidth="1" strokeLinecap="round" opacity=".6"/>
  </svg>
);

// Git / branch - Drawing line
export const GitIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <circle cx="5" cy="4" r="1.5" stroke={color} strokeWidth="1.2"/>
    <circle cx="5" cy="12" r="1.5" stroke={color} strokeWidth="1.2"/>
    <circle cx="11" cy="7" r="1.5" stroke={color} strokeWidth="1.2" />
    <path d="M5 5.5v5" stroke={color} strokeWidth="1.2" strokeLinecap="round"/>
    <path d="M5 5.5Q5 7 11 7" stroke={color} strokeWidth="1.2" strokeLinecap="round" fill="none" strokeDasharray="10" strokeDashoffset="10"
      style={isLive ? { animation: 'ai-draw-path 1.5s ease-out infinite alternate' } : { strokeDashoffset: 0 }} />
  </svg>
);

// API / webhook call - Dashing data
export const ApiIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M2 8h3l2-5 2 10 2-5h3" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      style={isLive ? { strokeDasharray: "4 4", animation: 'ai-dash 0.8s linear infinite' } : {}} />
  </svg>
);

// Thinking / brain - Synapse firing
export const ThinkIcon = ({ isLive, size = 16, color = '#a78bfa' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M8 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1.5A4 4 0 0 1 8 2z"
      stroke={color} strokeWidth="1.2" fill="none" style={isLive ? { animation: 'ai-brain-pulse 2s ease-in-out infinite', transformOrigin: 'center' } : {}} />
    <path d="M7 13h2" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
    {isLive && (
      <>
        <circle cx="8" cy="5" r="1.5" fill={color} style={{ animation: 'ai-blink 1.2s ease-in-out infinite' }} />
        <circle cx="5.5" cy="7.5" r="1" fill={color} style={{ animation: 'ai-blink 1.2s ease-in-out infinite 0.4s' }} />
        <circle cx="10.5" cy="7.5" r="1" fill={color} style={{ animation: 'ai-blink 1.2s ease-in-out infinite 0.8s' }} />
        <path d="M8 5 L5.5 7.5 M8 5 L10.5 7.5 M5.5 7.5 Q8 9.5 10.5 7.5" stroke={color} strokeWidth="0.8" opacity="0.6" strokeDasharray="10" strokeDashoffset="10" style={{ animation: 'ai-draw-path 1.2s ease-out infinite' }}/>
      </>
    )}
  </svg>
);

// Image generate - Expanding shapes
export const ImageIcon = ({ isLive, size = 16, color = '#3fb950' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <rect x="2" y="3" width="12" height="10" rx="1.5" stroke={color} strokeWidth="1.2" fill="none"/>
    <circle cx="5.5" cy="6.5" r="1.2" stroke={color} strokeWidth="1"
      style={isLive ? { filter: 'drop-shadow(0 0 3px currentColor)', animation: 'ai-float 1.5s ease-in-out infinite' } : {}} />
    <path d="M2 11l3.5-3 2.5 2.5 2-2 3 3" stroke={color} strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
    {isLive && <path d="M14 6l-2 2" stroke={color} strokeWidth="1" strokeLinecap="round" style={{ animation: 'ai-blink 1s ease-in-out infinite' }} />}
  </svg>
);

// Database query - Data fetching flow
export const DatabaseIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <ellipse cx="8" cy="4.5" rx="5" ry="1.8" stroke={color} strokeWidth="1.2"/>
    <path d="M3 4.5v3c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-3" stroke={color} strokeWidth="1.2"/>
    <path d="M3 7.5v3c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-3" stroke={color} strokeWidth="1.2" />
    {isLive && <path d="M8 4.5v7" stroke={color} strokeWidth="1.5" strokeDasharray="4" strokeDashoffset="8" style={{ filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-dash 1s linear infinite' }} />}
  </svg>
);

// Sub-agent / bot spawn - Nodes connecting
export const BotIcon = ({ isLive, size = 16, color = '#a78bfa' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <rect x="3" y="6" width="10" height="7" rx="2" stroke={color} strokeWidth="1.2" fill="none"/>
    <path d="M8 3v3M6 3h4" stroke={color} strokeWidth="1.2" strokeLinecap="round"/>
    <circle cx="6" cy="9.5" r="1.5" fill={color} style={isLive ? { animation: 'ai-blink 1s ease-in-out infinite' } : {}} />
    <circle cx="10" cy="9.5" r="1.5" fill={color} style={isLive ? { animation: 'ai-blink 1s ease-in-out infinite 0.5s' } : {}} />
    <path d="M6.5 11.5q1.5 1 3 0" stroke={color} strokeWidth="1" strokeLinecap="round" />
    {isLive && <circle cx="8" cy="3" r="2" fill={color} style={{ filter: 'drop-shadow(0 0 3px currentColor)', animation: 'ai-float 1.5s ease-in-out infinite' }} />}
  </svg>
);

// Loading / progress spinner
export const SpinnerIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.3" strokeDasharray="8 26" strokeLinecap="round"
      style={{ animation: 'ai-spin 1s linear infinite', transformOrigin: '8px 8px' }} />
  </svg>
);

// Slack
export const SlackIconPremium = ({ isLive, size = 16, color = '#E01E5A' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}
    style={isLive ? { animation: 'ai-float 2s ease-in-out infinite' } : {}}>
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
  </svg>
);

// Verification / check - Checkmark drawing
export const VerifyIcon = ({ isLive, size = 16, color = '#3fb950' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
    <style>{S}</style>
    <circle cx="8" cy="8" r="6.15" stroke={color} strokeWidth="1.25" />
    <path d="M4.65 8.1l2.18 2.18 4.52-4.65" stroke={color} strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="15" strokeDashoffset="15"
      style={isLive ? { animation: 'ai-draw-path 1.5s ease-out infinite alternate' } : { strokeDashoffset: 0 }} />
  </svg>
);

// Download / package
export const PackageIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M2 5.5l6-3 6 3v5l-6 3-6-3v-5z" stroke={color} strokeWidth="1.2" fill="none"/>
    <path d="M8 2.5v11M2 5.5l6 3 6-3" stroke={color} strokeWidth="1" opacity=".6"/>
    {isLive && <path d="M5 7l3 1.5 3-1.5" stroke={color} strokeWidth="1" strokeDasharray="10" strokeDashoffset="10"
      style={{ animation: 'ai-draw-path 1.2s ease-out infinite' }} />}
  </svg>
);

// Lightbulb / think (for Think card) - Idea spark
export const LightbulbIcon = ({ isLive, size = 16, color = '#8C8A88' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M8 2a4 4 0 0 1 2.83 6.83c-.44.44-.83 1.1-.83 1.67v.5H6v-.5c0-.57-.39-1.23-.83-1.67A4 4 0 0 1 8 2z"
      stroke={color} strokeWidth="1.2" fill="none" style={isLive ? { animation: 'ai-brain-pulse 2s ease-in-out infinite', transformOrigin: 'center' } : {}} />
    <path d="M6.5 13h3M7 14.5h2" stroke={color} strokeWidth="1.2" strokeLinecap="round"/>
    {isLive && (
      <>
        <line x1="8" y1="5.5" x2="8" y2="7.5" stroke={color} strokeWidth="1.5" style={{ animation: 'ai-blink 1s ease-in-out infinite' }} />
        <line x1="5.5" y1="4.5" x2="6.5" y2="5.5" stroke={color} strokeWidth="1.2" opacity="0.8" style={{ animation: 'ai-blink 1s ease-in-out infinite 0.2s' }} />
        <line x1="10.5" y1="4.5" x2="9.5" y2="5.5" stroke={color} strokeWidth="1.2" opacity="0.8" style={{ animation: 'ai-blink 1s ease-in-out infinite 0.4s' }} />
      </>
    )}
  </svg>
);
// Memory / context storage - Glowing data cube
export const MemoryIcon = ({ isLive, size = 16, color = '#a78bfa' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M8 2L2 5v6l6 3 6-3V5L8 2z" stroke={color} strokeWidth="1.2" fill="none" style={isLive ? { filter: 'drop-shadow(0 0 3px currentColor)', animation: 'ai-float 2s ease-in-out infinite' } : {}} />
    <path d="M2 5l6 3 6-3M8 14V8" stroke={color} strokeWidth="1" opacity="0.6"/>
    {isLive && (
      <>
        <circle cx="8" cy="8" r="1.5" fill={color} style={{ animation: 'ai-blink 1.5s ease-in-out infinite' }} />
        <path d="M8 8 L4 6.5" stroke={color} strokeWidth="1" opacity="0.8" style={{ animation: 'ai-draw-path 1.5s ease-out infinite' }} />
      </>
    )}
  </svg>
);

// Desktop control / UI automation - Interactive cursor
export const DesktopIcon = ({ isLive, size = 16, color = '#4FC1FF' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <rect x="1" y="3" width="14" height="10" rx="1" stroke={color} strokeWidth="1.2" fill="none" opacity="0.7"/>
    <path d="M1 6h14" stroke={color} strokeWidth="1" opacity="0.5"/>
    <path d="M6 10l5 3-1.5-2.5 3-1.5-6.5-4z" fill={color} stroke={color} strokeWidth="0.5" strokeLinejoin="round"
      style={isLive ? { filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-bounce 1s ease-in-out infinite' } : {}} />
    {isLive && <circle cx="6" cy="10" r="2" stroke={color} strokeWidth="1" style={{ animation: 'ai-pulse 1s ease-in-out infinite' }} />}
  </svg>
);

// Network / Mesh - Syncing nodes
export const NetworkIcon = ({ isLive, size = 16, color = '#8b949e' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <circle cx="3" cy="8" r="1.5" stroke={color} strokeWidth="1.2" />
    <circle cx="13" cy="4" r="1.5" stroke={color} strokeWidth="1.2" />
    <circle cx="13" cy="12" r="1.5" stroke={color} strokeWidth="1.2" />
    <path d="M4.5 7l7-2.5M4.5 9l7 2.5" stroke={color} strokeWidth="1" opacity="0.5" />
    {isLive && (
      <>
        <circle cx="3" cy="8" r="1" fill={color} style={{ filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-blink 1s ease-in-out infinite' }} />
        <path d="M4.5 7l7-2.5" stroke={color} strokeWidth="1.5" strokeDasharray="8" strokeDashoffset="8" style={{ animation: 'ai-dash 1s linear infinite' }} />
        <path d="M4.5 9l7 2.5" stroke={color} strokeWidth="1.5" strokeDasharray="8" strokeDashoffset="8" style={{ animation: 'ai-dash 1s linear infinite 0.5s' }} />
      </>
    )}
  </svg>
);

// Math / Data Science - Animated Chart
export const ChartIcon = ({ isLive, size = 16, color = '#3fb950' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M2 14h12M2 2v12" stroke={color} strokeWidth="1.2" strokeLinecap="round"/>
    <rect x="4" y="8" width="2" height="6" fill={color} opacity="0.6" style={isLive ? { animation: 'ai-float 1.5s ease-in-out infinite alternate' } : {}} />
    <rect x="7" y="5" width="2" height="9" fill={color} opacity="0.8" style={isLive ? { animation: 'ai-float 1.2s ease-in-out infinite alternate 0.2s' } : {}} />
    <rect x="10" y="2" width="2" height="12" fill={color} style={isLive ? { filter: 'drop-shadow(0 0 2px currentColor)', animation: 'ai-float 1.8s ease-in-out infinite alternate 0.4s' } : {}} />
  </svg>
);

// Security / Audit - Shield Scan
export const SecurityIcon = ({ isLive, size = 16, color = '#4FC1FF' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <style>{S}</style>
    <path d="M8 1L2 3.5v5c0 3.5 2.5 6 6 6.5 3.5-.5 6-3 6-6.5v-5L8 1z" stroke={color} strokeWidth="1.2" fill="none"/>
    <path d="M8 1v14" stroke={color} strokeWidth="1" opacity="0.4" />
    {isLive && (
      <>
        <line x1="2" y1="8" x2="14" y2="8" stroke={color} strokeWidth="1.5" style={{ filter: 'drop-shadow(0 0 3px currentColor)', animation: 'ai-scan 2s ease-in-out infinite' }} />
        <path d="M5 8l2 2 4-4" stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'ai-blink 1.5s ease-in-out infinite' }} />
      </>
    )}
  </svg>
);

// Map of tool text → animated icon component + color
export const AGENT_ICONS: Record<string, { Icon: React.FC<IconProps>; color: string }> = {
  'Running command':        { Icon: TerminalIcon,  color: '#8b949e' },
  'Running project command':{ Icon: TerminalIcon,  color: '#8b949e' },
  'Reading file':           { Icon: ReadIcon,      color: '#8b949e' },
  'Scanning directory':     { Icon: FolderIcon,    color: '#8b949e' },
  'Editing file':           { Icon: EditIcon,      color: '#4FC1FF' },
  'Writing artifact':       { Icon: WriteIcon,     color: '#3fb950' },
  'Searching codebase':     { Icon: SearchIcon,    color: '#8b949e' },
  'Researching':            { Icon: GlobeIcon,     color: '#8b949e' },
  'Reading source':         { Icon: GlobeIcon,     color: '#8b949e' },
  'Deep researching':       { Icon: ThinkIcon,     color: '#a78bfa' },
  'Analyzing code':         { Icon: CodeIcon,      color: '#8b949e' },
  'Refactoring code':       { Icon: EditIcon,      color: '#4FC1FF' },
  'Verifying code':         { Icon: VerifyIcon,    color: '#3fb950' },
  'Verifying output':       { Icon: VerifyIcon,    color: '#3fb950' },
  'Git operation':          { Icon: GitIcon,       color: '#8b949e' },
  'Spawning sub-agents':    { Icon: BotIcon,       color: '#a78bfa' },
  'API request':            { Icon: ApiIcon,       color: '#8b949e' },
  'API call':               { Icon: ApiIcon,       color: '#8b949e' },
  'Database query':         { Icon: DatabaseIcon,  color: '#8b949e' },
  'Generating image':       { Icon: ImageIcon,     color: '#3fb950' },
  'Loading skill':          { Icon: ReadIcon,      color: '#8b949e' },
  'Scaffolding project':    { Icon: PackageIcon,   color: '#3fb950' },
  'Slack':                  { Icon: SlackIconPremium, color: '#E01E5A' },
  'Sending Slack':          { Icon: SlackIconPremium, color: '#E01E5A' },
  'Think':                  { Icon: LightbulbIcon, color: '#8C8A88' },
  'Saving memory':          { Icon: MemoryIcon,    color: '#a78bfa' },
  'Reading memory':         { Icon: MemoryIcon,    color: '#a78bfa' },
  'Recalling context':      { Icon: MemoryIcon,    color: '#a78bfa' },
  'Automating UI':          { Icon: DesktopIcon,   color: '#4FC1FF' },
  'Controlling desktop':    { Icon: DesktopIcon,   color: '#4FC1FF' },
  'Syncing network':        { Icon: NetworkIcon,   color: '#8b949e' },
  'Generating chart':       { Icon: ChartIcon,     color: '#3fb950' },
  'Analyzing data':         { Icon: ChartIcon,     color: '#3fb950' },
  'Running safety check':   { Icon: SecurityIcon,  color: '#4FC1FF' },
  'Auditing code':          { Icon: SecurityIcon,  color: '#4FC1FF' },
};

// Fuzzy matcher to ensure premium icons are always used, even if the exact string differs.
export const resolveAgentIcon = (verb: string, rawText?: string) => {
  const exact = AGENT_ICONS[verb] || (rawText && AGENT_ICONS[rawText]);
  if (exact) return exact;
  
  const text = ((verb || '') + ' ' + (rawText || '')).toLowerCase();
  
  // Fuzzy matches based on context
  if (text.includes('spawn') || text.includes('agent') || text.includes('bot')) return { Icon: BotIcon, color: '#a78bfa' };
  if (text.includes('memory') || text.includes('remember') || text.includes('context')) return { Icon: MemoryIcon, color: '#a78bfa' };
  if (text.includes('desktop') || text.includes('ui ') || text.includes('click') || text.includes('automate')) return { Icon: DesktopIcon, color: '#4FC1FF' };
  if (text.includes('network') || text.includes('sync') || text.includes('traffic')) return { Icon: NetworkIcon, color: '#8b949e' };
  if (text.includes('chart') || text.includes('plot') || text.includes('math') || text.includes('data')) return { Icon: ChartIcon, color: '#3fb950' };
  if (text.includes('safet') || text.includes('audit') || text.includes('secur')) return { Icon: SecurityIcon, color: '#4FC1FF' };
  if (text.includes('search') || text.includes('scan') || text.includes('analyz') || text.includes('find')) return { Icon: SearchIcon, color: '#8b949e' };
  if (text.includes('read') || text.includes('view') || text.includes('open')) return { Icon: ReadIcon, color: '#8b949e' };
  if (text.includes('writ') || text.includes('creat') || text.includes('generat') || text.includes('scaffold')) return { Icon: WriteIcon, color: '#3fb950' };
  if (text.includes('edit') || text.includes('modif') || text.includes('updat') || text.includes('refactor')) return { Icon: EditIcon, color: '#4FC1FF' };
  if (text.includes('run') || text.includes('execut') || text.includes('build') || text.includes('install')) return { Icon: TerminalIcon, color: '#8b949e' };
  if (text.includes('git') || text.includes('commit') || text.includes('push')) return { Icon: GitIcon, color: '#8b949e' };
  if (text.includes('api') || text.includes('fetch') || text.includes('request') || text.includes('webhook')) return { Icon: ApiIcon, color: '#8b949e' };
  if (text.includes('verif') || text.includes('test') || text.includes('check')) return { Icon: VerifyIcon, color: '#3fb950' };
  if (text.includes('db') || text.includes('database') || text.includes('sql') || text.includes('query')) return { Icon: DatabaseIcon, color: '#8b949e' };
  if (text.includes('think') || text.includes('reason') || text.includes('plan')) return { Icon: ThinkIcon, color: '#a78bfa' };
  if (text.includes('web') || text.includes('brows') || text.includes('scrap')) return { Icon: GlobeIcon, color: '#8b949e' };
  if (text.includes('slack') || text.includes('message')) return { Icon: SlackIconPremium, color: '#E01E5A' };
  if (text.includes('load') || text.includes('progress') || text.includes('wait')) return { Icon: SpinnerIcon, color: '#8b949e' };
  
  // Default to Terminal if no other match
  return { Icon: TerminalIcon, color: '#8b949e' };
};
