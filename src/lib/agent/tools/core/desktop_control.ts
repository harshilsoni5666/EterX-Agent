import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { screenAgentTool } from './screen_agent';
import { enforceToolCapability } from '../security/tool_policy';

const ACTION_MAP: Record<string, string> = {
  screenshot: 'see',
  capture_region: 'see_region',
  click_at: 'click',
  mouse_move: 'hover',
  drag: 'drag',
  type_text: 'type',
  press_key: 'key',
  hotkey: 'key',
  scroll_up: 'scroll',
  scroll_down: 'scroll',
  list_windows: 'list_apps',
  focus_window: 'focus_app',
  launch_app: 'launch_app',
  open_url: 'open_url',
  clipboard_read: 'clipboard_get',
  clipboard_write: 'clipboard_set',
  minimize_window: 'minimize',
  maximize_window: 'maximize',
  close_window: 'close_window',
  wait: 'wait_ms',
  wait_for_window: 'wait_text',
  get_mouse_position: 'get_cursor',
  open_start_menu: 'key',
  open_run_dialog: 'key',
};

function mapArgs(action: string, input: any): Record<string, any> {
  const mapped: Record<string, any> = {};
  if (input.x != null) mapped.x = input.x;
  if (input.y != null) mapped.y = input.y;
  if (input.toX != null) mapped.x2 = input.toX;
  if (input.toY != null) mapped.y2 = input.toY;
  if (input.text != null) mapped.text = input.text;
  if (input.key != null) mapped.text = input.key;
  if (input.keys != null) mapped.text = Array.isArray(input.keys) ? input.keys.join('+') : input.keys;
  if (input.app != null) mapped.text = input.app;
  if (input.title != null && !mapped.text) mapped.text = input.title;
  if (action === 'scroll_up') {
    mapped.direction = 'up';
    mapped.amount = input.amount ?? 3;
  }
  if (action === 'scroll_down') {
    mapped.direction = 'down';
    mapped.amount = input.amount ?? 3;
  }
  if (input.width != null) mapped.width = input.width;
  if (input.height != null) mapped.height = input.height;
  if (input.ms != null || input.milliseconds != null) mapped.ms = input.ms ?? input.milliseconds ?? 1000;
  if (input.windowTitle != null) mapped.text = input.windowTitle;
  if (action === 'open_url' && input.url) mapped.url = input.url;
  if (action === 'open_start_menu') mapped.text = process.platform === 'darwin' ? 'cmd+space' : process.platform === 'win32' ? 'win' : 'super';
  if (action === 'open_run_dialog') mapped.text = process.platform === 'darwin' ? 'cmd+space' : process.platform === 'win32' ? 'win+r' : 'alt+F2';
  return mapped;
}

export const desktopControlTool: ToolDefinition = {
  name: 'desktop_control',
  description: 'Compatibility router for desktop control actions. Routes to screen_agent, which controls the isolated EterX Computer by default and requires explicit host-control capability for real host desktop automation.',
  category: 'core',
  inputSchema: z.object({
    action: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    keys: z.union([z.string(), z.array(z.string())]).optional(),
    app: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    amount: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    ms: z.number().optional(),
    milliseconds: z.number().optional(),
    windowTitle: z.string().optional(),
    chatId: z.string().optional(),
  }),
  outputSchema: z.any(),
  execute: async (input: any, context?: any) => {
    const decision = enforceToolCapability('desktop_control', input, context);
    if (!decision.allowed) {
      return {
        success: false,
        action: String(input?.action || 'unknown'),
        result: decision.reason || 'Desktop control is not allowed',
      };
    }

    const oldAction = String(input.action || 'screenshot');
    const screenAction = ACTION_MAP[oldAction] || 'see';
    const mappedArgs = mapArgs(oldAction, input);
    return (screenAgentTool as any).execute(
      { action: screenAction, ...mappedArgs, chatId: input.chatId ?? context?.chatId },
      context,
    );
  },
};
