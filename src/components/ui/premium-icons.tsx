import React from 'react';

const ICONS8_AGENT_URL = '/icons/agent-ui/agent.png';

// A premium microphone with a subtle inner glass fill and thick clean strokes
export const PremiumMic = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="8.5" y="2" width="7" height="12" rx="3.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M5 11v1a7 7 0 0 0 14 0v-1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path d="M12 19v3M9 22h6" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

// A modern send arrow, sleek and forward-leaning
export const PremiumSend = ({ className, strokeWidth = 2.5 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 21V3" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 10L12 3L19 10" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// A smooth Audio/Live connection icon (6-bar asymmetrical waveform with spaced layout and hover wave)
export const PremiumAudioLines = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <style>
      {`
        @keyframes wave-bounce {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(1.35); }
        }
        .group:hover .wave-1 { animation: wave-bounce 0.4s ease-in-out infinite 0.0s; }
        .group:hover .wave-2 { animation: wave-bounce 0.4s ease-in-out infinite 0.05s; }
        .group:hover .wave-3 { animation: wave-bounce 0.4s ease-in-out infinite 0.10s; }
        .group:hover .wave-4 { animation: wave-bounce 0.4s ease-in-out infinite 0.15s; }
        .group:hover .wave-5 { animation: wave-bounce 0.4s ease-in-out infinite 0.20s; }
        .group:hover .wave-6 { animation: wave-bounce 0.4s ease-in-out infinite 0.25s; }
      `}
    </style>
    <path className="wave-1" style={{ transformOrigin: '12px 12px' }} d="M2.5 10v4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path className="wave-2" style={{ transformOrigin: '12px 12px' }} d="M6.3 6v12" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path className="wave-3" style={{ transformOrigin: '12px 12px' }} d="M10.1 3v18" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path className="wave-4" style={{ transformOrigin: '12px 12px' }} d="M13.9 8v8" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path className="wave-5" style={{ transformOrigin: '12px 12px' }} d="M17.7 5v14" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path className="wave-6" style={{ transformOrigin: '12px 12px' }} d="M21.5 10v4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

// A premium plus icon inside a soft container
export const PremiumPlus = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// A soft Pin icon with a solid head
export const PremiumPin = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 17v5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Sidebar Context Menu Icons
export const PremiumShare = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 6l-4-4-4 4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 2v13" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumEdit = ({ className, strokeWidth = 1.8 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M18.4 2.6a2.121 2.121 0 0 1 3 3L11.5 15.5l-4.5 1 1-4.5L18.4 2.6z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16.5 4.5l3 3" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

export const PremiumStar = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumFolder = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumTrash = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M3 6h18" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 11v6" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
    <path d="M14 11v6" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
  </svg>
);

// Main Navigation & UI Icons
export const PremiumSearch = ({ className, strokeWidth = 1.8 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="10.5" cy="10.5" r="6.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M16 16l5.5 5.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10.5 7a3.5 3.5 0 0 1 3.5 3.5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" opacity="0.4" />
  </svg>
);

export const PremiumDashboard = ({ className, strokeWidth = 1.8 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.75" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} />
    <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.75" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} />
    <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.75" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} />
    <rect x="14" y="14" width="6.5" height="6.5" rx="1.75" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} />
  </svg>
);

export const PremiumBot = ({ className, strokeWidth = 1.8 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3.5" y="7.5" width="17" height="12" rx="3.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M12 7.5V4.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <circle cx="12" cy="3.5" r="1" fill="currentColor" />
    <rect x="6.5" y="11" width="11" height="4" rx="1.5" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth={strokeWidth - 0.25} />
    <circle cx="9" cy="13" r="1.2" fill="currentColor" />
    <circle cx="15" cy="13" r="1.2" fill="currentColor" />
    <path d="M3.5 12H2M20.5 12H22" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

export const PremiumAgent = ({ className }: any) => (
  <img src={ICONS8_AGENT_URL} alt="" className={`object-contain opacity-95 ${className || ''}`} draggable={false} />
);

export const PremiumLayers = ({ className, strokeWidth = 1.8 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
    <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
  </svg>
);

export const PremiumChannels = ({ className }: any) => (
  <span
    aria-hidden="true"
    className={`inline-block shrink-0 bg-current ${className || ''}`}
    style={{
      WebkitMaskImage: 'url(/icons/ui/channel-chain-icons8.png)',
      maskImage: 'url(/icons/ui/channel-chain-icons8.png)',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
    }}
  />
);

export const PremiumFolderOpen = ({ className, strokeWidth = 1.8 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h16Z" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 10h20" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
  </svg>
);

export const PremiumCode = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M14 4l-4 16" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.5" />
    <path d="M8 6L2 12l6 6" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 6l6 6-6 6" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumPanelLeft = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M9 3v18" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M3 7a4 4 0 0 1 4-4h2v18H7a4 4 0 0 1-4-4V7z" fill="currentColor" fillOpacity="0.15" />
  </svg>
);

export const PremiumDownload = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
    <path d="M12 3v12" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path d="M7 10l5 5 5-5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumCheckSquare = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumMoreHorizontal = ({ className }: any) => (
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className}>
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
  </svg>
);

// Live Gemini UI Icons
export const PremiumVolume2 = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
  </svg>
);

export const PremiumVolumeX = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M23 9l-6 6" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.8"/>
    <path d="M17 9l6 6" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.8"/>
  </svg>
);

export const PremiumMicOff = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="8.5" y="2" width="7" height="12" rx="3.5" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth={strokeWidth} opacity="0.6" />
    <path d="M5 11v1a7 7 0 0 0 14 0v-1" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.6" />
    <path d="M12 19v3M9 22h6" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" opacity="0.6" />
    <path d="M3 3l18 18" stroke="currentColor" strokeWidth={strokeWidth + 0.5} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumStop = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="7" y="7" width="10" height="10" rx="3" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth={strokeWidth} />
  </svg>
);

export const PremiumSettings = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PremiumActivity = ({ className, strokeWidth = 2 }: any) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth={strokeWidth} />
    <path d="M7 14l3-3 3 3 4-4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M17 10v4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
  </svg>
);
