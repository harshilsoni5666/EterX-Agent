'use client';
import React, { useDeferredValue, useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, Check, ChevronRight } from 'lucide-react';

// Connector registry logos are local app SVGs in public/icons/connectors.
const connectorLogo = (id: string, label: string) => (
  <img
    src={`/icons/connectors/${id}.svg`}
    alt={`${label} logo`}
    className="eterx-connectors-logo-img h-6 w-6 object-contain"
    draggable={false}
  />
);

// ── Connector data ───────────────────────────────────────────
export const CONNECTORS = [
  // Communication
  { id: 'slack', name: 'Slack', desc: 'Send messages, read channels, search workspace', category: 'Communication', logo: connectorLogo('slack', 'Slack'), color: '#4A154B', functional: true },
  { id: 'discord', name: 'Discord', desc: 'Manage servers, send messages, read channels', category: 'Communication', logo: connectorLogo('discord', 'Discord'), color: '#5865F2' },
  { id: 'telegram', name: 'Telegram', desc: 'Send & receive messages, manage bots', category: 'Communication', logo: connectorLogo('telegram', 'Telegram'), color: '#2AABEE' },
  { id: 'whatsapp', name: 'WhatsApp', desc: 'Send messages and manage conversations', category: 'Communication', logo: connectorLogo('whatsapp', 'WhatsApp'), color: '#25D366' },
  { id: 'teams', name: 'Microsoft Teams', desc: 'Chat, meet, and collaborate in Teams', category: 'Communication', logo: connectorLogo('teams', 'Microsoft Teams'), color: '#6264A7' },
  { id: 'zoom', name: 'Zoom', desc: 'Schedule and manage Zoom meetings', category: 'Communication', logo: connectorLogo('zoom', 'Zoom'), color: '#2D8CFF' },
  // Email & Calendar
  { id: 'gmail', name: 'Gmail', desc: 'Read, draft, search, and send emails', category: 'Email & Calendar', logo: connectorLogo('gmail', 'Gmail'), color: '#EA4335' },
  { id: 'outlook_mail', name: 'Outlook Mail', desc: 'Manage Outlook inbox and send emails', category: 'Email & Calendar', logo: connectorLogo('outlook_mail', 'Outlook Mail'), color: '#0078D4' },
  { id: 'google_calendar', name: 'Google Calendar', desc: 'Create and manage events and schedules', category: 'Email & Calendar', logo: connectorLogo('google_calendar', 'Google Calendar'), color: '#4285F4' },
  { id: 'outlook_calendar', name: 'Outlook Calendar', desc: 'View and manage Outlook calendar events', category: 'Email & Calendar', logo: connectorLogo('outlook_calendar', 'Outlook Calendar'), color: '#0078D4' },
  // Dev Tools
  { id: 'github', name: 'GitHub', desc: 'Repos, PRs, issues, and code reviews', category: 'Dev Tools', logo: connectorLogo('github', 'GitHub'), color: '#24292E' },
  { id: 'gitlab', name: 'GitLab', desc: 'Manage repos, pipelines, and merge requests', category: 'Dev Tools', logo: connectorLogo('gitlab', 'GitLab'), color: '#FC6D26' },
  { id: 'jira', name: 'Jira', desc: 'Create and track issues, manage sprints', category: 'Dev Tools', logo: connectorLogo('jira', 'Jira'), color: '#0052CC' },
  { id: 'linear', name: 'Linear', desc: 'Manage issues and track engineering work', category: 'Dev Tools', logo: connectorLogo('linear', 'Linear'), color: '#5E6AD2' },
  { id: 'figma', name: 'Figma', desc: 'Access designs, comments, and prototypes', category: 'Dev Tools', logo: connectorLogo('figma', 'Figma'), color: '#F24E1E' },
  // Productivity
  { id: 'notion', name: 'Notion', desc: 'Read and write pages, databases, and notes', category: 'Productivity', logo: connectorLogo('notion', 'Notion'), color: '#000000' },
  { id: 'trello', name: 'Trello', desc: 'Manage boards, cards, and lists', category: 'Productivity', logo: connectorLogo('trello', 'Trello'), color: '#0052CC' },
  { id: 'asana', name: 'Asana', desc: 'Create and manage tasks and projects', category: 'Productivity', logo: connectorLogo('asana', 'Asana'), color: '#F06A6A' },
  { id: 'clickup', name: 'ClickUp', desc: 'Manage tasks, docs, and workflows', category: 'Productivity', logo: connectorLogo('clickup', 'ClickUp'), color: '#7B68EE' },
  { id: 'monday', name: 'Monday.com', desc: 'Manage boards and track project progress', category: 'Productivity', logo: connectorLogo('monday', 'Monday.com'), color: '#FF3D57' },
  { id: 'airtable', name: 'Airtable', desc: 'Read and write to Airtable bases and tables', category: 'Productivity', logo: connectorLogo('airtable', 'Airtable'), color: '#FCB400' },
  // Cloud Storage
  { id: 'google_drive', name: 'Google Drive', desc: 'Access, create, and share Drive files', category: 'Cloud Storage', logo: connectorLogo('google_drive', 'Google Drive'), color: '#4285F4' },
  { id: 'dropbox', name: 'Dropbox', desc: 'Upload, download, and share files', category: 'Cloud Storage', logo: connectorLogo('dropbox', 'Dropbox'), color: '#0061FF' },
  { id: 'onedrive', name: 'OneDrive', desc: 'Manage and share OneDrive files', category: 'Cloud Storage', logo: connectorLogo('onedrive', 'OneDrive'), color: '#0078D4' },
  // Social & Marketing
  { id: 'twitter', name: 'X / Twitter', desc: 'Post tweets, read timeline, search', category: 'Social', logo: connectorLogo('twitter', 'X'), color: '#000000' },
  { id: 'linkedin', name: 'LinkedIn', desc: 'Post updates and manage your profile', category: 'Social', logo: connectorLogo('linkedin', 'LinkedIn'), color: '#0A66C2' },
  { id: 'instagram', name: 'Instagram', desc: 'Generate and publish posts and stories', category: 'Social', logo: connectorLogo('instagram', 'Instagram'), color: '#E1306C' },
  { id: 'youtube', name: 'YouTube', desc: 'Extract transcripts, manage channel data', category: 'Social', logo: connectorLogo('youtube', 'YouTube'), color: '#FF0000' },
  // Business
  { id: 'hubspot', name: 'HubSpot', desc: 'Manage CRM contacts and deals', category: 'Business', logo: connectorLogo('hubspot', 'HubSpot'), color: '#FF7A59' },
  { id: 'salesforce', name: 'Salesforce', desc: 'Access CRM records and run reports', category: 'Business', logo: connectorLogo('salesforce', 'Salesforce'), color: '#00A1E0' },
  { id: 'stripe', name: 'Stripe', desc: 'Monitor payments and manage subscriptions', category: 'Business', logo: connectorLogo('stripe', 'Stripe'), color: '#6772E5' },
  { id: 'shopify', name: 'Shopify', desc: 'Manage products, orders, and customers', category: 'Business', logo: connectorLogo('shopify', 'Shopify'), color: '#96BF48' },
];

