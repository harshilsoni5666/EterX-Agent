import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, ArrowUp } from 'lucide-react';
import { PremiumEdit, PremiumSettings } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';

interface Agent {
  id: string;
  name: string;
  description: string;
  accessType: 'Full Access' | 'Selected Access' | 'Agent Decides';
  isSetup?: boolean;
  toolCount?: number;
  builderMessages?: {role: 'user' | 'assistant', content: string}[];
}

export const AgentsView = ({
  onOpenBuilder,
  onUseAgent,
  selectedAgentId,
}: {
  onOpenBuilder: (id: string) => void;
  onUseAgent?: (id: string | null, name: string) => void;
  selectedAgentId?: string | null;
}) => {
  const [agents, setAgents] = useState<Agent[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('eterx_agents');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          console.error('Failed to parse saved agents', e);
        }
      }
    }
    return [{
      id: 'default-1',
      name: 'Default Chat Agent',
      description: '',
      accessType: 'Full Access',
      isSetup: true
    }];
  });

  useEffect(() => {
    localStorage.setItem('eterx_agents', JSON.stringify(agents));
    try {
      window.dispatchEvent(new CustomEvent('eterx_agents_updated'));
    } catch { }
  }, [agents]);

  useEffect(() => {
    let cancelled = false;

    const syncServerAgents = async () => {
      try {
        const res = await fetch('/api/agents/list', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const serverAgents = Array.isArray(data.agents)
          ? data.agents
          : [];
        if (cancelled) return;

        setAgents(prev => {
          const serverIds = new Set<string>();
          const byId = new Map(
            prev
              .filter(agent => agent.id === 'default-1' || agent.isSetup !== true || !agent.id.startsWith('eterxagent-'))
              .map(agent => [agent.id, agent])
          );

          for (const serverAgent of serverAgents) {
            const id = String(serverAgent.agentId || '').trim();
            if (!id) continue;
            serverIds.add(id);
            const existing = byId.get(id);
            byId.set(id, {
              id,
              name: serverAgent.name || existing?.name || id,
              description: serverAgent.mission || existing?.description || 'Ready custom agent.',
              accessType: existing?.accessType || 'Agent Decides',
              isSetup: serverAgent.status === 'ready',
              toolCount: serverAgent.toolCount,
              builderMessages: existing?.builderMessages || [],
            });
          }

          for (const agent of prev) {
            if (agent.id === 'default-1') continue;
            if (!agent.id.startsWith('eterxagent-')) continue;
            if (agent.isSetup === false && !serverIds.has(agent.id)) byId.set(agent.id, agent);
          }

          return Array.from(byId.values());
        });
      } catch {
        // Local agents still render if the server list is unavailable.
      }
    };

    syncServerAgents();
    window.addEventListener('focus', syncServerAgents);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', syncServerAgents);
    };
  }, []);
  
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // Modal state
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [generatedId, setGeneratedId] = useState("");

  // Settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState<Agent | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState('');

  const handleDeleteAgent = async (id: string) => {
    if (id === 'default-1' || deletingAgentId) return;
    setDeletingAgentId(id);
    setSettingsError('');

    try {
      const res = await fetch(`/api/agents/list?agentId=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success === false) {
        throw new Error(payload?.error || `Delete failed (${res.status})`);
      }

      setAgents(prev => prev.filter(a => a.id !== id));
      if (selectedAgentId === id) onUseAgent?.(null, 'General');
      try {
        window.dispatchEvent(new CustomEvent('eterx_agents_updated', { detail: { deletedAgentId: id } }));
      } catch { }
      setIsSettingsOpen(false);
      setSettingsAgent(null);
    } catch (error: any) {
      setSettingsError(error?.message || 'Could not delete this agent.');
    } finally {
      setDeletingAgentId(null);
    }
  };

  const handleCloseModal = () => {
    setIsCreating(false);
    
    // Reset modal state after animation completes
    setTimeout(() => {
      setNewAgentName("");
      setGeneratedId("");
    }, 300);
  };

  const getOrCreateBuilderId = () => {
    if (generatedId) return generatedId;
    const random4 = Math.floor(1000 + Math.random() * 9000);
    const shortName = newAgentName.substring(0, 4).toLowerCase().replace(/[^a-z0-9]/g, 'a').padEnd(4, 'x');
    const newId = `eterxagent-${random4}-${shortName}`;
    setGeneratedId(newId);
    return newId;
  };

  const handleStartBuilder = () => {
    if (!newAgentName.trim()) return;
    const builderId = getOrCreateBuilderId();
    handleCloseModal();
    setTimeout(() => onOpenBuilder(builderId), 300);
  };

  return (
    <div className="eterx-agents-view flex-1 w-full h-full flex flex-col px-5 py-5 md:px-8 md:pt-6 md:pb-6 overflow-hidden relative z-20 bg-transparent">
      
      {/* Agents container stretching to the very top */}
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="eterx-agents-library-panel flex-1 bg-[#0A0A0A]/70 backdrop-blur-sm border border-white/[0.04] rounded-[18px] p-4 md:p-5 w-full shadow-[inset_0_1px_1px_rgba(255,255,255,0.02)] flex flex-col gap-3 overflow-hidden relative"
        >
          {/* Header internal row matching style and spacing of ProjectsView */}
          <div className="w-full flex items-center justify-between shrink-0 pl-1 pr-1 pb-1.5 border-b border-white/[0.03]">
            <span className="text-[13px] font-semibold text-[#A3A19E] tracking-normal">Library</span>
            <button 
              onClick={() => setIsCreating(true)}
              className="eterx-agents-primary-button flex h-7 shrink-0 items-center gap-1.5 px-3 bg-white text-black font-semibold text-[11px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95 group cursor-pointer"
            >
              <Plus className="w-3 h-3 text-black" strokeWidth={2.8} />
              New agent
            </button>
          </div>

          {/* Scrollable list grid */}
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-0.5 flex flex-col gap-2">
            {agents.map((agent) => {
              const isDefaultAgent = agent.id === 'default-1';
              const isReady = isDefaultAgent || agent.isSetup !== false;
              const useLabel = isDefaultAgent ? 'Use General' : 'Use in chat';

              return (
                <div 
                  key={agent.id} 
                  onClick={() => onOpenBuilder(agent.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button,input,textarea')) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenBuilder(agent.id);
                    }
                  }}
                  className="eterx-agent-card group relative bg-[#111111] border border-white/[0.06] rounded-[14px] p-3 hover:border-white/[0.12] hover:bg-[#151515] transition-all duration-200 cursor-pointer overflow-hidden flex items-stretch justify-between shrink-0 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                >
                  <div className="absolute inset-0 bg-white/[0.02] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                  
                  <div className="relative z-10 flex w-full min-w-0 flex-col gap-3 px-1 sm:flex-row sm:items-center">
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 items-center gap-2 mb-0.5">
                        {editingAgentId === agent.id ? (
                          <input 
                            autoFocus
                            value={editingName}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                setAgents(agents.map(a => a.id === agent.id ? { ...a, name: editingName || a.name } : a));
                                setEditingAgentId(null);
                              }
                            }}
                            className="text-[14px] md:text-[15px] font-semibold text-white bg-white/5 border border-white/10 rounded-md px-2 py-0.5 outline-none focus:border-white/30 w-full max-w-[250px]"
                          />
                        ) : (
                          <>
                            <h3 className="min-w-0 text-[14px] md:text-[15px] font-semibold text-[#E8E6E3] group-hover:text-white transition-colors truncate">{agent.name}</h3>
                            <Tooltip text="Edit agent name" side="top">
                              <button
                                type="button"
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  setEditingName(agent.name);
                                  setEditingAgentId(agent.id); 
                                }}
                                className="text-[#555350] hover:text-[#E8E6E3] p-1 rounded-md transition-colors hover:bg-white/5 opacity-0 group-hover:opacity-100 focus:opacity-100"
                              >
                                <PremiumEdit className="w-3.5 h-3.5" />
                              </button>
                            </Tooltip>
                            
                            <div className={`ml-2 flex items-center px-2 py-0.5 rounded-[6px] border ${
                              isReady
                                ? 'bg-white/[0.055] border-white/[0.12]'
                                : 'bg-white/[0.025] border-white/[0.08]'
                            }`}>
                              <span className={`text-[11px] font-medium ${isReady ? 'text-white/78' : 'text-white/50'}`}>
                                {isReady ? 'Ready' : 'Setup needed'}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 flex-1 text-[12px] md:text-[13px] text-[#8C8A88] truncate max-w-[400px]">
                          {agent.description}
                        </p>
                        <div className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] bg-white/[0.03] border border-white/[0.05]">
                          <span className="text-[10px] text-[#A3A19E] font-medium tracking-normal">{agent.accessType}</span>
                        </div>
                        {typeof agent.toolCount === 'number' && (
                          <div className="hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] bg-white/[0.025] border border-white/[0.06]">
                            <span className="text-[10px] text-white/45 font-medium tracking-normal">{agent.toolCount} tools</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!isReady) {
                            onOpenBuilder(agent.id);
                            return;
                          }
                          onUseAgent?.(isDefaultAgent ? null : agent.id, isDefaultAgent ? 'General' : agent.name);
                        }}
                        className={`eterx-agent-use-button flex items-center whitespace-nowrap px-3.5 py-1.5 font-semibold text-[12px] rounded-full border transition-all duration-200 active:scale-95 ${
                          isReady
                            ? 'bg-white/[0.065] text-white border-white/[0.12] hover:bg-white/[0.10]'
                            : 'bg-white/[0.025] text-white/58 border-white/[0.08] hover:bg-white/[0.05]'
                        }`}
                      >
                        {isReady ? useLabel : 'Setup'}
                      </button>
                      <button 
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenBuilder(agent.id); }}
                        className="eterx-agent-open-button whitespace-nowrap px-3.5 py-1.5 bg-white text-black font-semibold text-[12px] rounded-full hover:bg-[#E8E6E3] transition-all duration-200 active:scale-95"
                      >
                        {agent.isSetup === false ? 'Setup' : 'Open'}
                      </button>

                      <div className="hidden w-[1px] h-5 bg-white/[0.08] mx-1 sm:block"></div>
                      <Tooltip text="Agent Settings" side="top">
                        <button 
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSettingsAgent(agent);
                            setSettingsError('');
                            setIsSettingsOpen(true);
                          }}
                          className="eterx-agent-icon-button text-[#555350] hover:text-white transition-colors p-2 rounded-xl hover:bg-white/10 active:scale-95 group/btn"
                        >
                          <PremiumSettings className="w-[18px] h-[18px] group-hover/btn:rotate-90 transition-transform duration-500" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      </div>

      {/* Create New Agent Modal overlay */}
      <AnimatePresence>
        {isCreating && (
          <motion.div 
            key="create-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-6"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="bg-[#0A0A0A] border border-white/10 rounded-[28px] p-6 w-full max-w-[500px] shadow-2xl flex flex-col gap-6 max-h-[90vh]"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-white tracking-tight">Agent Builder</h2>
                <button 
                  onClick={handleCloseModal}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5 text-[#555350] hover:text-white transition-all cursor-pointer"
                >
                  &times;
                </button>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-[13px] font-semibold text-[#8C8A88] tracking-normal">Agent Name</label>
                  <input 
                    type="text" 
                    placeholder="e.g. Code Reviewer, Content Creator"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    className="w-full bg-[#111111] border border-white/10 rounded-xl px-4 py-3 text-[14px] text-white outline-none focus:border-white/20 transition-all font-sans placeholder:text-[#555350]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/5">
                <button 
                  onClick={handleCloseModal}
                  className="px-6 py-2.5 bg-white/5 text-[#E8E6E3] font-semibold text-[13px] rounded-full hover:bg-white/10 transition-all duration-300 active:scale-95"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleStartBuilder}
                  disabled={!newAgentName.trim()}
                  className="px-6 py-2.5 bg-white text-black font-semibold text-[13px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95 disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  Start Building
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings modal */}
      <AnimatePresence>
        {isSettingsOpen && settingsAgent && (
          <motion.div 
            key="settings-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-6"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="bg-[#0A0A0A] border border-white/10 rounded-[28px] p-6 w-full max-w-[500px] shadow-2xl flex flex-col gap-6 max-h-[90vh]"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-white tracking-tight">Agent Settings</h2>
                <button 
                  onClick={() => { setSettingsError(''); setIsSettingsOpen(false); }}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/5 text-[#555350] hover:text-white transition-all cursor-pointer"
                >
                  &times;
                </button>
              </div>

              <div className="flex flex-col gap-4 overflow-y-auto custom-scrollbar pr-1 max-h-[50vh]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white font-bold text-lg">
                    {settingsAgent.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[15px] font-semibold text-white truncate">{settingsAgent.name}</span>
                    <span className="text-[11px] text-[#8C8A88] font-mono truncate">{settingsAgent.id}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 rounded-xl bg-white/[0.02] border border-white/5 p-4">
                  <h4 className="text-[14px] font-medium text-[#E8E6E3] mb-2">Configuration</h4>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-[#8C8A88]">Access Type</span>
                    <span className="text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">{settingsAgent.accessType}</span>
                  </div>
                </div>

                <div className="w-full h-[1px] bg-white/5 my-2"></div>

                <div className="flex flex-col gap-2">
                  <h4 className="text-[14px] font-medium text-[#ef4444] mb-1">Danger Zone</h4>
                  <p className="text-[12px] text-[#8C8A88] mb-3">Deleting this agent removes its saved profile, tools, prompt, and local entry. This action cannot be undone.</p>
                  {settingsError && (
                    <div className="rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 px-3 py-2 text-[12px] text-[#ffb4b4]">
                      {settingsError}
                    </div>
                  )}
                  
                  <button 
                    onClick={() => handleDeleteAgent(settingsAgent.id)}
                    disabled={settingsAgent.id === 'default-1' || deletingAgentId === settingsAgent.id}
                    className="w-full py-3 bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#ef4444] font-semibold text-[13px] rounded-xl hover:bg-[#ef4444]/20 transition-all duration-300 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {deletingAgentId === settingsAgent.id ? 'Deleting...' : 'Delete agent permanently'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end pt-4 border-t border-white/5">
                <button 
                  onClick={() => { setSettingsError(''); setIsSettingsOpen(false); }}
                  className="px-6 py-2 bg-white/5 text-white font-semibold text-[13px] rounded-full hover:bg-white/10 transition-all duration-300 active:scale-95"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};
