'use client';

import { useState } from 'react';
import { ChevronRight, LockKeyhole, RefreshCw } from 'lucide-react';
import styles from './computer-use-settings.module.css';

type BrowserAction = 'connect_signed' | 'launch_managed';
type AccessSetting = 'browserAccess' | 'computerUse' | 'autoReview';

interface RuntimeStatus {
  success?: boolean;
  platform?: string;
  signedBrowser?: boolean;
  managedBrowser?: boolean;
  signedBrowserAvailable?: boolean;
  signedBrowserReason?: string;
  browser?: { mode?: string };
  computer?: {
    screenProvider?: string;
    inputProvider?: string;
    cuaDriver?: {
      healthy?: boolean; installed?: boolean; version?: string; daemonRunning?: boolean;
      overall?: string; message?: string;
      health?: { checks?: Array<{ name?: string; status?: string; message?: string; hint?: string }> };
    };
  };
}

interface ComputerUseSettingsProps {
  settings: Record<AccessSetting, boolean>;
  runtime: RuntimeStatus | null;
  runtimeBusy: boolean;
  runtimeMessage: string;
  accessError?: string;
  platform: string;
  onSettingChange: (key: AccessSetting, value: boolean) => void;
  onBrowserAction: (action: BrowserAction) => Promise<void>;
  onRefresh: () => Promise<void>;
}

function AccessRow({
  id,
  title,
  description,
  enabled,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.copy}>
        <label className={styles.label} htmlFor={id}>{title}</label>
        <p className={styles.description} id={`${id}-description`}>{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={title}
        aria-describedby={`${id}-description`}
        className={styles.toggle}
        onClick={() => onChange(!enabled)}
      >
        <span className={styles.toggleThumb} />
      </button>
    </div>
  );
}

