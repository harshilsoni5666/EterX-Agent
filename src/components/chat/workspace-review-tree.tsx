'use client';

import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { FilePanelProps } from './file-panel';
import { WorkspaceFileIcon } from './workspace-file-icon';
import { isWithinWorkspace, workspacePathKey } from '../../lib/workspace-paths';

type File = FilePanelProps & { status?: string; directory?: boolean };
type Node = { key: string; name: string; path: string; children: Map<string, Node>; file?: File; changed: boolean };

export function PierreChevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="eterx-pierre-chevron shrink-0"
      style={{
        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 0.14s ease-out',
        color: 'var(--trees-fg-muted, #84848a)'
      }}
      aria-hidden="true"
    >
      <path
        d="M12.4697 5.46973C12.7626 5.17684 13.2374 5.17684 13.5303 5.46973C13.8232 5.76262 13.8232 6.23738 13.5303 6.53028L8.53028 11.5303C8.23738 11.8232 7.76262 11.8232 7.46973 11.5303L2.46973 6.53028C2.17684 6.23738 2.17684 5.76262 2.46973 5.46973C2.76262 5.17684 3.23738 5.17684 3.53028 5.46973L8 9.93946L12.4697 5.46973Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function WorkspaceReviewStatus({ status = 'M', viewed = false }: { status?: string; viewed?: boolean }) {
  if (viewed) return <Check size={13} className="eterx-workspace-review-status-viewed shrink-0 text-[#00cab1]" aria-label="Viewed" />;
  const s = status || 'M';
  const kind = s.includes('?') ? 'untracked' : s.includes('U') ? 'conflict' : s.includes('D') ? 'deleted' : s.includes('A') ? 'added' : s.includes('R') ? 'renamed' : 'modified';
  const symbol = {
    untracked: 'U',
    conflict: '!',
    deleted: 'D',
    added: 'A',
    renamed: 'R',
    modified: 'M↓'
  }[kind];
  return <span className={'eterx-pierre-git-status is-' + kind} aria-label={kind}>{symbol}</span>;
}

export function reviewDisplayPath(path: string, roots: string[]) {
  const root = roots.filter(root => isWithinWorkspace(path, root)).sort((a, b) => b.length - a.length)[0];
  return root && isWithinWorkspace(path, root) ? path.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').replace(/\/$/, '').length + 1) || path : path;
}

function ReviewFolderRow({
  branch,
  segments,
  depth,
  changed,
  children
}: {
  branch: Node;
  segments: { name: string; path: string }[];
  depth: number;
  changed: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <details
      className="eterx-workspace-review-folder"
      style={{ '--review-depth': depth } as React.CSSProperties}
      open={open}
      onToggle={e => setOpen(e.currentTarget.open)}
    >
      <summary style={{ paddingLeft: 8 + depth * 14 }} aria-label={branch.path}>
        <PierreChevron open={open} size={12} />
        <WorkspaceFileIcon path={branch.path} folder />
        <span className="eterx-workspace-flattened-segments">
          {segments.map((seg, idx) => (
            <span key={seg.path} className="eterx-workspace-flattened-segment">
              <span>{seg.name}</span>
              {idx < segments.length - 1 && <span className="eterx-workspace-flatten-slash"> / </span>}
            </span>
          ))}
        </span>
        {changed && <span className="eterx-workspace-folder-dot" title="Contains unviewed changes" aria-label="Contains unviewed changes" />}
      </summary>
      <div className="eterx-workspace-review-folder-children">{children}</div>
    </details>
  );
}

export function WorkspaceReviewTree({ files, roots, selected, viewed, compact = true, onSelect }: { files: File[]; roots: string[]; selected?: string; viewed: string[]; compact?: boolean; onSelect: (path: string) => void }) {
  const tree = useMemo(() => {
    const tree = new Map<string, Node>();
    for (const file of files) {
      const root = roots.filter(root => isWithinWorkspace(file.filepath, root)).sort((a, b) => b.length - a.length)[0] || '';
      const parts = reviewDisplayPath(file.filepath, roots).split(/[\\/]/).filter(Boolean);
      if (roots.length > 1) parts.unshift(root.split(/[\\/]/).filter(Boolean).pop() || root);
      let children = tree;
      let path = roots.length > 1 ? '' : root;
      parts.forEach((name, index) => {
        path = roots.length > 1 && index === 0 ? root : path.replace(/[\\/]$/, '') + '/' + name;
        const key = workspacePathKey(path);
        let node = children.get(key);
        if (!node) { node = { key, name, path, children: new Map(), changed: false }; children.set(key, node); }
        node.changed ||= !viewed.includes(workspacePathKey(file.filepath));
        if (index === parts.length - 1) node.file = file;
        children = node.children;
      });
    }
    return tree;
  }, [files, roots, viewed]);

  const render = (nodes: Map<string, Node>, depth = 0): React.ReactNode =>
    [...nodes.values()]
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map(node => {
        if (node.file) {
          return (
            <button
              className={'eterx-workspace-file-row ' + (selected === node.file.filepath ? 'is-selected' : '')}
              style={{ paddingLeft: 8 + depth * 14 + 14 }}
              key={node.key}
              aria-current={selected === node.file.filepath ? 'page' : undefined}
              aria-label={node.file.filepath}
              onClick={() => onSelect(node.file!.filepath)}
            >
              <WorkspaceFileIcon path={node.file.filepath} folder={node.file.directory} />
              <span className="eterx-workspace-tree-label">{node.name}</span>
              <WorkspaceReviewStatus status={node.file.status} viewed={viewed.includes(workspacePathKey(node.file.filepath))} />
            </button>
          );
        }
        const segments: { name: string; path: string }[] = [{ name: node.name, path: node.path }];
        let branch = node;
        while (compact && branch.children.size === 1) {
          const child = [...branch.children.values()][0];
          if (child.file) break;
          segments.push({ name: child.name, path: child.path });
          branch = child;
        }
        return (
          <ReviewFolderRow
            key={node.key}
            branch={branch}
            segments={segments}
            depth={depth}
            changed={node.changed}
          >
            {render(branch.children, depth + 1)}
          </ReviewFolderRow>
        );
      });

  return <div className="eterx-pierre-file-tree">{render(tree)}</div>;
}
