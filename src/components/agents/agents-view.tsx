import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Loader2, ShieldCheck, Settings2, UserCog, ArrowLeft, ArrowUp } from 'lucide-react';
import { PremiumEdit, PremiumSettings, PremiumActivity } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';
import { ProfessionalThought } from '../chat/thought-sequence';

interface Agent {
  id: string;
  name: string;
  description: string;
  accessType: 'Full Access' | 'Selected Access' | 'Agent Decides';
  isSetup?: boolean;
  builderMessages?: {role: 'user' | 'assistant', content: string}[];
}

export const AgentsView = ({ onOpenBuilder }: { onOpenBuilder: (id: string) => void }) => {
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
  }, [agents]);
  
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // Modal state
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentAccess, setNewAgentAccess] = useState<'Full Access' | 'Selected Access' | 'Agent Decides'>('Full Access');
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [generatedId, setGeneratedId] = useState("");
  const [generatedCode, setGeneratedCode] = useState("");

  // Settings modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState<Agent | null>(null);

  const handleDeleteAgent = (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id));
    setIsSettingsOpen(false);
  };

  const handleSave = () => {
    if (!newAgentName.trim()) return;
    setIsSaving(true);
    
    // Simulate real-time generation and saving
    setTimeout(() => {
      const random4 = Math.floor(1000 + Math.random() * 9000);
      const shortName = newAgentName.substring(0, 4).toLowerCase().replace(/[^a-z0-9]/g, 'a').padEnd(4, 'x');
      const newId = `eterxagent-${random4}-${shortName}`;
      
      const codeSnippet = `const agentConfig = {\n  id: "${newId}",\n  name: "${newAgentName}",\n  accessType: "${newAgentAccess}",\n  status: "active"\n};\n\nawait EterX.deploy(agentConfig);`;
      
      setGeneratedId(newId);
      setGeneratedCode(codeSnippet);
      setIsSaving(false);
      setIsSaved(true);
    }, 2500);
  };

  const handleCloseModal = () => {
    if (isSaved) {
      setAgents(prev => [...prev, {
        id: generatedId,
        name: newAgentName,
        description: 'Custom autonomous agent variant.',
        accessType: newAgentAccess,
        isSetup: false,
        builderMessages: []
      }]);
    }
    setIsCreating(false);
    
    // Reset modal state after animation completes
    setTimeout(() => {
      setNewAgentName("");
      setNewAgentAccess('Full Access');
      setIsSaving(false);
      setIsSaved(false);
      setGeneratedId("");
      setGeneratedCode("");
    }, 300);
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col px-6 py-5 md:px-10 md:pt-6 md:pb-6 overflow-hidden relative z-20 bg-[#050505]">
      {/* Header Area */}
      <div className="flex items-center justify-between mb-5 shrink-0">
        <div className="flex flex-col">
          <motion.h1 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl md:text-[42px] font-semibold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white via-[#E8E6E3] to-[#8C8A88] pb-2"
          >
            Agent-Room
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-[#8C8A88] mt-2 text-[14px] max-w-md leading-relaxed"
          >
            Manage and deploy autonomous agents. Build custom variants tailored to specific workflows.
          </motion.p>
        </div>

        <motion.button 
          onClick={() => setIsCreating(true)}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="flex items-center gap-2.5 pl-2.5 pr-5 py-2 bg-white text-black font-semibold text-[13px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95 group"
        >
          <div className="w-7 h-7 rounded-full bg-black flex items-center justify-center shadow-sm">
            <Plus className="w-4 h-4 text-white group-hover:rotate-90 transition-transform duration-500" strokeWidth={2.5} />
          </div>
          Create new agent
        </motion.button>
      </div>

      {/* Agents container */}
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <motion.h2 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-[18px] md:text-[20px] font-semibold text-[#E8E6E3] tracking-wide shrink-0"
        >
          Your agents
        </motion.h2>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="flex-1 bg-[#0A0A0A] border border-white/[0.04] rounded-[28px] p-3 md:p-4 w-full shadow-[inset_0_1px_1px_rgba(255,255,255,0.02)] overflow-y-auto custom-scrollbar flex flex-col gap-2"
        >
          {agents.map((agent) => (
            <div 
              key={agent.id} 
              onClick={() => onOpenBuilder(agent.id)}
              className="group relative bg-gradient-to-r from-[#121212] to-[#0F0F0F] border border-white/[0.06] rounded-[20px] p-3 md:p-4 hover:border-white/[0.12] hover:from-[#161616] hover:to-[#121212] transition-all duration-300 cursor-pointer overflow-hidden flex items-center justify-between shrink-0 shadow-sm"
            >
              <div className="absolute inset-0 bg-white/[0.02] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
              
              <div className="flex items-center gap-4 relative z-10 w-full px-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    {editingAgentId === agent.id ? (
                      <input 
                        autoFocus
                        type="text" 
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => {
                          setAgents(agents.map(a => a.id === agent.id ? { ...a, name: editingName || a.name } : a));
                          setEditingAgentId(null);
                        }}
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
                        <h3 className="text-[14px] md:text-[15px] font-semibold text-[#E8E6E3] group-hover:text-white transition-colors truncate">{agent.name}</h3>
                        <Tooltip text="Edit agent name" side="top">
                          <button 
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
                        
                        {agent.isSetup === false && (
                          <div className="ml-2 flex items-center px-2 py-0.5 rounded-[6px] bg-[#f59e0b]/10 border border-[#f59e0b]/20">
                            <span className="text-[11px] text-[#fbbf24] font-medium">Setup builder required!</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <p className="text-[12px] md:text-[13px] text-[#8C8A88] truncate max-w-[400px]">
                      {agent.description}
                    </p>
                    <div className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] bg-white/[0.03] border border-white/[0.05]">
                      <span className="text-[10px] text-[#A3A19E] font-medium uppercase tracking-wider">{agent.accessType}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button 
                    onClick={(e) => { e.stopPropagation(); onOpenBuilder(agent.id); }}
                    className="px-4 py-1.5 bg-white text-black font-semibold text-[12px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95 mr-2"
                  >
                    {agent.isSetup === false ? 'Setup' : 'Open'}
                  </button>

                  <Tooltip text="View Statistics" side="top">
                    <button 
                      onClick={(e) => e.stopPropagation()}
                      className="text-[#555350] hover:text-[#34d399] transition-colors p-2 rounded-xl hover:bg-[#34d399]/10 active:scale-95 group/btn"
                    >
                      <PremiumActivity className="w-[18px] h-[18px] group-hover/btn:scale-110 transition-transform" />
                    </button>
                  </Tooltip>
                  <div className="w-[1px] h-5 bg-white/[0.08] mx-1"></div>
                  <Tooltip text="Agent Settings" side="top">
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setSettingsAgent(agent);
                        setIsSettingsOpen(true);
                      }}
                      className="text-[#555350] hover:text-white transition-colors p-2 rounded-xl hover:bg-white/10 active:scale-95 group/btn"
                    >
                      <PremiumSettings className="w-[18px] h-[18px] group-hover/btn:rotate-90 transition-transform duration-500" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          ))}
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
                {!isSaving && !isSaved && (
                  <button onClick={handleCloseModal} className="text-[#8C8A88] hover:text-white transition-colors">
                    <Plus className="w-5 h-5 rotate-45" />
                  </button>
                )}
              </div>

              <div className="flex flex-col gap-5 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] min-h-0 pb-2">
                {/* Name Input */}
                <div className="flex flex-col gap-2 shrink-0">
                  <label className="text-[13px] font-medium text-[#A3A19E]">Agent Name</label>
                  <input 
                    type="text"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    disabled={isSaving || isSaved}
                    placeholder="E.g. Financial Analyst Bot"
                    className="w-full bg-[#121212] border border-white/10 rounded-xl px-4 py-3 text-[14px] text-white placeholder-white/20 focus:outline-none focus:border-white/30 transition-colors disabled:opacity-50"
                  />
                </div>

                {/* Access Selection */}
                <div className="flex flex-col gap-3 shrink-0">
                  <label className="text-[13px] font-medium text-[#A3A19E]">Access & Permissions</label>
                  <div className="grid grid-cols-1 gap-2">
                    {[
                      { id: 'Full Access', icon: ShieldCheck, desc: 'Complete access to all workspace files and tools.' },
                      { id: 'Selected Access', icon: Settings2, desc: 'Restricted to explicitly selected scopes.' },
                      { id: 'Agent Decides', icon: UserCog, desc: 'Agent autonomously requests access as needed.' }
                    ].map(opt => (
                      <button 
                        key={opt.id}
                        disabled={isSaving || isSaved}
                        onClick={() => setNewAgentAccess(opt.id as any)}
                        className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${newAgentAccess === opt.id ? 'bg-white/[0.08] border-white/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]' : 'bg-transparent border-white/5 hover:bg-white/[0.02]'} disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        <opt.icon className={`w-5 h-5 mt-0.5 shrink-0 ${newAgentAccess === opt.id ? 'text-white' : 'text-[#8C8A88]'}`} />
                        <div className="flex flex-col">
                          <span className={`text-[14px] font-medium ${newAgentAccess === opt.id ? 'text-white' : 'text-[#E8E6E3]'}`}>{opt.id}</span>
                          <span className="text-[12px] text-[#8C8A88] mt-0.5">{opt.desc}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Real-time generated details block */}
                <AnimatePresence>
                  {isSaved && (
                    <motion.div 
                      key="saved-details"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="flex flex-col gap-3 overflow-hidden mt-2 shrink-0"
                    >
                      <div className="w-full h-[1px] bg-white/10 mb-2"></div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[12px] font-semibold uppercase tracking-wider text-[#34d399] flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-[#34d399] animate-pulse"></div>
                          Agent Initialized
                        </label>
                        <div className="bg-[#121212] border border-[#34d399]/20 rounded-xl p-3 flex flex-col gap-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[12px] text-[#8C8A88]">Generated ID</span>
                            <span className="text-[12px] font-mono text-[#E8E6E3] bg-white/5 px-2 py-0.5 rounded">{generatedId}</span>
                          </div>
                          <div className="w-full h-[1px] bg-white/5"></div>
                          <div className="text-[11px] font-mono text-[#A3A19E] whitespace-pre p-3 bg-[#0A0A0A] rounded-lg overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] border border-white/5">
                            {generatedCode}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Bottom Actions */}
              <div className="flex items-center justify-between pt-4 mt-auto shrink-0 border-t border-white/5">
                <button 
                  disabled={!isSaved}
                  onClick={() => {
                    handleCloseModal();
                    setTimeout(() => onOpenBuilder(generatedId), 300);
                  }}
                  className="px-6 py-2.5 bg-white text-black font-semibold text-[13px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95 disabled:opacity-30 disabled:hover:bg-white disabled:active:scale-100"
                >
                  Go to Agent builder
                </button>
                
                {isSaved ? (
                  <button 
                    onClick={handleCloseModal}
                    className="px-6 py-2.5 bg-white text-black font-semibold text-[13px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95"
                  >
                    Close
                  </button>
                ) : (
                  <motion.button 
                    layout
                    onClick={handleSave}
                    disabled={!newAgentName.trim() || isSaving}
                    className={`relative flex items-center justify-center px-6 py-2.5 font-semibold text-[13px] rounded-full transition-all duration-300 overflow-hidden min-w-[100px] ${
                      isSaving 
                        ? 'bg-[#121212] text-white border border-white/20 cursor-wait' 
                        : 'bg-white text-black hover:bg-[#E8E6E3] active:scale-95 disabled:opacity-50 disabled:hover:bg-white disabled:active:scale-100'
                    }`}
                  >
                    <AnimatePresence mode="wait">
                      {isSaving ? (
                        <motion.div 
                          key="saving"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.2 }}
                          className="flex items-center gap-2"
                        >
                          <span>Saving</span>
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
                        </motion.div>
                      ) : (
                        <motion.span 
                          key="save"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.2 }}
                        >
                          Save
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agent Settings Modal */}
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
              className="bg-[#0A0A0A] border border-white/10 rounded-[28px] p-6 w-full max-w-[450px] shadow-2xl flex flex-col gap-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <h2 className="text-xl font-semibold text-white tracking-tight">Agent Settings</h2>
                  <p className="text-[13px] text-[#8C8A88] mt-1">{settingsAgent.name}</p>
                </div>
                <button onClick={() => setIsSettingsOpen(false)} className="text-[#8C8A88] hover:text-white transition-colors">
                  <Plus className="w-5 h-5 rotate-45" />
                </button>
              </div>

              <div className="flex flex-col gap-4">
                <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/5">
                  <h4 className="text-[14px] font-medium text-[#E8E6E3] mb-2">Configuration</h4>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-[#8C8A88]">Access Type</span>
                    <span className="text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">{settingsAgent.accessType}</span>
                  </div>
                </div>

                <div className="w-full h-[1px] bg-white/5 my-2"></div>

                <div className="flex flex-col gap-2">
                  <h4 className="text-[14px] font-medium text-[#ef4444] mb-1">Danger Zone</h4>
                  <p className="text-[12px] text-[#8C8A88] mb-3">Deleting this agent will remove all its configurations and memory history. This action cannot be undone.</p>
                  
                  <button 
                    onClick={() => handleDeleteAgent(settingsAgent.id)}
                    className="w-full py-3 bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#ef4444] font-semibold text-[13px] rounded-xl hover:bg-[#ef4444]/20 transition-all duration-300 active:scale-[0.98]"
                  >
                    Delete Agent
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end pt-4 border-t border-white/5">
                <button 
                  onClick={() => setIsSettingsOpen(false)}
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
