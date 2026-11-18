import { Fragment, useId, type CSSProperties, type ReactNode } from 'react';
import styles from './settings-usage-skeleton.module.css';

function UsageShimmer({ children }: { children: ReactNode }) {
  const id = useId();
  const clipId = `${id}-clip`;
  const gradientId = `${id}-glow`;

  return <svg className={styles.shimmer} width="100%" height="100%" aria-hidden="true" focusable="false">
    <defs>
      <clipPath id={clipId}>{children}</clipPath>
      <linearGradient id={gradientId} x1="0%" y1="42%" x2="100%" y2="58%">
        <stop offset="0%" stopOpacity={0} />
        <stop offset="26%" stopOpacity={0.35} />
        <stop offset="50%" />
        <stop offset="74%" stopOpacity={0.35} />
        <stop offset="100%" stopOpacity={0} />
      </linearGradient>
    </defs>
    <g clipPath={`url(#${clipId})`}>
      <rect className={styles.base} width="100%" height="100%" />
      <rect className={styles.sweep} x="-50%" width="50%" height="100%" fill={`url(#${gradientId})`} />
    </g>
  </svg>;
}

export function ActivityGridSkeleton({ cells, columns, weekly }: {
  cells: readonly { key: string; available: boolean }[];
  columns: number;
  weekly: boolean;
}) {
  const rows = weekly ? 1 : 7;
  return <div className={styles.heatmap} data-weekly={weekly} style={{ '--activity-columns': columns, '--activity-rows': rows } as CSSProperties}>
    <UsageShimmer>
      {cells.map((cell, index) => cell.available && <rect key={cell.key} className={styles.heatmapCell} rx={3}
        style={{ '--activity-column': Math.floor(index / rows), '--activity-row': index % rows } as CSSProperties} />)}
    </UsageShimmer>
  </div>;
}

const ROW_WIDTHS = [148, 126, 174, 133, 155, 116, 168, 140, 150, 120, 161, 137];

export function TokenUsageRowsSkeleton({ actions = false, showCounts }: { actions?: boolean; showCounts: boolean }) {
  return <div className={styles.rows} data-actions={actions} data-counts={showCounts}>
    <UsageShimmer>
      {ROW_WIDTHS.map((width, index) => {
        const top = actions ? 17 + index * 48 : 15 + index * 43.5;
        return <Fragment key={width}>
          {actions && <rect x={12} y={top + 2} width={25} height={6} rx={3} />}
          <rect className={styles.rowTitle} y={top} height={10} rx={4}
            style={{ '--usage-title-width': `${width + (actions ? 42 : 0)}px` } as CSSProperties} />
          {showCounts && <>
            <rect className={styles.rowInput} y={top + 1} height={8} rx={4} />
            <rect className={styles.rowOutput} y={top + 1} height={8} rx={4} />
          </>}
        </Fragment>;
      })}
    </UsageShimmer>
  </div>;
}
