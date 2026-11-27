import path from 'node:path';
import type { MachineCatalog, VirtualMachine } from './contracts';
import { runHostProgram } from './host-program';
import { findExecutable } from '../agent/tools/core/shell_resolver';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const starting = new Map<string, Promise<VirtualMachine>>();

function virtualBox() {
  const base = process.env.VBOX_MSI_INSTALL_PATH || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Oracle', 'VirtualBox');
  return findExecutable(process.platform === 'win32'
    ? ['VBoxManage.exe', path.join(base, 'VBoxManage.exe')]
    : ['VBoxManage', '/Applications/VirtualBox.app/Contents/MacOS/VBoxManage']);
}

function parseMachines(reply: Buffer) {
  return reply.toString().split(/\r?\n/).flatMap(line => {
    const match = /^"(.*)"\s+\{([a-f\d-]+)\}\s*$/i.exec(line);
    return match && uuid.test(match[2]) ? [{ id: match[2].toLowerCase(), name: match[1] }] : [];
  });
}

export async function listLocalMachines(): Promise<MachineCatalog> {
  const program = virtualBox();
  if (!program) return { available: false, machines: [] };
  const [registered, running] = await Promise.all([
    runHostProgram(program, ['list', 'vms']),
    runHostProgram(program, ['list', 'runningvms']),
  ]);
  const active = new Set(parseMachines(running).map(item => item.id));
  const machines: VirtualMachine[] = parseMachines(registered).map(item => ({
    ...item, status: active.has(item.id) ? 'running' : starting.has(item.id) ? 'starting' : 'off',
  }));
  return { available: true, machines: machines.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80) };
}

export async function startLocalMachine(value: string) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Choose a registered VirtualBox machine.');
  const id = value.toLowerCase();
  const pending = starting.get(id);
  if (pending) return pending;
  const operation = (async () => {
    const program = virtualBox();
    if (!program) throw new Error('VirtualBox is unavailable on this host.');
    const { machines } = await listLocalMachines();
    const selected = machines.find(machine => machine.id === id);
    if (!selected) throw new Error('The selected VirtualBox machine is no longer registered.');
    if (selected.status !== 'running') await runHostProgram(program, ['startvm', id, '--type', 'gui'], 30_000);
    return { ...selected, status: selected.status === 'running' ? 'running' as const : 'starting' as const };
  })().finally(() => starting.delete(id));
  starting.set(id, operation);
  return operation;
}
