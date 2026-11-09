'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Download, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';

type Option = { value: string; label: string; description?: string };
type ModelState = {
  id: string;
  status: 'available' | 'preparing' | 'downloading' | 'verifying' | 'installed' | 'cancelled' | 'error';
  progress: number;
  bundled?: boolean;
  error?: string;
};
type SpeechModel = ModelState & {
  name: string; family: string; bytes: number; englishOnly: boolean; precision: string;
};
type Props = {
  microphoneDeviceId: string;
  language: string;
  modelId: string;
  onMicrophoneChange: (id: string) => void;
  onLanguageChange: (id: string) => void;
  onModelChange: (id: string) => void;
  Select: React.ComponentType<{ value: string; options: Option[]; onChange: (id: string) => void; className?: string }>;
};

const formatSize = (bytes: number) => bytes >= 1_000_000_000
  ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
const isBusy = (state: ModelState) => ['preparing', 'downloading', 'verifying'].includes(state.status);
const Row = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
  <div className="eterx-settings-stack-row flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] px-5 py-4 last:border-b-0">
    <div className="min-w-0 flex-1">
      <div className="eterx-setting-label text-[13px] font-medium text-[#F1F1F1]">{title}</div>
      {description && <div className="eterx-setting-description mt-1 text-[12px] leading-relaxed text-[#A7A7A7]">{description}</div>}
    </div>
    {children}
  </div>
);

