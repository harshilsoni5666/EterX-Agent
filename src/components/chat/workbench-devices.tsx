'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, Camera, ChevronDown, CircleDot, FolderOpen, Home, Keyboard, Link2, Loader2, Maximize, Minimize, Monitor, Moon, Play, Power, RotateCw, Smartphone, Square, Sun, Tv, Watch } from 'lucide-react';
import { notifyWorkbenchClient, subscribeDeviceConnectionsChanged, workbenchAction, workbenchJson, workbenchUrl } from '../../lib/workbench/client';
import { deviceHostStateLabel, localDeviceHostId, supportsDeviceAppearance, type DeviceCatalog, type DeviceInput, type DeviceKey, type MachineCatalog, type WorkbenchDevice, type WorkbenchDeviceMode } from '../../lib/workbench/contracts';
import { drawDeviceVideo } from '../../lib/workbench/device-video-client';

type NativeSource = { id: string; name: string };
type WorkbenchDesktopBridge = {
  workbenchWindowSources?: () => Promise<NativeSource[]>;
  workbenchChooseFile?: (kind: 'apk' | 'app') => Promise<string | null>;
};

function desktopBridge() {
  return (window as typeof window & { electronAPI?: WorkbenchDesktopBridge }).electronAPI;
}

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const deviceLabels = { android: 'Android', ios: 'iPhone', ipados: 'iPad', watchos: 'Apple Watch', tvos: 'Apple TV', visionos: 'visionOS' };
const deviceStatus = { ready: 'Connected', starting: 'Starting', off: 'Powered off', offline: 'Offline', unauthorized: 'Authorize debugging' };

function downloadFrame(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    downloadFrame(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, 'image/png');
}

