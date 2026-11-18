import { createHash, randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import path from 'path';
import { cuaDriverProvider, ensureCuaDriverDaemon, type CuaActionResult } from './cua-driver';
import { CuaConnection } from './cua-connection';
import { CuaToolError, type CuaResponse } from './cua-response';
import { MAX_DESKTOP_IMAGE_BASE64_LENGTH } from './tool-vision';
import { getPlatformShortcut, normalizeShortcutForPlatform } from './platform-shortcuts';
import { isComputerUseDisabled } from '../builtin-agent-tool-policy';

type Target = { scope: 'desktop' } | { scope: 'window'; pid: number; window_id: number; app?: string; title?: string };
type Vision = NonNullable<CuaActionResult['vision']>;
type Frame = { vision: Vision; metadata: Record<string, any>; width?: number; height?: number };
type Session = {
  target: Target;
  observation?: Record<string, any>;
  tokens: Set<string>;
  frameHash?: string;
  connections: Map<string, CuaConnection>;
  frameConnection?: CuaConnection;
};
type ActionOptions = {
  chatId?: string; signal?: AbortSignal; deadline?: number; maxElements?: number; maxImageDimension?: number;
  preview?: boolean;
  onDispatch?: () => void;
  defaultTypingDelay?: boolean;
  openTarget?: (kind: 'url' | 'path', target: string) => Promise<unknown>;
};

// Desktop state is shared by OS processes. Serialize complete observe/action
// transactions, including calls from different chats, and retain state per chat.
const runtime = globalThis as typeof globalThis & {
  __eterxCuaActions?: { tail: Promise<void>; sessions: Map<string, Session>; pending?: number };
};
const shared: NonNullable<typeof runtime.__eterxCuaActions> = runtime.__eterxCuaActions ||= { tail: Promise.resolve(), sessions: new Map() };

async function exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  shared.pending = (shared.pending || 0) + 1;
  const previous = shared.tail;
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  // A cancelled waiter can return immediately without letting the next caller
  // overtake the action that still owns the desktop.
  shared.tail = previous.then(() => finished);
  let onAbort: (() => void) | undefined;
  try {
    await (signal ? Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason || new Error('Computer action cancelled.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]) : previous);
    signal?.throwIfAborted();
    return await work();
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    shared.pending = Math.max(0, (shared.pending || 1) - 1);
    release();
  }
}

function sessionFor(chatId = ''): Session {
  const existing = shared.sessions.get(chatId);
  if (existing) { existing.connections ||= new Map(); return existing; }
  // The owning run closes its native sessions on stop, cancellation or exit.
  // A paused preview or another active chat must not evict this selection.
  const state: Session = { target: { scope: 'desktop' }, tokens: new Set(), connections: new Map() };
  shared.sessions.set(chatId, state);
  return state;
}

async function releaseSession(chatId: string) {
  const state = shared.sessions.get(chatId);
  shared.sessions.delete(chatId);
  await Promise.allSettled(Array.from(state?.connections?.values() || [], connection => connection.close()));
}

const captureOptions = new Set(['max_image_dimension', 'include_screenshot', 'include_accessibility_tree',
  'screenshot_format', 'display_only', 'tree_format', 'max_depth', 'max_elements', 'query']);

async function callResponse(tool: string, input: Record<string, unknown>, options: ActionOptions, timeout = 15_000): Promise<CuaResponse> {
  options.signal?.throwIfAborted();
  const requestOptions = () => {
    const remaining = options.deadline == null ? timeout : Math.min(timeout, options.deadline - Date.now());
    if (remaining <= 0) throw new Error('The desktop observation deadline expired.');
    return { signal: options.signal, timeout: remaining };
  };
  const state = options.preview ? shared.sessions.get(options.chatId || '') : sessionFor(options.chatId);
  if (!state) throw new Error('Native desktop session ended.');
  const { target, ...args } = input;
  const selected = target as { kind: 'desktop' | 'window'; pid?: number; window_id?: number } | undefined;
  const scope = selected?.kind || (tool === 'get_cursor_position' || tool === 'get_desktop_state' ? 'desktop' : 'window');
  const key = `${options.preview ? 'preview' : 'action'}-${scope}`;
  let connection = state.connections.get(key);
  if (!connection || connection.closed) {
    const status = await ensureCuaDriverDaemon();
    options.signal?.throwIfAborted();
    if (!status.installed || !status.daemonRunning) throw new CuaToolError(status.message, true);
    connection = await CuaConnection.open(`eterx-${randomUUID()}`, scope, requestOptions());
    if (shared.sessions.get(options.chatId || '') !== state || options.signal?.aborted) {
      await connection.close();
      throw new Error('Native desktop session ended.');
    }
    state.connections.set(key, connection);
  }
  if (selected && connection.supports(tool, 'target')) {
    args.target = selected;
  } else if (selected && (!args.element_token || connection.requires(tool, 'pid') || connection.requires(tool, 'window_id'))) {
    if (scope === 'window' && connection.supports(tool, 'pid') && connection.supports(tool, 'window_id')) {
      args.pid = selected.pid;
      args.window_id = selected.window_id;
    } else if (scope === 'desktop' && connection.supports(tool, 'scope')) args.scope = 'desktop';
    else throw new CuaToolError(`This driver cannot address the selected ${scope} with ${tool}.`, true);
  }
  if (tool === 'launch_app' && typeof args.name === 'string') {
    const name = args.name;
    let field = 'name';
    if (path.isAbsolute(name) && connection.supports(tool, 'path')) field = 'path';
    else if (process.platform === 'win32' && /^[^!\s]+![^!\s]+$/.test(name) && connection.supports(tool, 'aumid')) field = 'aumid';
    else if (process.platform === 'darwin' && /^[\w-]+(?:\.[\w-]+){2,}$/.test(name) && connection.supports(tool, 'bundle_id')) field = 'bundle_id';
    if (field !== 'name') { delete args.name; args[field] = name; }
  }
  if (selected?.kind === 'desktop') {
    if (args.delivery_mode === 'background') throw new CuaToolError('Desktop input addresses the foreground. Select a window for background delivery.', true);
    if (connection.supports(tool, 'delivery_mode')) args.delivery_mode = 'foreground';
    else delete args.delivery_mode; // A desktop-scoped action intrinsically targets the foreground.
  } else if (!args.delivery_mode && connection.requires(tool, 'delivery_mode')) {
    args.delivery_mode = 'background';
  }
  if (tool === 'get_window_state' || tool === 'get_desktop_state') {
    for (const field of captureOptions) if (!connection.supports(tool, field)) delete args[field];
  }
  if (!connection.supports(tool, 'capture_id')) delete args.capture_id;
  if (options.defaultTypingDelay && !connection.supports(tool, 'delay_ms')) delete args.delay_ms;
  for (const field of Object.keys(args)) {
    if (!connection.supports(tool, field)) throw new CuaToolError(`The installed driver's ${tool} tool does not support ${field} for this target.`, true);
  }
  return connection.call(tool, args, requestOptions(), options.onDispatch);
}

async function call(tool: string, input: Record<string, unknown>, options: ActionOptions, timeout = 15_000) {
  return (await callResponse(tool, input, options, timeout)).value;
}

function readFrame(reply: CuaResponse): Frame {
  const metadata = reply.value && typeof reply.value === 'object' && !Array.isArray(reply.value) ? reply.value : {};
  const data = reply.image?.data;
  if (!data) {
    const reason = metadata.screenshot_error || metadata.degraded_reason || metadata.message;
    throw new Error(reason ? `Cua Driver could not supply the screenshot. ${String(reason).slice(0, 600)}` : 'Cua Driver returned no screenshot for this target.');
  }
  if (data.length > MAX_DESKTOP_IMAGE_BASE64_LENGTH) throw new Error('The captured image exceeds the EterX image limit. Select the target window or request a smaller maxWidth on drivers that support it.');
  // The provider accepts this base64 directly. Only the header needs decoding.
  const header = Buffer.from(data.slice(0, 48), 'base64');
  const png = data.length > 48 && header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && header.toString('ascii', 12, 16) === 'IHDR';
  const jpeg = data.length > 48 && header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (!png && !jpeg) throw new Error('Cua Driver returned invalid screenshot bytes. Capture a fresh image before any further input.');
  return {
    metadata,
    vision: { inlineData: { data, mimeType: png ? 'image/png' : 'image/jpeg' } },
    width: png ? header.readUInt32BE(16) : metadata.screenshot_width,
    height: png ? header.readUInt32BE(20) : metadata.screenshot_height,
  };
}

function identity(target: Target): Record<string, unknown> {
  return target.scope === 'window' ? { pid: target.pid, window_id: target.window_id } : {};
}

function inputTarget(target: Target): Record<string, unknown> {
  return { target: target.scope === 'window'
    ? { kind: 'window', pid: target.pid, window_id: target.window_id }
    : { kind: 'desktop', display_id: 'primary' } };
}

function sameTarget(a: Target, b: Target): boolean {
  return a.scope === b.scope && (a.scope === 'desktop' || (b.scope === 'window' && a.pid === b.pid && a.window_id === b.window_id));
}

function bind(state: Session, target: Target) {
  if (!sameTarget(state.target, target)) {
    state.observation = undefined;
    state.tokens.clear();
    state.frameHash = undefined;
  }
  state.target = target;
}

function asWindow(window: any): Target {
  const pid = Number(window?.pid), windowId = Number(window?.window_id);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId <= 0) {
    throw new Error('The driver did not return an exact process and window ID. Use list_apps to select a window.');
  }
  return { scope: 'window', pid, window_id: windowId, app: window.app_name, title: window.title };
}

async function windows(options: ActionOptions): Promise<any[]> {
  const result = await call('list_windows', {}, options);
  const items = Array.isArray(result) ? result : result?.windows;
  if (!Array.isArray(items)) throw new Error('Cua Driver did not return a window list.');
  return items.filter((window: any) => window.title !== 'EterX Computer Use Overlay');
}

function frontmost(items: any[]): any {
  const visible = items.filter(item => item.is_on_screen !== false && item.is_minimized !== true);
  const focused = visible.filter(item => item.is_focused === true || item.focused === true);
  if (focused.length === 1) return focused[0];
  const ranked = visible.filter(item => typeof item.z_index === 'number').sort((a, b) => b.z_index - a.z_index);
  if (ranked.length && (ranked.length === 1 || ranked[0].z_index !== ranked[1].z_index)) return ranked[0];
  if (visible.length === 1) return visible[0];
  throw new Error('The active window is ambiguous. Use list_apps, then pass pid and window_id or a unique app/window title.');
}

async function resolveTarget(input: any, state: Session, options: ActionOptions, requireWindow = false): Promise<Target> {
  if (input.scope === 'desktop') {
    if (requireWindow || input.app || input.pid != null || input.window_id != null) throw new Error('This action needs one window. Do not combine desktop scope with an app or window target.');
    return { scope: 'desktop' };
  }
  if ((input.pid == null) !== (input.window_id == null)) throw new Error('Provide pid and window_id together.');
  if (input.pid != null) return asWindow(input);
  const query = String(input.app || '').trim().toLowerCase();
  if (query) {
    const all = await windows(options);
    const exact = all.filter(item => [item.app_name, item.title].some(value => String(value || '').toLowerCase() === query));
    const matches = exact.length ? exact : all.filter(item => `${item.app_name || ''} ${item.title || ''}`.toLowerCase().includes(query));
    if (matches.length !== 1) throw new Error(matches.length ? 'Several windows match. Use list_apps and select the exact pid and window_id.' : `Window not found: ${input.app}`);
    return asWindow(matches[0]);
  }
  if (state.target.scope === 'window') return state.target;
  if (requireWindow || input.scope === 'window') return asWindow(frontmost(await windows(options)));
  return { scope: 'desktop' };
}

async function capture(target: Target, options: ActionOptions, preview = false, query?: string): Promise<Frame> {
  const reply = await callResponse(target.scope === 'window' ? 'get_window_state' : 'get_desktop_state', {
    ...identity(target),
    max_image_dimension: preview ? 1280 : options.maxImageDimension || 1920,
    ...(target.scope === 'window' ? {
      include_screenshot: true, include_accessibility_tree: !preview, screenshot_format: 'png',
      ...(preview ? { display_only: true } : {
        tree_format: 'elements', max_depth: 25, max_elements: options.maxElements || (query ? 2000 : 250),
        ...(query ? { query } : {}),
      }),
    } : {}),
  }, options);
  return readFrame(reply);
}

function snapshot(state: Session, frame: Frame): Record<string, any> {
  const raw = frame.metadata;
  const elements = (Array.isArray(raw?.elements) ? raw.elements : []).slice(0, 2000).map((element: any) => ({
    element_token: element.element_token,
    element_index: element.element_index,
    parent_index: element.parent_index,
    depth: element.depth,
    role: element.role,
    text: String(element.label || element.name || element.text || element.title || '').slice(0, 1000),
    value: typeof element.value === 'string' ? element.value.slice(0, 2000) : element.value,
    enabled: element.enabled ?? element.is_enabled,
    actions: element.actions,
  }));
  state.tokens = new Set(elements.map((element: any) => element.element_token).filter((token: any): token is string => typeof token === 'string'));
  state.frameHash = createHash('sha256').update(frame.vision.inlineData.data).digest('hex');
  state.frameConnection = state.connections.get(`action-${state.target.scope}`);
  state.observation = {
    target: state.target,
    snapshot_id: raw.snapshot_id,
    capture_id: raw.capture_id,
    coordinateSpace: state.target.scope === 'window' ? 'window screenshot pixels' : 'desktop screenshot pixels',
    width: frame.width, height: frame.height,
    capturedAt: Date.now(),
    elements,
    truncated: raw.truncated === true,
    truncation_reason: raw.truncation_reason,
    elements_complete: raw.elements_complete,
    degraded_reason: raw.degraded_reason,
    ...(typeof raw.tree_markdown === 'string' && !elements.length ? { tree: raw.tree_markdown.slice(0, 16000) } : {}),
  };
  return state.observation;
}

async function observe(state: Session, options: ActionOptions, query?: string): Promise<CuaActionResult> {
  // A capture can replace the driver's snapshot even if its image is lost.
  state.tokens.clear();
  state.observation = undefined;
  state.frameHash = undefined;
  // Legacy accessibility caches are shared by window, even across MCP connections.
  if (state.target.scope === 'window') {
    for (const other of shared.sessions.values()) {
      if (other !== state && sameTarget(other.target, state.target)) {
        other.tokens.clear();
        other.frameHash = undefined;
      }
    }
  }
  const frame = await capture(state.target, options, false, query);
  const observation = snapshot(state, frame);
  return {
    success: true, provider: cuaDriverProvider(), result: 'Current target observed.',
    observation, vision: frame.vision,
    ...(!frame.vision ? { observationError: 'No screenshot was returned. Desktop control requires a visual observation; restore screen capture before acting.' } : {}),
  };
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function point(input: any, state: Session, end = false): Record<string, number> {
  const x = finite(input[end ? 'x2' : 'x'], end ? 'x2' : 'x');
  const y = finite(input[end ? 'y2' : 'y'], end ? 'y2' : 'y');
  const frame = state.observation;
  if (!frame || !state.frameHash) throw new Error('Observe this target with see before sending screenshot coordinates.');
  if (Date.now() - frame.capturedAt > 120_000) throw new Error('The screenshot is old. Observe the target again before sending coordinates.');
  if (x < 0 || y < 0 || (frame.width && x >= frame.width) || (frame.height && y >= frame.height)) {
    throw new Error('Coordinates are outside the returned screenshot. Use its pixel dimensions without adding a window offset or display scale.');
  }
  if (input.capture_id && input.capture_id !== frame.capture_id) throw new Error('The capture_id is stale or belongs to another target. Observe again.');
  return { x, y };
}

function address(input: any, state: Session, needsPoint = false): Record<string, unknown> {
  if (input.element_token) {
    if (input.x != null || input.y != null) throw new Error('Use either an element_token or x and y, not both.');
    if (!state.tokens.has(input.element_token)) throw new Error('This element_token is stale or belongs to another chat/window. Read the target again.');
    return { ...inputTarget(state.target), element_token: input.element_token };
  }
  const target = inputTarget(state.target);
  if (needsPoint || input.x != null || input.y != null) {
    return { ...target, ...point(input, state), ...(state.observation?.capture_id ? { capture_id: state.observation.capture_id } : {}) };
  }
  return target;
}

function normalizedKey(value: string): string {
  const key = value.trim().toLowerCase();
  return ({ esc: 'escape', enter: 'return', ctrl: 'control', cmd: 'command', page_up: 'pageup', page_down: 'pagedown' } as Record<string, string>)[key] || key;
}

const ACTIONS = new Set([
  'see', 'see_region', 'get_controls', 'get_active', 'click', 'right_click', 'double_click', 'drag', 'type', 'key', 'scroll', 'hover',
  'get_cursor', 'list_apps', 'focus_app', 'launch_app', 'find', 'read', 'wait_text', 'wait_change', 'wait_ms',
  'clipboard_get', 'clipboard_set', 'select_all', 'copy', 'paste', 'save', 'undo', 'close_window',
  'open_file', 'open_url', 'set_window_frame', 'set_value', 'invoke_menu',
]);

async function execute(action: string, input: any, options: ActionOptions): Promise<CuaActionResult> {
  if (Number.isInteger(input.max_elements) && input.max_elements > 0) options = { ...options, maxElements: Math.min(input.max_elements, 2000) };
  if (Number.isFinite(input.maxWidth) && input.maxWidth > 0) options = { ...options, maxImageDimension: Math.max(320, Math.min(input.maxWidth, 4096)) };
  const provider = cuaDriverProvider();
  const state = sessionFor(options.chatId);
  const response = (result: unknown, success = true): CuaActionResult => ({ success, result, provider, vision: null });
  let dispatched = false;
  const onDispatch = () => {
    options.signal?.throwIfAborted();
    if (isComputerUseDisabled()) throw new Error('Computer Use was turned off.');
    dispatched = true;
  };
  const mutate = async (tool: string, args: Record<string, unknown>, timeout = 15_000) => {
    const result = await call(tool, args, { ...options, onDispatch,
      defaultTypingDelay: tool === 'type_text' && input.delay_ms == null && !input.speed }, timeout);
    // Input and observation have separate outcomes. A failed screenshot never
    // converts an already delivered click/type into an invitation to repeat it.
    state.tokens.clear();
    state.observation = undefined;
    state.frameHash = undefined;
    try {
      const observed = await observe(state, options);
      return { ...observed, result, actionStatus: 'sent' as const };
    } catch (error: any) {
      return { ...response(result), actionStatus: 'sent' as const, observationError: String(error?.message || error).slice(0, 600) };
    }
  };

  try {
    if (action === 'list_apps') {
      const listed = await windows(options);
      const query = String(input.query || input.filter || input.app || '').trim().toLowerCase();
      return response(query ? listed.filter(item => `${item.app_name || ''} ${item.title || ''}`.toLowerCase().includes(query)) : listed);
    }
    if (action === 'get_cursor') return response({
      ...(await call('get_cursor_position', {}, options)),
      coordinateSpace: 'OS desktop points; use a screenshot for input coordinates.',
    });
    if (action === 'get_active') return response({ activeWindow: frontmost(await windows(options)), selectedTarget: state.target });
    if (action === 'clipboard_get') return response(await call('clipboard_read', { include_text: true }, options));
    if (action === 'clipboard_set') {
      return await mutate('clipboard_write', { text: String(input.text ?? '') });
    }
    if (action === 'open_file' || action === 'open_url') {
      if (!options.openTarget) throw new Error('Opening files and URLs requires the EterX desktop app.');
      const target = String((action === 'open_file' ? input.path : input.url) || input.text || '').trim();
      if (!target) throw new Error(action === 'open_file' ? 'An absolute file, folder or application path is required.' : 'An HTTP or HTTPS URL is required.');
      onDispatch();
      const opened = await options.openTarget(action === 'open_file' ? 'path' : 'url', target);
      bind(state, { scope: 'desktop' });
      try { return { ...(await observe(state, options)), success: true, result: opened, actionStatus: 'sent' }; }
      catch (error: any) { return { ...response(opened), actionStatus: 'sent', observationError: String(error?.message || error) }; }
    }
    if (action === 'launch_app') {
      const name = String(input.path || input.app || input.text || '').trim();
      if (!name) throw new Error('An app name, bundle identifier or application path is required.');
      const launched = await call('launch_app', { name }, { ...options, onDispatch });
      bind(state, { scope: 'desktop' });
      try {
        const opened = Array.isArray(launched?.windows) ? launched.windows : [];
        if (opened.length === 1) {
          // Windows releases report the process on the launch result. macOS
          // also reports the actual owner on each returned window.
          bind(state, asWindow({ ...opened[0], pid: opened[0].pid ?? launched.pid }));
        }
        const result = state.target.scope === 'window' ? launched : { ...launched, next: 'Select the opened window with list_apps before window input.' };
        return { ...(await observe(state, options)), success: true, result, actionStatus: 'sent' };
      } catch (error: any) {
        return { ...response(launched), actionStatus: 'sent', observationError: String(error?.message || error) };
      }
    }
    if (action === 'focus_app') {
      if (!input.app && !input.text && input.pid == null) throw new Error('Select an app or exact window to focus.');
      bind(state, await resolveTarget({ ...input, app: input.app || input.text }, state, options, true));
      return await mutate('bring_to_front', identity(state.target));
    }

    const windowRead = ['find', 'read', 'get_controls', 'wait_text', 'see_region', 'set_window_frame', 'set_value', 'invoke_menu'].includes(action);
    bind(state, await resolveTarget(input, state, options, windowRead));
    if (action === 'see') return await observe(state, options);
    if (action === 'see_region') {
      // zoom adds padding and has its own coordinate transform. Keep this a
      // visual detail read; get a normal see frame before a subsequent pixel action.
      const x = finite(input.x, 'x'), y = finite(input.y, 'y');
      const width = finite(input.width, 'width'), height = finite(input.height, 'height');
      if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new Error('Provide a positive window region within its screenshot.');
      state.frameHash = undefined;
      const reply = await callResponse('zoom', { ...identity(state.target), x1: x, y1: y, x2: x + width, y2: y + height }, options);
      const frame = readFrame(reply);
      return { ...response({ detail: frame.metadata, target: state.target, next: 'This image is a padded detail view. Use see before pixel input.' }), vision: frame.vision };
    }
    if (['read', 'get_controls', 'find'].includes(action)) {
      const query = String(input.query || input.filter || (action === 'find' ? input.text : '') || '').trim().toLowerCase();
      if (action === 'find' && !query) throw new Error('A control label or text query is required.');
      const observed = await observe(state, options, query || undefined);
      const elements = (observed.observation?.elements || []).filter((item: any) => !query || `${item.text} ${item.value ?? ''}`.toLowerCase().includes(query));
      return { ...observed, success: observed.success && (action !== 'find' || elements.length > 0),
        ...(action === 'find' && !elements.length ? { error: `No accessible control matched "${query}" in the selected window.` } : {}),
        result: action === 'read' ? elements.map((item: any) => `${item.text}${item.value != null ? `: ${item.value}` : ''}`).join('\n') || observed.observation?.tree || 'No accessible text was returned; use the screenshot.'
          : { matches: elements, target: state.target, tip: 'Use a returned element_token. If several controls match, select one from this observation; do not guess.' } };
    }
    if (action === 'wait_ms') {
      await delay(Math.max(0, Math.min(30_000, Number(input.ms ?? input.timeout_ms ?? 1000))), undefined, { signal: options.signal });
      return await observe(state, options);
    }
    if (action === 'wait_text' || action === 'wait_change') {
      const wanted = String(input.query || input.text || '').trim().toLowerCase();
      if (action === 'wait_text' && !wanted) throw new Error('Text to wait for is required.');
      const previousHash = state.frameHash;
      const deadline = Date.now() + Math.max(1, Math.min(60_000, Number(input.timeout_ms ?? 8000)));
      let baseline = previousHash;
      let last: CuaActionResult | undefined;
      do {
        options.signal?.throwIfAborted();
        try { last = await observe(state, { ...options, deadline }, action === 'wait_text' ? wanted : undefined); }
        catch (error) {
          options.signal?.throwIfAborted();
          if (Date.now() >= deadline) break;
          throw error;
        }
        const text = (last.observation?.elements || []).map((item: any) => `${item.text} ${item.value ?? ''}`).join('\n').toLowerCase();
        if (last.success && ((action === 'wait_text' && text.includes(wanted)) || (action === 'wait_change' && baseline && state.frameHash && baseline !== state.frameHash))) {
          return { ...last, success: true, result: action === 'wait_text' ? 'Requested text appeared.' : 'The captured image changed. Inspect it to determine whether the intended action completed.' };
        }
        baseline ||= state.frameHash;
        if (Date.now() >= deadline) break;
        await delay(Math.min(500, deadline - Date.now()), undefined, { signal: options.signal });
      } while (Date.now() < deadline);
      return { ...(last || response('')), success: false, result: 'The expected state was not observed before the timeout.' };
    }

    if (!state.frameHash || !state.observation || !state.frameConnection || state.frameConnection.closed || Date.now() - state.observation.capturedAt > 120_000) {
      const observed = await observe(state, options);
      return { ...observed, actionStatus: 'not_sent', observationRequired: true,
        result: observed.success
          ? 'A fresh screenshot was captured automatically. The requested input has not been sent. Inspect this image, then choose the next action.'
          : observed.result };
    }
    const delivery = input.delivery_mode ? { delivery_mode: input.delivery_mode } : {};
    const modifiers = Array.isArray(input.modifiers) && input.modifiers.length
      ? { modifier: input.modifiers.map((key: string) => normalizedKey(normalizeShortcutForPlatform(key))) } : {};
    if (action === 'set_value') {
      if (!input.element_token || typeof input.value !== 'string') throw new Error('set_value requires a current element_token and a string value.');
      return await mutate('set_value', { ...address(input, state), value: input.value });
    }
    if (action === 'invoke_menu') {
      if (!Array.isArray(input.menu_path) || !input.menu_path.length) throw new Error('Provide the exact menu labels in menu_path.');
      return await mutate('invoke_menu', { ...identity(state.target), path: input.menu_path });
    }
    if (action === 'set_window_frame') {
      const bounds = input.bounds || {};
      const x = finite(bounds.x, 'bounds.x'), y = finite(bounds.y, 'bounds.y');
      const width = finite(bounds.width, 'bounds.width'), height = finite(bounds.height, 'bounds.height');
      if (width < 1 || height < 1) throw new Error('Window width and height must be positive.');
      return await mutate('set_window_frame', { ...identity(state.target), x, y, width, height });
    }
    if (['click', 'right_click', 'double_click'].includes(action)) {
      const payload = address(input, state, !input.element_token);
      // The universal click endpoint supports desktop right/double clicks;
      // dedicated right_click requires a window on some driver versions.
      const tool = input.element_token && action !== 'click' ? action : 'click';
      return await mutate(tool, { ...payload, ...delivery, ...modifiers,
        ...(action === 'click' && input.button ? { button: input.button } : {}),
        ...(tool === 'click' && action === 'right_click' ? { button: 'right' } : {}),
        ...(tool === 'click' && action === 'double_click' ? { count: 2 } : {}),
      });
    }
    if (action === 'type') {
      if (typeof input.text !== 'string' || !input.text.length) throw new Error('Text to type is required.');
      const delayMs = input.delay_ms ?? (input.speed === 'slow' ? 60 : input.speed === 'fast' ? 0 : 10);
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 200) throw new Error('delay_ms must be an integer from 0 to 200.');
      const timeout = 15_000 + input.text.length * delayMs;
      if (timeout > 300_000) throw new Error('This text and delay exceed five minutes. Use delay_ms=0 or smaller text chunks; no text was sent.');
      return await mutate('type_text', { ...address(input, state), ...delivery, text: input.text,
        delay_ms: delayMs,
      }, timeout);
    }
    if (action === 'key' || ['select_all', 'copy', 'paste', 'save', 'undo', 'close_window'].includes(action)) {
      const shortcut = action === 'key' ? normalizeShortcutForPlatform(String(input.text || ''))
        : getPlatformShortcut(action as 'select_all' | 'copy' | 'paste' | 'save' | 'undo' | 'close_window');
      if (!shortcut) throw new Error('A key or shortcut is required.');
      const keys = shortcut.split('+').map(normalizedKey);
      return await mutate(keys.length > 1 ? 'hotkey' : 'press_key', { ...address(input, state), ...delivery, ...(keys.length > 1 ? { keys } : { key: keys[0] }) });
    }
    if (action === 'scroll') return await mutate('scroll', {
      ...address(input, state, state.target.scope === 'desktop' && !input.element_token), ...delivery,
      direction: input.direction || 'down', amount: Math.max(1, Math.min(50, Math.round(Number(input.amount ?? 3)))),
    });
    if (action === 'hover') return await mutate('move_cursor', { ...address(input, state, true), ...delivery });
    if (action === 'drag') {
      const start = point(input, state), end = point(input, state, true);
      return await mutate('drag', { ...inputTarget(state.target), ...delivery, ...modifiers,
        from_x: start.x, from_y: start.y, to_x: end.x, to_y: end.y,
        ...(state.observation?.capture_id ? { capture_id: state.observation.capture_id } : {}),
        ...(input.duration_ms != null ? { duration_ms: input.duration_ms } : {}),
      });
    }
    return response(`Action ${action} is not supported by Cua Driver.`, false);
  } catch (error: any) {
    if (dispatched) { state.observation = undefined; state.tokens.clear(); state.frameHash = undefined; }
    const refused = error instanceof CuaToolError && error.inputRefused;
    return { ...response(String(error?.message || error).slice(0, 700), false), actionStatus: dispatched && !refused ? 'unknown' : 'not_sent' };
  }
}

export async function executeCuaScreenAction(action: string, input: any, options: ActionOptions = {}): Promise<CuaActionResult | null> {
  if (!ACTIONS.has(action)) return null;
  try {
    return await exclusive(async () => {
      options.signal?.throwIfAborted();
      if (isComputerUseDisabled()) return { success: false, provider: cuaDriverProvider(), result: 'Computer Use was turned off.', vision: null, actionStatus: 'not_sent' as const };
      return execute(action, input, options);
    }, options.signal);
  } catch (error: any) {
    return { success: false, provider: cuaDriverProvider(), result: String(error?.message || error).slice(0, 600), vision: null, actionStatus: 'not_sent' };
  }
}

/** Display-only frames never replace the tokens or coordinate frame an agent read. */
export async function captureCuaPreview(chatId: string, signal?: AbortSignal): Promise<Frame | null> {
  if (shared.pending || isComputerUseDisabled()) return null;
  const state = shared.sessions.get(chatId);
  if (!state?.observation) return null;
  const { target, observation } = state;
  // Legacy window reads replace other clients' control tokens. The monitor
  // already receives every agent observation on those installations.
  if (target.scope === 'window' && !state.connections.get('action-window')?.supports('get_window_state', 'display_only')) return null;
  const frame = await capture(target, { chatId, preview: true, signal, deadline: Date.now() + 5000 }, true);
  // Display-only capture has its own connection and never holds the input
  // queue. An older preview cannot overwrite a newer action in the monitor.
  return !shared.pending && shared.sessions.get(chatId) === state && state.observation === observation && sameTarget(state.target, target) ? frame : null;
}

export async function endCuaSession(chatId: string): Promise<void> {
  // The owner has aborted pending input. Its dedicated connections can close
  // immediately even while another chat owns the action queue.
  await releaseSession(chatId);
}
