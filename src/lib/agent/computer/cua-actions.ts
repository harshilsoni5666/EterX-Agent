import { createHash } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { cuaDriverProvider, ensureCuaDriverDaemon, runCua, type CuaActionResult } from './cua-driver';
import { getPlatformShortcut, normalizeShortcutForPlatform } from './platform-shortcuts';
import { isComputerUseDisabled } from '../builtin-agent-tool-policy';

type Target = { scope: 'desktop' } | { scope: 'window'; pid: number; window_id: number; app?: string; title?: string };
type Vision = NonNullable<CuaActionResult['vision']>;
type Frame = { vision: Vision | null; metadata: Record<string, any>; width?: number; height?: number };
type Session = {
  target: Target;
  updatedAt: number;
  observation?: Record<string, any>;
  tokens: Set<string>;
  frameHash?: string;
  started?: boolean;
  previewStarted?: boolean;
};
type ActionOptions = {
  chatId?: string; signal?: AbortSignal; deadline?: number; maxElements?: number; maxImageDimension?: number;
  openTarget?: (kind: 'url' | 'path', target: string) => Promise<unknown>;
};

// Desktop state is shared by OS processes. Serialize complete observe/action
// transactions, including calls from different chats, and retain state per chat.
const runtime = globalThis as typeof globalThis & {
  __eterxCuaActions?: { tail: Promise<void>; sessions: Map<string, Session> };
};
const shared = runtime.__eterxCuaActions ||= { tail: Promise.resolve(), sessions: new Map() };

async function exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
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
    release();
  }
}

function sessionFor(chatId = ''): Session {
  const now = Date.now();
  for (const [id, state] of shared.sessions) {
    if (now - state.updatedAt > 30 * 60_000) shared.sessions.delete(id);
  }
  const existing = shared.sessions.get(chatId);
  if (existing) { existing.updatedAt = now; return existing; }
  if (shared.sessions.size >= 128) shared.sessions.delete(shared.sessions.keys().next().value!);
  const state: Session = { target: { scope: 'desktop' }, updatedAt: now, tokens: new Set() };
  shared.sessions.set(chatId, state);
  return state;
}

function sessionLabel(chatId = ''): string {
  return `eterx-${createHash('sha256').update(chatId || 'desktop').digest('hex').slice(0, 20)}`;
}

function parseResponse(stdout: string): any {
  const text = stdout.trim();
  try { return JSON.parse(text); } catch { /* Some CLI versions prefix a log line. */ }
  for (const line of text.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch { /* Continue to the JSON object. */ }
  }
  const start = text.indexOf('{');
  if (start >= 0) {
    try { return JSON.parse(text.slice(start)); } catch { /* Fail explicitly below. */ }
  }
  throw new Error('Cua Driver returned an unreadable response. Observe again before repeating input.');
}

function unwrapResponse(raw: any): any {
  let result = raw?.structuredContent ?? raw;
  if (Array.isArray(raw?.content) && !raw.structuredContent) {
    const texts = raw.content.filter((block: any) => block.type === 'text').map((block: any) => String(block.text || ''));
    for (const text of texts) {
      try { result = JSON.parse(text); break; } catch { /* A text-only error is handled below. */ }
    }
    if (result === raw) result = { message: texts.join('\n').slice(0, 4000) };
  }
  if (raw?.isError || result?.isError || result?.success === false || result?.ok === false
    || result?.error || (Array.isArray(result?.errors) && result.errors.length)
    || [result?.status, result?.effect].some(value => ['error', 'failed', 'denied', 'refused', 'blocked', 'background_unavailable'].includes(String(value || '').toLowerCase()))) {
    const reason = result?.error?.message || result?.error || result?.message || result?.reason || 'The driver refused this action.';
    throw new Error(typeof reason === 'string' ? reason.slice(0, 600) : JSON.stringify(reason).slice(0, 600));
  }
  return result;
}

async function call(tool: string, input: Record<string, unknown>, options: ActionOptions, screenshotPath?: string, timeout = 15_000) {
  options.signal?.throwIfAborted();
  if (options.deadline != null) {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new Error('The desktop observation deadline expired.');
    timeout = Math.min(timeout, remaining);
  }
  const args = ['call', tool];
  if (screenshotPath) args.push('--screenshot-out-file', screenshotPath);
  return unwrapResponse(parseResponse(await runCua(args, timeout, options.signal, JSON.stringify({ ...input, session: sessionLabel(options.chatId) }))));
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
  const items = Array.isArray(result) ? result : Array.isArray(result?.windows) ? result.windows : [];
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-cua-'));
  const imagePath = path.join(dir, 'screen.png');
  try {
    const metadata = await call(target.scope === 'window' ? 'get_window_state' : 'get_desktop_state', {
      ...identity(target),
      max_image_dimension: preview ? 1280 : options.maxImageDimension || 1920,
      ...(target.scope === 'window' ? {
        include_screenshot: true, include_accessibility_tree: !preview, screenshot_format: 'png',
        ...(preview ? { display_only: true } : {
          tree_format: 'elements', max_depth: 25, max_elements: options.maxElements || (query ? 2000 : 250),
          ...(query ? { query } : {}),
        }),
      } : {}),
    }, options, imagePath);
    if (!(await fs.pathExists(imagePath))) return { metadata, vision: null };
    const bytes = await fs.readFile(imagePath);
    const png = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216;
    if (!png && !jpeg) throw new Error('The driver returned an invalid screenshot.');
    return {
      metadata,
      vision: { inlineData: { data: bytes.toString('base64'), mimeType: png ? 'image/png' : 'image/jpeg' } },
      ...(png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}),
    };
  } finally {
    await fs.remove(dir).catch(() => {});
  }
}

