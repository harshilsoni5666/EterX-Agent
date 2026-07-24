import React from 'react';

type ShimmerProps = {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  active?: boolean;
  as?: 'span' | 'div' | 'p';
  durationMs?: number;
  angle?: number;
  spread?: string;
  color?: string;
  once?: boolean;
  reverse?: boolean;
};

type ShimmerStyle = React.CSSProperties & {
  '--shimmer-duration'?: string;
  '--shimmer-angle'?: string;
  '--shimmer-spread'?: string;
  '--shimmer-color'?: string;
};

/** Thin React wrapper around the shadcn shimmer CSS utility. */
export const Shimmer = ({
  children,
  className = '',
  style,
  active = true,
  as: Tag = 'span',
  durationMs,
  angle,
  spread,
  color,
  once = false,
  reverse = false,
}: ShimmerProps) => {
  const classes = [
    active ? 'shimmer' : '',
    active && once ? 'shimmer-once' : '',
    active && reverse ? 'shimmer-reverse' : '',
    className,
  ].filter(Boolean).join(' ');

  const shimmerStyle: ShimmerStyle = {
    ...style,
    ...(durationMs !== undefined ? { '--shimmer-duration': `${Math.max(1, durationMs)}ms` } : {}),
    ...(angle !== undefined ? { '--shimmer-angle': `${angle}deg` } : {}),
    ...(spread ? { '--shimmer-spread': spread } : {}),
    ...(color ? { '--shimmer-color': color } : {}),
  };

  return <Tag className={classes} style={shimmerStyle}>{children}</Tag>;
};
