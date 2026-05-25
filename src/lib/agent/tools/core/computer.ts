import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { monitorEmitter } from '../../monitor/emitter';
import { isUnsafeHostControlEnabled } from '../../computer/computer-session';
import {
  focusManagedApp,
  getManagedComputerStatus,
  launchManagedApp,
  listManagedWindows,
  typeManagedText,
} from '../../computer/managed-computer';

export const computerTool: ToolDefinition = {
  name: 'computer',
  description: `ETERX COMPUTER CONTROL - safe app control inside the isolated EterX Computer.

Default behavior is isolated and does not move the host mouse, type into host apps, launch host apps, or attach to the user's real Chrome.

ACTIONS:
  see          - capture the isolated EterX Computer screen
  see_window   - focus a managed app, then capture the isolated screen
  stream_start - stream isolated EterX Computer frames to the monitor
  stream_stop  - stop streaming
  list_apps    - list windows inside EterX Computer
  find_app     - find a managed window by title
  focus_app    - focus a managed app
  launch_app   - launch an app inside EterX Computer
  connect      - focus or launch a managed app
  read_text    - list managed window titles
  type_into    - type into the focused managed app
  get_active   - return managed computer status

Host UI Automation actions (get_controls and click_in) are disabled unless ETERX_ALLOW_UNSAFE_HOST_COMPUTER=1 is set.`,

  category: 'core',

  inputSchema: z.object({
    action: z.enum([
      'see', 'see_window', 'stream_start', 'stream_stop',
      'list_apps', 'find_app', 'focus_app', 'launch_app', 'connect',
      'get_controls', 'read_text', 'type_into', 'click_in',
      'get_active', 'get_stats',
    ]).describe('Action to perform'),
    app: z.string().optional().describe('App name or window title'),
    control: z.string().optional().describe('Control name to interact with'),
    text: z.string().optional().describe('Text to type or app/control to find'),
    fps: z.number().min(1).max(20).optional().describe('Stream frames per second'),
    quality: z.number().min(10).max(95).optional().describe('JPEG quality 10-95'),
    maxWidth: z.number().optional().describe('Max frame width in px'),
    filter: z.string().optional().describe('Filter controls by name'),
    chatId: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    result: z.any(),
    vision: z.object({
      inlineData: z.object({ data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg']) }),
    }).optional(),
  }),

  execute: async (input: any, ctx: any) => {
    const action = input.action;
    const chatId = input.chatId || ctx?.chatId;

    try {
      switch (action) {
        case 'see': {
          const { captureFrameForVision } = await import('../../computer/live-stream');
          const frame = await captureFrameForVision(input.quality || 82, input.maxWidth || 1280, chatId || '');
          if (!frame) return { success: false, action, result: 'EterX Computer frame capture failed.' };
          return {
            success: true,
            action,
            result: 'EterX Computer captured',
            vision: { inlineData: { data: frame, mimeType: 'image/jpeg' as const } },
          };
        }

        case 'see_window': {
          if (!isUnsafeHostControlEnabled()) {
            const appTitle = input.app || input.text || '';
            if (appTitle) await focusManagedApp(appTitle, chatId);
            const { captureFrameForVision } = await import('../../computer/live-stream');
            const frame = await captureFrameForVision(input.quality || 82, input.maxWidth || 1280, chatId || '');
            if (!frame) return { success: false, action, result: 'EterX Computer frame capture failed.' };
            return {
              success: true,
              action,
              result: appTitle ? `Managed app "${appTitle}" captured` : 'EterX Computer captured',
              vision: { inlineData: { data: frame, mimeType: 'image/jpeg' as const } },
            };
          }

          const { captureWindow } = await import('../../computer/computer-use-engine');
          const appTitle = input.app || input.text || '';
          const shot = await captureWindow(appTitle, 'agent_see_window', chatId);
          if (!shot) return { success: false, action, result: `Could not capture window: "${appTitle}"` };
          return {
            success: true,
            action,
            result: `Window "${appTitle}" captured`,
            vision: { inlineData: { data: shot.base64, mimeType: 'image/png' as const } },
          };
        }

        case 'stream_start': {
          const { startLiveStream } = await import('../../computer/live-stream');
          await startLiveStream({
            fps: input.fps || 8,
            quality: input.quality || 80,
            maxWidth: input.maxWidth || 1280,
            chatId: chatId || '',
          });
          return { success: true, action, result: 'EterX Computer live stream started' };
        }

        case 'stream_stop': {
          const { stopLiveStream, getLiveStreamStats } = await import('../../computer/live-stream');
          const stats = getLiveStreamStats();
          stopLiveStream();
          return { success: true, action, result: `Stream stopped. ${stats?.framesSent || 0} frames sent, ${stats?.kbStreamed || 0} KB` };
        }

        case 'list_apps':
          if (!isUnsafeHostControlEnabled()) {
            return { success: true, action, result: await listManagedWindows(chatId) };
          }
          break;

        case 'find_app':
          if (!isUnsafeHostControlEnabled()) {
            const appName = String(input.app || input.text || '').toLowerCase();
            const app = (await listManagedWindows(chatId)).find((win) => win.title.toLowerCase().includes(appName));
            if (!app) return { success: false, action, result: `Managed app not found: "${input.app || input.text || ''}"` };
            return { success: true, action, result: app };
          }
          break;

        case 'focus_app':
          if (!isUnsafeHostControlEnabled()) {
            const result = await focusManagedApp(input.app || input.text || '', chatId);
            return { success: result.success, action, result: result.result };
          }
          break;

        case 'launch_app':
          if (!isUnsafeHostControlEnabled()) {
            const result = await launchManagedApp(input.app || input.text || '', undefined, chatId);
            return { success: result.success, action, result: result.result };
          }
          break;

        case 'connect':
          if (!isUnsafeHostControlEnabled()) {
            const appName = input.app || input.text || '';
            let result = await focusManagedApp(appName, chatId);
            if (!result.success) result = await launchManagedApp(appName, undefined, chatId);
            if (!result.success) return { success: false, action, result: result.result };
            monitorEmitter.appConnected(appName, undefined, appName, chatId);
            return { success: true, action, result: { connected: appName, provider: 'isolated_eterx_computer' } };
          }
          break;

        case 'get_controls':
          if (!isUnsafeHostControlEnabled()) {
            return { success: false, action, result: 'Named UI control enumeration is not available in isolated EterX Computer yet. Use screen_agent find/click or coordinate actions inside the managed screen.' };
          }
          break;

        case 'read_text':
          if (!isUnsafeHostControlEnabled()) {
            const windows = await listManagedWindows(chatId);
            return { success: true, action, result: windows.length ? windows.map((win) => win.title).join('\n') : 'No managed app windows are open.' };
          }
          break;

        case 'type_into':
          if (!isUnsafeHostControlEnabled()) {
            const result = await typeManagedText(input.text || '', chatId);
            return { success: result.success, action, result: result.result };
          }
          break;

        case 'click_in':
          if (!isUnsafeHostControlEnabled()) {
            return { success: false, action, result: 'Named control click is not available in isolated EterX Computer yet. Use screen_agent click with coordinates from the live screen.' };
          }
          break;

        case 'get_active':
          if (!isUnsafeHostControlEnabled()) {
            return {
              success: true,
              action,
              result: {
                provider: 'isolated_eterx_computer',
                status: getManagedComputerStatus(chatId),
                windows: await listManagedWindows(chatId),
              },
            };
          }
          break;

        case 'get_stats': {
          const { getLiveStreamStats, isLiveStreaming } = await import('../../computer/live-stream');
          return {
            success: true,
            action,
            result: {
              provider: isUnsafeHostControlEnabled() ? 'unsafe_host_desktop' : 'isolated_eterx_computer',
              streaming: isLiveStreaming(),
              streamStats: getLiveStreamStats(),
              managedComputer: getManagedComputerStatus(chatId),
              monitorStats: monitorEmitter.getStats(),
            },
          };
        }

        default:
          return { success: false, action, result: `Unknown action: ${action}` };
      }

      const { appConnector } = await import('../../computer/app-connector');
      const appName = input.app || input.text || '';

      switch (action) {
        case 'list_apps': {
          const apps = await appConnector.listApps();
          return {
            success: true,
            action,
            result: apps.map((a: any) => ({ name: a.name, title: a.title, pid: a.pid, focused: a.isFocused })),
          };
        }
        case 'find_app': {
          const app = await appConnector.findApp(appName);
          if (!app) return { success: false, action, result: `App not found: "${appName}"` };
          return { success: true, action, result: { name: app.name, title: app.title, pid: app.pid, x: app.x, y: app.y, width: app.width, height: app.height } };
        }
        case 'focus_app': {
          const ok = await appConnector.focusApp(appName, chatId);
          return { success: ok, action, result: ok ? `Focused: ${appName}` : `App not found: "${appName}"` };
        }
        case 'launch_app': {
          const app = await appConnector.launchApp(appName, undefined, chatId);
          return { success: !!app, action, result: app ? `Launched: ${app.name} (PID ${app.pid})` : `Failed to launch: "${appName}"` };
        }
        case 'connect': {
          const ok = await appConnector.focusApp(appName, chatId);
          if (!ok) return { success: false, action, result: `App not found: "${appName}"` };
          const controls = await appConnector.getAppControls(appName, undefined);
          monitorEmitter.appConnected(appName, undefined, appName, chatId);
          return {
            success: true,
            action,
            result: {
              connected: appName,
              controlCount: controls.length,
              topControls: controls.slice(0, 10).map((c: any) => ({ name: c.name, type: c.controlType, at: { x: c.centerX, y: c.centerY } })),
            },
          };
        }
        case 'get_controls': {
          const controls = await appConnector.getAppControls(appName, input.filter);
          return {
            success: true,
            action,
            result: controls.map((c: any) => ({
              name: c.name,
              type: c.controlType,
              value: c.value,
              center: { x: c.centerX, y: c.centerY },
              size: { w: c.width, h: c.height },
              enabled: c.isEnabled,
            })),
          };
        }
        case 'read_text': {
          const text = await appConnector.readAppText(appName);
          return { success: !!text, action, result: text || `No readable text found in "${appName}"` };
        }
        case 'type_into': {
          const ok = await appConnector.typeIntoApp(input.app || '', input.control || input.filter || '', input.text || '');
          return { success: ok, action, result: ok ? `Typed into "${input.control || input.filter || ''}" in ${input.app || ''}` : `Failed to find control "${input.control || input.filter || ''}"` };
        }
        case 'click_in': {
          const ok = await appConnector.clickInApp(input.app || '', input.control || input.text || '');
          return { success: ok, action, result: ok ? `Clicked "${input.control || input.text || ''}" in ${input.app || ''}` : `Failed to find control "${input.control || input.text || ''}"` };
        }
        case 'get_active': {
          const { getActiveWindowTitle } = await import('../../computer/live-stream');
          const title = await getActiveWindowTitle();
          const app = title ? await appConnector.findApp(title) : null;
          return { success: true, action, result: { title, app: app ? { name: app.name, pid: app.pid } : null } };
        }
        default:
          return { success: false, action, result: `Unknown action: ${action}` };
      }
    } catch (e: any) {
      return { success: false, action, result: `Error: ${e.message?.substring(0, 300)}` };
    }
  },
};
