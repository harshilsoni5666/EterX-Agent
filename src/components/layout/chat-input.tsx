import React, { useRef, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, X, Check, Folder, FolderOpen, Files, File as FileIcon, ChevronDown, ChevronRight, Image as ImageIcon, AlertCircle } from 'lucide-react';
import { PremiumMic, PremiumSend, PremiumPlus, PremiumAudioLines, PremiumVolume2, PremiumVolumeX, PremiumMicOff } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';
import { ConnectorsModal, ConnectorsButton } from './connectors-modal';
import { AgentFace } from '../chat/agent-face';
import { notifyAgentFaceFiles, notifyAgentFaceInputChange, notifyAgentFaceSend } from '../chat/agent-face-controller';
import {
  MAIN_AGENT_MODEL_OPTIONS,
  MAIN_AGENT_THINKING_LEVEL_OPTIONS,
  getMainAgentModelConfig,
  normalizeMainAgentThinkingLevel,
  type MainAgentMode,
  type MainAgentThinkingLevel,
} from '../../lib/agent/model-routing';

// ─── Connector State Hook ────────────────────────────────
const useConnectors = () => {
  const [connectedApps, setConnectedApps] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors/status');
      if (res.ok) {
        const data = await res.json();
        const apps: Record<string, boolean> = {};
        // API returns { connectors: { slack: { connected: bool, ... } } }
        const conns = data.connectors || data;
        Object.entries(conns).forEach(([k, v]: [string, any]) => {
          if (v?.connected) apps[k] = true;
        });
        setConnectedApps(apps);
      }
    } catch { }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    let t: NodeJS.Timeout;
    if (open) t = setInterval(fetchStatus, 2000);
    return () => clearInterval(t);
  }, [open, fetchStatus]);

  const handleConnect = (id: string) => {
    if (id === 'slack') {
      const clientId = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID || '10978886718263.11022632946720';
      const redirectUri = encodeURIComponent('http://localhost:3000/api/auth/callback/slack');
      const userScopes = encodeURIComponent('channels:read,channels:history,chat:write,users:read,files:write,reactions:write,im:read,im:write,im:history,groups:read,groups:history');
      const url = `https://slack.com/oauth/v2/authorize?client_id=${ clientId }&user_scope=${ userScopes }&redirect_uri=${ redirectUri }`;
      if ((window as any).electronAPI?.openExternal) {
        (window as any).electronAPI.openExternal(url);
      } else {
        window.open(url, 'slack_oauth', 'width=620,height=700');
      }
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      // Optimistic update immediately
      setConnectedApps(prev => ({ ...prev, [id]: false }));
      // API expects { platform } in JSON body
      await fetch('/api/connectors/status', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: id }),
      });
    } catch { }
  };

  return { open, setOpen, connectedApps, handleConnect, handleDisconnect, fetchStatus };
};


interface Attachment {
  id?: string;
  file: File;
  name?: string;
  preview: string;
  uploadStatus?: 'uploading' | 'done' | 'error';
  fileUri?: string;
  localPath?: string;
}

interface ChatInputProps {
  inputValue: string;
  setInputValue: (val: string) => void;
  isThinking: boolean;
  isRecording: boolean;
  handleSend: () => void;
  handleStop: () => void;
  handleSteer?: () => void;  // Send live steering to running agent
  toggleSpeech: () => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  greeting: string;
  traceLogsLength: number;
  isProcessingVoice?: boolean;
  audioVolume?: number;
  cancelVoice?: () => void;
  acceptVoice?: () => void;
  agentMode?: MainAgentMode;
  onModeChange?: (mode: MainAgentMode) => void;
  thinkingLevel?: MainAgentThinkingLevel;
  onThinkingLevelChange?: (level: MainAgentThinkingLevel) => void;
  pinnedItems?: any[];
  setPinnedItems?: (items: any[]) => void;
  // ═══ Gemini Live Session ═══
  liveState?: 'idle' | 'connecting' | 'connected' | 'listening' | 'speaking' | 'error';
  onLiveStart?: () => void;
  onLiveStop?: () => void;
  liveOutputText?: string;
  liveInputText?: string;
  liveError?: string | null;
  liveMicVolume?: number;
  liveModelVolume?: number | number[];
  liveActiveTool?: string | null;
  isMicMuted?: boolean;
  onToggleMicMute?: () => void;
  isSpeakerMuted?: boolean;
  onToggleSpeakerMute?: () => void;
  isCompressed?: boolean;
}

const inferFileExtension = (mimeType: string) => {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  return map[mimeType] || 'file';
};

const getAttachmentName = (file: File) => {
  const existing = file.name?.trim();
  if (existing) return existing;
  const ext = inferFileExtension(file.type || '');
  return `${ file.type?.startsWith('image/') ? 'pasted-image' : 'pasted-file' }-${ Date.now() }.${ ext }`;
};

const formatAttachmentSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${ Math.max(1, Math.round(bytes / 1024)) } KB`;
  return `${ (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) } MB`;
};

const VoiceWaveform = ({ volume, isProcessing, cancelVoice, acceptVoice }: { volume: number, isProcessing: boolean, cancelVoice: () => void, acceptVoice: () => void }) => {
  const BAR_COUNT = 64;
  const [volumes, setVolumes] = useState<number[]>(new Array(BAR_COUNT).fill(2));
  const volumeRef = useRef(volume);
  const tickRef = useRef(0);

  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (isProcessing) return;
    const interval = setInterval(() => {
      tickRef.current += 1;
      setVolumes(prev => {
        const v = volumeRef.current; // 0–100
        // Base height driven by mic volume — taller range (2px idle → 40px peak)
        const base = Math.max(2, Math.min(40, (v / 100) * 38 + 2));
        // Frequency shimmer: subtle sine wave that shifts over time so bars aren't uniform
        const freqShimmer = Math.sin(tickRef.current * 0.18) * (v / 100) * 6;
        const jitter = Math.random() * 3; // micro organic noise
        const next = Math.max(2, Math.min(40, base + freqShimmer + jitter));
        return [...prev.slice(1), next];
      });
    }, 45); // ~22fps scroll — smooth waterfall
    return () => clearInterval(interval);
  }, [isProcessing]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className="flex items-center w-full min-h-[44px]"
    >
      {/* Main Pill Container */}
      <div className="flex-1 flex items-center justify-between bg-[#1C1C1C] border border-white/[0.08] rounded-full h-[48px] pl-5 pr-2 shadow-[0_4px_24px_rgba(0,0,0,0.5)] w-full overflow-hidden">

        {/* Scrolling Waterfall Waveform */}
        <div
          className="flex-1 flex items-center gap-[3px] h-[40px] overflow-hidden"
          style={{ WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 12%, black 88%, transparent 100%)' }}
        >
          {isProcessing ? (
            <div className="flex items-center justify-center gap-2 h-full w-full">
              {[0, 1, 2].map((dot) => (
                <motion.div
                  key={dot}
                  className="w-2.5 h-2.5 bg-[#E8E6E3]/70 rounded-full"
                  animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: dot * 0.25 }}
                />
              ))}
            </div>
          ) : (
            volumes.map((v, i) => {
              const intensity = Math.min(1, v / 32);
              const r = Math.round(130 + intensity * 102);
              const g = Math.round(128 + intensity * 100);
              const b = Math.round(126 + intensity * 93);
              return (
                <div
                  key={i}
                  style={{
                    height: v + 'px',
                    width: '3.5px',
                    borderRadius: '999px',
                    backgroundColor: `rgb(${ r },${ g },${ b })`,
                    transition: 'height 0.045s linear',
                    willChange: 'height',
                    transform: 'translateZ(0)',
                    flexShrink: 0,
                  }}
                />
              );
            })
          )}
        </div>

        {/* Right side controls */}
        {!isProcessing && (
          <div className="flex items-center gap-2 pl-4 shrink-0">
            {/* Cancel (X) */}
            <button
              onClick={cancelVoice}
              className="w-[34px] h-[34px] flex items-center justify-center rounded-full bg-white/[0.04] hover:bg-red-500/10 transition-all duration-200 group active:scale-95"
            >
              <X className="w-[17px] h-[17px] text-[#8C8A88] group-hover:text-red-400 transition-colors" strokeWidth={2.5} />
            </button>

            {/* Square Stop */}
            <button
              onClick={acceptVoice}
              className="w-[34px] h-[34px] flex items-center justify-center rounded-full bg-[#E8E6E3] hover:bg-white transition-all duration-200 group active:scale-95 shadow-[0_2px_12px_rgba(255,255,255,0.12)]"
            >
              <div className="w-[13px] h-[13px] rounded-[3.5px] bg-[#0A0A0A] group-hover:scale-90 transition-transform duration-200" />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
};

const inputControlButton = "eterx-control-button w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-full border border-white/[0.18] bg-[#242424]/96 text-white transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] active:scale-[0.96] active:bg-[#303030] hover:text-white hover:bg-[#2D2D2D] hover:border-white/[0.30] group relative overflow-hidden";
const inputControlSheen = "hidden";

const PinFolderIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 36 36" className={className} fill="none" aria-hidden="true">
    <path
      d="M7.05 15.05c0-2.33 1.89-4.22 4.22-4.22h4.86c.86 0 1.7.29 2.38.82l1.1.86c.56.44 1.25.68 1.96.68h3.28c2.28 0 4.12 1.84 4.12 4.12v7.2c0 2.33-1.89 4.22-4.22 4.22H11.27c-2.33 0-4.22-1.89-4.22-4.22v-9.46Z"
      fill="url(#pin-folder-fill)"
      stroke="currentColor"
      strokeWidth="1.95"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M8.35 15.95h19.3"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeOpacity="0.88"
    />
    <path
      d="M10.25 12.78h5.9c.62 0 1.23.2 1.72.58l1.28.99"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity="0.55"
    />
    <path
      d="M9.55 18.65v5.2c0 1.34 1.09 2.43 2.43 2.43h12.42"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeOpacity="0.26"
    />
    <path
      d="M24.2 17.7c1.04 0 1.88.84 1.88 1.88v3.58"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeOpacity="0.18"
    />
    <defs>
      <linearGradient id="pin-folder-fill" x1="18" y1="9.8" x2="18" y2="28.8" gradientUnits="userSpaceOnUse">
        <stop stopColor="currentColor" stopOpacity="0.08" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0.025" />
      </linearGradient>
    </defs>
  </svg>
);

const PinFileIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 36 36" className={className} fill="none" aria-hidden="true">
    <path
      d="M12.45 6.45h7.82c.78 0 1.53.31 2.08.87l4.03 4.07c.54.55.84 1.29.84 2.06v13.88a2.42 2.42 0 0 1-2.42 2.42H12.45a2.42 2.42 0 0 1-2.42-2.42V8.87a2.42 2.42 0 0 1 2.42-2.42Z"
      fill="url(#pin-file-fill)"
      stroke="currentColor"
      strokeWidth="1.95"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M20.82 7.02v4.15c0 1.15.93 2.08 2.08 2.08h3.88"
      fill="#0F0F0F"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14.35 17.65h7.3M14.35 21.35h5.55"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeOpacity="0.9"
    />
    <path
      d="M12.9 9.65v16.12c0 .8.65 1.45 1.45 1.45h9.26"
      stroke="currentColor"
      strokeWidth="1.18"
      strokeLinecap="round"
      strokeOpacity="0.28"
    />
    <path
      d="M14.35 13.95h3.05"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeOpacity="0.58"
    />
    <path
      d="M24.52 15.7v9.18"
      stroke="currentColor"
      strokeWidth="1.05"
      strokeLinecap="round"
      strokeOpacity="0.18"
    />
    <defs>
      <linearGradient id="pin-file-fill" x1="19.2" y1="6.35" x2="19.2" y2="29.65" gradientUnits="userSpaceOnUse">
        <stop stopColor="currentColor" stopOpacity="0.07" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0.02" />
      </linearGradient>
    </defs>
  </svg>
);

export const ChatInput: React.FC<ChatInputProps> = ({
  inputValue, setInputValue, isThinking, isRecording, handleSend, handleStop, handleSteer = () => { },
  toggleSpeech, attachments, setAttachments, greeting, traceLogsLength,
  isProcessingVoice = false, audioVolume = 0, cancelVoice = () => { }, acceptVoice = () => { },
  agentMode = 'think', onModeChange = () => { },
  thinkingLevel = 'low', onThinkingLevelChange = () => { },
  pinnedItems = [], setPinnedItems = () => { },
  liveState = 'idle', onLiveStart = () => { }, onLiveStop = () => { },
  liveOutputText = '', liveInputText = '',
  liveMicVolume = 0, liveModelVolume = 0, liveActiveTool = null,
  isMicMuted = false, onToggleMicMute = () => { },
  isSpeakerMuted = false, onToggleSpeakerMute = () => { },
  isCompressed = false
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const initialFocusAppliedRef = useRef(false);
  const queuedSendRef = useRef(false);
  const [showPinMenu, setShowPinMenu] = useState(false);
  const [openPillDrop, setOpenPillDrop] = useState<'files' | 'folders' | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isAtTop, setIsAtTop] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(false);
  const [isLogoHovered, setIsLogoHovered] = useState(false);
  const [isStopping, setIsStopping] = useState(false); // Intermediate stop state
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkingLevels, setShowThinkingLevels] = useState(false);
  const connectors = useConnectors();
  const textareaMaxHeight = isCompressed ? 260 : 400;
  const isModelLocked = isThinking;

  // Clear isStopping as soon as the agent actually stops
  useEffect(() => {
    if (!isThinking) setIsStopping(false);
  }, [isThinking]);
  useEffect(() => {
    if (isModelLocked) {
      setShowModelMenu(false);
      setShowThinkingLevels(false);
    }
  }, [isModelLocked]);
  useEffect(() => {
    if (!showModelMenu) setShowThinkingLevels(false);
  }, [showModelMenu]);
  useEffect(() => {
    if (initialFocusAppliedRef.current) return;
    initialFocusAppliedRef.current = true;

    const focusTimer = window.setTimeout(() => {
      const activeElement = document.activeElement;
      const activeIsEditable =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable);

      if (!activeIsEditable && !isThinking && !isRecording && liveState === 'idle') {
        textareaRef.current?.focus({ preventScroll: true });
      }
    }, 250);

    return () => window.clearTimeout(focusTimer);
  }, []); // Focus only once when the input first mounts.
  useEffect(() => {
    if (!showModelMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && modelSelectorRef.current?.contains(target)) return;
      setShowModelMenu(false);
      setShowThinkingLevels(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowModelMenu(false);
        setShowThinkingLevels(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showModelMenu]);
  const [logoHoverText, setLogoHoverText] = useState('');

  const logoHoverPhrases = [
    "Awaiting your command.",
    "Ready to assist!",
    "Systems fully operational.",
    "How can I help today?",
    "Standing by for input.",
    "Ready to execute!",
    "At your service.",
    "Awaiting task parameters.",
    "Shall we begin?",
    "All systems engaged!",
    "Awaiting next directive.",
    "Ready for deployment.",
    "Standing by.",
    "How may I proceed?",
    "Fully initialized!",
    "Awaiting instructions."
  ];

  // Smart scroll position tracking for textarea fumes
  const handleTextareaScroll = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const threshold = 5; // Slightly larger tolerance for mobile/retina
    setIsAtTop(el.scrollTop <= threshold);
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - threshold);
  }, []);

  // Save pasted/browser files as binary FormData so the renderer never base64-encodes media.
  const saveFileForAgent = useCallback(async (file: File, attachmentId: string, displayName: string) => {
    try {
      const filePath = (file as any).path;
      if (filePath) {
        setAttachments(prev => prev.map(att => att.id === attachmentId ? {
          ...att,
          uploadStatus: 'done' as const,
          localPath: filePath,
        } : att));
        return;
      }

      const formData = new FormData();
      formData.append('file', file, displayName);
      formData.append('fileName', displayName);
      formData.append('mimeType', file.type || 'application/octet-stream');

      const res = await fetch('/api/media/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        setAttachments(prev => prev.map(att => att.id === attachmentId ? { ...att, uploadStatus: 'error' as const } : att));
        return;
      }

      const data = await res.json();
      setAttachments(prev => prev.map(att => att.id === attachmentId ? {
        ...att,
        uploadStatus: 'done' as const,
        localPath: data.localPath,
      } : att));
    } catch {
      setAttachments(prev => prev.map(att => att.id === attachmentId ? { ...att, uploadStatus: 'error' as const } : att));
    }
  }, [setAttachments]);

  // Attach files instantly, then prepare only files that do not already have a local path.
  const addFilesAndUpload = useCallback((files: File[]) => {
    const validFiles = files.filter(file => file && file.size > 0);
    if (validFiles.length === 0) return;

    notifyAgentFaceFiles(validFiles);

    const newAttachments = validFiles.map((file, index) => {
      const displayName = getAttachmentName(file);
      const localPath = (file as any).path;
      return {
        id: `${ Date.now() }-${ index }-${ Math.random().toString(36).slice(2) }`,
        file,
        name: displayName,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
        uploadStatus: localPath ? 'done' as const : 'uploading' as const,
        localPath: localPath || undefined,
      };
    });

    setAttachments(prev => [...prev, ...newAttachments]);

    for (const att of newAttachments) {
      if (att.uploadStatus === 'uploading') {
        void saveFileForAgent(att.file, att.id, att.name);
      }
    }
  }, [setAttachments, saveFileForAgent]);

  useEffect(() => {
    const handleClickOutside = () => {
      setOpenPillDrop(null);
      setShowPinMenu(false);
    };
    if (openPillDrop || showPinMenu) {
      window.addEventListener('click', handleClickOutside);
    }
    return () => window.removeEventListener('click', handleClickOutside);
  }, [openPillDrop, showPinMenu]);

  // Auto-resize textarea dynamically based on scrollHeight
  useEffect(() => {
    if (textareaRef.current) {
      // Reset height to correctly recalculate
      textareaRef.current.style.height = '1px';
      const scrollHeight = textareaRef.current.scrollHeight;
      const newHeight = Math.max(24, Math.min(scrollHeight, textareaMaxHeight));
      textareaRef.current.style.height = `${ newHeight }px`;

      const overflowing = scrollHeight > textareaMaxHeight;
      setIsOverflowing(overflowing);

      // If we just became overflowing or changed content, check scroll position
      if (overflowing) {
        handleTextareaScroll();
      }
    }
  }, [inputValue, handleTextareaScroll, textareaMaxHeight]);

  // Generate a random ID for items
  const genId = () => Math.random().toString(36).substr(2, 9);

  const handlePinFolder = async () => {
    setShowPinMenu(false);
    if ((window as any).electronAPI) {
      const folderPath = await (window as any).electronAPI.selectFolder();
      if (folderPath && !pinnedItems.find(i => i.path === folderPath)) {
        setPinnedItems([
          ...pinnedItems,
          {
            id: genId(),
            type: 'folder',
            path: folderPath,
            name: folderPath.split(/[/\\]/).pop() || 'Folder'
          }
        ]);
      }
    } else {
      alert("Folder pinning requires the EterX desktop app.");
    }
  };

  const handlePinFiles = async () => {
    setShowPinMenu(false);
    if ((window as any).electronAPI) {
      const filePaths = await (window as any).electronAPI.selectFiles();
      if (filePaths && filePaths.length > 0) {
        const newItems = filePaths
          .filter((fp: string) => !pinnedItems.find(i => i.path === fp))
          .map((fp: string) => ({
            id: genId(),
            type: 'file',
            path: fp,
            name: fp.split(/[/\\]/).pop() || 'File'
          }));

        if (newItems.length > 0) {
          setPinnedItems([...pinnedItems, ...newItems]);
        }
      }
    } else {
      alert("File pinning requires the EterX desktop app.");
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFilesAndUpload(Array.from(e.target.files));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pastedFiles = Array.from(e.clipboardData.files || []);
    const itemFiles = Array.from(e.clipboardData.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file);
    const files = pastedFiles.length > 0 ? pastedFiles : itemFiles;

    if (files.length > 0) {
      e.preventDefault();
      addFilesAndUpload(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesAndUpload(Array.from(e.dataTransfer.files));
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => {
      const newArr = [...prev];
      if (newArr[index].preview) URL.revokeObjectURL(newArr[index].preview);
      newArr.splice(index, 1);
      return newArr;
    });
  };

  const hasPreparingAttachments = attachments.some(att => att.uploadStatus === 'uploading');
  const hasErroredAttachments = attachments.some(att => att.uploadStatus === 'error');

  useEffect(() => {
    if (!queuedSendRef.current || hasPreparingAttachments || hasErroredAttachments) return;
    if (!inputValue.trim() && attachments.length === 0) return;
    queuedSendRef.current = false;
    notifyAgentFaceSend();
    handleSend();
  }, [attachments.length, handleSend, hasErroredAttachments, hasPreparingAttachments, inputValue]);

  const submitPrompt = useCallback(() => {
    if (hasPreparingAttachments) {
      queuedSendRef.current = true;
      return;
    }
    if (hasErroredAttachments) return;
    if (inputValue.trim() || attachments.length > 0) {
      notifyAgentFaceSend();
    }
    handleSend();
  }, [attachments.length, handleSend, hasErroredAttachments, hasPreparingAttachments, inputValue]);

  let liveAnimateState: any = { boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' };
  let liveTransition: any = { duration: 0.2, ease: "easeOut" };

  if (liveState !== 'idle' && liveState !== 'error') {
    const micVol = Math.min(1, Math.max(0, liveMicVolume / 100));
    const modVolRaw = Array.isArray(liveModelVolume) ? liveModelVolume.reduce((a, b) => a + b, 0) / liveModelVolume.length : liveModelVolume;
    const modVol = Math.min(1, Math.max(0, modVolRaw / 100));

    // Smooth interpolations based on actual volume
    const mInt = 0.3 + (micVol * 0.5);
    const aInt = 0.35 + (modVol * 0.5);

    if (liveState === 'connecting') {
      // Connecting: Solid, subtle center glow
      liveAnimateState = {
        boxShadow: `0 20px 40px rgba(0,0,0,0.6), inset 0 0 50px -10px rgba(234, 179, 8, 0.45), inset 0 0 50px -10px rgba(249, 115, 22, 0.45), inset 0 0 15px rgba(255,255,255,0.08)`
      };
      liveTransition = { duration: 1.5, ease: "easeInOut" };
    } else if (liveActiveTool) {
      // Tool Execution: Deep focus state (Solid)
      liveAnimateState = {
        boxShadow: `0 20px 40px rgba(0,0,0,0.6), inset 0 0 60px -10px rgba(6, 182, 212, 0.4), inset 0 0 60px -10px rgba(59, 130, 246, 0.4), inset 0 0 20px rgba(255,255,255,0.1)`
      };
      liveTransition = { duration: 1.5, ease: "easeInOut" };
    } else if (liveState === 'speaking' && micVol > 0.05) {
      // True Interruption: Top and Bottom active simultaneously (Smooth volume reactivity, single string to prevent strobe)
      liveAnimateState = {
        boxShadow: `0 20px 40px rgba(0,0,0,0.6), inset 0 -40px 60px -15px rgba(16, 185, 129, ${ mInt }), inset 0 40px 60px -15px rgba(139, 92, 246, ${ aInt }), inset 0 0 20px rgba(255,255,255,0.1)`
      };
      liveTransition = { duration: 0.2, ease: "easeOut" };
    } else if (liveState === 'speaking') {
      // API Speaking: Top boundary. Single string with short duration creates perfect smooth volume lerping.
      liveAnimateState = {
        boxShadow: `0 20px 40px rgba(0,0,0,0.6), inset 0 40px 60px -15px rgba(139, 92, 246, ${ aInt }), inset 0 25px 40px -5px rgba(244, 63, 94, ${ aInt * 0.8 }), inset 0 5px 20px rgba(255,255,255,${ aInt * 0.3 })`
      };
      liveTransition = { duration: 0.2, ease: "easeOut" };
    } else if (liveState === 'listening' && micVol > 0.02) {
      // User Speaking: Bottom boundary. Single string for smooth tracking.
      liveAnimateState = {
        boxShadow: `0 20px 40px rgba(0,0,0,0.6), inset 0 -40px 60px -15px rgba(16, 185, 129, ${ mInt }), inset 0 -25px 40px -5px rgba(6, 182, 212, ${ mInt * 0.8 }), inset 0 -5px 20px rgba(255,255,255,${ mInt * 0.3 })`
      };
      liveTransition = { duration: 0.2, ease: "easeOut" };
    } else {
      // Idle Base: Solid soft background glow
      liveAnimateState = {
        boxShadow: `0 20px 40px rgba(0,0,0,0.6), inset 0 0 60px -15px rgba(16, 185, 129, 0.2), inset 0 0 60px -15px rgba(139, 92, 246, 0.2), inset 0 0 25px rgba(244, 63, 94, 0.04)`
      };
      liveTransition = { duration: 1.5, ease: "easeInOut" };
    }
  }

  const isEmptyHome = traceLogsLength === 0 && liveState === 'idle';
  const shellMaxWidth = 'max-w-[800px]';
  const inputSidePadding = isCompressed ? 'px-4' : 'px-4 sm:px-12';
  const modelOptions = MAIN_AGENT_MODEL_OPTIONS;
  const selectedModel = getMainAgentModelConfig(agentMode);
  const safeThinkingLevel = normalizeMainAgentThinkingLevel(thinkingLevel);
  const selectedThinkingLevel = MAIN_AGENT_THINKING_LEVEL_OPTIONS.find(option => option.id === safeThinkingLevel) || MAIN_AGENT_THINKING_LEVEL_OPTIONS[0];
  const modelDisplayLabel = selectedModel.label;
  const modelMenuOpensDown = isEmptyHome;
  const modelMenuVerticalClass = modelMenuOpensDown ? 'top-[calc(100%+10px)]' : 'bottom-[calc(100%+10px)]';
  const modelMenuOffset = modelMenuOpensDown ? -8 : 8;
  const thinkingMenuHorizontalClass = modelMenuOpensDown ? 'left-[calc(100%+8px)]' : 'right-[calc(100%+8px)]';
  const thinkingMenuVerticalClass = modelMenuOpensDown ? 'top-0' : 'bottom-0';
  const thinkingMenuOffset = modelMenuOpensDown ? -8 : 8;

  return (
    <div className={`absolute left-0 flex flex-col items-center z-30 ${ isEmptyHome ? 'right-0 w-full' : 'right-[14px] w-auto' } ${ isEmptyHome
      ? `top-[45%] -translate-y-1/2 ${ inputSidePadding }`
      : `top-auto bottom-0 ${ isCompressed ? 'pb-4 pt-10' : 'pb-6 pt-12' } ${ inputSidePadding } bg-gradient-to-t from-[#0F0F0F] via-[#0F0F0F]/95 to-transparent`
      }`}>

      <AnimatePresence>
        {traceLogsLength === 0 && !isThinking && liveState === 'idle' && (
          <motion.div
            initial={{ opacity: 1, scale: 1, filter: 'blur(0px)', x: "-50%" }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', x: "-50%" }}
            exit={{ opacity: 0, scale: 0.95, filter: 'blur(10px)', y: -20, x: "-50%" }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className={`absolute bottom-full left-1/2 flex flex-col items-center w-full pointer-events-none ${ isCompressed ? 'mb-4 max-w-[520px]' : 'mb-6 max-w-[800px]' }`}
          >
            <div className={`flex items-center ${ isCompressed ? 'gap-3' : 'gap-5 -translate-x-[32px]' }`}>
              <div
                className={`${ isCompressed ? 'h-[44px] w-[44px]' : 'h-[56px] w-[56px]' } shrink-0 relative group cursor-pointer pointer-events-auto transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:-translate-y-1 hover:scale-105`}
                onMouseEnter={() => {
                  setLogoHoverText(logoHoverPhrases[Math.floor(Math.random() * logoHoverPhrases.length)]);
                  setIsLogoHovered(true);
                }}
                onMouseLeave={() => setIsLogoHovered(false)}
              >
                <AgentFace
                  size="welcome"
                  mode="idle"
                  interactive
                  ariaLabel="EterX agent face"
                  className="transition-transform duration-500 ease-out group-hover:scale-110"
                />
                <AnimatePresence>
                  {isLogoHovered && (
                    <motion.div
                      initial={{ opacity: 0, y: 12, x: -32, scale: 0.9, filter: "blur(4px)" }}
                      animate={{ opacity: 1, y: 0, x: -32, scale: 1, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: 8, x: -32, scale: 0.95, filter: "blur(2px)" }}
                      transition={{ type: "spring", stiffness: 300, damping: 25 }}
                      className="absolute bottom-[120%] left-1/2 whitespace-nowrap bg-[#111111]/60 backdrop-blur-[24px] px-4 py-2.5 rounded-[14px] shadow-[0_20px_40px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.15),inset_0_-1px_1px_rgba(255,255,255,0.05)] border border-white/10 z-50 pointer-events-none origin-[32px_bottom] flex items-center justify-center"
                    >
                      {/* Glass tail using rotated square placed behind */}
                      <div className="absolute -bottom-[5px] left-[26px] w-[12px] h-[12px] bg-[#111111]/60 backdrop-blur-[24px] border-b border-r border-white/10 rotate-45 rounded-[2px] shadow-[inset_-1px_-1px_1px_rgba(255,255,255,0.05)] -z-10"></div>

                      <span className="text-[13px] font-medium tracking-wide text-transparent bg-clip-text bg-gradient-to-b from-white via-white/90 to-white/50 drop-shadow-sm">
                        {logoHoverText}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <h1 className={`font-serif tracking-tight leading-[1.2] pb-1 font-medium text-transparent bg-clip-text bg-gradient-to-r from-[#A3A19E] via-[#E8E6E3] to-[#8C8A88] drop-shadow-[0_2px_12px_rgba(255,255,255,0.05)] ${ isCompressed ? 'max-w-[360px] truncate text-[30px]' : 'text-[44px] whitespace-nowrap' }`}>
                {greeting}
              </h1>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`eterx-composer-shell w-full ${ shellMaxWidth } flex flex-col pointer-events-auto relative`}>

        <motion.div
          animate={liveAnimateState}
          transition={liveTransition}
          className={`w-full ${ isCompressed ? 'rounded-[28px]' : 'rounded-[32px]' } flex flex-col ${ attachments.length > 0 ? 'pt-1' : isCompressed ? 'pt-3' : 'pt-4' } pb-2 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] overflow-visible relative ${ liveState !== 'idle'
            ? 'bg-[#1E1E1E] backdrop-blur-3xl border border-white/[0.10] ring-1 ring-white/[0.05]'
            : `bg-[#1E1E1E] backdrop-blur-[28px] ${ isRecording ? 'border border-white/[0.20]' : 'border border-white/[0.08] hover:border-white/[0.12] focus-within:border-white/[0.18]' }`
            }`}>
          <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} className="hidden" />

          <AnimatePresence>
            {attachments.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 5, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: 5, height: 0 }}
                className="relative w-full pt-1"
              >
                {/* Horizontal Scrolling Fumes */}
                <div className="absolute left-0 top-0 bottom-0 w-7 bg-gradient-to-r from-[#202020] to-transparent pointer-events-none z-10 rounded-tl-[32px]" />
                <div className="absolute right-0 top-0 bottom-0 w-7 bg-gradient-to-l from-[#202020] to-transparent pointer-events-none z-10 rounded-tr-[32px]" />

                <div className="flex items-center gap-3 px-5 pb-3 pt-2 overflow-x-auto w-full [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                  {attachments.map((att, i) => {
                    const isImage = !!att.preview;
                    const displayName = att.name || att.file.name || 'file';
                    const extension = displayName.split('.').pop()?.toUpperCase() || 'FILE';
                    const isPdf = extension === 'PDF';
                    const isPreparing = att.uploadStatus === 'uploading';
                    const isErrored = att.uploadStatus === 'error';
                    const fileSize = formatAttachmentSize(att.file.size);

                    if (isImage) {
                      return (
                        <div key={att.id || i} className={`relative group w-[62px] h-[62px] shrink-0 rounded-[18px] shadow-[0_5px_16px_rgba(0,0,0,0.24)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.34)] transition-all cursor-pointer border ${ isErrored ? 'border-[#E2765A]/55' : 'border-white/[0.12] hover:border-white/[0.20]' } overflow-visible`}>
                          <img src={att.preview} alt={displayName} className={`w-full h-full object-cover rounded-[18px] transition-all ${ isErrored ? 'opacity-45 grayscale' : 'opacity-100' }`} />
                          {isPreparing && (
                            <div className="pointer-events-none absolute inset-0 rounded-[18px] bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.16)_45%,transparent_78%)] bg-[length:220%_100%] animate-[eterx-attachment-sheen_1.8s_ease-in-out_infinite]" />
                          )}
                          {isErrored && (
                            <div className="absolute inset-0 flex items-center justify-center rounded-[18px] bg-black/28">
                              <AlertCircle className="w-5 h-5 text-[#F0B6A7]" strokeWidth={2.2} />
                            </div>
                          )}
                          <div className="pointer-events-none absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/[0.12] bg-black/45 text-white/90 backdrop-blur-md">
                            <ImageIcon className="h-3 w-3" strokeWidth={2.15} />
                          </div>
                          <button
                            onClick={() => removeAttachment(i)}
                            className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] flex items-center justify-center rounded-full border border-white/[0.14] bg-[#202020]/95 text-[#D8D5CF] shadow-[0_4px_12px_rgba(0,0,0,0.45)] transition-all hover:scale-110 hover:border-[#E2765A]/70 hover:bg-[#E2765A] hover:text-white z-20"
                          >
                            <X className="w-2.5 h-2.5" strokeWidth={3} />
                          </button>
                        </div>
                      );
                    }

                    return (
                      <div key={att.id || i} className={`relative group w-[200px] shrink-0 h-[58px] rounded-[16px] bg-[#202020]/82 border ${ isErrored ? 'border-[#E2765A]/45' : 'border-white/[0.095] hover:border-white/[0.17]' } shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_5px_16px_rgba(0,0,0,0.2)] hover:bg-[#272727]/90 transition-all flex items-center p-2 cursor-pointer overflow-hidden`}>
                        {isPreparing && (
                          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.08)_44%,transparent_76%)] bg-[length:230%_100%] animate-[eterx-attachment-sheen_1.8s_ease-in-out_infinite]" />
                        )}
                        <div className={`w-[40px] h-[40px] rounded-[10px] flex items-center justify-center shrink-0 border border-white/5 ${ isPdf ? 'bg-[#EF4444]' : 'bg-[#007AFF]' }`}>
                          {isErrored ? (
                            <AlertCircle className="w-5 h-5 text-white" strokeWidth={2.15} />
                          ) : (
                            <FileText className="w-5 h-5 text-white" strokeWidth={2} />
                          )}
                        </div>

                        <div className="flex flex-col overflow-hidden ml-3 justify-center h-full w-full pr-1">
                          <span className="text-[13px] font-medium text-[#E8E6E3] truncate tracking-wide leading-tight">{displayName}</span>
                          <span className={`text-[11px] font-medium truncate mt-0.5 ${ isErrored ? 'text-[#F0B6A7]' : 'text-[#8C8A88]' }`}>
                            {isErrored ? 'Attach failed' : isPreparing ? 'Preparing' : (fileSize ? `${ extension } · ${ fileSize }` : extension)}
                          </span>
                        </div>

                        <button
                          onClick={() => removeAttachment(i)}
                          className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] flex items-center justify-center rounded-full border border-white/[0.14] bg-[#202020]/95 text-[#D8D5CF] shadow-[0_4px_12px_rgba(0,0,0,0.45)] transition-all hover:scale-110 hover:border-[#E2765A]/70 hover:bg-[#E2765A] hover:text-white z-20"
                        >
                          <X className="w-2.5 h-2.5" strokeWidth={3} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className={`${ isCompressed ? 'px-4' : 'px-5' } pb-2 min-h-[44px] flex items-center relative z-10`}>
            <AnimatePresence mode="wait">
              {/* ═══ GEMINI LIVE — Modern Centered Visualization ═══ */}
              {liveState !== 'idle' && liveState !== 'error' ? (
                <motion.div
                  key="live-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="flex items-center justify-center w-full min-h-[44px] relative"
                >
                  {/* Left Side: Mute Controls (Ultra-Aesthetic Circular Pill) */}
                  <div className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center p-1 bg-white/[0.03] backdrop-blur-[24px] border border-white/[0.08] rounded-full shadow-sm transition-all duration-300 hover:bg-white/[0.05] hover:border-white/[0.12] gap-0.5">
                    <Tooltip text={isSpeakerMuted ? "Unmute system voice" : "Mute system voice"} side="top">
                      <button
                        onClick={onToggleSpeakerMute}
                        className={`w-[34px] h-[34px] flex items-center justify-center rounded-full transition-all duration-300 group ${ isSpeakerMuted ? 'text-[#E2765A] bg-[#E2765A]/15' : 'text-[#F4F4F4] hover:bg-white/10 hover:text-white active:scale-95' }`}
                      >
                        {isSpeakerMuted ? (
                          <PremiumVolumeX className="w-[16px] h-[16px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        ) : (
                          <PremiumVolume2 className="w-[16px] h-[16px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        )}
                      </button>
                    </Tooltip>

                    <Tooltip text={isMicMuted ? "Unmute your microphone" : "Mute your microphone"} side="top">
                      <button
                        onClick={onToggleMicMute}
                        className={`w-[34px] h-[34px] flex items-center justify-center rounded-full transition-all duration-300 group ${ isMicMuted ? 'text-[#E2765A] bg-[#E2765A]/15' : 'text-[#F4F4F4] hover:bg-white/10 hover:text-white active:scale-95' }`}
                      >
                        {isMicMuted ? (
                          <PremiumMicOff className="w-[17px] h-[17px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        ) : (
                          <PremiumMic className="w-[17px] h-[17px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        )}
                      </button>
                    </Tooltip>
                  </div>

                  <motion.div
                    className="flex items-center gap-6"
                    animate={{ x: liveActiveTool ? -20 : 0 }}
                    transition={{ type: 'spring', bounce: 0.15, duration: 0.6 }}
                  >
                    {/* Centered Frequency Bar Visualizer — Lag Free & Modern */}
                    <div className="flex items-center justify-center gap-[4px] h-[36px]">
                      {Array.from({ length: 4 }).map((_, i) => {
                        // Advanced organic motion math
                        const isSpeaking = liveState === 'speaking';
                        const isConnecting = liveState === 'connecting';
                        const isListening = liveState === 'listening';

                        let h = 14; // Base height: perfect circle
                        let baseVol = 0;

                        if (isSpeaking) {
                          // True Multi-band EQ rendering: each bar dances independently to actual voice frequency buckets
                          if (Array.isArray(liveModelVolume)) {
                            baseVol = (liveModelVolume[i] / 100) * 26; // Punchy scaling
                            h = 14 + baseVol;
                          } else {
                            // Fallback for single volume
                            const multiplier = [0.6, 1.0, 0.85, 0.5][i];
                            baseVol = ((liveModelVolume as number) / 100) * 22;
                            h = 14 + (baseVol * multiplier);
                          }
                        } else if (isListening) {
                          // Real-time Mic volume with inverse wave distribution
                          const multiplier = [0.5, 0.85, 1.0, 0.6][i];
                          baseVol = (liveMicVolume / 100) * 22;
                          h = 14 + (baseVol * multiplier);
                        }

                        // Determine animation state
                        let animateHeight: any = Math.max(14, Math.min(36, h));
                        let transitionCfg: any = { type: 'spring', stiffness: 400, damping: 25, mass: 0.5 };

                        if (isConnecting) {
                          animateHeight = [14, 28, 14];
                          transitionCfg = { duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.2 };
                        } else if (isListening && baseVol < 1) {
                          // Subtle silent breathing
                          animateHeight = [14, 16 + (i % 2), 14];
                          transitionCfg = { duration: 2.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.4 };
                        }

                        return (
                          <motion.div
                            key={i}
                            className="w-[14px] rounded-full bg-white"
                            animate={{ height: animateHeight }}
                            transition={transitionCfg}
                          />
                        );
                      })}
                    </div>

                    {/* Removed center tool indicator to keep bars perfectly centered */}
                  </motion.div>

                  {/* Absolute positioned End Button and Status Text on the right */}
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-4">
                    <AnimatePresence mode="wait">
                      {liveState === 'connecting' ? (
                        <motion.span
                          key="connecting"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="text-[12.5px] text-[#F0F0F0] tracking-wide font-medium whitespace-nowrap"
                        >
                          Connecting...
                        </motion.span>
                      ) : liveActiveTool ? (
                        <motion.span
                          key="tool"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.3 }}
                          className="text-[12.5px] text-[#F0F0F0] tracking-wide font-medium whitespace-nowrap"
                        >
                          {(() => {
                            switch (liveActiveTool) {
                              case 'web_search': return 'Searching Web...';
                              case 'run_terminal_command': return 'Working...';
                              case 'store_chat_memory': return 'Updating Memory...';
                              case 'read_chat_memory': return 'Reading Memory...';
                              case 'change_voice': return 'Configuring Voice...';
                              case 'get_system_time': return 'Checking Time...';
                              case 'end_call': return 'Ending Call...';
                              default: return liveActiveTool.replace(/_/g, ' ') + '...';
                            }
                          })()}
                        </motion.span>
                      ) : null}
                    </AnimatePresence>

                    {/* Dark Modern Stop Button (Restored Square Core with Circular Bounds) */}
                    <button
                      onClick={onLiveStop}
                      className="w-[42px] h-[42px] flex items-center justify-center rounded-full bg-black/40 backdrop-blur-md border border-white/10 transition-all duration-300 hover:bg-black/60 hover:scale-105 hover:border-white/20 active:scale-95 shadow-md group"
                    >
                      <div className="w-[14px] h-[14px] rounded-[3.5px] bg-[#E8E6E3] opacity-90 group-hover:opacity-100 group-hover:scale-90 group-hover:bg-[#EF4444] transition-all duration-300" />
                    </button>
                  </div>
                </motion.div>
              ) : (isRecording || isProcessingVoice) ? (
                <VoiceWaveform
                  key="waveform"
                  volume={audioVolume}
                  isProcessing={isProcessingVoice}
                  cancelVoice={cancelVoice}
                  acceptVoice={acceptVoice}
                />
              ) : (
                <div className="relative w-full">
                  {isOverflowing && !isAtTop && (
                    <div className="absolute -top-1 left-0 right-3 h-10 bg-gradient-to-b from-[#1F1F1F] via-[#1F1F1F]/90 to-transparent pointer-events-none z-10 transition-opacity duration-200" />
                  )}
                  <motion.textarea
                    ref={textareaRef}
                    key="textarea"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    value={inputValue}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      notifyAgentFaceInputChange(inputValue, nextValue);
                      setInputValue(nextValue);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submitPrompt();
                      }
                    }}
                    onPaste={handlePaste}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onScroll={handleTextareaScroll}
                    placeholder="Ask EterX to Work"
                    className={`w-full appearance-none border-0 bg-transparent shadow-none outline-none ring-0 ${ isCompressed ? 'text-[15px]' : 'text-[16px]' } font-normal text-[#F0F0F0] placeholder:text-[#9C9A96] focus:border-0 focus:outline-none focus:ring-0 placeholder:font-normal min-h-[24px] max-h-[400px] resize-none leading-[1.55] selection:bg-white/15 transition-colors duration-200 relative z-0 py-1 ${ isOverflowing ? 'overflow-y-auto custom-scrollbar pr-2' : 'overflow-hidden' }`}
                    style={{
                      caretColor: '#F0F0F0',
                      height: '24px',
                      maxHeight: textareaMaxHeight,
                      outline: 'none',
                      boxShadow: 'none',
                      border: 0,
                    }}
                  />
                  {isOverflowing && !isAtBottom && (
                    <div className="absolute -bottom-1 left-0 right-3 h-10 bg-gradient-to-t from-[#1F1F1F] via-[#1F1F1F]/90 to-transparent pointer-events-none z-10 transition-opacity duration-200" />
                  )}
                </div>
              )}
            </AnimatePresence>
          </div>

          <div className={`eterx-chat-controls ${ isCompressed ? 'px-2.5' : 'px-3.5' } mt-1.5 relative z-10 transition-all duration-300`}>
            <div className="eterx-chat-controls-left">
              <Tooltip text="Attach files" side="top">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={inputControlButton}
                >
                  <div className={inputControlSheen} />
                    <PremiumPlus className="w-[22px] h-[22px] text-white transition-transform duration-200 ease-out group-hover:scale-[1.06]" strokeWidth={2.45} />
                </button>
              </Tooltip>
              <ConnectorsButton
                connectedCount={Object.values(connectors.connectedApps).filter(Boolean).length}
                onToggleAction={() => connectors.setOpen(true)}
              />
              <ConnectorsModal
                open={connectors.open}
                onClose={() => connectors.setOpen(false)}
                connectedApps={connectors.connectedApps}
                onConnect={connectors.handleConnect}
                onDisconnect={connectors.handleDisconnect}
              />
              <div className="relative">
                <Tooltip text="Pin folder or files" side="top">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenPillDrop(null);
                      setShowPinMenu(prev => !prev);
                    }}
                    className={`${inputControlButton} ${ showPinMenu || pinnedItems.length > 0 ? '!bg-[#292929] !border-white/[0.24] !text-white' : '' }`}
                    aria-haspopup="menu"
                    aria-expanded={showPinMenu}
                  >
                    <div className={inputControlSheen} />
                    <img
                      src="https://img.icons8.com/sf-regular/48/pin.png"
                      alt="Pin"
                      className={`h-[23px] w-[23px] object-contain opacity-100 invert brightness-200 transition-transform duration-200 ease-out group-hover:scale-[1.06] ${ showPinMenu ? '-rotate-12' : '' }`}
                    />
                  </button>
                </Tooltip>

                <AnimatePresence>
                  {showPinMenu && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.96 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                      className="absolute bottom-[calc(100%+10px)] left-1/2 z-[120] flex w-[150px] -translate-x-[27px] flex-col rounded-[15px] border border-white/[0.105] bg-[#1A1A1A]/95 backdrop-blur-2xl p-[3px] shadow-[0_16px_34px_rgba(0,0,0,0.58),inset_0_1px_0_rgba(255,255,255,0.055)]"
                    >
                      <span className="pointer-events-none absolute -bottom-[5px] left-[8px] z-0 h-[10px] w-[10px] rotate-45 border-b border-r border-white/[0.105] bg-[#1A1A1A]/95" />
                      <button type="button" onClick={handlePinFolder} className="group/menu relative z-10 flex h-[40px] w-full items-center gap-[9px] rounded-[12px] px-[9px] text-left text-white transition-all duration-150 hover:bg-white/[0.095] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus-visible:bg-white/[0.095] focus-visible:outline-none active:scale-[0.99]">
                        <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center text-white transition-colors">
                          <PinFolderIcon className="h-[24px] w-[24px]" />
                        </span>
                        <span className="min-w-0 text-[13.5px] font-semibold leading-none tracking-[-0.004em]">
                          Folder
                        </span>
                      </button>
                      <div className="relative z-10 mx-[9px] h-px bg-white/[0.05]" />
                      <button type="button" onClick={handlePinFiles} className="group/menu relative z-10 flex h-[40px] w-full items-center gap-[9px] rounded-[12px] px-[9px] text-left text-white transition-all duration-150 hover:bg-white/[0.095] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus-visible:bg-white/[0.095] focus-visible:outline-none active:scale-[0.99]">
                        <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center text-white transition-colors">
                          <PinFileIcon className="h-[24px] w-[24px]" />
                        </span>
                        <span className="min-w-0 text-[13.5px] font-semibold leading-none tracking-[-0.004em]">
                          Files
                        </span>
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Folders and Files Pills */}
              <AnimatePresence>
                {(() => {
                  const folders = pinnedItems.filter(i => i.type === 'folder');
                  const files = pinnedItems.filter(i => i.type === 'file');

                  return (
                    <div className={`eterx-pinned-items flex min-w-0 items-center gap-1.5 ${ isCompressed ? `ml-0 max-w-[180px] ${ openPillDrop ? 'overflow-visible' : 'overflow-hidden' }` : 'ml-1.5 flex-wrap' }`}>
                      {/* FOLDERS PILL */}
                      {folders.length > 0 && (
                        <motion.div
                          initial={{ opacity: 0, width: 0, scale: 0.9 }}
                          animate={{ opacity: 1, width: 'auto', scale: 1 }}
                          exit={{ opacity: 0, width: 0, scale: 0.9 }}
                          className="flex items-center h-[34px] group relative"
                        >
                          <div className="flex items-center gap-2 px-3 h-full bg-[#202020]/82 border border-white/[0.10] rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_10px_rgba(0,0,0,0.16)] hover:bg-[#2A2A2A]/86 hover:border-white/[0.16] transition-colors cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (folders.length > 1) {
                                setShowPinMenu(false);
                                setOpenPillDrop(openPillDrop === 'folders' ? null : 'folders');
                              }
                            }}
                          >
                            <Folder className="w-[14px] h-[14px] text-[#A78BFA] shrink-0" strokeWidth={2.5} />
                            <span className={`text-[12px] font-medium text-white truncate tracking-wide ${ isCompressed ? 'max-w-[62px]' : 'max-w-[120px]' }`}>
                              {folders.length === 1 ? folders[0].name : `${ folders.length } folders`}
                            </span>
                            <button onClick={(e) => {
                              e.stopPropagation();
                              if (folders.length === 1) {
                                setPinnedItems(pinnedItems.filter(i => i.type !== 'folder'));
                              } else {
                                // Clicking X on a multi-item pill removes all of them
                                setPinnedItems(pinnedItems.filter(i => i.type !== 'folder'));
                                setOpenPillDrop(null);
                              }
                            }} className="ml-0.5 p-0.5 text-[#F0F0F0] hover:text-[#E2765A] rounded-full transition-colors shrink-0">
                              <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                            </button>
                          </div>

                          {/* Folder Click Menu */}
                          <AnimatePresence>
                            {openPillDrop === 'folders' && folders.length > 1 && (
                              <motion.div
                                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                transition={{ duration: 0.2 }}
                                className="absolute bottom-full left-0 mb-2 flex flex-col bg-[#1A1A1A]/95 backdrop-blur-2xl border border-white/10 rounded-[13px] shadow-[0_12px_30px_rgba(0,0,0,0.64),inset_0_1px_0_rgba(255,255,255,0.04)] z-50 p-1 w-max max-w-[220px] max-h-[300px] overflow-y-auto custom-scrollbar overflow-x-hidden"
                              >
                                {folders.map(f => (
                                  <div key={f.id} className="flex items-center px-2 py-1.5 hover:bg-white/5 rounded-[8px] group/item transition-colors">
                                    <div className="flex items-center gap-2 overflow-hidden min-w-0 pr-2">
                                      <Folder className="w-3.5 h-3.5 text-[#A78BFA] shrink-0" />
                                      <span className="text-[11px] text-[#E8E6E3] truncate">{f.name}</span>
                                    </div>
                                    <button onClick={(e) => {
                                      e.stopPropagation();
                                      const newItems = pinnedItems.filter(i => i.id !== f.id);
                                      setPinnedItems(newItems);
                                      if (newItems.filter(i => i.type === 'folder').length <= 1) setOpenPillDrop(null);
                                    }} className="ml-auto flex-shrink-0 text-[#F0F0F0] hover:text-[#E2765A] opacity-0 group-hover/item:opacity-100 transition-opacity">
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      )}

                      {/* FILES PILL */}
                      {files.length > 0 && (
                        <motion.div
                          initial={{ opacity: 0, width: 0, scale: 0.9 }}
                          animate={{ opacity: 1, width: 'auto', scale: 1 }}
                          exit={{ opacity: 0, width: 0, scale: 0.9 }}
                          className="flex items-center h-[34px] group relative"
                        >
                          <div className="flex items-center gap-2 px-3 h-full bg-[#202020]/82 border border-white/[0.10] rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_10px_rgba(0,0,0,0.16)] hover:bg-[#2A2A2A]/86 hover:border-white/[0.16] transition-colors cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (files.length > 1) {
                                setShowPinMenu(false);
                                setOpenPillDrop(openPillDrop === 'files' ? null : 'files');
                              }
                            }}
                          >
                            <FileIcon className="w-[14px] h-[14px] text-[#FCD34D] shrink-0" strokeWidth={2.5} />
                            <span className={`text-[12px] font-medium text-white truncate tracking-wide ${ isCompressed ? 'max-w-[62px]' : 'max-w-[120px]' }`}>
                              {files.length === 1 ? files[0].name : `${ files.length } files`}
                            </span>
                            <button onClick={(e) => {
                              e.stopPropagation();
                              if (files.length === 1) {
                                setPinnedItems(pinnedItems.filter(i => i.type !== 'file'));
                              } else {
                                setPinnedItems(pinnedItems.filter(i => i.type !== 'file'));
                                setOpenPillDrop(null);
                              }
                            }} className="ml-0.5 p-0.5 text-[#F0F0F0] hover:text-[#E2765A] rounded-full transition-colors shrink-0">
                              <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                            </button>
                          </div>

                          {/* Files Click Menu */}
                          <AnimatePresence>
                            {openPillDrop === 'files' && files.length > 1 && (
                              <motion.div
                                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                transition={{ duration: 0.2 }}
                                className="absolute bottom-full left-0 mb-2 flex flex-col bg-[#1A1A1A]/95 backdrop-blur-2xl border border-white/10 rounded-[13px] shadow-[0_12px_30px_rgba(0,0,0,0.64),inset_0_1px_0_rgba(255,255,255,0.04)] z-50 p-1 w-max max-w-[220px] max-h-[300px] overflow-y-auto custom-scrollbar overflow-x-hidden"
                              >
                                {files.map(f => (
                                  <div key={f.id} className="flex items-center px-2 py-1.5 hover:bg-white/5 rounded-[8px] group/item transition-colors">
                                    <div className="flex items-center gap-2 overflow-hidden min-w-0 pr-2">
                                      <FileIcon className="w-3.5 h-3.5 text-[#FCD34D] shrink-0" />
                                      <span className="text-[11px] text-[#E8E6E3] truncate">{f.name}</span>
                                    </div>
                                    <button onClick={(e) => {
                                      e.stopPropagation();
                                      const newItems = pinnedItems.filter(i => i.id !== f.id);
                                      setPinnedItems(newItems);
                                      if (newItems.filter(i => i.type === 'file').length === 0) setOpenPillDrop(null);
                                    }} className="ml-auto flex-shrink-0 text-[#F0F0F0] hover:text-[#E2765A] opacity-0 group-hover/item:opacity-100 transition-opacity">
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      )}
                    </div>
                  );
                })()}
              </AnimatePresence>
            </div>

            <div className="eterx-chat-controls-right">
              {/* Model selector */}
              <div ref={modelSelectorRef} className="eterx-model-selector relative min-w-0">
                <button
                  onClick={() => {
                    if (isModelLocked) return;
                    setShowModelMenu(prev => !prev);
                  }}
                  className={`eterx-model-button ${ isCompressed ? 'mr-0 max-w-[160px] px-2.5' : 'mr-1 px-3.5' } flex h-[38px] w-full min-w-0 items-center gap-1.5 rounded-full border border-white/[0.16] bg-[#202020]/95 text-[#F4F4F4] transition-all duration-200 hover:bg-[#2A2A2A] hover:text-white hover:border-white/[0.26] active:scale-[0.98] group ${ showModelMenu ? '!bg-[#252525] !border-white/[0.30] !text-white' : '' } ${ isModelLocked ? 'cursor-not-allowed opacity-70 hover:bg-[#202020]/95 hover:text-[#F4F4F4] hover:border-white/[0.16] active:scale-100' : '' }`}
                  aria-haspopup="dialog"
                  aria-expanded={showModelMenu}
                  aria-disabled={isModelLocked}
                >
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={agentMode}
                      initial={{ opacity: 0, scale: 0.8, y: 4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.8, y: -4 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      <span className="min-w-0 truncate text-[14px] font-semibold tracking-normal transition-colors">
                        {modelDisplayLabel}
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 text-[#F0F0F0] transition-all duration-200 group-hover:text-white ${ showModelMenu ? 'rotate-180' : 'group-hover:translate-y-px' }`} strokeWidth={2.1} />
                    </motion.div>
                  </AnimatePresence>
                </button>

                <AnimatePresence>
                  {showModelMenu && (
                    <motion.div
                      initial={{ opacity: 0, y: modelMenuOffset, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: modelMenuOffset, scale: 0.98 }}
                      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                      className={`absolute ${ modelMenuVerticalClass } right-0 z-[130] flex ${ isCompressed ? 'w-[248px]' : 'w-[286px]' } max-w-[calc(100vw-32px)] flex-col rounded-[20px] border border-white/[0.08] bg-[#111111] p-1.5 text-[#F4F1EA] shadow-[0_18px_44px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.04)]`}
                      role="dialog"
                      aria-label="Model and thinking settings"
                    >
                      {modelOptions.map((option) => {
                        const selected = option.id === selectedModel.id;
                        return (
                          <React.Fragment key={option.id}>
                            <button
                              onClick={() => {
                                onModeChange(option.id);
                                setShowModelMenu(false);
                                setShowThinkingLevels(false);
                              }}
                              className={`group flex min-h-[44px] w-full items-center gap-2.5 rounded-[15px] px-2.5 py-1.5 text-left transition-colors duration-150 ${ selected ? 'text-white hover:bg-[#202020]' : 'text-[#F4F4F4] hover:bg-[#202020] hover:text-white' }`}
                              aria-pressed={selected}
                            >
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-white/95">
                                {selected && <Check className="h-4 w-4" strokeWidth={2.35} />}
                              </span>
                              <span className="flex min-w-0 flex-1 items-center">
                                <span className="truncate text-[13px] font-semibold leading-5 tracking-normal">
                                  {option.label}
                                </span>
                              </span>
                            </button>
                          </React.Fragment>
                        );
                      })}

                      <div className="mx-2 my-1.5 h-px bg-white/[0.09]" />

                      <div className="px-0.5 pb-0.5">
                        <div
                          className="relative"
                          onMouseEnter={() => setShowThinkingLevels(true)}
                          onMouseLeave={() => setShowThinkingLevels(false)}
                        >
                          <button
                            type="button"
                            onClick={() => setShowThinkingLevels(prev => !prev)}
                            onFocus={() => setShowThinkingLevels(true)}
                            className={`flex min-h-[46px] w-full items-center gap-2.5 rounded-[15px] px-2.5 py-1.5 text-left text-white transition-colors duration-150 hover:bg-[#242424] ${ showThinkingLevels ? 'bg-[#242424]' : '' }`}
                            aria-expanded={showThinkingLevels}
                          >
                            <span className="h-5 w-5 shrink-0" />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[13px] font-semibold leading-5 tracking-normal">
                                Thinking level
                              </span>
                              <span className="truncate text-[12px] font-medium leading-4 text-[#E7E7E7]">
                                {selectedThinkingLevel.label}
                              </span>
                            </span>
                            <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-white transition-transform duration-150 ${ showThinkingLevels ? 'rotate-90' : '' }`} strokeWidth={2.2} />
                          </button>

                          <AnimatePresence initial={false}>
                            {showThinkingLevels && (
                              <motion.div
                                initial={{ opacity: 0, x: thinkingMenuOffset, scale: 0.98 }}
                                animate={{ opacity: 1, x: 0, scale: 1 }}
                                exit={{ opacity: 0, x: thinkingMenuOffset, scale: 0.98 }}
                                transition={{ duration: 0.16, ease: 'easeOut' }}
                                className={`absolute ${ thinkingMenuVerticalClass } ${ thinkingMenuHorizontalClass } z-[140] w-[188px] max-w-[calc(100vw-44px)] overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#111111] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.62),inset_0_1px_0_rgba(255,255,255,0.04)]`}
                              >
                                {MAIN_AGENT_THINKING_LEVEL_OPTIONS.map(option => {
                                  const selected = option.id === safeThinkingLevel;
                                  return (
                                    <button
                                      key={option.id}
                                      type="button"
                                      onClick={() => {
                                        onThinkingLevelChange(option.id);
                                        setShowThinkingLevels(false);
                                      }}
                                      className={`flex min-h-[42px] w-full items-center gap-2.5 rounded-[14px] px-2.5 py-1.5 text-left transition-colors duration-150 ${ selected ? 'text-white hover:bg-[#202020]' : 'text-[#F4F4F4] hover:bg-[#202020] hover:text-white' }`}
                                    >
                                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-white/95">
                                        {selected && <Check className="h-4 w-4" strokeWidth={2.35} />}
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[13px] font-semibold leading-5">
                                          {option.label}
                                        </span>
                                      </span>
                                    </button>
                                  );
                                })}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <Tooltip text="Voice dictation" side="top">
                <button onClick={toggleSpeech} className={`eterx-control-button w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-full border border-white/[0.18] bg-[#242424]/96 text-white transition-all duration-200 ease-out hover:text-white hover:bg-[#2D2D2D] hover:border-white/[0.30] active:scale-[0.96] relative group ${ isRecording ? '!text-[#E2765A] animate-pulse bg-[#E2765A]/10 border-[#E2765A]/25' : '' }`}>
                  <PremiumMic className="w-[18px] h-[18px] group-hover:scale-[1.1] transition-transform duration-200 ease-out" strokeWidth={2} />
                </button>
              </Tooltip>

              {/* Send / Stop / Stopping-Spinner Button — 3-state with smooth AnimatePresence */}
              {liveState !== 'idle' && liveState !== 'error' ? (
                null /* Cancel/Stop is already rendered in the live overlay above */
              ) : (
                                <AnimatePresence mode="wait">
                  {isThinking && !isStopping && inputValue.trim() ? (
                    /* ── STEER button (agent running + user typed something) ── */
                    <motion.div key="steer"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                      <Tooltip text="Steer agent live" side="top">
                        <button
                          onClick={handleSteer}
                          className={inputControlButton}
                        >
                          <div className={inputControlSheen} />
                          <svg className="w-[20px] h-[20px] text-white group-hover:scale-110 transition-transform duration-200 ease-out relative z-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor" opacity="0.75"/>
                          </svg>
                        </button>
                      </Tooltip>
                    </motion.div>
                  ) : isThinking && !isStopping ? (
                    /* ── STOP button (agent running, input empty) ── */
                    <motion.div key="stop"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                      <Tooltip text="Stop Agent" side="top">
                        <button
                          onClick={() => { setIsStopping(true); handleStop(); }}
                          className="eterx-control-button w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-full bg-[#F2EFEA] hover:bg-white transition-all duration-200 shadow-[0_8px_22px_rgba(242,239,234,0.15),inset_0_1px_0_rgba(255,255,255,0.82)] active:scale-[0.96] group cursor-pointer overflow-hidden relative"
                        >
                          <div className="absolute inset-0 bg-gradient-to-t from-black/0 to-black/5" />
                          <div className="w-[12px] h-[12px] rounded-[3px] bg-[#161616] group-hover:scale-90 transition-transform duration-200" />
                        </button>
                      </Tooltip>
                    </motion.div>
                  ) : isStopping ? (
                    /* ── STOPPING spinner (stop clicked, waiting for backend) ── */
                    <motion.div key="stopping"
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                      <div className="eterx-control-button w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-full bg-[#242424] border border-white/[0.13] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] cursor-not-allowed">
                        <motion.div
                          className="w-[18px] h-[18px] rounded-full border-[2px] border-white/20 border-t-white"
                          animate={{ rotate: 360 }}
                          transition={{ duration: 0.75, repeat: Infinity, ease: 'linear' }}
                        />
                      </div>
                    </motion.div>
                  ) : (inputValue.trim() || attachments.length > 0) ? (
                    /* ── SEND button ── */
                    <motion.div key="send"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                      <Tooltip text={hasErroredAttachments ? "Remove failed attachment" : hasPreparingAttachments ? "Preparing media" : "Send message"} side="top">
                        <button
                          onClick={submitPrompt}
                          className={`eterx-control-button w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-full transition-all duration-200 bg-[#F2EFEA] text-black hover:bg-white shadow-[0_8px_22px_rgba(242,239,234,0.15),inset_0_1px_0_rgba(255,255,255,0.82)] active:scale-[0.96] group relative overflow-hidden ${ hasErroredAttachments ? 'opacity-60 cursor-not-allowed' : '' }`}
                        >
                          <div className="absolute inset-0 bg-gradient-to-t from-black/0 to-black/5" />
                          <PremiumSend className="w-[20px] h-[20px] text-black group-hover:-translate-y-0.5 group-hover:scale-110 transition-all duration-200 ease-out" strokeWidth={2.8} />
                        </button>
                      </Tooltip>
                    </motion.div>
                  ) : (
                    /* ── LIVE button ── */
                    <motion.div key="live"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                      <Tooltip text="Start Live Conversation" side="top">
                        <button
                          onClick={onLiveStart}
                          className={`eterx-control-button w-[40px] h-[40px] shrink-0 flex items-center justify-center rounded-full border border-white/[0.18] bg-[#242424]/96 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_5px_14px_rgba(0,0,0,0.24)] transition-all duration-200 active:scale-[0.96] active:bg-[#303030] cursor-pointer group relative overflow-hidden hover:bg-[#2D2D2D] hover:border-white/[0.30] hover:text-white ${ isRecording ? '!text-[#E2765A]' : '' }`}
                        >
                          <div className={inputControlSheen} />
                          <PremiumAudioLines className={`w-[20px] h-[20px] text-white transition-all duration-200 ease-out group-hover:scale-110 ${ isRecording ? '!text-[#E2765A] animate-pulse scale-110' : '' }`} strokeWidth={2.2} />
                        </button>
                      </Tooltip>
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};