// ── Connector icon helper (used by thought sequence) ─────────
export const getConnectorIcon = (toolName: string): React.ReactNode | null => {
  const map: Record<string, React.ReactNode> = {
    github_connector: connectorLogo('github', 'GitHub'),
    gmail_connector: connectorLogo('gmail', 'Gmail'),
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
  const deferredSearch = useDeferredValue(search);

  const categories = useMemo(() => ['All', ...Array.from(new Set(CONNECTORS.map(c => c.category)))], []);
  const filtered = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return CONNECTORS.filter(c => {
      const matchSearch = !query || c.name.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query);
      const matchCat = activeCategory === 'All' || c.category === activeCategory;
      return matchSearch && matchCat;
    });
  }, [activeCategory, deferredSearch]);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  const [mounted, setMounted] = useState(false);
  const [setupConnector, setSetupConnector] = useState<typeof CONNECTORS[number] | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [healthPath, setHealthPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [setupError, setSetupError] = useState('');
  useEffect(() => setMounted(true), []);

  const openSetup = (connector: typeof CONNECTORS[number]) => {
    if (connector.id === 'slack') {
      onConnect(connector.id);
      return;
    }
    setSetupConnector(connector);
    setBaseUrl('');
    setToken('');
    setHealthPath('');
    setSetupError('');
  };

  const saveSetup = async () => {
    if (!setupConnector) return;
    setSaving(true);
    setSetupError('');
    try {
      const response = await fetch('/api/connectors/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: setupConnector.id, baseUrl, token, healthPath }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Connection verification failed.');
      onConnect(setupConnector.id);
      setSetupConnector(null);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="eterx-connectors-overlay fixed inset-0 left-0 top-0 w-screen h-screen z-[9999] flex items-center justify-center overflow-hidden"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)' }}
        >
          <motion.div
            ref={ref}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            className="eterx-connectors-panel relative w-[780px] max-w-[95vw] h-[640px] max-h-[85vh] flex flex-col rounded-2xl overflow-hidden"
            style={{ background: '#141414', border: '1px solid rgba(255,255,255,0.1)', boxShadow: 'none' }}
          >
            {/* Header */}
            <div className="eterx-connectors-header flex items-center justify-between px-7 pt-6 pb-4 border-b border-white/[0.07] shrink-0">
              <div>
                <h2 className="eterx-connectors-title text-white text-[20px] font-semibold tracking-tight">Connectors</h2>
                <p className="text-[#6B6966] text-[13px] mt-0.5">{Object.values(connectedApps).filter(Boolean).length} connected · {CONNECTORS.length} available</p>
              </div>
              <div className="flex items-center gap-3">
                {/* Search */}
                <div className="eterx-connectors-search relative">
                  <Search className="eterx-connectors-search-icon absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search connectors..."
                    className="eterx-connectors-search-input pl-9 pr-4 py-2 rounded-xl text-[13px] text-white placeholder-[#555] outline-hidden w-[200px]"
                    style={{ background: '#1E1E1E', border: '1px solid rgba(255,255,255,0.08)' }}
                  />
                </div>
                <button onClick={onClose} className="eterx-connectors-close w-8 h-8 rounded-lg flex items-center justify-center text-[#555] hover:text-white hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Category tabs */}
            <div className="eterx-connectors-tabs eterx-scrollbar flex items-center gap-1 px-7 py-3 border-b border-white/[0.05] shrink-0 overflow-x-auto">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  data-active={activeCategory === cat ? 'true' : undefined}
                  className={`eterx-connectors-tab px-3 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap transition-all ${activeCategory === cat ? 'bg-white/10 text-white' : 'text-[#666] hover:text-[#999] hover:bg-white/5'}`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Grid */}
            <div className="eterx-connectors-grid flex-1 overflow-y-auto p-6 grid grid-cols-2 gap-3 content-start eterx-scrollbar">
              {filtered.map(connector => {
                const isConnected = !!connectedApps[connector.id];
                return (
                  <motion.div
                    key={connector.id}
                    data-connected={isConnected ? 'true' : undefined}
                    data-functional={connector.functional ? 'true' : undefined}
                    className="eterx-connectors-card relative flex items-center gap-4 p-4 rounded-xl cursor-pointer group transition-colors"
                    style={{ background: '#1A1A1A', border: `1px solid ${isConnected ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.06)'}` }}
                    whileHover={{ scale: 1.01 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* Logo */}
                    <div
                      className="eterx-connectors-logo w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-2xl"
                      style={{ background: '#FFFFFF', border: `1px solid ${connector.color}33` }}
                    >
                      {connector.logo}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="eterx-connectors-name text-[14px] font-medium text-white truncate">{connector.name}</span>
                        {connector.id === 'slack' && <span className="eterx-connectors-live px-1.5 py-0.5 rounded-sm text-[9px] font-bold tracking-wide" style={{ background: '#34D39922', color: '#34D399', border: '1px solid #34D39933' }}>OAUTH</span>}
                      </div>
                      <p className="eterx-connectors-desc text-[12px] text-[#555] mt-0.5 truncate">{connector.desc}</p>
                    </div>

                    {/* Action */}
                    {isConnected ? (
                      <button
                        onClick={() => onDisconnect(connector.id)}
                        className="eterx-connectors-action eterx-connectors-action-connected flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all text-emerald-400 hover:text-red-400 hover:bg-red-400/10"
                        style={{ border: '1px solid rgba(52,211,153,0.3)' }}
                      >
                        <Check className="w-3 h-3" />
                        <span className="group-hover:hidden">Connected</span>
                        <span className="hidden group-hover:inline">Disconnect</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => openSetup(connector)}
                        className="eterx-connectors-action px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all text-white hover:bg-white/10"
                        style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                        title="Connect and verify"
                      >
                        Connect
                      </button>
                    )}
                  </motion.div>
                );
              })}
            </div>
            <AnimatePresence>
              {setupConnector && (
                <motion.div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <motion.div className="w-full max-w-[460px] rounded-2xl border border-white/10 bg-[#1b1b1b] p-6 shadow-none" initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }}>
                    <div className="flex items-start justify-between gap-4">
                      <div><h3 className="text-[18px] font-semibold text-white">Connect {setupConnector.name}</h3><p className="mt-1 text-[12px] leading-5 text-[#888]">Enter the API origin and credential. EterX verifies the connection before the agent can use it.</p></div>
                      <button type="button" onClick={() => setSetupConnector(null)} className="rounded-lg p-1 text-[#777] hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
                    </div>
                    <label className="mt-5 block text-[12px] font-medium text-[#bbb]">API base URL<span className="ml-1 text-[#777]">(optional when EterX has a default)</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-[13px] text-white outline-hidden focus:border-[#5aaeff]" /></label>
                    <label className="mt-3 block text-[12px] font-medium text-[#bbb]">API key / access token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Stored encrypted on this device" className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-[13px] text-white outline-hidden focus:border-[#5aaeff]" /></label>
                    <label className="mt-3 block text-[12px] font-medium text-[#bbb]">Health-check path<span className="ml-1 text-[#777]">(optional)</span><input value={healthPath} onChange={(event) => setHealthPath(event.target.value)} placeholder="/user or /v1/me" className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-[13px] text-white outline-hidden focus:border-[#5aaeff]" /></label>
                    {setupError && <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[12px] leading-5 text-red-200">{setupError}</div>}
                    <div className="mt-5 flex items-center justify-end gap-2"><button type="button" onClick={() => setSetupConnector(null)} className="rounded-lg border border-white/10 px-3 py-2 text-[12px] text-[#aaa]">Cancel</button><button type="button" disabled={saving} onClick={() => void saveSetup()} className="rounded-lg bg-white px-3.5 py-2 text-[12px] font-semibold text-black disabled:opacity-50">{saving ? 'Verifying…' : 'Verify and connect'}</button></div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

export default ConnectorsModal;
// End of connector modal module.
