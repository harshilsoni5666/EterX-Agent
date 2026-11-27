'use client';

import { useEffect, useState } from 'react';
import { AppWindow, ArrowUpRight, Box, Globe, Radio, Smartphone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppVisibility } from '../../lib/app-visibility';
import { openDevelopmentPreview, openWorkbenchView, useSideWorkspace } from '../../lib/side-workspace-store';
import { workbenchJson, workbenchUrl } from '../../lib/workbench/client';
import type { WorkbenchRuntime } from '../../lib/workbench/contracts';
import { useWorkbenchServiceHealth } from '../../lib/workbench/service-health';
import { useWorkbenchActivity } from '../../lib/workbench/use-activity';

const emptyRuntime: WorkbenchRuntime = { device: null, machine: null };

function DevelopmentRow({ icon: Icon, title, detail, status, onSelect }: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  status?: string;
  onSelect: () => void;
}) {
  return <button type="button" className="eterx-work-panel-row eterx-work-panel-development-row" title={title} onClick={onSelect}>
    <span className="eterx-work-panel-row-icon"><Icon size={15} strokeWidth={1.8} aria-hidden="true" /></span>
    <span className="eterx-work-panel-development-label">
      <strong>{title}</strong>
      {detail && <small>{detail}</small>}
    </span>
    {status && <span className="eterx-work-panel-status" data-ready={['Running', 'Listening', 'Ready', 'Live'].includes(status)}>{status}</span>}
    <ArrowUpRight size={13} aria-hidden="true" />
  </button>;
}

export function WorkPanelDevelopment({ chatId, owner, onOpen }: { chatId: string; owner: string; onOpen: () => void }) {
  const visible = useAppVisibility();
  const { snapshot, error, loading } = useWorkbenchActivity(chatId, visible);
  const workspace = useSideWorkspace(owner);
  const activeTab = workspace.open ? workspace.tabs.find(tab => tab.id === workspace.activeId) : undefined;
  const sharedWindow = activeTab?.kind === 'workbench' && (!activeTab.workbenchChatId || activeTab.workbenchChatId === chatId)
    ? activeTab.workbenchWindow : undefined;
  const deviceId = snapshot.deviceId;
  const machineId = snapshot.machine?.id;
  const runtimeEnabled = visible && !loading && !error && snapshot.desktop && Boolean(deviceId || machineId);
  const [runtime, setRuntime] = useState<WorkbenchRuntime>(emptyRuntime);
  const services = snapshot.targets.filter(target => target.kind === 'web');
  const probes = useWorkbenchServiceHealth(chatId, services, visible && snapshot.desktop);

  useEffect(() => {
    setRuntime(emptyRuntime);
    if (!runtimeEnabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await workbenchJson<WorkbenchRuntime>(workbenchUrl(chatId, 'runtime'), { signal: controller.signal }, 30_000);
        if (!controller.signal.aborted) setRuntime(result);
      } catch {
        if (!controller.signal.aborted) setRuntime(emptyRuntime);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [chatId, deviceId, machineId, runtimeEnabled]);

  const runningIds = new Set(snapshot.tasks.filter(task => task.status === 'running').map(task => task.id));
  const targets = !loading && !error && snapshot.desktop ? services.filter(target => probes[target.url] === true || (target.taskId && runningIds.has(target.taskId))) : [];
  const device = runtimeEnabled && deviceId === runtime.device?.id && runtime.device && ['ready', 'starting'].includes(runtime.device.status) ? runtime.device : null;
  const machine = runtimeEnabled && machineId === runtime.machine?.id && runtime.machine && runtime.machine.status !== 'off' ? runtime.machine : null;
  if (!(targets.length || device || machine || sharedWindow)) return null;
  return <section className="eterx-work-panel-section" aria-label="Services and devices">
    <div className="eterx-work-panel-heading"><Radio size={15} aria-hidden="true" /><span>Services and devices</span></div>
    {sharedWindow && <DevelopmentRow icon={AppWindow} title={sharedWindow} detail="Window sharing" status="Live"
      onSelect={() => { openWorkbenchView(owner, chatId, 'devices', { mode: 'windows' }); onOpen(); }} />}
    {device && <DevelopmentRow icon={Smartphone} title={device.name} detail={device.hostLabel || device.runtime || 'This computer'}
      status={device.status === 'starting' ? 'Starting' : 'Ready'}
      onSelect={() => { openWorkbenchView(owner, chatId, 'devices'); onOpen(); }} />}
    {machine && <DevelopmentRow icon={Box} title={machine.name} detail="Virtual machine" status={machine.status === 'running' ? 'Running' : 'Starting'}
      onSelect={() => { openWorkbenchView(owner, chatId, 'devices', { mode: 'windows' }); onOpen(); }} />}
    {targets.slice(0, 3).map(target => {
      const ready = probes[target.url] === true;
      const address = target.url.replace(/^https?:\/\//i, '').split(/[?#]/, 1)[0];
      return <DevelopmentRow key={target.url} icon={Globe}
        title={target.label || address} detail={target.label ? address : 'Browser preview'}
        status={ready ? 'Listening' : 'Awaiting port'} onSelect={() => {
          if (ready && (window as any).electronAPI?.workspaceBrowserCreate) {
            try { openDevelopmentPreview(owner, target.url, target.label); }
            catch { openWorkbenchView(owner, chatId, 'services', { url: target.url }); }
          } else openWorkbenchView(owner, chatId, 'services', { url: target.url });
          onOpen();
        }} />;
    })}
    {targets.length > 3 && <button type="button" className="eterx-work-panel-row" onClick={() => {
      openWorkbenchView(owner, chatId, 'services');
      onOpen();
    }}><Radio size={16} aria-hidden="true" /><span className="eterx-work-panel-label">View all services</span><ArrowUpRight size={13} aria-hidden="true" /></button>}
  </section>;
}
