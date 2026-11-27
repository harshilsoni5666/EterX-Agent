'use client';

import { createContext, useContext, useState } from 'react';
import { Activity, ArrowRight, Braces, Camera, CircleAlert, Download, Globe, Keyboard, Loader2, Monitor, PanelRight, Play, Power, Smartphone, TerminalSquare, type LucideIcon } from 'lucide-react';
import { useFilePanelOwner } from '../../contexts/FilePanelContext';
import { isFeedTraceOpen } from '../../lib/chat-feed-lifecycle';
import { openWorkbenchView } from '../../lib/side-workspace-store';
import { workbenchTraceArgs, workbenchTraceResult } from '../../lib/workbench/activity-trace';
import type { WorkbenchAction, WorkbenchDeviceMode, WorkbenchView } from '../../lib/workbench/contracts';
import styles from './workbench-chat-action.module.css';

type WorkbenchSettingsTab = 'connections' | 'computer';
export const WorkbenchChatContext = createContext<{
  chatId: string | null;
  openSettings?: (tab: WorkbenchSettingsTab) => void;
} | null>(null);

type ActionStyle = { icon: LucideIcon; running: string; finished: string; view: WorkbenchView; button?: string; mode?: WorkbenchDeviceMode };
const deviceView = { view: 'devices', button: 'Open Devices' } as const;
const virtualView = { ...deviceView, button: 'Open virtual machines', mode: 'windows' as const };
const actions: Record<WorkbenchAction, ActionStyle> = {
  activity: { icon: Activity, running: 'Reading Workbench activity', finished: 'Read Workbench activity', view: 'services', button: 'Open Workbench' },
  show_runs: { icon: TerminalSquare, running: 'Sharing run output', finished: 'Shared run output', view: 'runs', button: 'Open runs' },
  publish: { icon: Globe, running: 'Sharing local service', finished: 'Shared local service', view: 'services', button: 'Open Services' },
  browser: { icon: Globe, running: 'Using browser preview', finished: 'Browser preview observed', view: 'services', button: 'Open Services' },
  devices: { icon: Smartphone, running: 'Finding devices', finished: 'Found development devices', ...deviceView },
  select_device: { icon: Smartphone, running: 'Selecting device', finished: 'Selected device', ...deviceView },
  start_device: { icon: Play, running: 'Requesting device boot', finished: 'Device boot requested', ...deviceView },
  stop_device: { icon: Power, running: 'Requesting device shutdown', finished: 'Device shutdown requested', ...deviceView },
  capture: { icon: Camera, running: 'Capturing device screen', finished: 'Captured device screen', ...deviceView },
  input: { icon: Keyboard, running: 'Sending device input', finished: 'Device input sent', view: 'devices' },
  install_app: { icon: Download, running: 'Installing build', finished: 'Installed build', ...deviceView },
  launch_app: { icon: Play, running: 'Launching app', finished: 'Launched app', ...deviceView },
  machines: { icon: Monitor, running: 'Finding virtual machines', finished: 'Found virtual machines', ...virtualView },
  start_machine: { icon: Monitor, running: 'Starting virtual machine', finished: 'Virtual machine startup requested', ...virtualView },
};
const generic: ActionStyle = { icon: PanelRight, running: 'Using Workbench', finished: 'Workbench action', view: 'services', button: 'Open Workbench' };
const labels = { pending: 'Running', done: '', requested: 'Requested', failed: 'Failed', stopped: 'Stopped', unknown: 'Result unavailable' };
const countLabel = (amount: number, noun: string) => amount + ' ' + noun + (amount === 1 ? '' : 's');