export function ComputerUseSettings({
  settings,
  runtime,
  runtimeBusy,
  runtimeMessage,
  accessError,
  platform,
  onSettingChange,
  onBrowserAction,
  onRefresh,
}: ComputerUseSettingsProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopMessage, setDesktopMessage] = useState('');
  const driver = runtime?.computer?.cuaDriver;
  const browserConnected = Boolean(runtime?.signedBrowser || runtime?.managedBrowser);
  const platformId = runtime?.platform || platform;
  const platformLabel: Record<string, string> = {
    win32: 'Windows', windows: 'Windows', darwin: 'macOS', mac: 'macOS', linux: 'Linux', unknown: 'Detecting…',
  };
  const browserState = runtimeBusy ? 'Connecting…' : runtime?.success === false ? 'Unavailable' : browserConnected ? 'Connected' : runtime ? 'Not connected' : 'Checking…';
  const checkingDesktop = !driver || driver.overall === 'checking';
  const desktopState = !settings.computerUse ? 'Off' : desktopBusy ? 'Starting…' : checkingDesktop ? 'Checking…' : driver?.healthy ? 'Ready' : driver?.daemonRunning ? 'Needs attention' : driver?.installed ? 'Stopped' : 'Setup required';
  const browserSession = runtime?.signedBrowser ? 'Existing browser' : runtime?.managedBrowser ? 'Isolated browser' : 'No active session';
  const driverState = checkingDesktop ? 'Checking…' : driver?.healthy ? (driver.version ? `Cua ${driver.version}` : 'Ready') : driver?.daemonRunning ? 'Needs attention' : driver?.installed ? 'Stopped' : 'Not installed';

  const setupDesktop = async (action: 'start' | 'permissions') => {
    setDesktopBusy(true);
    setDesktopMessage(action === 'start' ? 'Starting desktop service…' : 'Opening macOS permissions…');
    try {
      const response = await fetch('/api/computer/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }), signal: AbortSignal.timeout(40_000),
      });
      const payload = await response.json();
      setDesktopMessage(response.ok && payload.success ? payload.message : payload.error || 'Desktop setup could not finish.');
    } catch {
      setDesktopMessage('Could not finish desktop setup. Refresh status to see the current state.');
    } finally {
      try { await onRefresh(); }
      catch { setDesktopMessage('Could not refresh desktop status. Try Refresh again.'); }
      finally { setDesktopBusy(false); }
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/computer/status?refresh=1', { cache: 'no-store', signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
      await onRefresh();
      setDesktopMessage('');
    } catch {
      setDesktopMessage('Could not refresh desktop status. Try Refresh again.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <p>Manage browser and desktop access on this device.</p>
        <button type="button" className={styles.refreshButton} onClick={() => void refresh()} disabled={refreshing || runtimeBusy}>
          <RefreshCw size={13} aria-hidden="true" />
          {refreshing ? 'Refreshing…' : 'Refresh status'}
        </button>
      </div>

      <section className={styles.section} aria-labelledby="computer-browser-heading">
        <div className={styles.sectionHeader}>
          <h4 id="computer-browser-heading">Browser control</h4>
          <span className={styles.status} data-ready={browserConnected && !runtimeBusy && runtime?.success !== false}>{browserState}</span>
        </div>
        <AccessRow
          id="computer-browser-access"
          title="Allow browser control"
          description="Let EterX navigate pages and interact with browser tabs."
          enabled={settings.browserAccess}
          onChange={value => onSettingChange('browserAccess', value)}
        />
        <div className={styles.session}>
          <div className={styles.sessionHeading}>
            <span className={styles.label}>Browser session</span>
            {browserConnected && <span className={styles.sessionType}>{browserSession}</span>}
          </div>
          <p className={styles.description}>Connect your signed-in browser or start a separate, isolated session.</p>
          <div className={styles.actions} aria-busy={runtimeBusy}>
            <button
              type="button"
              className={`${styles.button} ${styles.primaryButton}`}
              disabled={runtimeBusy || refreshing || runtime?.signedBrowserAvailable === false}
              onClick={() => void onBrowserAction('connect_signed')}
            >
              Connect existing browser
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={runtimeBusy || refreshing}
              onClick={() => void onBrowserAction('launch_managed')}
            >
              Launch isolated browser
            </button>
          </div>
          <p className={styles.hint}>Existing sessions use your Chrome, Edge, or Brave profile. Close the browser before reconnecting.</p>
          <p className={styles.runtimeMessage} role="status">{runtimeMessage}</p>
          {runtime?.signedBrowserAvailable === false && (
            <p className={styles.notice}>Existing browser unavailable{runtime.signedBrowserReason ? `: ${runtime.signedBrowserReason}` : '.'}</p>
          )}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="computer-desktop-heading">
        <div className={styles.sectionHeader}>
          <h4 id="computer-desktop-heading">Desktop control</h4>
          <span className={styles.status} data-ready={settings.computerUse && driver?.healthy}>{desktopState}</span>
        </div>
        <AccessRow
          id="computer-desktop-access"
          title="Allow computer actions"
          description="Let General and Coding Heavy view the screen and interact with native apps. Agent tool settings and task access also apply."
          enabled={settings.computerUse}
          onChange={value => onSettingChange('computerUse', value)}
        />
        {accessError && <p className={styles.notice} role="alert">{accessError}</p>}
        <p className={styles.hint}>Desktop work uses screenshots with your selected model. Choose a model that accepts images and tools; changing provider does not change desktop access. In the desktop app, a soft blue border shows active computer use. Press Escape to stop it.</p>
        {!checkingDesktop && !driver?.healthy && (
          <div className={styles.session}>
            <p className={styles.description}>{driver?.message || 'Set up desktop access on this device.'}</p>
            <div className={styles.actions}>
              {driver?.installed && !driver.daemonRunning && (
                <button type="button" className={styles.button} disabled={desktopBusy || refreshing} onClick={() => void setupDesktop('start')}>Start desktop service</button>
              )}
              {driver?.installed && ['darwin', 'mac'].includes(platformId) && (
                <button type="button" className={styles.button} disabled={desktopBusy || refreshing} onClick={() => void setupDesktop('permissions')}>Open macOS permissions</button>
              )}
              {!driver?.installed && <a className={styles.button} href="https://cua.ai/docs/cua-driver/quickstart" target="_blank" rel="noopener noreferrer">Desktop setup guide</a>}
            </div>
          </div>
        )}
        {desktopMessage && <p className={styles.runtimeMessage} role="status">{desktopMessage}</p>}
        <details className={styles.details}>
          <summary>
            <ChevronRight className={styles.disclosureIcon} size={14} aria-hidden="true" />
            <span>Connection details</span>
            <span className={styles.runtimeSummary}>{driver?.healthy ? 'Desktop runtime ready' : driver?.installed ? 'Setup required' : 'Runtime information'}</span>
          </summary>
          <dl className={styles.metadata}>
            {[
              ['Operating system', platformLabel[platformId] || platformId],
              ['Browser session', browserSession],
              ['Browser mode', browserConnected ? runtime?.browser?.mode || browserSession : 'Not connected'],
              ['Desktop driver', driverState],
              ['Service', checkingDesktop ? 'Checking…' : driver?.daemonRunning ? 'Running' : 'Stopped'],
              ['Screen provider', runtime?.computer?.screenProvider || (runtime ? 'Unavailable' : 'Checking…')],
              ['Input provider', runtime?.computer?.inputProvider || (runtime ? 'Unavailable' : 'Checking…')],
            ].map(([label, value]) => (
              <div className={styles.metadataRow} key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {driver?.health?.checks?.filter(check => check.status !== 'pass' && check.status !== 'ok').map((check, index) => (
            <p key={`${check.name}-${index}`} className={styles.notice}>{check.message || check.name}{check.hint ? ` ${check.hint}` : ''}</p>
          ))}
        </details>
      </section>

      <section className={styles.section} aria-labelledby="computer-permissions-heading">
        <div className={styles.sectionHeader}>
          <h4 id="computer-permissions-heading">Safety & permissions</h4>
        </div>
        <AccessRow
          id="computer-permission-review"
          title="Permission review"
          description="Review sensitive desktop actions before they run."
          enabled={settings.autoReview}
          onChange={value => onSettingChange('autoReview', value)}
        />
        <p className={styles.permissionNote}>
          <LockKeyhole size={13} aria-hidden="true" />
          <span>Desktop actions follow the active task’s access permissions and this device’s operating-system permissions.</span>
        </p>
      </section>
    </div>
  );
}
