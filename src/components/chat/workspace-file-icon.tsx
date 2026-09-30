'use client';

import { Globe } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { workspaceFileIcon } from '../../lib/workspace-file-icons';

export function WorkspaceSiteIcon({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && /^https?:\/\//i.test(url) && !failed ? <img className="eterx-workspace-favicon" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Globe size={16} />;
}

export function WorkspaceFileIcon({ path, folder = false, size = 16 }: { path?: string; folder?: boolean; size?: number }) {
  const icon = workspaceFileIcon(path || '', folder || !path);
  const style = { '--workspace-file-icon-size': `${size}px` } as CSSProperties;
  const fallback = folder || !path ? 'folder' : 'default';
  const sources = [`/icons/pierre/${icon}.svg`, `/icons/files/${icon}.svg`, `/icons/pierre/${fallback}.svg`];
  return <img
    key={icon}
    className="eterx-workspace-pack-icon"
    data-icon={icon}
    src={sources[0]}
    width={size} height={size} style={style} alt="" aria-hidden="true" draggable={false}
    onError={event => {
      const image = event.currentTarget;
      const next = Number(image.dataset.fallback || 0) + 1;
      image.dataset.fallback = String(next);
      if (next < sources.length) image.src = sources[next];
    }}
  />;
}