export function WorkbenchChatAction({ log, preview, turnActive }: { log: any; preview?: any; turnActive: boolean }) {
  const owner = useFilePanelOwner();
  const scope = useContext(WorkbenchChatContext);
  const [openError, setOpenError] = useState('');
  const args = workbenchTraceArgs(log.toolArgs || preview?.toolArgs);
  const action = args.action;
  const result = workbenchTraceResult(log.result ?? log.toolResult ?? preview?.result ?? preview?.toolResult);
  const style = action ? actions[action] : generic;
  const stopped = result?.cancelled || ['stopped', 'cancelled', 'canceled'].includes(log.status);
  const error = result?.error || (typeof log.error === 'string' ? log.error : '');
  const failed = !stopped && Boolean(error || result?.success === false || ['failed', 'error'].includes(log.status));
  const requested = !failed && (result?.actionStatus === 'requested' ||
    (action === 'start_device' && result?.actionStatus !== 'ready') ||
    (action === 'stop_device' && result?.actionStatus !== 'off') ||
    (action === 'start_machine' && result?.machine?.status !== 'running'));
  const settled = result?.success === true || log.status === 'completed';
  const state = stopped ? 'stopped' : failed ? 'failed' : settled ? requested ? 'requested' : 'done'
    : turnActive && isFeedTraceOpen(log) ? 'pending' : 'unknown';
  const isApi = action === 'publish' && args.target === 'api';
  const TitleIcon = isApi ? Braces : style.icon;
  const url = result?.url || args.url || args.browser?.url;
  const device = result?.device;
  const machine = result?.machine;
  let finished = isApi ? 'Shared local API' : style.finished;
  let detail = '';
  if (action === 'devices' && result?.deviceCount !== undefined) {
    finished = result.deviceCount ? 'Found ' + countLabel(result.deviceCount, 'device') : 'No devices found';
    detail = result.deviceNames?.join(' · ') || result.setup || '';
  } else if (action === 'machines' && result?.machineCount !== undefined) {
    finished = result.machineCount ? 'Found ' + countLabel(result.machineCount, 'virtual machine') : 'No virtual machines found';
  } else if (action === 'publish' || action === 'browser') {
    detail = [result?.label || args.label, url?.replace(/^https?:\/\//i, '')].filter(Boolean).join(' · ');
    if (action === 'browser') {
      if (args.browser?.kind === 'status') finished = 'Read browser preview status';
      else if (args.browser?.kind === 'snapshot') finished = 'Captured browser preview';
      else if (args.browser?.kind === 'navigate') finished = 'Browser navigation requested';
      else if (args.browser?.kind === 'reload') finished = 'Browser reload requested';
      else if (result?.actionStatus === 'sent') finished = 'Browser input sent';
    }
  } else if (action === 'activity' && result) {
    detail = [
      result.runningCount === undefined ? undefined : result.runningCount + ' running',
      result.serviceCount === undefined ? undefined : countLabel(result.serviceCount, 'service'),
      device?.name,
    ].filter(Boolean).join(' · ');
  } else if (action === 'show_runs') {
    if (!args.taskId) finished = 'Shared runs';
    detail = result?.command || '';
  } else {
    if (action === 'select_device' && device?.name) finished = 'Selected ' + device.name;
    if (action === 'start_device' && result?.actionStatus === 'ready') finished = 'Device is ready';
    if (action === 'stop_device' && result?.actionStatus === 'off') finished = 'Virtual device is off';
    if (action === 'start_machine' && machine?.status === 'running') finished = 'Virtual machine is running';
    const showDevice = action === 'select_device' && device?.name ? undefined : device?.name;
    const subject = action === 'install_app' ? args.artifact : action === 'launch_app' ? args.appId : undefined;
    detail = [subject, showDevice || machine?.name, device?.host, result?.dimensions].filter(Boolean).join(' · ');
  }
  const heading = state === 'pending' ? isApi ? 'Sharing local API' : style.running
    : state === 'done' || state === 'requested' ? finished : style.running;
  const needsSettings: WorkbenchSettingsTab | undefined = failed && /computer use/i.test(error) ? 'computer'
    : (action === 'devices' && result?.setup) || (failed && /xcode|ssh|disabled or removed|remote connection/i.test(error)) ? 'connections' : undefined;
  const settings = needsSettings && scope?.openSettings;
  const destination = isApi ? 'api' : style.view;
  const button = settings ? needsSettings === 'computer' ? 'Computer Use settings' : 'Open Connections'
    : isApi ? 'Open API' : style.button;
  const canOpen = Boolean(button && (settings || (owner && scope?.chatId)) && state !== 'stopped' && state !== 'pending');

  return <div className={styles.row} data-state={state}>
    <span className={styles.icon} aria-hidden="true"><TitleIcon size={16} strokeWidth={1.8} /></span>
    <div className={styles.content}>
      <div className={styles.heading}>
        <strong>{heading}</strong>
        {state === 'pending' ? <Loader2 size={12} aria-label="Running" className="motion-safe:animate-spin" />
          : labels[state] && <span className={styles.status}>{state === 'failed' && <CircleAlert size={12} />}{labels[state]}</span>}
      </div>
      {state !== 'stopped' && (failed ? error : detail) && <p title={failed ? error : detail}>{failed ? error : detail}</p>}
      {openError && <p role="status">{openError}</p>}
    </div>
    {canOpen && <button type="button" className={styles.open} onClick={() => {
      if (needsSettings && settings) {
        settings(needsSettings);
      } else if (owner && scope?.chatId) {
        try {
          openWorkbenchView(owner, scope.chatId, destination, { url, taskId: args.taskId, mode: style.mode });
        } catch {
          setOpenError('Could not open this Workbench view.');
        }
      }
    }}>{button}<ArrowRight aria-hidden="true" size={13} /></button>}
  </div>;
}
