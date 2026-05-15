'use client';
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, Check, ChevronRight, Puzzle } from 'lucide-react';
import { Tooltip } from '../ui/tooltip';

// ── Inline SVG logos for top connectors ─────────────────────
const SlackLogo = () => (
  <svg viewBox="0 0 54 54" className="w-6 h-6">
    <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
    <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
    <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
    <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.25a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A"/>
  </svg>
);

const GithubLogo = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-white">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
  </svg>
);

const GmailLogo = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6">
    <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" fill="#EA4335"/>
  </svg>
);

// ── Connector data ───────────────────────────────────────────
export const CONNECTORS = [
  // Communication
  { id: 'slack', name: 'Slack', desc: 'Send messages, read channels, search workspace', category: 'Communication', logo: <SlackLogo />, color: '#4A154B', functional: true },
  { id: 'discord', name: 'Discord', desc: 'Manage servers, send messages, read channels', category: 'Communication', emoji: '💬', color: '#5865F2' },
  { id: 'telegram', name: 'Telegram', desc: 'Send & receive messages, manage bots', category: 'Communication', emoji: '✈️', color: '#2AABEE' },
  { id: 'whatsapp', name: 'WhatsApp', desc: 'Send messages and manage conversations', category: 'Communication', emoji: '📱', color: '#25D366' },
  { id: 'teams', name: 'Microsoft Teams', desc: 'Chat, meet, and collaborate in Teams', category: 'Communication', emoji: '🔵', color: '#6264A7' },
  { id: 'zoom', name: 'Zoom', desc: 'Schedule and manage Zoom meetings', category: 'Communication', emoji: '📹', color: '#2D8CFF' },
  // Email & Calendar
  { id: 'gmail', name: 'Gmail', desc: 'Read, draft, search, and send emails', category: 'Email & Calendar', logo: <GmailLogo />, color: '#EA4335' },
  { id: 'outlook_mail', name: 'Outlook Mail', desc: 'Manage Outlook inbox and send emails', category: 'Email & Calendar', emoji: '📧', color: '#0078D4' },
  { id: 'google_calendar', name: 'Google Calendar', desc: 'Create and manage events and schedules', category: 'Email & Calendar', emoji: '📅', color: '#4285F4' },
  { id: 'outlook_calendar', name: 'Outlook Calendar', desc: 'View and manage Outlook calendar events', category: 'Email & Calendar', emoji: '🗓️', color: '#0078D4' },
  // Dev Tools
  { id: 'github', name: 'GitHub', desc: 'Repos, PRs, issues, and code reviews', category: 'Dev Tools', logo: <GithubLogo />, color: '#24292E', functional: false },
  { id: 'gitlab', name: 'GitLab', desc: 'Manage repos, pipelines, and merge requests', category: 'Dev Tools', emoji: '🦊', color: '#FC6D26' },
  { id: 'jira', name: 'Jira', desc: 'Create and track issues, manage sprints', category: 'Dev Tools', emoji: '🔵', color: '#0052CC' },
  { id: 'linear', name: 'Linear', desc: 'Manage issues and track engineering work', category: 'Dev Tools', emoji: '⚡', color: '#5E6AD2' },
  { id: 'figma', name: 'Figma', desc: 'Access designs, comments, and prototypes', category: 'Dev Tools', emoji: '🎨', color: '#F24E1E' },
  // Productivity
  { id: 'notion', name: 'Notion', desc: 'Read and write pages, databases, and notes', category: 'Productivity', emoji: '⬛', color: '#000000' },
  { id: 'trello', name: 'Trello', desc: 'Manage boards, cards, and lists', category: 'Productivity', emoji: '📋', color: '#0052CC' },
  { id: 'asana', name: 'Asana', desc: 'Create and manage tasks and projects', category: 'Productivity', emoji: '🌸', color: '#F06A6A' },
  { id: 'clickup', name: 'ClickUp', desc: 'Manage tasks, docs, and workflows', category: 'Productivity', emoji: '⬆️', color: '#7B68EE' },
  { id: 'monday', name: 'Monday.com', desc: 'Manage boards and track project progress', category: 'Productivity', emoji: '🟧', color: '#FF3D57' },
  { id: 'airtable', name: 'Airtable', desc: 'Read and write to Airtable bases and tables', category: 'Productivity', emoji: '🟨', color: '#FCB400' },
  // Cloud Storage
  { id: 'google_drive', name: 'Google Drive', desc: 'Access, create, and share Drive files', category: 'Cloud Storage', emoji: '📁', color: '#4285F4' },
  { id: 'dropbox', name: 'Dropbox', desc: 'Upload, download, and share files', category: 'Cloud Storage', emoji: '📦', color: '#0061FF' },
  { id: 'onedrive', name: 'OneDrive', desc: 'Manage and share OneDrive files', category: 'Cloud Storage', emoji: '☁️', color: '#0078D4' },
  // Social & Marketing
  { id: 'twitter', name: 'X / Twitter', desc: 'Post tweets, read timeline, search', category: 'Social', emoji: '🐦', color: '#000000' },
  { id: 'linkedin', name: 'LinkedIn', desc: 'Post updates and manage your profile', category: 'Social', emoji: '💼', color: '#0A66C2' },
  { id: 'instagram', name: 'Instagram', desc: 'Generate and publish posts and stories', category: 'Social', emoji: '📸', color: '#E1306C' },
  { id: 'youtube', name: 'YouTube', desc: 'Extract transcripts, manage channel data', category: 'Social', emoji: '▶️', color: '#FF0000' },
  // Business
  { id: 'hubspot', name: 'HubSpot', desc: 'Manage CRM contacts and deals', category: 'Business', emoji: '🧡', color: '#FF7A59' },
  { id: 'salesforce', name: 'Salesforce', desc: 'Access CRM records and run reports', category: 'Business', emoji: '☁️', color: '#00A1E0' },
  { id: 'stripe', name: 'Stripe', desc: 'Monitor payments and manage subscriptions', category: 'Business', emoji: '💳', color: '#6772E5' },
  { id: 'shopify', name: 'Shopify', desc: 'Manage products, orders, and customers', category: 'Business', emoji: '🛍️', color: '#96BF48' },
];