export function MicrophoneSettings({ microphoneDeviceId, language, modelId, onMicrophoneChange, onLanguageChange, onModelChange, Select }: Props) {
  const [microphones, setMicrophones] = useState<Option[]>([]);
  const [deviceMessage, setDeviceMessage] = useState('');
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [languages, setLanguages] = useState<Option[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [actionError, setActionError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [usingModel, setUsingModel] = useState('');
  const mounted = useRef(false);
  const updates = useRef(new Map<string, ModelState>());
  const deviceRequest = useRef(0);
  const catalogRequest = useRef(0);
  const applyRequest = useRef(0);

  const loadDevices = useCallback(async (requestPermission = false) => {
    const request = ++deviceRequest.current;
    let stream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('Microphone selection is available in the desktop app.');
      if (requestPermission) {
        setDeviceBusy(true);
        const access = await (window as any).electronAPI?.requestLiveMediaPermissions?.();
        if (!mounted.current || request !== deviceRequest.current) return;
        if (['denied', 'restricted'].includes(access?.microphone)) throw new Error('Allow EterX microphone access in system settings, then refresh.');
        // Device names are hidden until microphone access is granted. This
        // brief permission request is only made after clicking Refresh.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!mounted.current || request !== deviceRequest.current) return;
      const audio = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
      setMicrophones(audio.map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` })));
      setDeviceMessage(devices.some(device => device.kind === 'audioinput' && !device.label)
        ? 'Refresh and allow microphone access to see device names.'
        : audio.length ? '' : 'No named microphone is available yet. Connect a device or refresh to grant access.');
    } catch (error) {
      if (mounted.current && request === deviceRequest.current) setDeviceMessage(error instanceof Error ? error.message : 'Could not list microphones.');
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (mounted.current && request === deviceRequest.current) setDeviceBusy(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    const request = ++catalogRequest.current;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const api = (window as any).electronAPI;
      if (!api?.getSpeechModelCatalog) throw new Error('Local speech model downloads are available in the EterX desktop app.');
      const catalog = await api.getSpeechModelCatalog();
      if (catalog?.error || !Array.isArray(catalog?.models)) throw new Error(catalog?.error || 'Could not load speech models.');
      if (!mounted.current || request !== catalogRequest.current) return;
      setModels(catalog.models.map((model: SpeechModel) => ({ ...model, ...updates.current.get(model.id) })));
      setLanguages(catalog.languages || []);
    } catch (error) {
      if (mounted.current && request === catalogRequest.current) setCatalogError(error instanceof Error ? error.message : 'Could not load speech models.');
    } finally {
      if (mounted.current && request === catalogRequest.current) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = (window as any).electronAPI?.onSpeechModelState?.((state: ModelState) => {
      if (!mounted.current || !state?.id) return;
      updates.current.set(state.id, state);
      setModels(previous => previous.map(model => model.id === state.id ? { ...model, error: undefined, ...state } : model));
    });
    void loadCatalog();
    void loadDevices();
    const changed = () => { void loadDevices(); };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => {
      mounted.current = false;
      deviceRequest.current++;
      catalogRequest.current++;
      applyRequest.current++;
      unsubscribe?.();
      navigator.mediaDevices?.removeEventListener('devicechange', changed);
    };
  }, [loadCatalog, loadDevices]);

  const download = async (model: SpeechModel, useAfter = false) => {
    const request = useAfter ? ++applyRequest.current : 0;
    if (useAfter) setUsingModel(model.id);
    setActionError('');
    try {
      const result = await (window as any).electronAPI.downloadSpeechModel(model.id);
      if (!mounted.current) return;
      if (!result?.success) {
        if (!/cancelled/i.test(result?.error || '')) setActionError(result?.error || 'Download failed. Please retry.');
        return;
      }
      if (useAfter && request === applyRequest.current) onModelChange(model.id);
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : 'Could not prepare this model.');
    } finally {
      if (useAfter && mounted.current && request === applyRequest.current) setUsingModel('');
    }
  };

  const cancel = async (id: string) => {
    try {
      const result = await (window as any).electronAPI.cancelSpeechModelDownload(id);
      if (mounted.current && result?.error) setActionError(result.error);
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : 'Could not cancel the download.');
    }
  };

  const savedDeviceMissing = microphoneDeviceId !== 'default' && !microphones.some(device => device.value === microphoneDeviceId);
  const deviceOptions = [
    { value: 'default', label: 'System default' },
    ...microphones,
    ...(savedDeviceMissing ? [{ value: microphoneDeviceId, label: 'Saved microphone (unavailable)' }] : []),
  ];
  const selected = models.find(model => model.id === modelId);
  const languageConflict = selected?.englishOnly && language !== 'auto' && language !== 'en';
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = models.filter(model => (!downloadedOnly || model.status === 'installed' || isBusy(model))
    && `${model.name} ${model.id} ${model.precision} ${model.englishOnly ? 'english only' : 'multilingual'}`.toLowerCase().includes(normalizedQuery));

  return (
    <div>
      <div className="eterx-settings-stack overflow-visible rounded-xl border border-white/[0.09] bg-[#202020]">
        <Row title="Microphone" description="Used for voice chat and dictation">
          <Select value={microphoneDeviceId} onChange={onMicrophoneChange} options={deviceOptions} className="w-[230px] max-w-full" />
          <button type="button" onClick={() => void loadDevices(true)} disabled={deviceBusy} aria-label="Refresh microphones and allow access" title="Refresh microphones" className="p-2 text-[#A7A7A7] hover:text-[#F1F1F1] disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${deviceBusy ? 'animate-spin' : ''}`} />
          </button>
        </Row>
        <Row title="Language" description="Language spoken during local dictation">
          <Select value={language} onChange={onLanguageChange} options={[{ value: 'auto', label: 'Auto-detect' }, ...languages]} className="w-[230px] max-w-full" />
        </Row>
        <Row title="Speech model" description={selected ? `${selected.name} · ${selected.precision} · ${formatSize(selected.bytes)}` : modelId === 'large-v3-q5_0' ? 'Whisper Large v3 · Q5 · Default' : modelId}>
          <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls="speech-model-manager" className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-4 py-2 text-[13px] font-medium text-[#F2F2F2] hover:bg-[#363636]">
            Manage models <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </Row>
      </div>
      {(deviceMessage || savedDeviceMissing) && <p role="status" className="mt-2 text-[12px] text-[#A7A7A7]">{savedDeviceMissing ? 'The saved microphone is unavailable. Reconnect it or choose System default.' : deviceMessage}</p>}
      {languageConflict && <p role="alert" className="mt-2 text-[12px] text-amber-400">The default model supports English only. Choose English, Auto-detect, or a multilingual model.</p>}
      <p className="mt-2 text-[12px] text-[#A7A7A7]">Changes apply the next time you start the microphone. Speech models run locally; live voice chat uses its configured provider.</p>

      {expanded && <div id="speech-model-manager" className="eterx-settings-stack mt-4 overflow-hidden rounded-xl border border-white/[0.09] bg-[#202020]">
        <div className="border-b border-white/[0.07] p-4">
          <div className="eterx-setting-label text-[13px] font-medium text-[#F1F1F1]">Local speech models</div>
          <p className="eterx-setting-description mt-1 text-[12px] leading-relaxed text-[#A7A7A7]">Download a model, then select Use to make it the default. Large models generally need more memory and processing time. Q5 and Q8 reduce download size; Original uses the original model precision.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="relative min-w-[160px] flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-[#888]" />
              <input aria-label="Search speech models" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search all speech models…" className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/10 pl-9 pr-3 text-[12px] text-[#F1F1F1] outline-hidden focus:border-blue-400" />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-[#A7A7A7]"><input type="checkbox" checked={downloadedOnly} onChange={event => setDownloadedOnly(event.target.checked)} /> Downloaded</label>
          </div>
        </div>
        {catalogLoading && <p role="status" className="flex items-center gap-2 p-4 text-[12px] text-[#A7A7A7]"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading speech models…</p>}
        {catalogError && <div role="alert" className="p-4 text-[12px] text-red-400">{catalogError} <button type="button" onClick={() => void loadCatalog()} className="ml-2 text-blue-400 underline">Retry</button></div>}
        {actionError && <p role="alert" className="px-4 pt-3 text-[12px] text-red-400">{actionError}</p>}
        <div className="max-h-[390px] overflow-y-auto eterx-scrollbar">
          {visibleModels.map(model => {
            const active = model.id === modelId;
            const busy = isBusy(model);
            const incompatible = model.englishOnly && language !== 'auto' && language !== 'en';
            return <div key={model.id} className="eterx-settings-stack-row flex items-center gap-4 border-b border-white/[0.07] px-4 py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="eterx-setting-label text-[13px] font-medium text-[#F1F1F1]">{model.name} <span className="ml-1 text-[11px] font-normal text-[#A7A7A7]">{model.precision}</span></div>
                <div className="eterx-setting-description mt-1 text-[11px] text-[#A7A7A7]">{formatSize(model.bytes)} · {model.englishOnly ? 'English only' : 'Multilingual'}{model.bundled ? ' · Included with EterX' : ''}</div>
                {model.status === 'error' && <p className="mt-1 text-[11px] text-red-400">{model.error}</p>}
                {incompatible && <p className="mt-1 text-[11px] text-amber-400">Select English or Auto-detect to use this model.</p>}
              </div>
              {busy ? <div className="flex shrink-0 items-center gap-2">
                <div className="w-[92px]" role="progressbar" aria-label={`Downloading ${model.name} ${model.precision}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={model.progress}>
                  <div className="mb-1 flex items-center justify-end gap-1.5 text-[12px] text-blue-400"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{model.status === 'downloading' ? `${model.progress}%` : model.status === 'verifying' ? 'Finishing…' : 'Preparing…'}</div>
                  <div className="h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-blue-500 transition-[width]" style={{ width: `${model.progress}%` }} /></div>
                </div>
                <button type="button" onClick={() => void cancel(model.id)} aria-label={`Cancel ${model.name} download`} title="Cancel download" className="p-1.5 text-[#A7A7A7] hover:text-white"><X className="h-4 w-4" /></button>
              </div> : model.status === 'installed' ? active
                ? <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-blue-400"><Check className="h-4 w-4" />Default</span>
                : <button type="button" onClick={() => void download(model, true)} disabled={Boolean(usingModel) || incompatible} className="shrink-0 rounded-lg bg-blue-500 px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40">Use</button>
                : <button type="button" onClick={() => void download(model)} aria-label={`Download ${model.name} ${model.precision}, ${formatSize(model.bytes)}`} title={model.status === 'error' ? 'Retry download' : `Download ${formatSize(model.bytes)}`} className="flex shrink-0 items-center gap-1.5 rounded-lg p-2 text-[#A7A7A7] hover:bg-white/[0.06] hover:text-blue-400"><Download className="h-5 w-5" />{model.status === 'error' && <span className="text-[11px]">Retry</span>}</button>}
            </div>;
          })}
          {!catalogLoading && !catalogError && visibleModels.length === 0 && <p className="p-5 text-center text-[12px] text-[#A7A7A7]">No matching models.</p>}
        </div>
        {!catalogLoading && !catalogError && <p className="border-t border-white/[0.07] px-4 py-2 text-[11px] text-[#A7A7A7]">{models.length} supported models and variants · Available offline after download</p>}
      </div>}
    </div>
  );
}
