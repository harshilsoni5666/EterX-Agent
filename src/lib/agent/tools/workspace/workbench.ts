import { z } from 'zod';
import type { ToolDefinition } from '../../schemas';
import { isComputerUseDisabled } from '../../builtin-agent-tool-policy';
import { enforceToolCapability } from '../security/tool_policy';
import { localWorkbenchUrl, workbenchActions } from '../../../workbench/contracts';
import { captureWorkbenchDevice, deviceInputSchema, installWorkbenchDeviceApp, launchWorkbenchDeviceApp, listWorkbenchDevices, resolveWorkbenchDevice, sendWorkbenchDeviceInput, startWorkbenchDevice, stopWorkbenchDevice } from '../../../workbench/devices';
import { resolveReadableWorkspacePathForContext } from '../../workspace/path_resolver';
import { publishWorkbenchTarget, readWorkbench, revealWorkbenchRuns, setWorkbenchDevice, setWorkbenchMachine } from '../../../workbench/events';
import { desktopWorkbenchEnabled, workbenchActivity } from '../../../workbench/server';
import { previewActionSchema, queuePreviewJob } from '../../../workbench/preview-jobs';
import { listLocalMachines, startLocalMachine } from '../../../workbench/virtual-machines';

const inputSchema = z.object({
  action: z.enum(workbenchActions)
    .describe('Use stop_device only when the user asks to power off the selected simulator or emulator.'),
  url: z.string().max(2048).optional().describe('A loopback HTTP URL for publish, including the actual port and path.'),
  target: z.enum(['web', 'api']).optional(),
  label: z.string().max(90).optional(),
  taskId: z.string().max(115).optional().describe('The managed task producing this URL for publish, or the specific run to show with show_runs.'),
  reveal: z.boolean().optional().describe('Show the corresponding view beside the conversation. Use when the user wants to see it.'),
  deviceId: z.string().max(220).optional().describe('Exact device ID returned by devices. Only used by select_device.'),
  appId: z.string().max(200).optional().describe('Android package or Apple bundle identifier for launch_app, or the known identifier when using install_app.'),
  artifact: z.string().max(4096).optional().describe('A built .apk or simulator .app for install_app. For SSH devices, use an absolute path on the named host.'),
  refresh: z.boolean().optional().describe('Refresh device discovery after setting up a runtime or connecting a device.'),
  machineId: z.string().max(36).optional().describe('Registered VirtualBox machine UUID from machines for start_machine.'),
  input: deviceInputSchema.optional().describe('Touch coordinates are normalized fractions of the latest device capture.'),
  browser: previewActionSchema.optional().describe('Action for the currently visible local browser preview. Touch and scroll coordinates are fractions of the last snapshot.'),
});

