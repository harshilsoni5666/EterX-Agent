import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, ArrowUp, SendHorizontal, Download, CheckCircle2, Upload } from 'lucide-react';
import { PremiumEdit, PremiumSettings } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';
import type { MainAgentThinkingLevel } from '../../lib/agent/model-routing';

interface Agent {
  id: string;
  name: string;
  description: string;
  accessType: 'Full Access' | 'Selected Access' | 'Agent Decides';
  isSetup?: boolean;
  toolCount?: number;
  kind?: 'agent' | 'flow';
  stepCount?: number;
  preferredModel?: string;
  preferredThinkingLevel?: MainAgentThinkingLevel;
  qualityScore?: number;
  readinessPassed?: number;
  readinessChecks?: number;
  category?: string;
  starterPrompts?: string[];
  builderMessages?: {role: 'user' | 'assistant', content: string}[];
}

export const AgentsView = React.memo(({
  onOpenBuilder,
  onUseAgent,
  selectedAgentId,
}: {
  onOpenBuilder: (id: string, name?: string) => void;
  onUseAgent?: (id: string | null, name: string) => void;
  selectedAgentId?: string | null;
}) => {
  const [agents, setAgents] = useState<Agent[]>([{
      id: 'default-1',
      name: 'Default Chat Agent',
      description: '',
      accessType: 'Full Access',
      isSetup: true
    }]);

  useEffect(() => {
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
          const existingById = new Map(prev.map(agent => [agent.id, agent]));
          const byId = new Map(
            prev
              .filter(agent => {
                const serverBacked = agent.kind === 'flow'
                  || agent.id.startsWith('eterxagent-')
                  || agent.id.startsWith('eterxflow-');
                return agent.id === 'default-1' || agent.isSetup !== true || !serverBacked;
              })
              .map(agent => [agent.id, agent])
          );

          for (const serverAgent of serverAgents) {
            const id = String(serverAgent.agentId || '').trim();
            if (!id) continue;
            serverIds.add(id);
            const existing = existingById.get(id);
            byId.set(id, {
              id,
              name: serverAgent.name || existing?.name || id,
              description: serverAgent.presentation?.description || serverAgent.mission || existing?.description || 'Custom agent.',
              accessType: existing?.accessType || 'Agent Decides',
              isSetup: serverAgent.status === 'ready',
              toolCount: serverAgent.toolCount,
              kind: serverAgent.kind === 'flow' ? 'flow' : 'agent',
              stepCount: serverAgent.stepCount,
              preferredModel: existing?.preferredModel,
              preferredThinkingLevel: existing?.preferredThinkingLevel,
              qualityScore: Number.isFinite(serverAgent.qualityScore) ? serverAgent.qualityScore : existing?.qualityScore,
              readinessPassed: Number.isFinite(serverAgent.readinessPassed) ? serverAgent.readinessPassed : existing?.readinessPassed,
              readinessChecks: Number.isFinite(serverAgent.readinessChecks) ? serverAgent.readinessChecks : existing?.readinessChecks,
              category: serverAgent.presentation?.category || existing?.category,
              starterPrompts: Array.isArray(serverAgent.presentation?.starterPrompts) ? serverAgent.presentation.starterPrompts : existing?.starterPrompts,
              builderMessages: existing?.builderMessages || [],
            });
          }

          for (const agent of prev) {
            if (agent.id === 'default-1') continue;
            const serverBacked = agent.kind === 'flow'
              || agent.id.startsWith('eterxagent-')
              || agent.id.startsWith('eterxflow-');
            if (!serverBacked) continue;
            if (agent.isSetup === false && !serverIds.has(agent.id)) byId.set(agent.id, agent);
          }

          return Array.from(byId.values());
        });
      } catch {
        // Keep the default card or an in-progress draft visible if the folder
        // store is temporarily unavailable.
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
  const [newAgentPurpose, setNewAgentPurpose] = useState("");
  const [newAgentTemplate, setNewAgentTemplate] = useState<'general' | 'sales' | 'support' | 'operations' | 'research' | 'coding'>('general');
  const [newAgentIntegration, setNewAgentIntegration] = useState<'none' | 'channels' | 'connectors' | 'all'>('none');
  const [newAgentChannelProfile, setNewAgentChannelProfile] = useState('');
  const [channelProfiles, setChannelProfiles] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [generatedId, setGeneratedId] = useState("");

  useEffect(() => {
    if (!isCreating) return;
    const desktopApi = (window as any)?.electronAPI;
    void desktopApi?.getGatewayState?.().then((state: any) => {
      const profiles = Array.isArray(state?.config?.channelAgent?.profiles) ? state.config.channelAgent.profiles : [];
      setChannelProfiles(profiles.map((item: any) => ({ id: String(item.id), name: String(item.name || item.id), role: String(item.role || 'custom') })));
      const defaultId = String(state?.config?.channelAgent?.defaultProfileId || profiles[0]?.id || '');
      if (defaultId) setNewAgentChannelProfile(defaultId);
    }).catch(() => {});
  }, [isCreating]);

  // Download, Import & Setup Notice state
  const [setupNoticeAgent, setSetupNoticeAgent] = useState<{ id: string; name: string } | null>(null);
  const [downloadToastName, setDownloadToastName] = useState<string | null>(null);
  const [importToastName, setImportToastName] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleDownloadAgent = async (agent: Agent, isReady: boolean) => {
    if (!isReady) {
      setSetupNoticeAgent({ id: agent.id, name: agent.name });
      setTimeout(() => setSetupNoticeAgent(prev => (prev?.id === agent.id ? null : prev)), 4000);
      return;
    }

    // Real-time full agent package export
    try {
      let serverProfile: any = null;
      let serverKind: 'agent' | 'flow' | null = null;
      try {
        const res = await fetch(`/api/agents/list?agentId=${encodeURIComponent(agent.id)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.profile) {
            serverProfile = data.profile;
            serverKind = data.kind === 'flow' ? 'flow' : 'agent';
          }
        }
      } catch { }

      const packageKind = serverKind || agent.kind || 'agent';

      const configData = {
        version: "1.0",
        type: "eterx-agent-package",
        exportedAt: new Date().toISOString(),
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          accessType: agent.accessType,
          toolCount: agent.toolCount || 0,
          kind: packageKind,
          stepCount: agent.stepCount || serverProfile?.steps?.length || 0,
          isSetup: true,
          status: 'ready',
          profile: serverProfile || {
            name: agent.name,
            mission: agent.description,
            professionalPrompt: `You are ${agent.name}. Mission: ${agent.description}`,
            behaviorRules: [],
            safetyRules: [],
            directMainTools: [],
            customTools: [],
            skills: [],
            responseStyle: 'Professional, accurate, and direct.',
            toolUsePolicy: 'Use attached tools purposefully to achieve the mission.',
            completionCriteria: 'All requirements of the user request have been successfully verified.',
            notes: []
          },
          builderMessages: agent.builderMessages || []
        }
      };

      const blob = new Blob([JSON.stringify(configData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${agent.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-agent.eterx.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setDownloadToastName(agent.name);
      setTimeout(() => setDownloadToastName(prev => (prev === agent.name ? null : prev)), 3500);
    } catch (e) {
      console.error('Download failed', e);
    }
  };

  const handleTriggerImportFile = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleImportAgentFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const pkg = JSON.parse(text);

      const agentData = pkg?.agent || (pkg?.id ? pkg : null);
      if (!agentData || !agentData.name) {
        alert('Invalid agent package file format.');
        return;
      }

      const random4 = Math.floor(1000 + Math.random() * 9000);
      const shortName = String(agentData.name).substring(0, 4).toLowerCase().replace(/[^a-z0-9]/g, 'a').padEnd(4, 'x');
      const name = agentData.name;
      const description = agentData.description || agentData.profile?.mission || 'Imported custom agent.';
      const accessType = agentData.accessType || 'Agent Decides';
      const isFlowPackage = agentData.kind === 'flow' || Array.isArray(agentData.profile?.steps);
      const newAgentId = `${isFlowPackage ? 'eterxflow' : 'eterxagent'}-${random4}-${shortName}`;
      const toolCount = agentData.toolCount ||
        (agentData.profile?.directMainTools?.length || 0) +
        (agentData.profile?.customTools?.length || 0);
      const profile = agentData.profile || {};

      // 1. Write the complete profile to the shared backend. An imported
      // package is only runnable when its server profile is actually present.
      try {
        const createResponse = await fetch('/api/agents/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isFlowPackage ? {
            agentId: newAgentId,
            kind: 'flow',
            name,
            description: profile.description || description,
            createdAt: profile.createdAt,
            steps: profile.steps,
            maxIterations: profile.maxIterations,
            notes: profile.notes || [],
          } : {
            agentId: newAgentId,
            name,
            mission: description,
            professionalPrompt: profile.professionalPrompt || `You are ${name}. Mission: ${description}`,
            responseStyle: profile.responseStyle,
            behaviorRules: profile.behaviorRules || [],
            safetyRules: profile.safetyRules || [],
            skills: profile.skills || [],
            toolUsePolicy: profile.toolUsePolicy,
            completionCriteria: profile.completionCriteria,
            directMainTools: profile.directMainTools || [],
            customTools: profile.customTools || [],
            notes: profile.notes || [],
            presentation: profile.presentation || {
              description,
              category: 'Imported',
              starterPrompts: [],
            },
            description
          })
        });
        const createPayload = await createResponse.json().catch(() => ({}));
        if (!createResponse.ok || createPayload?.success === false) {
          throw new Error(createPayload?.error || `Could not import ${name} (${createResponse.status}).`);
        }

        if (!isFlowPackage) {
          const readyResponse = await fetch('/api/agents/list', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: newAgentId, status: 'ready' })
          });
          const readyPayload = await readyResponse.json().catch(() => ({}));
          if (!readyResponse.ok || readyPayload?.success === false) {
            throw new Error(readyPayload?.error || `Could not finalize imported agent (${readyResponse.status}).`);
          }
        }
      } catch (err) {
        throw err;
      }

      // 2. Add to local state with isSetup: true (ready to use immediately!)
      const newAgent: Agent = {
        id: newAgentId,
        name,
        description,
        accessType,
        isSetup: true,
        kind: isFlowPackage ? 'flow' : 'agent',
        toolCount,
        stepCount: isFlowPackage ? (profile.steps?.length || 0) : undefined,
        category: profile.presentation?.category,
        starterPrompts: profile.presentation?.starterPrompts || [],
        builderMessages: agentData.builderMessages || []
      };

      setAgents(prev => {
        const next = [newAgent, ...prev.filter(a => a.id !== newAgentId)];
        return next;
      });

      try {
        window.dispatchEvent(new CustomEvent('eterx_agents_updated'));
      } catch { }

      // 3. Show import toast
      setImportToastName(name);
      setTimeout(() => setImportToastName(prev => (prev === name ? null : prev)), 4000);
    } catch (err) {
      console.error('Failed to import agent file:', err);
      alert('Failed to parse agent file. Please select a valid .eterx.json or .json file.');
    }
  };

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
      setNewAgentPurpose("");
      setNewAgentTemplate('general');
      setNewAgentIntegration('none');
      setNewAgentChannelProfile('');
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

  const handleStartBuilder = async () => {
    if (!newAgentName.trim()) return;
    const builderId = getOrCreateBuilderId();
    const name = newAgentName.trim();
    const purpose = newAgentPurpose.trim() || `Create a professional ${newAgentTemplate === 'general' ? 'custom' : newAgentTemplate} agent named ${name}.`;
    const attachChannels = newAgentIntegration === 'channels' || newAgentIntegration === 'all';
    const attachConnectors = newAgentIntegration === 'connectors' || newAgentIntegration === 'all';
    const attachedTools = [
      ...(attachChannels ? [{ toolName: 'channel_agent', purpose: 'Load the configured channel workflow on demand.', whenToUse: 'Call first for inbox, customer, lead, sales, support, drafting, or reply work across connected channels.', inputPolicy: newAgentChannelProfile ? `Use profile_id=${newAgentChannelProfile}.` : 'Omit profile_id to use the default Channel Agent profile.', outputPolicy: 'Follow the returned send and escalation policy; never claim delivery unless send_reply succeeds.', attachedAt: new Date().toISOString() }, { toolName: 'gateway_bridge', purpose: 'Use low-level native Gateway operations when the high-level channel tool cannot express the requested action.', whenToUse: 'Use after channel_agent when explicit conversation, event, attachment, pairing, or target control is required.', inputPolicy: 'Use only identifiers returned by Gateway tools.', outputPolicy: 'Treat live results and errors as authoritative.', attachedAt: new Date().toISOString() }] : []),
      ...(attachConnectors ? [{ toolName: 'connector_mcp', purpose: 'Operate saved REST and MCP integrations.', whenToUse: 'Discover and call a configured external service required by the mission.', inputPolicy: 'Discover the connector and exact live tool before calling it; never expose secrets.', outputPolicy: 'Verify the connector result before claiming success.', attachedAt: new Date().toISOString() }] : []),
    ];
    setAgents(previous => [
      {
        id: builderId,
        name,
        description: purpose,
        accessType: 'Agent Decides',
        isSetup: false,
        builderMessages: [],
      },
      ...previous.filter(agent => agent.id !== builderId),
    ]);
    // Create the draft in the shared app-data store immediately. This keeps
    // named agents available after a reload without depending on browser storage.
    try {
      // Wait for the draft to exist before opening the room. Otherwise a fast
      // first builder message can race this write and be overwritten by the
      // initial placeholder profile.
      await fetch('/api/agents/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: builderId,
        name,
        mission: purpose,
        description: purpose,
        professionalPrompt: `You are ${name}. Your mission is: ${purpose}\n\nThis is a draft. Agent Builder must complete the operating prompt, behavior, safety, tools, evidence rules, failure recovery, and completion criteria before finalization.`,
        directMainTools: attachedTools,
        presentation: {
          description: purpose,
          category: newAgentTemplate === 'general' ? 'Custom' : newAgentTemplate.charAt(0).toUpperCase() + newAgentTemplate.slice(1),
          starterPrompts: [],
        },
      }),
      });
    } catch {
      // The builder can still create the profile on its first save.
    }
    handleCloseModal();
    setTimeout(() => onOpenBuilder(builderId, name), 300);
  };

  const customAgents = agents.filter(agent => agent.id !== 'default-1');

  return (
    <div className="eterx-agents-view flex-1 w-full h-full flex flex-col px-5 py-5 md:px-8 md:pt-6 md:pb-6 overflow-hidden relative z-20 bg-transparent">
      
      {/* Outermost Notification Toasts — Rendered directly into document.body via Portal */}
      {typeof document !== 'undefined' && createPortal(
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[99999] pointer-events-none flex flex-col items-center gap-2">
          <AnimatePresence>
            {setupNoticeAgent && (
              <motion.div
                key="setup-notice"
                initial={{ opacity: 0, y: -16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.96 }}
                className="pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-full bg-[#1C1C1B]/95 border border-white/[0.16] text-white shadow-none backdrop-blur-2xl whitespace-nowrap"
              >
                <span className="text-[12px] font-medium text-[#EDEBE7]">
                  Setup required to download <strong className="font-semibold text-white">{setupNoticeAgent.name}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const id = setupNoticeAgent.id;
                    setSetupNoticeAgent(null);
                    onOpenBuilder(id, setupNoticeAgent.name);
                  }}
                  className="text-[11.5px] font-semibold text-black bg-white hover:bg-[#E8E6E3] px-3 py-0.5 rounded-full transition-colors cursor-pointer"
                >
                  Setup now →
                </button>
              </motion.div>
            )}
            {downloadToastName && (
              <motion.div
                key="download-notice"
                initial={{ opacity: 0, y: -16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.96 }}
                className="pointer-events-auto flex items-center gap-2.5 px-4 py-2 rounded-full bg-[#181817]/95 border border-white/[0.16] text-white shadow-none backdrop-blur-2xl whitespace-nowrap"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-[12px] font-medium text-[#F0EDE8]">
                  Downloaded package for <strong className="font-semibold text-white">{downloadToastName}</strong>
                </span>
              </motion.div>
            )}
            {importToastName && (
              <motion.div
                key="import-notice"
                initial={{ opacity: 0, y: -16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.96 }}
                className="pointer-events-auto flex items-center gap-2.5 px-4 py-2 rounded-full bg-[#181817]/95 border border-white/[0.16] text-white shadow-none backdrop-blur-2xl whitespace-nowrap"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-[12px] font-medium text-[#F0EDE8]">
                  Successfully imported & configured <strong className="font-semibold text-white">{importToastName}</strong>
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>,
        document.body
      )}

      {/* Hidden file input for agent import */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportAgentFile}
        accept=".json,.eterx"
        className="hidden"
      />

      {/* Agents container stretching to the very top */}
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="eterx-agents-library-panel flex-1 bg-[#0A0A0A]/70 backdrop-blur-sm border border-white/[0.04] rounded-[18px] p-4 md:p-5 w-full shadow-none flex flex-col gap-3 overflow-hidden relative"
        >
          {/* Header internal row matching style and spacing of ProjectsView */}
          <div className="w-full flex items-center justify-between shrink-0 pl-1 pr-1 pb-1.5 border-b border-white/[0.03]">
            <span className="text-[13px] font-semibold text-[#A3A19E] tracking-normal">Library</span>
            <div className="flex items-center gap-2">
              <button 
                type="button"
                onClick={handleTriggerImportFile}
                className="flex h-7 shrink-0 items-center gap-1.5 px-3 bg-white/[0.06] text-white font-semibold text-[11px] rounded-full border border-white/[0.12] hover:bg-white/[0.12] hover:border-white/[0.22] transition-all duration-200 active:scale-95 cursor-pointer"
              >
                <Upload className="w-3 h-3 text-white" strokeWidth={2.4} />
                Import agent
              </button>
              <button 
                type="button"
                onClick={() => setIsCreating(true)}
                className="eterx-agents-primary-button flex h-7 shrink-0 items-center gap-1.5 px-3 bg-white text-black font-semibold text-[11px] rounded-full hover:bg-[#E8E6E3] transition-all duration-300 active:scale-95 group cursor-pointer"
              >
                <Plus className="w-3 h-3 text-black" strokeWidth={2.8} />
                New agent
              </button>
            </div>
          </div>

          {/* Scrollable list grid */}
          <div className="flex-1 overflow-y-auto eterx-scrollbar pr-0.5 flex flex-col gap-2">
            {customAgents.length === 0 ? (
              <div className="flex flex-1 min-h-[220px] items-center justify-center text-center text-sm text-white/40">
                No Agents Created
              </div>
            ) : customAgents.map((agent) => {
              const isDefaultAgent = agent.id === 'default-1';
              const isReady = isDefaultAgent || agent.isSetup !== false;
              const useLabel = isDefaultAgent ? 'Use General' : 'Use in chat';

              return (
                <div 
                  key={agent.id} 
                  onClick={() => onOpenBuilder(agent.id, agent.name)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button,input,textarea')) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenBuilder(agent.id, agent.name);
                    }
                  }}
                  className="eterx-agent-card group relative bg-[#111111] border border-white/[0.06] rounded-[14px] p-3 hover:border-white/[0.12] hover:bg-[#151515] transition-all duration-200 cursor-pointer overflow-hidden flex items-stretch justify-between shrink-0 shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
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
                                const nextName = editingName.trim() || agent.name;
                                setAgents(previous => previous.map(a => a.id === agent.id ? { ...a, name: nextName } : a));
                                void fetch('/api/agents/list', {
                                  method: 'PUT',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ agentId: agent.id, name: nextName }),
                                }).catch(() => { });
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
                          <span className="text-[10px] text-[#A3A19E] font-medium tracking-normal">{agent.category || agent.accessType}</span>
                        </div>
                        {(agent.kind === 'flow' || typeof agent.toolCount === 'number') && (
                          <div className="hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] bg-white/[0.025] border border-white/[0.06]">
                            <span className="text-[10px] text-white/45 font-medium tracking-normal">
                              {agent.kind === 'flow' ? `${agent.stepCount || 0} steps` : `${agent.toolCount} tools`}
                            </span>
                          </div>
                        )}
                        {typeof agent.qualityScore === 'number' && (
                          <div className="hidden lg:flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] bg-white/[0.025] border border-white/[0.06]">
                            <span className="text-[10px] text-white/45 font-medium tracking-normal">
                              {agent.qualityScore}% quality
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
                      {/* Professional Download Button */}
                      <Tooltip text={isReady ? "Download Agent Package" : "Setup required to download"} side="top">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownloadAgent(agent, isReady);
                          }}
                          className={`relative flex items-center justify-center w-[34px] h-[34px] rounded-full border transition-colors duration-150 ${
                            isReady
                              ? 'bg-white/[0.06] text-[#E5E3DF] border-white/[0.1] hover:bg-white/[0.12] hover:text-white'
                              : 'bg-white/[0.03] text-white/40 border-white/[0.06] hover:bg-white/[0.07] hover:text-white/70'
                          }`}
                          aria-label={`Download ${agent.name}`}
                        >
                          <Download className="w-3.5 h-3.5" strokeWidth={1.9} />
                        </button>
                      </Tooltip>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!isReady) {
                            onOpenBuilder(agent.id, agent.name);
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
                        onClick={(e) => { e.stopPropagation(); onOpenBuilder(agent.id, agent.name); }}
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
              className="bg-[#0A0A0A] border border-white/10 rounded-[28px] p-6 w-full max-w-[680px] shadow-none flex flex-col gap-6 max-h-[90vh] overflow-y-auto eterx-scrollbar"
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newAgentName.trim()) {
                        e.preventDefault();
                        void handleStartBuilder();
                      }
                    }}
                    className="w-full bg-[#111111] border border-white/10 rounded-xl px-4 py-3 text-[14px] text-white outline-none focus:border-white/20 transition-all font-sans placeholder:text-[#555350]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <label className="text-[13px] font-semibold text-[#8C8A88]">Role template</label>
                    <select value={newAgentTemplate} onChange={(event) => setNewAgentTemplate(event.target.value as typeof newAgentTemplate)} className="h-11 rounded-xl border border-white/10 bg-[#111111] px-3 text-[13px] text-white outline-none focus:border-white/20">
                      <option value="general">General</option><option value="sales">Sales</option><option value="support">Support</option><option value="operations">Operations</option><option value="research">Research</option><option value="coding">Coding</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[13px] font-semibold text-[#8C8A88]">Integrations</label>
                    <select value={newAgentIntegration} onChange={(event) => setNewAgentIntegration(event.target.value as typeof newAgentIntegration)} className="h-11 rounded-xl border border-white/10 bg-[#111111] px-3 text-[13px] text-white outline-none focus:border-white/20">
                      <option value="none">None yet</option><option value="channels">Channels</option><option value="connectors">REST / MCP</option><option value="all">Channels + connectors</option>
                    </select>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-[13px] font-semibold text-[#8C8A88]">What should this agent accomplish?</label>
                  <textarea rows={4} value={newAgentPurpose} onChange={(event) => setNewAgentPurpose(event.target.value)} placeholder="Example: Qualify inbound leads, answer from approved product information, draft concise follow-ups, and escalate pricing or security questions." className="w-full resize-none rounded-xl border border-white/10 bg-[#111111] px-4 py-3 text-[13px] leading-5 text-white outline-none transition-all placeholder:text-[#555350] focus:border-white/20" />
                </div>
                {(newAgentIntegration === 'channels' || newAgentIntegration === 'all') && (
                  <div className="flex flex-col gap-2 rounded-xl border border-[#1d8cff]/20 bg-[#1d8cff]/[0.06] p-3">
                    <div className="flex items-center justify-between gap-3"><div><label className="text-[13px] font-semibold text-[#b9dcff]">Channel Agent profile</label><p className="mt-1 text-[11px] leading-4 text-[#8C8A88]">The workflow loads only when needed, keeping normal prompts smaller.</p></div><span className="rounded-full bg-[#1d8cff]/15 px-2 py-1 text-[9px] font-semibold text-[#9dceff]">On demand</span></div>
                    <select value={newAgentChannelProfile} onChange={(event) => setNewAgentChannelProfile(event.target.value)} className="h-10 rounded-lg border border-white/10 bg-[#111111] px-3 text-[12px] text-white outline-none">
                      <option value="">Default Gateway profile</option>{channelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.role}</option>)}
                    </select>
                    {channelProfiles.length === 0 && <p className="text-[10px] text-amber-300/80">No custom Channel Agent profiles found. The Gateway default will be used; profiles can be added under Channels → Channel Agents.</p>}
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2">
                  {[['1', 'Describe', 'Mission + role'], ['2', 'Build', 'Prompt + tools'], ['3', 'Verify', 'Quality + finalize']].map(([step, title, detail]) => <div key={step} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5"><div className="text-[9px] font-bold text-[#9dceff]">STEP {step}</div><div className="mt-1 text-[11px] font-semibold text-white">{title}</div><div className="mt-0.5 text-[9px] text-[#706e6b]">{detail}</div></div>)}
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
              className="bg-[#0A0A0A] border border-white/10 rounded-[28px] p-6 w-full max-w-[500px] shadow-none flex flex-col gap-6 max-h-[90vh]"
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

              <div className="flex flex-col gap-4 overflow-y-auto eterx-scrollbar pr-1 max-h-[50vh]">
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
                  {settingsAgent.preferredModel && (
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="text-[#8C8A88]">Preferred model</span>
                      <span className="max-w-[260px] truncate text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">
                        {settingsAgent.preferredModel}
                      </span>
                    </div>
                  )}
                  {settingsAgent.preferredThinkingLevel && (
                    <div className="flex items-center justify-between text-[13px]">
                      <span className="text-[#8C8A88]">Thinking level</span>
                      <span className="capitalize text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">
                        {settingsAgent.preferredThinkingLevel}
                      </span>
                    </div>
                  )}
                  {typeof settingsAgent.qualityScore === 'number' && (
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="text-[#8C8A88]">Builder quality</span>
                      <span className="text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">
                        {settingsAgent.qualityScore}% · {settingsAgent.readinessPassed || 0}/{settingsAgent.readinessChecks || 0} checks
                      </span>
                    </div>
                  )}
                  {settingsAgent.category && (
                    <div className="flex items-center justify-between text-[13px]">
                      <span className="text-[#8C8A88]">Category</span>
                      <span className="text-white px-2 py-0.5 rounded bg-white/5 border border-white/10">{settingsAgent.category}</span>
                    </div>
                  )}
                </div>

                {settingsAgent.starterPrompts && settingsAgent.starterPrompts.length > 0 && (
                  <div className="flex flex-col gap-2 rounded-xl bg-white/[0.02] border border-white/5 p-4">
                    <h4 className="text-[14px] font-medium text-[#E8E6E3]">Try this agent</h4>
                    {settingsAgent.starterPrompts.slice(0, 4).map((prompt) => (
                      <div
                        key={prompt}
                        className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-left text-[12px] leading-5 text-white/65"
                      >
                        {prompt}
                      </div>
                    ))}
                  </div>
                )}

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
});
