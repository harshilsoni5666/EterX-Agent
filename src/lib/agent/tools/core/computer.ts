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
import { cuaDriverProvider, getCuaDriverStatus } from '../../computer/cua-driver';
import { enforceToolCapability } from '../security/tool_policy';

async function executePortableComputerAction(action: string, input: any, ctx: any, chatId?: string) {
  const { screenAgentTool } = await import('./screen_agent');
  const appName = String(input.app || (['type_into', 'read_text', 'click_in'].includes(action) ? '' : input.text) || '').trim();
  const invoke = (screenAction: string, extra: Record<string, any> = {}) => (
    screenAgentTool as any
  ).execute({ ...input, app: appName || undefined, ...extra, action: screenAction, chatId }, ctx);

  if (action === 'get_stats') {
    const { getLiveStreamStats, isLiveStreaming } = await import('../../computer/live-stream');
    return {
      success: true,
      action,
      result: {
        provider: (await getCuaDriverStatus()).installed ? cuaDriverProvider() : 'Not configured',
        streaming: isLiveStreaming(),
        streamStats: getLiveStreamStats(),
        monitorStats: monitorEmitter.getStats(),
      },
    };
  }

  if (action === 'see_window') {
    return { ...(await invoke('see', { scope: 'window' })), action };
  }

  if (action === 'find_app') {
    const listed = await invoke('list_apps');
    const apps = Array.isArray(listed.result) ? listed.result : [];
    const needle = appName.toLowerCase();
    if (!listed.success) return { ...listed, action };
    if (!needle) return { success: false, action, result: 'An app name or window title is required.' };
    const matches = apps.filter((app: any) => JSON.stringify(app).toLowerCase().includes(needle));
    return matches.length
      ? { success: true, action, result: matches.length === 1 ? matches[0] : { matches, next: 'Select an exact pid and window_id.' } }
      : { success: false, action, result: `App not found: "${appName}"` };
  }

  if (action === 'connect') {
    if (!appName) return { success: false, action, result: 'An app name or window title is required.' };
    const listed = await invoke('list_apps');
    if (!listed.success) return { ...listed, action };
    const exists = Array.isArray(listed.result) && listed.result.some((app: any) => JSON.stringify(app).toLowerCase().includes(appName.toLowerCase()));
    const connected = exists ? await invoke('see', { scope: 'window' }) : await invoke('launch_app', { text: appName });
    if (connected.success) monitorEmitter.appConnected(appName, undefined, appName, chatId);
    return { ...connected, action };
  }

  if (action === 'type_into' || action === 'click_in') {
    const control = String(input.control || input.filter || (action === 'click_in' ? input.text : '') || '').trim();
    if (control && !input.element_token) {
      const found = await invoke('find', { query: control });
      if (!found.success) return { ...found, action };
      const matches = Array.isArray(found.result?.matches) ? found.result.matches : [];
      const exact = matches.filter((item: any) => String(item.text).toLowerCase() === control.toLowerCase());
      const candidates = exact.length ? exact : matches;
      if (candidates.length !== 1 || !candidates[0].element_token || candidates[0].enabled === false) {
        return { ...found, success: false, action, result: { matches, message: 'Choose one enabled control from get_controls and pass its element_token.' } };
      }
      return { ...(await invoke(action === 'type_into' ? 'type' : 'click', {
        element_token: candidates[0].element_token, x: undefined, y: undefined,
        ...found.observation?.target,
      })), action };
    }
    return { ...(await invoke(action === 'type_into' ? 'type' : 'click')), action };
  }

  const screenAction: Record<string, string> = {
    see: 'see',
    stream_start: 'stream_start',
    stream_stop: 'stream_stop',
    list_apps: 'list_apps',
    focus_app: 'focus_app',
    launch_app: 'launch_app',
    open_file: 'open_file',
    open_url: 'open_url',
    read_text: 'read',
    get_controls: 'get_controls',
    get_active: 'get_active',
  };
  const mapped = screenAction[action];
  if (!mapped) return { success: false, action, result: `Action ${action} is not supported by the portable desktop provider.` };
  return { ...(await invoke(mapped, { text: action === 'read_text' ? input.text : appName })), action };
}

