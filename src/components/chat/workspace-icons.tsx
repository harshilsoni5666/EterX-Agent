import type { SVGProps } from 'react';

export interface WorkspaceIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
  strokeWidth?: number | string;
}

/**
 * Lucide icon: file-code-corner
 * Used for Workspace Review tab
 */
export function FileCodeCorner({
  size = 16,
  strokeWidth = 2,
  className = '',
  ...props
}: WorkspaceIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="m5 16-3 3 3 3" />
      <path d="m9 22 3-3-3-3" />
    </svg>
  );
}

/**
 * Lucide icon: messages-circle
 * Used for Workspace Side chat tab
 */
export function MessagesCircle({
  size = 16,
  strokeWidth = 2,
  className = '',
  ...props
}: WorkspaceIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M19.95 10.05a7 7 0 0 1 1.412 7.872 1 1 0 0 0-.058.787l.675 2.089a1 1 0 0 1-1.236 1.168l-2.155-.631a1 1 0 0 0-.745.06 7 7 0 0 1-7.793-1.445" />
      <path d="M2.696 12.708a1 1 0 0 0-.058-.785 7 7 0 1 1 3.518 3.473 1 1 0 0 0-.744-.061l-2.155.63a1 1 0 0 1-1.236-1.167z" />
    </svg>
  );
}

/**
 * Lucide icon: file-search-corner
 * Used for find in file and file search filters
 */
export function FileSearchCorner({
  size = 16,
  strokeWidth = 2,
  className = '',
  ...props
}: WorkspaceIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M11.1 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.589 3.588A2.4 2.4 0 0 1 20 8v3.25" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="m21 22-2.88-2.88" />
      <circle cx="16" cy="17" r="3" />
    </svg>
  );
}

/**
 * Lucide icon: square-split-horizontal
 * Professional split view / split diff icon
 */
export function SquareSplitHorizontal({
  size = 16,
  strokeWidth = 2,
  className = '',
  ...props
}: WorkspaceIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M12 2v20" />
      <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
      <path d="M8 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/**
 * Lucide icon: file-plus-corner
 * Used for file creation actions
 */
export function FilePlusCorner({
  size = 16,
  strokeWidth = 2,
  className = '',
  ...props
}: WorkspaceIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M14 19h6" />
      <path d="M17 16v6" />
    </svg>
  );
}


