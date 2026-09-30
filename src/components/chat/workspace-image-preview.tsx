'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus, RotateCw } from 'lucide-react';
import { buildFilePreviewUrl } from '../../lib/path-utils';
import { Tooltip } from '../ui/tooltip';

/** Shared image controls for Files and Review, including fit after pane resize. */
export function WorkspaceImagePreview({ path, revision = 0, label, onError }: { path: string; revision?: string | number; label?: string; onError?: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number }>();
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => { if (node.clientWidth && node.clientHeight) setAvailable({ width: node.clientWidth, height: node.clientHeight }); };
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);
  const width = rotation % 180 ? natural.height : natural.width;
  const height = rotation % 180 ? natural.width : natural.height;
  const fit = width && height ? Math.max(.01, Math.min(1, Math.max(1, available.width - 32) / width, Math.max(1, available.height - 32) / height)) : 1;
  const scale = zoom ?? fit;
  const changeZoom = (factor: number) => setZoom(Math.max(.05, Math.min(8, scale * factor)));
  const canPan = width * scale > available.width || height * scale > available.height;
  const reset = () => { setZoom(null); viewport.current?.scrollTo(0, 0); };
  return <div className="eterx-workspace-image-preview">
    <div className="eterx-workspace-image-controls">
      {label && <span className="eterx-workspace-image-label">{label}</span>}
      <Tooltip text="Zoom out"><button aria-label="Zoom out" disabled={!natural.width || scale <= .05} onClick={() => changeZoom(1 / 1.25)}><Minus size={15} /></button></Tooltip>
      <button className="eterx-workspace-image-scale" aria-label="Show image at actual size" disabled={!natural.width} onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
      <Tooltip text="Zoom in"><button aria-label="Zoom in" disabled={!natural.width || scale >= 8} onClick={() => changeZoom(1.25)}><Plus size={15} /></button></Tooltip>
      <Tooltip text="Fit image"><button aria-label="Fit image to panel" aria-pressed={zoom === null} onClick={reset}><Maximize size={15} /></button></Tooltip>
      <Tooltip text="Rotate image"><button aria-label="Rotate image clockwise" disabled={!natural.width} onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={15} /></button></Tooltip>
      {!!natural.width && <small>{natural.width} × {natural.height}</small>}
    </div>
    <div ref={viewport} className="eterx-workspace-image-viewport eterx-scrollbar" data-pannable={canPan} tabIndex={0} aria-label="Image preview"
      onDoubleClick={reset}
      onKeyDown={event => { if (['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); event.key === '0' ? reset() : changeZoom(event.key === '-' ? 1 / 1.25 : 1.25); } }}
      onPointerDown={event => { if (event.button !== 0 || !canPan) return; event.preventDefault(); const node = event.currentTarget; drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }; node.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) { event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY; } }}
      onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}>
      {failed ? <div className="eterx-workspace-empty"><p>Could not load this image.</p><button onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Try again</button></div> : <div className="eterx-workspace-image-stage" style={{ width: Math.max(available.width, width * scale + 32), height: Math.max(available.height, height * scale + 32) }}>
        <img src={buildFilePreviewUrl(path) + '&v=' + encodeURIComponent(revision) + '&retry=' + attempt} alt={path.split(/[\\/]/).pop() || 'Image'} draggable={false}
          style={{ width: natural.width ? natural.width * scale : undefined, height: natural.height ? natural.height * scale : undefined, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
          onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setFailed(false); }} onError={() => { setFailed(true); onError?.(); }} />
      </div>}
    </div>
  </div>;
}