export const computerTool: ToolDefinition = {
  name: 'computer',
  description: `Inspect and control native desktop apps on Windows, macOS and Linux when Computer Use is enabled for this task.
Start with list_apps, then see_window with a unique app/title or exact pid and window_id. The returned observation and screenshot refer to that window; selecting it does not raise it. focus_app explicitly raises it.
get_controls returns accessibility labels, roles and element_token values. read_text reads the selected window. click_in and type_into accept a fresh element_token or a unique control name; ambiguous matches are returned for selection. Pixel input uses coordinates from the latest screenshot of that same target.
connect selects an existing app window or requests an app launch. launch_app reports the actual launch state; a launch request alone does not prove a window is ready. In the desktop app, open_file opens an absolute file/folder/application path and open_url opens an HTTP(S) URL with its default app. Select and observe the resulting window before input. get_active reports the foreground window and selected target. see captures the selected target; scope=desktop explicitly returns to the desktop. stream_start/stream_stop control the preview; get_stats reports runtime information.
Desktop and browser access are separate settings. Use screen_agent for detailed mouse, keyboard and wait actions. An input being sent is not proof of the requested result; inspect the returned observation. If observation fails after input, observe again before repeating the action.`,

  category: 'core',

  inputSchema: z.object({
    action: z.enum([
      'see', 'see_window', 'stream_start', 'stream_stop',
      'list_apps', 'find_app', 'focus_app', 'launch_app', 'open_file', 'open_url', 'connect',
      'get_controls', 'read_text', 'type_into', 'click_in',
      'get_active', 'get_stats',
    ]).describe('Action to perform'),
    app: z.string().optional().describe('App name or window title'),
    scope: z.enum(['desktop', 'window']).optional().describe('Selected target scope; omitted retains this chat’s selected window'),
    pid: z.number().int().positive().optional().describe('Process ID from list_apps; pass with window_id'),
    window_id: z.number().int().positive().optional().describe('Exact window ID from list_apps; pass with pid'),
    element_token: z.string().optional().describe('Fresh control token from the latest observation of this window'),
    capture_id: z.string().optional().describe('Capture ID associated with the screenshot used for coordinates'),
    delivery_mode: z.enum(['background', 'foreground']).optional().describe('Explicitly choose foreground when the intended app requires visible input; delivery mode is never changed automatically'),
    control: z.string().optional().describe('Control name to interact with'),
    path: z.string().optional().describe('Absolute file, folder or application path for open_file'),
    url: z.string().optional().describe('HTTP or HTTPS URL for open_url'),
    max_elements: z.number().int().min(1).max(2000).optional().describe('Accessibility walk limit; prefer filter before expanding a truncated tree'),
    text: z.string().optional().describe('Text to type or app/control to find'),
    delay_ms: z.number().int().min(0).max(200).optional().describe('Inter-character typing delay; default 10 ms, 0 for fastest delivery'),
    fps: z.number().min(1).max(20).optional().describe('Stream frames per second'),
    quality: z.number().min(10).max(95).optional().describe('JPEG quality 10-95'),
    maxWidth: z.number().int().min(320).max(4096).optional().describe('Maximum screenshot dimension; default 1920 pixels'),
    x: z.number().optional().describe('X coordinate for portable click actions'),
    y: z.number().optional().describe('Y coordinate for portable click actions'),
    filter: z.string().optional().describe('Filter controls by name'),
    chatId: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    result: z.any(),
    vision: z.object({
      inlineData: z.object({ data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg']) }),
    }).nullable().optional(),
    observation: z.record(z.string(), z.any()).optional(),
    observationError: z.string().optional(),
    provider: z.string().optional(),
    actionStatus: z.enum(['not_sent', 'sent', 'unknown']).optional(),
  }),

  execute: async (input: any, ctx: any) => {
    const action = input.action;
    const chatId = ctx?.chatId || ctx?.projectId || input.chatId;
    const decision = enforceToolCapability('computer', input, ctx);
    if (!decision.allowed) {
      return { success: false, action, result: decision.reason || 'Computer control is not allowed' };
    }

    try {
      if (process.platform !== 'win32' || (ctx?.allowHostControl === true && ctx?.computerUseEnabled !== false)) {
        return await executePortableComputerAction(action, input, ctx, chatId);
      }

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
