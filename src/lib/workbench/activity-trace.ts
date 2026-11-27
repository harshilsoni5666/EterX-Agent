import { localWorkbenchUrl, workbenchActions, type DeviceCatalog, type WorkbenchAction } from './contracts';

type DeviceLabel = { name?: string; host?: string; status?: string };
export type WorkbenchReceipt = {
  kind: 'workbench-receipt';
  success?: boolean;
  cancelled?: boolean;
  error?: string;
  actionStatus?: string;
  device?: DeviceLabel;
  machine?: DeviceLabel;
  deviceCount?: number;
  deviceNames?: string[];
  machineCount?: number;
  runningCount?: number;
  serviceCount?: number;
  setup?: string;
  appId?: string;
  command?: string;
  url?: string;
  label?: string;
  dimensions?: string;
};

const actions = new Set<string>(workbenchActions);
export function isWorkbenchTrace(log: any) {
  return String(log?.toolName || log?.tool || log?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_') === 'workspace_workbench';
}

const text = (value: unknown, length = 140) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, length) || undefined
  : undefined;

export function workbenchReceiptUrl(value: unknown) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = localWorkbenchUrl(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export function workbenchTraceArgs(args: any) {
  const action = actions.has(args?.action) ? args.action as WorkbenchAction : undefined;
  return {
    action,
    target: args?.target === 'api' ? 'api' as const : 'web' as const,
    url: workbenchReceiptUrl(args?.url),
    taskId: typeof args?.taskId === 'string' && /^term_[A-Za-z0-9_]{1,100}$/.test(args.taskId) ? args.taskId : undefined,
    label: text(args?.label),
    appId: text(args?.appId),
    artifact: typeof args?.artifact === 'string' ? text(args.artifact.split(/[\\/]/).filter(Boolean).pop()) : undefined,
    browser: args?.browser?.kind ? { kind: text(args.browser.kind, 20), url: workbenchReceiptUrl(args.browser.url) } : undefined,
    input: args?.input?.kind ? {
      kind: text(args.input.kind, 20), key: text(args.input.key, 16),
      appearance: text(args.input.appearance, 12), rotation: text(args.input.rotation, 12),
    } : undefined,
  };
}

function deviceLabel(value: any): DeviceLabel | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return { name: text(value.name), host: text(value.hostLabel), status: text(value.status, 20) };
}

/** Conversation traces need human labels and outcomes, not screen pixels or typed text. */
export function workbenchTraceResult(value: any): WorkbenchReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (value.kind === 'workbench-receipt') return value as WorkbenchReceipt;
  const devices: DeviceCatalog['devices'] | undefined = Array.isArray(value.devices) ? value.devices : undefined;
  const hosts: DeviceCatalog['hosts'] = Array.isArray(value.hosts) ? value.hosts : [];
  const blocked = hosts.find(host => host?.state === 'offline') || hosts.find(host => host?.state === 'setup');
  const setup = devices?.length === 0
    ? text(blocked?.detail || blocked?.apple || blocked?.android || hosts.find(host => host?.apple)?.apple, 220)
    : undefined;
  const size = Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && value.width > 0 && value.height > 0;
  return {
    kind: 'workbench-receipt',
    success: typeof value.success === 'boolean' ? value.success : undefined,
    cancelled: value.cancelled === true || value.error === 'CANCELLED_BY_USER' || undefined,
    error: text(value.error, 260),
    actionStatus: text(value.actionStatus, 30),
    device: deviceLabel(value.device),
    machine: deviceLabel(value.machine),
    deviceCount: devices?.length,
    deviceNames: devices?.slice(0, 2).flatMap(device => text(device?.name, 70) || []),
    machineCount: Array.isArray(value.machines) ? value.machines.length : undefined,
    runningCount: Array.isArray(value.tasks) ? value.tasks.filter((task: any) => task?.status === 'running').length : undefined,
    serviceCount: Array.isArray(value.targets) ? value.targets.length : undefined,
    setup,
    appId: text(value.appId),
    command: text(value.task?.command),
    url: workbenchReceiptUrl(value.target?.url || value.url),
    label: text(value.target?.label || value.title),
    dimensions: size ? value.width + ' × ' + value.height : undefined,
  };
}
