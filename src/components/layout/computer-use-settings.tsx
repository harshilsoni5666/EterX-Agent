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
    cuaDriver?: { healthy?: boolean; installed?: boolean; version?: string };
  };
}

interface ComputerUseSettingsProps {
  settings: Record<AccessSetting, boolean>;
  runtime: RuntimeStatus | null;
  runtimeBusy: boolean;
  runtimeMessage: string;
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
  platform,
  onSettingChange,
  onBrowserAction,
  onRefresh,
}: ComputerUseSettingsProps) {
  const [refreshing, setRefreshing] = useState(false);
  const driver = runtime?.computer?.cuaDriver;
  const browserConnected = Boolean(runtime?.signedBrowser || runtime?.managedBrowser);
  const platformId = runtime?.platform || platform;
  const platformLabel: Record<string, string> = {
    win32: 'Windows', windows: 'Windows', darwin: 'macOS', mac: 'macOS', linux: 'Linux', unknown: 'Detecting…',
  };
  const browserState = runtimeBusy ? 'Connecting…' : runtime?.success === false ? 'Unavailable' : browserConnected ? 'Connected' : runtime ? 'Not connected' : 'Checking…';
  const desktopState = !settings.computerUse ? 'Off' : !runtime ? 'Checking…' : driver?.healthy ? 'Ready' : driver?.installed ? 'Setup required' : 'Unavailable';
  const browserSession = runtime?.signedBrowser ? 'Existing browser' : runtime?.managedBrowser ? 'Isolated browser' : 'No active session';
  const driverState = driver?.healthy ? (driver.version ? `Cua ${driver.version}` : 'Ready') : driver?.installed ? 'Setup required' : runtime ? 'Unavailable' : 'Checking…';

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
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
          description="Let EterX view the screen and use the mouse and keyboard in native apps."
          enabled={settings.computerUse}
          onChange={value => onSettingChange('computerUse', value)}
        />
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
              ['Screen provider', runtime?.computer?.screenProvider || (runtime ? 'Unavailable' : 'Checking…')],
              ['Input provider', runtime?.computer?.inputProvider || (runtime ? 'Unavailable' : 'Checking…')],
            ].map(([label, value]) => (
              <div className={styles.metadataRow} key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
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
          <span>Desktop actions also require your approval in the active task.</span>
        </p>
      </section>
    </div>
  );
}