export const workspaceWorkbenchTool: ToolDefinition = {
  name: 'workspace_workbench',
  category: 'workspace',
  description: 'Show development activity, publish loopback web/API targets, and use a real local device or simulator from an enabled SSH host.',
  modelDescription: 'Use for live app previews and development devices, including saved SSH hosts. Discover the target first. For preview, simulator, or SSH setup, load development_workbench once with get_skill_guidelines if available. Use workspace_run_command to start processes.',
  inputSchema,
  outputSchema: z.object({ success: z.boolean(), error: z.string().optional() }).passthrough(),
  execute: async (raw, context) => {
    try {
      const input = inputSchema.parse(raw);
      const chatId = String(context?.ownerChatId || context?.chatId || context?.projectId || '').trim();
      if (!chatId) throw new Error('This tool requires an active chat.');
      if (context?.abortSignal?.aborted) throw new Error('This request was cancelled.');
      if (input.action === 'activity') {
        const activity = await workbenchActivity(chatId);
        return { success: true, ...activity, tasks: activity.tasks.slice(0, 20) };
      }
      if (input.action === 'show_runs') {
        const task = input.taskId ? (await workbenchActivity(chatId)).tasks.find(item => item.id === input.taskId) : undefined;
        if (input.taskId && !task) {
          throw new Error('That managed task is unavailable in this chat.');
        }
        revealWorkbenchRuns(chatId, input.taskId);
        return { success: true, ...(task && { task: { id: task.id, command: task.command } }) };
      }
      if (input.action === 'publish') {
        const url = localWorkbenchUrl(input.url || '').href;
        if (input.taskId && !(await workbenchActivity(chatId)).tasks.some(task => task.id === input.taskId)) {
          throw new Error('That managed task is unavailable in this chat. Publish without a taskId if the service was started elsewhere.');
        }
        const target = { url, label: input.label, kind: input.target || 'web', taskId: input.taskId };
        publishWorkbenchTarget(chatId, target, input.reveal === true);
        return { success: true, target };
      }
      if (!desktopWorkbenchEnabled()) throw new Error('Preview and device controls are available in EterX Desktop on the development host.');
      if (input.action === 'browser') {
        const allowed = enforceToolCapability('browser_control', undefined, context);
        if (!allowed.allowed) throw new Error(allowed.reason || 'Browser control is unavailable.');
        if (!input.browser) throw new Error('Provide an action for the local browser preview.');
        return await queuePreviewJob(chatId, input.browser.kind === 'navigate'
          ? { ...input.browser, url: localWorkbenchUrl(input.browser.url).href } : input.browser, context?.abortSignal);
      }
      if (isComputerUseDisabled() || context?.computerUseEnabled === false || context?.allowHostControl === false) {
        throw new Error('Device automation requires Computer Use to be enabled for this agent.');
      }
      if (input.action === 'machines') return { success: true, ...await listLocalMachines() };
      if (input.action === 'start_machine') {
        const machine = await startLocalMachine(input.machineId || '');
        setWorkbenchMachine(chatId, machine);
        return { success: true, machineId: machine.id, machine };
      }
      const localOnly = context?.networkPolicy === 'deny' && context?.allowNetwork !== true;
      if (input.action === 'devices') return { success: true, ...await listWorkbenchDevices(input.refresh === true, localOnly) };
      if (input.action === 'select_device') {
        if (localOnly && input.deviceId?.includes('/')) throw new Error('Network access is disabled for this run. Choose a local device.');
        const device = await resolveWorkbenchDevice(input.deviceId || '');
        setWorkbenchDevice(chatId, device, input.reveal === true);
        return { success: true, device };
      }
      const selected = readWorkbench(chatId);
      const id = selected.deviceId;
      if (!id) throw new Error('Select the intended device before using it.');
      if (localOnly && id.includes('/')) throw new Error('Network access is disabled for this run. Choose a local device.');
      const device = selected.device && { name: selected.device.name, hostLabel: selected.device.hostLabel };
      if (input.action === 'capture') {
        const frame = await captureWorkbenchDevice(id);
        return { success: true, deviceId: id, device, width: frame.width, height: frame.height, vision: { inlineData: { data: frame.png.toString('base64'), mimeType: 'image/png' } } };
      }
      if (input.action === 'start_device') {
        const status = await startWorkbenchDevice(id);
        return { success: true, deviceId: id, device, actionStatus: status, message: status === 'ready' ? 'The device is already ready.' : 'Boot requested. Use devices to see when it is ready.' };
      }
      if (input.action === 'stop_device') {
        return { success: true, deviceId: id, device, actionStatus: await stopWorkbenchDevice(id) };
      }
      if (input.action === 'install_app') {
        if (!input.artifact?.trim()) throw new Error('Provide the path to the built app on its device host.');
        const artifact = id.includes('/') ? input.artifact : resolveReadableWorkspacePathForContext(input.artifact, context);
        const appId = await installWorkbenchDeviceApp(id, artifact, input.appId);
        return { success: true, deviceId: id, device, appId };
      }
      if (input.action === 'launch_app') await launchWorkbenchDeviceApp(id, input.appId || '');
      if (input.action === 'input') {
        if (!input.input) throw new Error('Provide a device input.');
        await sendWorkbenchDeviceInput(id, input.input);
      }
      return { success: true, deviceId: id, device };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