// ── Connector icon helper (used by thought sequence) ─────────
export const getConnectorIcon = (toolName: string): React.ReactNode | null => {
  const map: Record<string, React.ReactNode> = {
    slack_controller: <SlackLogo />,
    github_connector: <GithubLogo />,
    gmail_connector: <GmailLogo />,
  };
  return map[toolName] || null;
};

// ── Main Modal ───────────────────────────────────────────────
interface ConnectorsModalProps {
  open: boolean;
  onClose: () => void;
  connectedApps: Record<string, boolean>;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

export const ConnectorsModal: React.FC<ConnectorsModalProps> = ({ open, onClose, connectedApps, onConnect, onDisconnect }) => {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const ref = useRef<HTMLDivElement>(null);

  const categories = ['All', ...Array.from(new Set(CONNECTORS.map(c => c.category)))];
  const filtered = CONNECTORS.filter(c => {
    const matchSearch = c.name.toLowerCase().includes(search.toLowerCase()) || c.desc.toLowerCase().includes(search.toLowerCase());
    const matchCat = activeCategory === 'All' || c.category === activeCategory;
    return matchSearch && matchCat;
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 left-0 top-0 w-screen h-screen z-[9999] flex items-center justify-center overflow-hidden"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)' }}
        >
          <motion.div
            ref={ref}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            className="relative w-[780px] max-w-[95vw] h-[640px] max-h-[85vh] flex flex-col rounded-2xl overflow-hidden"
            style={{ background: '#141414', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 40px 100px rgba(0,0,0,1)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-7 pt-6 pb-4 border-b border-white/[0.07] shrink-0">
              <div>
                <h2 className="text-white text-[20px] font-semibold tracking-tight">Connectors</h2>
                <p className="text-[#6B6966] text-[13px] mt-0.5">{Object.values(connectedApps).filter(Boolean).length} connected · {CONNECTORS.length} available</p>
              </div>
              <div className="flex items-center gap-3">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search connectors..."
                    className="pl-9 pr-4 py-2 rounded-xl text-[13px] text-white placeholder-[#555] outline-none w-[200px]"
                    style={{ background: '#1E1E1E', border: '1px solid rgba(255,255,255,0.08)' }}
                  />
                </div>
                <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-[#555] hover:text-white hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Category tabs */}
            <div className="flex items-center gap-1 px-7 py-3 border-b border-white/[0.05] shrink-0 overflow-x-auto">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap transition-all ${activeCategory === cat ? 'bg-white/10 text-white' : 'text-[#666] hover:text-[#999] hover:bg-white/5'}`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-6 grid grid-cols-2 gap-3 content-start custom-scrollbar">
              {filtered.map(connector => {
                const isConnected = !!connectedApps[connector.id];
                return (
                  <motion.div
                    key={connector.id}
                    className="relative flex items-center gap-4 p-4 rounded-xl cursor-pointer group transition-colors"
                    style={{ background: '#1A1A1A', border: `1px solid ${isConnected ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.06)'}` }}
                    whileHover={{ scale: 1.01 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* Logo */}
                    <div
                      className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-2xl"
                      style={{ background: connector.color + '22', border: `1px solid ${connector.color}33` }}
                    >
                      {connector.logo || <span>{connector.emoji}</span>}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-white truncate">{connector.name}</span>
                        {connector.functional && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide" style={{ background: '#34D39922', color: '#34D399', border: '1px solid #34D39933' }}>LIVE</span>}
                      </div>
                      <p className="text-[12px] text-[#555] mt-0.5 truncate">{connector.desc}</p>
                    </div>

                    {/* Action */}
                    {isConnected ? (
                      <button
                        onClick={() => onDisconnect(connector.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all text-emerald-400 hover:text-red-400 hover:bg-red-400/10"
                        style={{ border: '1px solid rgba(52,211,153,0.3)' }}
                      >
                        <Check className="w-3 h-3" />
                        <span className="group-hover:hidden">Connected</span>
                        <span className="hidden group-hover:inline">Disconnect</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => onConnect(connector.id)}
                        className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${connector.functional ? 'text-white hover:bg-white/10' : 'text-[#555] cursor-not-allowed'}`}
                        style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                        disabled={!connector.functional}
                        title={!connector.functional ? 'Coming soon' : 'Connect'}
                      >
                        {connector.functional ? 'Connect' : 'Soon'}
                      </button>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

export const ConnectorsButton: React.FC<{ connectedCount: number; onToggleAction: () => void }> = ({ connectedCount, onToggleAction }) => (
  <Tooltip text="Connectors" side="top">
    <button
      onClick={onToggleAction}
      className="w-[38px] h-[38px] flex items-center justify-center rounded-full border border-white/[0.14] bg-[#202020] text-[#F4F4F4] shadow-[inset_0_1px_0_rgba(255,255,255,0.065),0_4px_12px_rgba(0,0,0,0.18)] transition-all duration-200 ease-out active:scale-95 active:bg-[#303030] hover:text-white hover:bg-[#292929] hover:border-white/[0.24] group relative overflow-hidden"
    >
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.10] to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      <Puzzle className="w-[18px] h-[18px] transition-all duration-300 ease-out group-hover:scale-[1.15]" strokeWidth={2.2} />
    </button>
  </Tooltip>
);
