'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, FolderOpen, Laptop, Link2, Loader2, Pause, Pencil, Play, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { notifyDeviceConnectionsChanged, workbenchJson } from '../../lib/workbench/client';
import {
  deviceHostLimit, deviceHostStateLabel, localDeviceHostId,
  type DeviceConnectionSettings, type DeviceHostInput, type DeviceHostProfile, type DeviceHostStatus,
} from '../../lib/workbench/contracts';
import { safeCopyTextToClipboard } from '../ui/copy-button';
import styles from './connections-settings.module.css';

type Change =
  | { action: 'save'; id?: string; profile: DeviceHostInput }
  | { action: 'set-enabled'; id: string; enabled: boolean }
  | { action: 'remove' | 'inspect'; id: string };
type Draft = { id?: string; name: string; target: string; port: string; identityFile: string; enabled: boolean };

const endpoint = '/api/settings/connections';
const clientHeaders = { 'X-EterX-Workbench': 'connections' };
const emptyDraft: Draft = { name: '', target: '', port: '', identityFile: '', enabled: true };
const osNames = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

function summarizeHost(host?: DeviceHostStatus) {
  const summary = [];
  if (host?.platform) summary.push(osNames[host.platform]);
  if (host?.androidCount) summary.push(host.androidCount + (host.androidCount === 1 ? ' Android device' : ' Android devices'));
  if (host?.appleCount) summary.push(host.appleCount + (host.appleCount === 1 ? ' Apple simulator' : ' Apple simulators'));
  return summary.join(' · ');
}

function HostBadge({ state, busy }: { state: DeviceHostStatus['state']; busy?: boolean }) {
  return <span className={styles.badge} data-state={busy ? 'idle' : state}>
    {busy ? <Loader2 size={12} className="animate-spin" /> : <i aria-hidden="true" />}
    {busy ? 'Connecting…' : deviceHostStateLabel[state]}
  </span>;
}

function HostDetails({ status, profile, windows }: { status?: DeviceHostStatus; profile?: DeviceHostProfile; windows?: boolean }) {
  const [copyStatus, setCopyStatus] = useState('');
  if (!status || status.state === 'paused' || status.state === 'idle') return null;
  const identity = profile?.identityFile;
  const quotedKey = identity ? "'" + identity.replace(/'/g, windows ? "''" : "'\\''") + "'" : '';
  const command = profile ? [
    'ssh',
    ...(profile.port ? ['-p', String(profile.port)] : []),
    ...(quotedKey ? ['-i', quotedKey] : []),
    profile.target.replace(/\[([^\]]+)\]$/, '$1'),
  ].join(' ') : '';
  const details = [status.detail, status.apple, status.android].filter(Boolean);
  return details.length > 0 && <div className={styles.details} data-offline={status.state === 'offline'}>
    {details.map((text, index) => <p key={index}>{text}</p>)}
    {status.state === 'offline' && command && <div className={styles.copyRow}>
      <code>{command}</code>
      <button type="button" className={styles.quiet} title={windows ? 'Copy for PowerShell' : 'Copy for Terminal'} onClick={async () => {
        const copied = await safeCopyTextToClipboard(command);
        setCopyStatus(copied ? 'Copied' : 'Select the command to copy it');
      }}>{copyStatus || 'Copy SSH command'}</button>
    </div>}
  </div>;
}

function SetupGuide({ local }: { local?: DeviceHostStatus }) {
  return <section className={styles.section} data-settings-search-target="device-setup" tabIndex={-1}>
    <h4>Device setup</h4>
    <div className={styles.guide}>
      <details>
        <summary>Android phone or emulator</summary>
        <p>Install Android Studio and Android SDK Platform-Tools on the machine that will run the app. In Android Studio, open Device Manager and create a phone, tablet, watch, or TV emulator. For a physical Android device, enable USB debugging and accept its connection prompt.</p>
        <a href="https://developer.android.com/studio" target="_blank" rel="noreferrer">Get Android Studio <ArrowUpRight size={13} /></a>
      </details>
      <details>
        <summary>iPhone, iPad, and other Apple simulators</summary>
        <p>{local?.platform === 'macos' ? 'Set up Xcode on this Mac or connect to another Mac.' : 'Use a Mac you can access, including a hosted Mac. You can use an iPhone simulator without a physical iPhone.'} On the Mac, open Xcode to complete first launch, select Xcode in Settings → Locations, then install a simulator runtime in Settings → Components.</p>
        <p>Workbench can boot simulators, install builds, and show screenshots using Xcode. For iPhone and iPad video and in-panel input, install idb and idb_companion on the Mac. Apple Watch, Apple TV, and visionOS controls vary by runtime.</p>
        <div className={styles.links}>
          <a href="https://developer.apple.com/xcode/" target="_blank" rel="noreferrer">Get Xcode <ArrowUpRight size={13} /></a>
          <a href="https://fbidb.io/docs/installation/" target="_blank" rel="noreferrer">Install idb <ArrowUpRight size={13} /></a>
        </div>
      </details>
      <details>
        <summary>Connect a machine over SSH</summary>
        <p>On a Mac, turn on Remote Login under System Settings → General → Sharing. On Linux, enable the SSH server. Use a machine and account you control.</p>
        <p>Set up key authentication, then sign in once from this computer’s terminal and verify the machine’s fingerprint. Enter the same SSH address or an alias from your SSH config. If your provider supplies a separate key file, choose it under SSH options.</p>
        <p>Build the app on the device host or make the built app available there. In Workbench → Devices, choose the host’s device and select Install a build.</p>
      </details>
    </div>
  </section>;
}

