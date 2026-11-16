'use client';

/* eslint-disable @next/next/no-img-element -- Arbitrary source domains require sequential favicon fallbacks. */

import React, { useEffect, useId, useMemo, useState } from 'react';
import { ChevronRight, Globe2 } from 'lucide-react';
import { useFilePanelOwner, useFilePanelReveal } from '../../contexts/FilePanelContext';
import { openWorkspaceBrowser } from '../../lib/side-workspace-store';
import { WEB_ACTIVITY_LABELS, type WebActivity, type WebSource } from '../../lib/tool-result-presentation';
import { WebSearchIcon } from './agent-icons';
import { ActivityDisclosure } from './activity-disclosure';
import { ToolResultScroll } from './tool-result-scroll';
import { Shimmer } from '../ui/shimmer';

function FaviconImage({ source }: { source: WebSource }) {
  const candidates = useMemo(() => [...new Set([
    source.favicon,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(source.url).hostname)}&sz=32`,
    `${new URL(source.url).origin}/favicon.ico`,
  ].filter((url): url is string => Boolean(url)))], [source.favicon, source.url]);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = candidates[index];
  useEffect(() => {
    if (!src || loaded) return;
    const timeout = setTimeout(() => setIndex(value => value + 1), 5_000);
    return () => clearTimeout(timeout);
  }, [src, loaded]);
  return <span className="eterx-source-favicon" aria-hidden="true">
    {!loaded && <Globe2 size={15} />}
    {src && <img key={src} src={src} alt="" width={18} height={18} decoding="async" referrerPolicy="no-referrer"
      style={{ opacity: loaded ? 1 : 0 }}
      onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setIndex(value => value + 1); }} />}
  </span>;
}

export function SourceFavicon({ source }: { source: WebSource }) {
  return <FaviconImage key={`${source.url}:${source.favicon || ''}`} source={source} />;
}

export function WebSourceChips({ sources }: { sources: WebSource[] }) {
  const owner = useFilePanelOwner();
  const revealOwner = useFilePanelReveal();
  return <div className="eterx-source-chips" role="list" aria-label="Web sources">
    {sources.map(source => <span key={source.url} role="listitem" className="eterx-source-item">
      <a className="eterx-source-chip" href={source.url} target="_blank" rel="noopener noreferrer"
        title={`${source.title}\n${source.url}`} aria-label={`Open ${source.title} in browser panel: ${source.url}`}
        data-website-url={source.url}
        onClick={event => {
          if (!owner) return;
          event.preventDefault();
          event.stopPropagation();
          openWorkspaceBrowser(owner, source.url, { title: source.hostname, favicon: source.favicon });
          revealOwner?.();
        }}>
        <SourceFavicon source={source} /><span className="eterx-source-domain">{source.hostname}</span>
      </a>
    </span>)}
  </div>;
}

export function WebSourceActivity({ activity, sources, live, failed, inCard = false }: {
  activity: WebActivity;
  sources: WebSource[];
  live: boolean;
  failed: boolean;
  inCard?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const sites = useMemo(() => [...new Map(sources.map(source => [source.hostname, source])).values()], [sources]);
  const labels = WEB_ACTIVITY_LABELS[activity];
  const label = live ? labels.live : failed ? labels.failed : labels.done;
  const expandable = sources.length > 0;
  const expanded = expandable && open;
  const contents = <>
    <span className="eterx-action-icon"><WebSearchIcon size={15} isLive={live} color="currentColor" /></span>
    <Shimmer active={live} className="eterx-action-verb">{label}</Shimmer>
    {expandable && <span className="eterx-source-summary" aria-hidden="true">
      <span className="eterx-source-stack">{sites.slice(0, 3).map(source => <SourceFavicon key={source.hostname} source={source} />)}</span>
      {sites.length > 3 && <span className="eterx-source-more">+{sites.length - 3}</span>}
      <span className="eterx-source-summary-label">Sources</span>
    </span>}
    {expandable && <ChevronRight className="eterx-source-chevron" size={14} />}
  </>;
  return <div className="eterx-web-activity" data-status={failed && !live ? 'failed' : live ? 'running' : 'completed'}>
    {expandable ? <button type="button" className={`eterx-action-chip eterx-web-source-row ${inCard ? '' : 'eterx-action-card'}`}
      aria-expanded={expanded} aria-controls={expanded ? contentId : undefined}
      aria-label={`${label}. ${sources.length} source${sources.length === 1 ? '' : 's'}. ${expanded ? 'Hide' : 'Show'} sources`}
      onClick={() => setOpen(value => !value)}>{contents}</button>
      : <div className={`eterx-action-chip eterx-web-source-row ${inCard ? '' : 'eterx-action-card'}`}>{contents}</div>}
    <ActivityDisclosure open={expanded} id={contentId}>
      <div className="eterx-web-sources-panel eterx-activity-child-panel">
        <ToolResultScroll label="Web sources"><WebSourceChips sources={sources} /></ToolResultScroll>
      </div>
    </ActivityDisclosure>
  </div>;
}