function snapshot(state: Session, frame: Frame): Record<string, any> {
  const raw = frame.metadata;
  const elements = (Array.isArray(raw?.elements) ? raw.elements : []).slice(0, 2000).map((element: any) => ({
    element_token: element.element_token,
    element_index: element.element_index,
    parent_index: element.parent_index,
    depth: element.depth,
    role: element.role,
    text: String(element.label || element.name || '').slice(0, 1000),
    value: typeof element.value === 'string' ? element.value.slice(0, 2000) : element.value,
    enabled: element.enabled ?? element.is_enabled,
    actions: element.actions,
  }));
  state.tokens = new Set(elements.map((element: any) => element.element_token).filter((token: any): token is string => typeof token === 'string'));
  state.frameHash = frame.vision ? createHash('sha256').update(frame.vision.inlineData.data).digest('hex') : undefined;
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
  // The driver may replace its snapshot before file delivery fails. Do not
  // retain an older coordinate frame or token after an unsuccessful read.
  state.tokens.clear();
  state.observation = undefined;
  state.frameHash = undefined;
  const frame = await capture(state.target, options, false, query);
  const observation = snapshot(state, frame);
  const readable = Boolean(frame.vision);
  if (!readable) state.tokens.clear();
  return {
    success: readable, provider: cuaDriverProvider(), result: readable ? 'Current target observed.' : 'The target could not be observed. Check desktop permissions and whether the screen is unlocked.',
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

function address(input: any, state: Session, needsPoint = false, bindCapture = false): Record<string, unknown> {
  if (input.element_token) {
    if (input.x != null || input.y != null) throw new Error('Use either an element_token or x and y, not both.');
    if (!state.tokens.has(input.element_token)) throw new Error('This element_token is stale or belongs to another chat/window. Read the target again.');
    return { element_token: input.element_token };
  }
  const target = inputTarget(state.target);
  if (needsPoint || input.x != null || input.y != null) {
    return { ...target, ...point(input, state), ...(bindCapture && state.observation?.capture_id ? { capture_id: state.observation.capture_id } : {}) };
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
  const mutate = async (tool: string, args: Record<string, unknown>, timeout = 15_000) => {
    options.signal?.throwIfAborted();
    if (isComputerUseDisabled()) throw new Error('Computer Use was turned off.');
    dispatched = true;
    const result = await call(tool, args, options, undefined, timeout);
    // Input and observation have separate outcomes. A failed screenshot never
    // converts an already delivered click/type into an invitation to repeat it.
    state.tokens.clear();
    state.observation = undefined;
    state.frameHash = undefined;
    try {
      const observed = await observe(state, options);
      return { ...observed, success: true, result, actionStatus: 'sent' as const,
        ...(!observed.success ? { observationError: String(observed.result) } : {}) };
    } catch (error: any) {
      return { ...response(result), actionStatus: 'sent' as const, observationError: String(error?.message || error).slice(0, 600) };
    }
  };

  try {
    if (!state.started) {
      await call('start_session', {}, options);
      state.started = true;
    }
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
      dispatched = true;
      const result = await call('clipboard_write', { text: String(input.text ?? '') }, options);
      return { ...response(result), actionStatus: 'sent' };
    }
    if (action === 'open_file' || action === 'open_url') {
      if (!options.openTarget) throw new Error('Opening files and URLs requires the EterX desktop app.');
      const target = String((action === 'open_file' ? input.path : input.url) || input.text || '').trim();
      if (!target) throw new Error(action === 'open_file' ? 'An absolute file, folder or application path is required.' : 'An HTTP or HTTPS URL is required.');
      options.signal?.throwIfAborted();
      if (isComputerUseDisabled()) throw new Error('Computer Use was turned off.');
      dispatched = true;
      const opened = await options.openTarget(action === 'open_file' ? 'path' : 'url', target);
      bind(state, { scope: 'desktop' });
      try { return { ...(await observe(state, options)), success: true, result: opened, actionStatus: 'sent' }; }
      catch (error: any) { return { ...response(opened), actionStatus: 'sent', observationError: String(error?.message || error) }; }
    }
    if (action === 'launch_app') {
      const name = String(input.app || input.text || '').trim();
      if (!name) throw new Error('An app name, bundle identifier or application path is required.');
      dispatched = true;
      const launched = await call('launch_app', { name }, options);
      const opened = Array.isArray(launched.windows) ? launched.windows : [];
      if (opened.length === 1) {
        bind(state, asWindow(opened[0]));
        try { return { ...(await observe(state, options)), success: true, result: launched, actionStatus: 'sent' }; }
        catch (error: any) { return { ...response(launched), actionStatus: 'sent', observationError: String(error?.message || error) }; }
      }
      // Never leave subsequent input bound to the app that preceded a launch.
      bind(state, { scope: 'desktop' });
      return { ...response({ ...launched, next: 'Use list_apps to select the opened window before acting.' }), actionStatus: 'sent' };
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-cua-zoom-'));
      try {
        const imagePath = path.join(dir, 'region.jpg');
        const detail = await call('zoom', { ...identity(state.target), x1: x, y1: y, x2: x + width, y2: y + height }, options, imagePath);
        if (!(await fs.pathExists(imagePath))) throw new Error('No region screenshot was returned.');
        const bytes = await fs.readFile(imagePath);
        state.frameHash = undefined;
        return { ...response({ detail, target: state.target, next: 'This image is a padded detail view. Use see before pixel input; do not use detail-image coordinates on the full window.' }), vision: { inlineData: { data: bytes.toString('base64'), mimeType: bytes[0] === 137 ? 'image/png' : 'image/jpeg' } } };
      } finally { await fs.remove(dir).catch(() => {}); }
    }
    if (['read', 'get_controls', 'find'].includes(action)) {
      const query = String(input.query || input.filter || (action === 'find' ? input.text : '') || '').trim().toLowerCase();
      if (action === 'find' && !query) throw new Error('A control label or text query is required.');
      const observed = await observe(state, options, query || undefined);
      const elements = (observed.observation?.elements || []).filter((item: any) => !query || `${item.text} ${item.value ?? ''}`.toLowerCase().includes(query));
      return { ...observed, success: observed.success && (action !== 'find' || elements.length > 0),
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

    if (!state.frameHash || !state.observation || Date.now() - state.observation.capturedAt > 120_000) {
      throw new Error('Observe this exact target with see before sending input. A recent visual observation is required.');
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
      const payload = address(input, state, !input.element_token, true);
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
        ...(input.duration_ms != null ? { duration_ms: input.duration_ms } : {}),
      });
    }
    return response(`Action ${action} is not supported by Cua Driver.`, false);
  } catch (error: any) {
    if (dispatched) { state.observation = undefined; state.tokens.clear(); state.frameHash = undefined; }
    return { ...response(String(error?.message || error).slice(0, 700), false), actionStatus: dispatched ? 'unknown' : 'not_sent' };
  }
}

export async function executeCuaScreenAction(action: string, input: any, options: ActionOptions = {}): Promise<CuaActionResult | null> {
  if (!ACTIONS.has(action)) return null;
  try {
    return await exclusive(async () => {
      const status = await ensureCuaDriverDaemon();
      options.signal?.throwIfAborted();
      if (isComputerUseDisabled()) return { success: false, provider: cuaDriverProvider(), result: 'Computer Use was turned off.', vision: null, actionStatus: 'not_sent' as const };
      if (!status.installed) return null;
      if (!status.daemonRunning) return { success: false, provider: cuaDriverProvider(), result: status.message, vision: null, actionStatus: 'not_sent' as const };
      return execute(action, input, options);
    }, options.signal);
  } catch (error: any) {
    return { success: false, provider: cuaDriverProvider(), result: String(error?.message || error).slice(0, 600), vision: null, actionStatus: 'not_sent' };
  }
}

/** Display-only frames never replace the tokens or coordinate frame an agent read. */
export async function captureCuaPreview(chatId: string): Promise<Frame | null> {
  return exclusive(async () => {
    if (isComputerUseDisabled()) return null;
    const state = shared.sessions.get(chatId);
    if (!state || Date.now() - state.updatedAt > 60_000) return null;
    const previewOptions = { chatId: `${chatId}:preview` };
    if (!state.previewStarted) {
      await call('start_session', {}, previewOptions);
      state.previewStarted = true;
    }
    // Desktop capture has no display_only parameter. A separate lifecycle
    // session keeps its preview pixels out of the agent's action frame.
    return capture(state.target, previewOptions, true);
  }).catch(() => null);
}

export async function endCuaSession(chatId: string): Promise<void> {
  await exclusive(async () => {
    shared.sessions.delete(chatId);
    await call('end_session', {}, { chatId }, undefined, 3000).catch(() => {});
    await call('end_session', {}, { chatId: `${chatId}:preview` }, undefined, 3000).catch(() => {});
  });
}