function NativeWindowSurface({ chatId, desktop, visible, onShareChange }: { chatId: string; desktop: boolean; visible: boolean; onShareChange: (name?: string) => void }) {
  const api = typeof window !== 'undefined' ? desktopBridge() : undefined;
  const [sources, setSources] = useState<NativeSource[]>([]);
  const [selected, setSelected] = useState('');
  const [sharing, setSharing] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [machines, setMachines] = useState<MachineCatalog>();
  const [machineLoading, setMachineLoading] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [startingMachine, setStartingMachine] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const revision = useRef(0);
  const stop = () => {
    ++revision.current;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  };
  useEffect(() => {
    if (!visible) { stop(); setSharing(''); setPending(false); }
    return stop;
  }, [visible]);
  useEffect(() => {
    if (sharing && video.current) video.current.srcObject = stream.current;
  }, [sharing]);
  useEffect(() => {
    if (!visible || !sharing) return;
    onShareChange(sharing);
    return () => onShareChange();
  }, [sharing, visible, onShareChange]);
  const load = async () => {
    if (!api?.workbenchWindowSources) return;
    const current = ++revision.current;
    setPending(true);
    setError('');
    try {
      const items = await api.workbenchWindowSources();
      if (current !== revision.current) return;
      setSources(items);
      setSelected(previous => items.some(item => item.id === previous) ? previous : items[0]?.id || '');
      if (!items.length) setError('No shareable app windows were found. Open the target window and refresh.');
    } catch (error) { if (current === revision.current) setError(errorText(error)); }
    finally { if (current === revision.current) setPending(false); }
  };
  const share = async () => {
    const source = sources.find(item => item.id === selected);
    if (!source) return;
    stop();
    const current = revision.current;
    setSharing('');
    setPending(true);
    setError('');
    try {
      const constraints: MediaTrackConstraints & { mandatory: { chromeMediaSource: string; chromeMediaSourceId: string; maxFrameRate: number } } = {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: 30 },
      };
      const captured = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
      if (current !== revision.current) { captured.getTracks().forEach(track => track.stop()); return; }
      stream.current = captured;
      captured.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (current === revision.current) { stop(); setSharing(''); setError('Window sharing ended. Choose the window again to resume.'); }
      }, { once: true });
      setSharing(source.name);
    } catch (error) {
      if (current === revision.current) setError('Window capture could not start. ' + errorText(error));
    } finally { if (current === revision.current) setPending(false); }
  };
  const snapshot = () => {
    const target = video.current;
    if (!target?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = target.videoWidth;
    canvas.height = target.videoHeight;
    canvas.getContext('2d')?.drawImage(target, 0, 0);
    downloadCanvas(canvas, 'eterx-window.png');
  };
  const refreshMachines = async () => {
    if (!desktop || machineLoading) return;
    setMachineLoading(true);
    try {
      const catalog = await workbenchJson<MachineCatalog>(workbenchUrl(chatId, 'machines'));
      setMachines(catalog);
      setMachineId(previous => catalog.machines.some(machine => machine.id === previous) ? previous : catalog.machines[0]?.id || '');
    } catch (error) { setError(errorText(error)); }
    finally { setMachineLoading(false); }
  };
  const startMachine = async () => {
    if (!machineId || startingMachine) return;
    setStartingMachine(true);
    setError('');
    try {
      await workbenchAction(chatId, 'start-machine', { machineId });
      await refreshMachines();
      if (!sharing) await load();
    } catch (error) { setError(errorText(error)); }
    finally { setStartingMachine(false); }
  };
  const machine = machines?.machines.find(item => item.id === machineId);
  return <>
    <div className="eterx-wb-device-bar">
      {sharing
        ? <><span className="eterx-wb-status" data-status="running"><i />Live</span><strong title={sharing}>{sharing}</strong><button type="button" className="eterx-wb-icon" aria-label="Save window screenshot" title="Save screenshot" onClick={snapshot}><Camera size={16} /></button><button type="button" className="eterx-wb-button" onClick={() => { stop(); setSharing(''); }}><Square size={12} />Stop sharing</button></>
        : <><label className="eterx-wb-target-select"><Monitor size={16} /><select aria-label="Native window" disabled={!sources.length || pending} value={selected} onChange={event => setSelected(event.target.value)}>
            {!sources.length && <option value="">Choose a window</option>}{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select><ChevronDown size={14} /></label>
          <button type="button" className="eterx-wb-icon" title="Find open windows" aria-label="Find open windows" disabled={!api?.workbenchWindowSources || pending} onClick={() => void load()}>{pending ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}</button>
          <button type="button" className="eterx-wb-button is-primary" disabled={!selected || pending} onClick={() => void share()}>Share</button></>}
    </div>
    {desktop && !sharing && <details className="eterx-wb-machines" onToggle={event => { if (event.currentTarget.open) void refreshMachines(); }}>
      <summary>VirtualBox machines</summary>
      {machineLoading ? <p role="status">Finding registered virtual machines…</p>
        : machines?.machines.length ? <div>
          <label className="eterx-wb-target-select"><Monitor size={15} /><select value={machineId} aria-label="Virtual machine" disabled={startingMachine} onChange={event => setMachineId(event.target.value)}>
            {machines.machines.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}
          </select><ChevronDown size={14} /></label>
          <button type="button" className="eterx-wb-button" disabled={!machine || machine.status !== 'off' || startingMachine} onClick={() => void startMachine()}><Play size={13} />{startingMachine ? 'Starting…' : 'Start VM'}</button>
        </div>
          : <p>{machines?.available ? 'No virtual machines are registered on this host.' : 'VirtualBox must be installed to start a guest here.'}</p>}
    </details>}
    {error && <p className="eterx-wb-error" role="alert">{error}</p>}
    <div className="eterx-wb-stage" data-window="true">
      {sharing ? <video autoPlay playsInline muted ref={video} aria-label={sharing + ' live window'} />
        : <div className="eterx-wb-placeholder"><Monitor size={32} strokeWidth={1.4} /><strong>Native window</strong><span>Mirror a running Windows, macOS, or Linux app, game, browser, or virtual machine. Interact in its own window.</span>
          {api?.workbenchWindowSources && !sources.length && <button type="button" className="eterx-wb-button" disabled={pending} onClick={() => void load()}>Find open windows</button>}
        </div>}
    </div>
  </>;
}

const keyboardKeys: Record<string, DeviceKey> = { Enter: 'enter', Backspace: 'delete', Escape: 'back', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const remoteKeys = [{ key: 'up', icon: ArrowUp }, { key: 'down', icon: ArrowDown }, { key: 'left', icon: ArrowLeft }, { key: 'right', icon: ArrowRight }, { key: 'select', icon: CircleDot }] as const;
type DeviceDisplay = HTMLImageElement | HTMLCanvasElement;

function DeviceViewport({ chatId, device, visible, send, runInput, busy, textOpen, onToggleText }: {
  chatId: string;
  device: WorkbenchDevice;
  visible: boolean;
  send: (input: DeviceInput) => void;
  runInput: (input: DeviceInput) => Promise<boolean>;
  busy: boolean;
  textOpen: boolean;
  onToggleText: () => void;
}) {
  const [frame, setFrame] = useState('');
  const [video, setVideo] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape');
  const [appearance, setAppearance] = useState<'light' | 'dark'>('dark');
  const screen = useRef<HTMLCanvasElement>(null);
  const screenArea = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === screenArea.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    setFrame('');
    setVideo(false);
    setError('');
    if (!visible || device.status !== 'ready') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frameUrl = '';
    let failed = 0;
    let streaming = false;
    let capturing = false;
    const poll = async () => {
      if (controller.signal.aborted || streaming || capturing) return;
      capturing = true;
      let candidate = '';
      try {
        const response = await fetch(workbenchUrl(chatId, 'frame', { deviceId: device.id }), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(24_000)]), cache: 'no-store',
        });
        if (!response.ok) throw new Error((await response.json()).error || 'The device frame is unavailable.');
        candidate = URL.createObjectURL(await response.blob());
        const image = new Image();
        image.src = candidate;
        await image.decode();
        if (controller.signal.aborted || streaming) return;
        if (frameUrl) URL.revokeObjectURL(frameUrl);
        frameUrl = candidate;
        candidate = '';
        setFrame(frameUrl);
        if (failed) setError('');
        failed = 0;
      } catch (error) {
        if (!controller.signal.aborted && !streaming) { failed++; setError(errorText(error)); }
      } finally {
        capturing = false;
        if (candidate) URL.revokeObjectURL(candidate);
        if (!controller.signal.aborted && !streaming) {
          const interval = device.hostId !== localDeviceHostId ? 650 : device.platform === 'android' ? 180 : 360;
          timer = setTimeout(poll, failed ? Math.min(failed * 1200, 6000) : interval);
        }
      }
    };
    const follow = async () => {
      const canvas = screen.current;
      if (device.video && canvas && typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined') {
        const url = workbenchUrl(chatId, 'device-video', { deviceId: device.id });
        while (!controller.signal.aborted) {
          const started = Date.now();
          try {
            await drawDeviceVideo(url, canvas, controller.signal, () => {
              streaming = true;
              clearTimeout(timer);
              if (frameUrl) URL.revokeObjectURL(frameUrl);
              frameUrl = '';
              setFrame('');
              setError('');
              setVideo(true);
            });
            if (Date.now() - started < 5000) break;
          } catch {
            break;
          }
        }
      }
      if (!controller.signal.aborted && streaming) {
        streaming = false;
        setVideo(false);
        await poll();
      }
    };
    // Paint a real frame immediately while the decoder starts up.
    void poll();
    void follow();
    return () => { controller.abort(); clearTimeout(timer); if (frameUrl) URL.revokeObjectURL(frameUrl); };
  }, [chatId, device.id, device.hostId, device.platform, device.status, device.video, visible, retry]);
  const hasDisplay = video || Boolean(frame);
  const interactive = hasDisplay && !error && visible && device.input;
  const touchable = interactive && device.formFactor !== 'tv';
  const position = (event: ReactPointerEvent<DeviceDisplay>) => {
    const node = event.currentTarget;
    const rect = node.getBoundingClientRect();
    const width = node instanceof HTMLCanvasElement ? node.width : node.naturalWidth;
    const height = node instanceof HTMLCanvasElement ? node.height : node.naturalHeight;
    const scale = Math.min(rect.width / width, rect.height / height) || 1;
    const w = width * scale;
    const h = height * scale;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left - (rect.width - w) / 2) / w)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top - (rect.height - h) / 2) / h)),
    };
  };
  const controls: React.HTMLAttributes<DeviceDisplay> & { 'data-interactive': boolean } = {
    tabIndex: interactive ? 0 : undefined,
    'data-interactive': touchable,
    onPointerDown: event => {
      if (!touchable || event.button !== 0) return;
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = { id: event.pointerId, ...position(event) };
    },
    onPointerCancel: () => { pointer.current = null; },
    onLostPointerCapture: () => { pointer.current = null; },
    onPointerUp: event => {
      const start = pointer.current;
      pointer.current = null;
      if (!touchable || !start || start.id !== event.pointerId) return;
      const end = position(event);
      send(Math.hypot(start.x - end.x, start.y - end.y) > .025
        ? { kind: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y } : { kind: 'tap', ...end });
    },
    onKeyDown: event => {
      if (!interactive || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      const key = keyboardKeys[event.key];
      if (key || (touchable && event.key.length === 1)) {
        event.preventDefault();
        send(key ? { kind: 'key', key } : { kind: 'text', text: event.key });
      }
    },
  };
  const saveScreenshot = () => {
    if (video && screen.current) downloadCanvas(screen.current, 'eterx-device.png');
    else if (frame) downloadFrame(frame, 'eterx-device.png');
  };
  const toggleFullscreen = async () => {
    try {
      if (fullscreen) await document.exitFullscreen();
      else await screenArea.current?.requestFullscreen();
    } catch { /* Keep the device available in its current layout. */ }
  };
  return <>
    <div className="eterx-wb-view-status">
      <span className="eterx-wb-status" data-status={error ? 'failed' : hasDisplay ? 'running' : 'unknown'}><i />{error ? 'Waiting for display' : video ? 'Live video' : frame ? 'Live screenshots' : deviceStatus[device.status]}</span>
      {device.hostLabel && <span className="eterx-wb-device-host" title={device.hostLabel}><Link2 size={12} />{device.hostLabel}</span>}
      <div className="eterx-wb-display-actions">
        {frame && device.video && typeof VideoDecoder !== 'undefined' && <button type="button" className="eterx-wb-icon" aria-label="Retry live video" title="Retry live video" onClick={() => setRetry(value => value + 1)}><RotateCw size={14} /></button>}
      </div>
    </div>
    {error && <p className="eterx-wb-error" role="status">{error}</p>}
    <div ref={screenArea} className="eterx-wb-device-view">
      <div className="eterx-wb-stage" data-device={device.formFactor || 'phone'}>
        <canvas ref={screen} hidden={!video} aria-label={device.name + ' live display'} role="img" {...(video ? controls : {})} />
        {frame && !video && <img src={frame} alt={device.name + ' live display'} draggable={false} {...controls} />}
        {!hasDisplay && <div className="eterx-wb-placeholder"><Smartphone size={32} strokeWidth={1.4} /><strong>{device.name}</strong>
          <span>{device.detail || (device.status === 'ready' ? 'Connecting to the device display…' : device.status === 'unauthorized' ? 'Accept the debugging prompt on your device.' : device.status === 'starting' ? 'Waiting for the runtime to finish booting.' : 'Start or reconnect the device to see its display.')}</span></div>}
      </div>
      {device.status === 'ready' && <div className="eterx-wb-device-rail" role="group" aria-label="Device controls">
        {device.input && <>
          <button type="button" className="eterx-wb-icon" title="Home" aria-label="Device home" disabled={busy} onClick={() => send({ kind: 'key', key: 'home' })}><Home size={16} /></button>
          <button type="button" className="eterx-wb-icon" title={device.platform === 'android' ? 'Back' : 'Escape'} aria-label={device.platform === 'android' ? 'Device back' : 'Device escape'}
            disabled={busy} onClick={() => send({ kind: 'key', key: 'back' })}><ArrowLeft size={16} /></button>
          {device.formFactor !== 'tv' && <>
            <button type="button" className="eterx-wb-icon" title={'Rotate to ' + orientation} aria-label={'Rotate device to ' + orientation}
              disabled={busy} onClick={async () => {
                if (await runInput({ kind: 'rotation', rotation: orientation })) {
                  setOrientation(orientation === 'landscape' ? 'portrait' : 'landscape');
                  setRetry(value => value + 1);
                }
              }}><RotateCw size={16} /></button>
            {!fullscreen && <button type="button" className="eterx-wb-icon" title="Type on device" aria-label="Type on device" aria-pressed={textOpen}
              disabled={busy} onClick={onToggleText}><Keyboard size={16} /></button>}
          </>}
        </>}
        {supportsDeviceAppearance(device) && <button type="button" className="eterx-wb-icon" title={'Set ' + appearance + ' appearance'} aria-label={'Set device to ' + appearance + ' appearance'}
          disabled={busy} onClick={async () => {
            if (await runInput({ kind: 'appearance', appearance })) setAppearance(appearance === 'dark' ? 'light' : 'dark');
          }}>{appearance === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</button>}
        <button type="button" className="eterx-wb-icon" aria-label="Save device screenshot" title="Save screenshot" disabled={!hasDisplay} onClick={saveScreenshot}><Camera size={16} /></button>
        <button type="button" className="eterx-wb-icon" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen' : 'Full screen'}
          disabled={!hasDisplay && !fullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>
      </div>}
    </div>
  </>;
}

export function WorkbenchDevices({ chatId, selectedId, desktop, visible, onOpenConnections, mode: tab, onModeChange: setTab, onShareChange }: {
  chatId: string;
  selectedId?: string;
  desktop: boolean;
  visible: boolean;
  onOpenConnections: () => void;
  mode: WorkbenchDeviceMode;
  onModeChange: (mode: WorkbenchDeviceMode) => void;
  onShareChange: (name?: string) => void;
}) {
  const [catalog, setCatalog] = useState<DeviceCatalog>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState('');
  const [appId, setAppId] = useState('');
  const [artifact, setArtifact] = useState('');
  const [notice, setNotice] = useState('');
  const [text, setText] = useState('');
  const [textOpen, setTextOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const textField = useRef<HTMLInputElement>(null);
  const command = useRef<AbortController | null>(null);
  const inputQueue = useRef<Promise<unknown>>(Promise.resolve());
  const inputCount = useRef(0);
  const currentDevice = useRef(selectedId);
  const forceRefresh = useRef(false);
  currentDevice.current = visible && tab === 'devices' ? selectedId : undefined;
  const device = catalog?.devices.find(item => item.id === selectedId);
  useEffect(() => {
    setAppId('');
    setArtifact('');
    setText('');
    setNotice('');
    setTextOpen(false);
  }, [selectedId]);
  useEffect(() => { if (textOpen) textField.current?.focus(); }, [textOpen]);
  useEffect(() => subscribeDeviceConnectionsChanged(() => setRefresh(value => value + 1)), []);
  useEffect(() => {
    if (!desktop || !visible || tab !== 'devices') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const force = forceRefresh.current;
    forceRefresh.current = false;
    const list = async () => {
      if (first) setLoading(true);
      const params: Record<string, string> = first && force ? { refresh: '1' } : {};
      let merged = false;
      // Update the local list while network discovery runs independently.
      void workbenchJson<DeviceCatalog>(workbenchUrl(chatId, 'devices', { ...params, local: '1' }), { signal: controller.signal })
        .then(result => {
          if (!controller.signal.aborted && !merged) setCatalog(previous => ({
            devices: [...result.devices, ...(previous?.devices.filter(item => item.hostId !== localDeviceHostId) || [])],
            hosts: [...result.hosts, ...(previous?.hosts.filter(item => item.id !== localDeviceHostId) || [])],
          }));
        }, () => undefined);
      let delay = 8500;
      try {
        const result = await workbenchJson<DeviceCatalog>(workbenchUrl(chatId, 'devices', params), { signal: controller.signal }, 30_000);
        if (controller.signal.aborted) return;
        merged = true;
        setCatalog(result);
        if (result.devices.some(item => item.status === 'starting')) delay = 2000;
      } catch (error) {
        if (!controller.signal.aborted) setError(errorText(error));
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(list, delay); }
        first = false;
      }
    };
    void list();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [chatId, desktop, visible, tab, refresh]);
  useEffect(() => () => { command.current?.abort(); currentDevice.current = undefined; }, []);
  const act = async (operation: string, input: object) => {
    if (command.current) return null;
    const controller = new AbortController();
    command.current = controller;
    setBusy(true);
    setAction(operation);
    setError('');
    setNotice('');
    try {
      const result = await workbenchAction<{ success: true; appId?: string }>(
        chatId, operation, input, controller.signal, operation === 'install-app' ? 105_000 : undefined,
      );
      notifyWorkbenchClient(chatId);
      if (operation === 'start-device' || operation === 'stop-device') setRefresh(value => value + 1);
      return result;
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error));
      return null;
    } finally {
      if (command.current === controller) { command.current = null; setBusy(false); setAction(''); }
    }
  };
  const send = (input: DeviceInput) => {
    if (!device || inputCount.current >= 32) return;
    const id = device.id;
    inputCount.current++;
    setError('');
    inputQueue.current = inputQueue.current.then(async () => {
      if (currentDevice.current === id) await workbenchAction(chatId, 'device-input', { deviceId: id, input });
    }).catch(error => { if (currentDevice.current === id) setError(errorText(error)); })
      .finally(() => inputCount.current--);
  };
  const connected = device?.status === 'ready';
  const TargetIcon = device?.formFactor === 'tv' ? Tv : device?.formFactor === 'watch' ? Watch : Smartphone;
  const buildExtension = device?.platform === 'android' ? 'apk' : 'app';
  const hostLabel = device?.hostLabel || 'this computer';
  const picker = typeof window !== 'undefined' && device?.hostId === localDeviceHostId ? desktopBridge()?.workbenchChooseFile : undefined;
  const local = catalog?.hosts.find(host => host.id === localDeviceHostId);
  return <div className="eterx-wb-devices">
    <div className="eterx-wb-switch">
      <button type="button" aria-pressed={tab === 'devices'} onClick={() => setTab('devices')}><Smartphone size={15} />Device screen</button>
      <button type="button" aria-pressed={tab === 'windows'} onClick={() => setTab('windows')}><Monitor size={15} />Native windows</button>
      {desktop && <button type="button" className="eterx-wb-connections-link" onClick={onOpenConnections} title="Open Connections settings"><Link2 size={15} />Connections</button>}
    </div>
    {tab === 'windows' ? <NativeWindowSurface chatId={chatId} desktop={desktop} visible={visible} onShareChange={onShareChange} /> : <>
      <div className="eterx-wb-device-bar">
        <label className="eterx-wb-target-select"><TargetIcon size={16} /><select aria-label="Development device" value={device?.id || ''} disabled={!desktop || busy || !catalog?.devices.length} onChange={event => void act('select-device', { deviceId: event.target.value || null })}>
          <option value="">Choose a device</option>
          {catalog?.hosts.map(host => {
            const devices = catalog.devices.filter(item => item.hostId === host.id);
            return devices.length > 0 && <optgroup key={host.id} label={host.name}>
              {devices.map(item => <option key={item.id} value={item.id}>{item.name} · {item.runtime || deviceLabels[item.platform]} · {deviceStatus[item.status]}</option>)}
            </optgroup>;
          })}
        </select><ChevronDown size={14} /></label>
        <button type="button" className="eterx-wb-icon" aria-label="Refresh devices" title="Refresh devices" disabled={!desktop || loading} onClick={() => {
          forceRefresh.current = true;
          setError('');
          setRefresh(value => value + 1);
        }}><RotateCw size={16} className={loading ? 'animate-spin' : ''} /></button>
        {device?.status === 'off' && <button type="button" className="eterx-wb-button is-primary" disabled={busy} onClick={() => void act('start-device', { deviceId: device.id })}><Play size={14} />{action === 'start-device' ? 'Starting…' : 'Start'}</button>}
        {device && device.transport !== 'connected' && connected && <button type="button" className="eterx-wb-icon" title="Power off this virtual device" aria-label="Power off this virtual device"
          disabled={busy} onClick={() => void act('stop-device', { deviceId: device.id })}>{action === 'stop-device' ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}</button>}
        {device?.transport === 'simulator' && device.hostId === localDeviceHostId && connected && <button type="button" className="eterx-wb-icon" title="Open Simulator window" aria-label="Open Simulator window" disabled={busy} onClick={() => void act('open-simulator', { deviceId: device.id })}><Monitor size={16} /></button>}
      </div>
      {error && <p className="eterx-wb-error" role="alert">{error}</p>}
      {notice && <p className="eterx-wb-device-notice" role="status">{notice}</p>}
      {device ? <DeviceViewport key={device.id} chatId={chatId} device={device} visible={visible} send={send} busy={busy}
        runInput={async input => Boolean(await act('device-input', { deviceId: device.id, input })) && currentDevice.current === device.id}
        textOpen={textOpen} onToggleText={() => setTextOpen(value => !value)} />
        : <div className="eterx-wb-stage"><div className="eterx-wb-placeholder">
          <Smartphone size={33} strokeWidth={1.4} /><strong>{catalog?.devices.length ? 'Choose a development device' : loading ? 'Finding development devices…' : 'No development devices connected'}</strong>
          {!desktop ? <span>Use EterX Desktop on your development computer.</span> : <>
            {selectedId && !loading && <span>The selected device is unavailable. Choose another device or manage its connection.</span>}
            {!catalog?.devices.length && local && <><span>{local.android}</span>{local.apple && <span>{local.apple}</span>}</>}
            {!catalog?.devices.length && <button type="button" className="eterx-wb-button" onClick={onOpenConnections}><Link2 size={14} />Set up devices</button>}
          </>}
        </div></div>}
      {device && connected && <div className="eterx-wb-device-tools">
        {device.input && device.formFactor === 'tv' && <div className="eterx-wb-device-controls" role="group" aria-label="TV navigation">
          {remoteKeys.map(({ key, icon: Icon }) => <button key={key} type="button" className="eterx-wb-icon" aria-label={'TV ' + key} title={key} disabled={busy} onClick={() => send({ kind: 'key', key })}><Icon size={16} /></button>)}
        </div>}
        {device.input && device.formFactor !== 'tv' && textOpen && <form className="eterx-wb-device-form" onSubmit={async event => {
          event.preventDefault();
          if (text && await act('device-input', { deviceId: device.id, input: { kind: 'text', text } }) && currentDevice.current === device.id) setText('');
        }}><Keyboard size={15} /><input ref={textField} aria-label="Text for device" placeholder="Type on device" value={text} maxLength={256}
          onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setTextOpen(false); } }} />
          <button type="submit" disabled={busy || !text}>Send</button>
        </form>}
        {!device.input && device.transport === 'simulator' && <p>
          {device.hostId === localDeviceHostId ? 'Use the Simulator window for input. Apple runtime setup is in Connections.' : 'See the Apple runtime setup in Connections for input on this Mac.'}
        </p>}
        <form className="eterx-wb-device-form" onSubmit={async event => {
          event.preventDefault();
          if (appId.trim() && await act('launch-app', { deviceId: device.id, appId: appId.trim() }) && currentDevice.current === device.id) setNotice('App launched.');
        }}>
          <input aria-label="Installed app identifier" placeholder="App package or bundle ID" value={appId} maxLength={200} onChange={event => setAppId(event.target.value)} spellCheck={false} />
          <button type="submit" disabled={!appId.trim() || busy}><Play size={13} />{action === 'launch-app' ? 'Launching…' : 'Launch'}</button>
        </form>
        <details key={device.id} className="eterx-wb-install">
          <summary><ArrowDownToLine size={13} />Install a build</summary>
          <p>Choose a built .{buildExtension} on {hostLabel}.{buildExtension === 'app' && ' Use a simulator build.'}</p>
          <form className="eterx-wb-device-form" onSubmit={async event => {
            event.preventDefault();
            if (!artifact.trim()) return;
            const result = await act('install-app', { deviceId: device.id, artifact: artifact.trim() });
            if (result && currentDevice.current === device.id) {
              if (result.appId) setAppId(result.appId);
              setNotice('Build installed. Use the app identifier to launch it.');
            }
          }}>
            <input aria-label="Build path" placeholder={device.hostId === localDeviceHostId ? 'Absolute path to build' : 'Absolute path on this host'} value={artifact} maxLength={4096} onChange={event => setArtifact(event.target.value)} spellCheck={false} />
            {picker && <button type="button" disabled={busy} aria-label="Browse for a build" title="Browse for a build" onClick={async () => {
              try {
                const file = await picker(buildExtension);
                if (file && currentDevice.current === device.id) setArtifact(file);
              } catch (error) { setError(errorText(error)); }
            }}><FolderOpen size={15} /></button>}
            <button type="submit" disabled={busy || !artifact.trim()}>{action === 'install-app' ? 'Installing…' : 'Install'}</button>
          </form>
        </details>
      </div>}
      {!!catalog?.hosts.some(host => host.id !== localDeviceHostId) && <details className="eterx-wb-machines">
        <summary>Device connections</summary>
        <ul className="eterx-wb-device-hosts">
          {catalog.hosts.map(host => <li key={host.id}>
            <div><strong>{host.name}</strong><span>{deviceHostStateLabel[host.state]}</span></div>
            {host.detail && <p>{host.detail}</p>}
          </li>)}
        </ul>
        <button type="button" className="eterx-wb-button" onClick={onOpenConnections}>Manage connections</button>
      </details>}
    </>}
  </div>;
}
