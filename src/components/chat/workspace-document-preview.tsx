'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { buildFilePreviewUrl } from '../../lib/path-utils';
import { WorkspaceFileIcon } from './workspace-file-icon';

/** Conversion belongs to this file selection; late results cannot replace it. */
export function WorkspaceDocumentPreview({ path, revision, isActive, onOpen }: { path: string; revision: number; isActive: boolean; onOpen: () => void }) {
  const [preview, setPreview] = useState<{ key: string; url?: string; error?: string } | null>(null);
  const filename = path.split(/[\\/]/).pop() || path;
  const key = `${path}:${revision}`;
  const supportsConversion = /\.docx$/i.test(path);
  const current = preview?.key === key ? preview : null;
  useEffect(() => {
    if (!isActive || !supportsConversion || current) return;
    let disposed = false;
    const convert = async () => {
      try {
        const api = (window as any).electronAPI;
        if (!api?.convertDocxToPdf) throw new Error('Document preview is unavailable on this device.');
        const pdf = await api.convertDocxToPdf(path);
        if (!disposed) setPreview({ key, ...(pdf ? { url: buildFilePreviewUrl(pdf) } : { error: 'This document could not be previewed.' }) });
      } catch {
        if (!disposed) setPreview({ key, error: 'This document could not be previewed. Open it in its desktop app.' });
      }
    };
    void convert();
    return () => { disposed = true; };
  }, [key, path, isActive, supportsConversion, current]);
  return <div className="eterx-workspace-document-preview">
    <div className="eterx-workspace-document-tools"><button onClick={onOpen}>Open in app</button><a href={buildFilePreviewUrl(path)} download={filename}><Download size={14} />Download</a></div>
    {current?.url ? <iframe title={filename} src={current.url} /> :
      <div className="eterx-workspace-empty">
        {supportsConversion && !current ? <><Loader2 size={24} className="animate-spin" /><p role="status">Preparing document preview…</p></> :
          <><WorkspaceFileIcon path={path} size={48} /><h3>{filename}</h3><p>{current?.error || 'Open this file in its desktop app to view or edit it.'}</p>{current?.error && <button onClick={() => setPreview(null)}>Retry preview</button>}<button onClick={onOpen}>Open in app</button></>}
      </div>}
  </div>;
}