export function ConnectionsSettings({ onOpenDevices }: { onOpenDevices?: () => void }) {
  const [data, setData] = useState<DeviceConnectionSettings>();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [remove, setRemove] = useState('');
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const identityInputId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    workbenchJson<DeviceConnectionSettings>(endpoint, { headers: clientHeaders, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message || 'Connections could not be loaded.'); });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [reload]);

  async function update(change: Change, key: string) {
    if (request.current) return false;
    const controller = new AbortController();
    request.current = controller;
    setBusy(key);
    setError('');
    try {
      const result = await workbenchJson<DeviceConnectionSettings>(endpoint, {
        method: 'POST',
        headers: { ...clientHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
        signal: controller.signal,
      }, 40_000);
      if (controller.signal.aborted) return false;
      setData(result);
      notifyDeviceConnectionsChanged();
      return true;
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setBusy('');
      }
    }
  }

  const local = data?.hosts.find(host => host.id === localDeviceHostId);
  const chooseKey = typeof window !== 'undefined'
    ? (window as typeof window & { electronAPI?: { workbenchChooseFile?: (kind: 'ssh-key') => Promise<string | null> } }).electronAPI?.workbenchChooseFile
    : undefined;
  return <div className={styles.root}>
    <div className={styles.intro}>
      <p>Use devices on this computer or connect another computer to run its simulators in the Workbench.</p>
      {onOpenDevices && data?.hosts.some(host => host.state === 'ready') && <button type="button" className={styles.secondary} onClick={onOpenDevices}>Open Devices <ArrowUpRight size={14} /></button>}
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!data && error && <button type="button" className={styles.secondary} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />Retry</button>}
    {!data && !error && <p className={styles.loading} role="status"><Loader2 size={15} className="animate-spin" />Loading connections…</p>}
    {data?.desktop === false && <div className={styles.empty}>Open EterX Desktop to set up devices and connect development machines.</div>}
    {data?.desktop && <>
      {local && <section className={styles.section} data-settings-search-target="local-device-runtimes" tabIndex={-1}>
        <h4>This computer</h4>
        <div className={styles.panel}>
          <div className={styles.row}>
            <Laptop size={18} className={styles.rowIcon} />
            <div className={styles.rowText}><strong>Local devices</strong><span>{summarizeHost(local) || 'No devices available'}</span></div>
            <div className={styles.actions}>
              <HostBadge state={local.state} busy={busy === localDeviceHostId} />
              <button className={styles.iconButton} type="button" disabled={Boolean(busy)} title="Refresh local devices" aria-label="Refresh local devices" onClick={() => void update({ action: 'inspect', id: localDeviceHostId }, localDeviceHostId)}><RefreshCw size={15} /></button>
            </div>
          </div>
          <HostDetails status={local} />
        </div>
      </section>}
      <section className={styles.section} data-settings-search-target="remote-device-connections" tabIndex={-1}>
        <div className={styles.heading}>
          <h4>Remote machines</h4>
          <button className={styles.primary} type="button" disabled={Boolean(busy) || Boolean(draft) || data.profiles.length >= deviceHostLimit}
            onClick={() => { setError(''); setRemove(''); setDraft(emptyDraft); }}><Plus size={15} />Add connection</button>
        </div>
        {!data.sshAvailable && <p className={styles.hint}>Install the OpenSSH client on this computer, then reopen Connections.</p>}
        {draft && <form className={styles.editor} onSubmit={async event => {
          event.preventDefault();
          const { id, name, target, port, identityFile, enabled } = draft;
          const profile = { name: name.trim(), target: target.trim(), port: port ? Number(port) : undefined, identityFile: identityFile.trim() || undefined, enabled };
          if (await update({ action: 'save', id, profile }, 'save')) setDraft(undefined);
        }}>
          <h5>{draft.id ? 'Edit machine' : 'Add a machine'}</h5>
          <div className={styles.fields}>
            <label>Machine name<input autoFocus required maxLength={64} placeholder="Build Mac" value={draft.name} disabled={Boolean(busy)}
              onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>SSH address<input required maxLength={255} placeholder="user@mac.local or SSH alias" value={draft.target} disabled={Boolean(busy)} spellCheck={false}
              onChange={event => setDraft({ ...draft, target: event.target.value })} /></label>
          </div>
          <details className={styles.advanced} open={Boolean(draft.port || draft.identityFile) || undefined}>
            <summary>SSH options</summary>
            <div className={styles.advancedFields}>
              <div>
                <label htmlFor={identityInputId}>Identity file <small>optional</small></label>
                <div className={styles.fileInput}>
                  <input id={identityInputId} type="text" maxLength={4096} spellCheck={false} placeholder="Use SSH config or existing keys" value={draft.identityFile} disabled={Boolean(busy)}
                    onChange={event => setDraft({ ...draft, identityFile: event.target.value })} />
                  {chooseKey && <button type="button" className={styles.secondary} disabled={Boolean(busy)} aria-label="Choose an SSH identity file" title="Choose SSH key file" onClick={async () => {
                    try {
                      const file = await chooseKey('ssh-key');
                      if (file) setDraft(current => current && current.id === draft.id ? { ...current, identityFile: file } : current);
                    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
                  }}><FolderOpen size={15} /></button>}
                </div>
              </div>
              <label>Port <small>optional</small><input type="number" min={1} max={65535} step={1} placeholder="SSH default" value={draft.port} disabled={Boolean(busy)}
                onChange={event => setDraft({ ...draft, port: event.target.value })} /></label>
            </div>
          </details>
          <p className={styles.hint}>Devices are grouped by machine in Workbench → Devices. The agent uses your Computer Use permissions.</p>
          <div className={styles.editorActions}>
            <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => setDraft(undefined)}>Cancel</button>
            <button type="submit" className={styles.primary} disabled={Boolean(busy) || !draft.name.trim() || !draft.target.trim()}>
              {busy === 'save' && <Loader2 size={14} className="animate-spin" />}
              {busy === 'save' ? (draft.enabled ? 'Connecting…' : 'Saving…') : draft.enabled ? 'Save and connect' : 'Save'}
            </button>
          </div>
        </form>}
        {!data.profiles.length && !draft && <div className={styles.empty}>
          <Link2 size={18} /><p>Connect a Mac with Xcode for Apple simulators, or a Mac or Linux machine with Android SDK tools.</p>
        </div>}
        {data.profiles.length > 0 && <ul className={styles.panel}>
          {data.profiles.map(profile => {
            const status = data.hosts.find(host => host.id === profile.id);
            const summary = summarizeHost(status);
            return <li key={profile.id} className={styles.machine}>
              <div className={styles.row}>
                <Server size={18} className={styles.rowIcon} />
                <div className={styles.rowText}>
                  <strong>{profile.name}</strong>
                  <span>{profile.target}{profile.port && ' · Port ' + profile.port}{summary && ' · ' + summary}</span>
                </div>
                <div className={styles.actions}>
                  <HostBadge state={status?.state || 'idle'} busy={busy === profile.id} />
                  {profile.enabled && <button type="button" className={styles.secondary} disabled={Boolean(busy)}
                    aria-label={'Check connection to ' + profile.name} title="Check connection"
                    onClick={() => void update({ action: 'inspect', id: profile.id }, profile.id)}>Check</button>}
                  <button type="button" className={styles.iconButton} disabled={Boolean(busy) || Boolean(draft)}
                    title={profile.enabled ? 'Disable connection' : 'Enable connection'}
                    aria-label={(profile.enabled ? 'Disable ' : 'Enable ') + profile.name}
                    onClick={() => void update({ action: 'set-enabled', id: profile.id, enabled: !profile.enabled }, profile.id)}>{profile.enabled ? <Pause size={14} /> : <Play size={14} />}</button>
                  <button type="button" className={styles.iconButton} disabled={Boolean(busy)} title="Edit connection" aria-label={'Edit ' + profile.name}
                    onClick={() => {
                      setRemove('');
                      setError('');
                      setDraft({ ...profile, port: profile.port?.toString() || '', identityFile: profile.identityFile || '' });
                    }}><Pencil size={14} /></button>
                  <button type="button" className={styles.iconButton} disabled={Boolean(busy) || Boolean(draft)} title="Remove connection" aria-label={'Remove ' + profile.name} onClick={() => setRemove(profile.id)}><Trash2 size={14} /></button>
                </div>
              </div>
              {remove === profile.id ? <div className={styles.confirm}>
                <span>Remove {profile.name} from Connections?</span>
                <button type="button" className={styles.secondary} onClick={() => setRemove('')} disabled={Boolean(busy)}>Cancel</button>
                <button type="button" className={styles.danger} disabled={Boolean(busy)} onClick={async () => {
                  if (await update({ action: 'remove', id: profile.id }, profile.id)) setRemove('');
                }}>Remove</button>
              </div> : <HostDetails key={profile.id} status={status} profile={profile} windows={local?.platform === 'windows'} />}
            </li>;
          })}
        </ul>}
      </section>
      <SetupGuide local={local} />
    </>}
  </div>;
}
