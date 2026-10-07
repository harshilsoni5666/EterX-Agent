"use client";

import { useEffect, useState } from 'react';
import { reloadApp } from '../lib/reload-app';

export default function Loading() {
  const [showReload, setShowReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShowReload(true), 15000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="eterx-startup" aria-busy="true">
      <div className="eterx-startup-drag" aria-hidden="true" />
      <div className="eterx-startup-content">
        <img src="/logo.png" alt="" draggable={false} className="eterx-startup-logo" />
        <h1 className="eterx-startup-title">Welcome to EterX</h1>
        <div className="eterx-startup-status" role="status">
          <span className="eterx-startup-spinner" aria-hidden="true" />
          <span>Loading EterX</span>
        </div>
      </div>
      {showReload && <button type="button" className="eterx-startup-reload" disabled={reloading}
        onClick={async () => {
          setReloading(true);
          try { await reloadApp(); } finally { setReloading(false); }
        }}>{reloading ? 'Reloading…' : 'Reload app'}</button>}
    </div>
  );
}
