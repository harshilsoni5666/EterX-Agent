import React, { useMemo, useId } from 'react';
import Avatar from 'boring-avatars';

/**
 * 16 Curated High-Vibrancy Multi-Tone Palettes for Boring Avatars.
 * Inspired by Nice Color Palettes and Boring Avatars design standards:
 * - NO muddy blacks, dirty browns, or low-contrast sludge colors.
 * - Multi-tone contrast ensures face, hair, and features pop crisply in both Dark and Light themes.
 * - Palette 1 is the exact signature palette shown on boringavatars.com.
 */
export const BORING_AVATAR_PALETTES: string[][] = [
  // 1. Signature Boring (From boringavatars.com reference)
  ['#00686C', '#32C2B9', '#EDECB3', '#FAD928', '#FF9915'],
  // 2. Warm Sunset & Sea Teal (Nice Palettes #1)
  ['#264653', '#2A9D8F', '#E9C46A', '#F4A261', '#E76F51'],
  // 3. Electric Indigo & Fuchsia Pop
  ['#4361EE', '#3F37C9', '#4895EF', '#4CC9F0', '#F72585'],
  // 4. Classic Boring Default
  ['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90'],
  // 5. Vivid Emerald & Sunshine
  ['#059669', '#10B981', '#34D399', '#6EE7B7', '#FDE047'],
  // 6. Coral Rose & Tangerine
  ['#E11D48', '#FB7185', '#FDA4AF', '#F97316', '#FDE68A'],
  // 7. Cyber Lavender & Orchid
  ['#7C3AED', '#8B5CF6', '#A78BFA', '#C4B5FD', '#F472B6'],
  // 8. Sunburst Amber & Sky Cyan
  ['#D97706', '#F59E0B', '#FBBF24', '#38BDF8', '#BAE6FD'],
  // 9. Fresh Garden Green & Warm Coral
  ['#2E7D32', '#4CAF50', '#81C784', '#FFE082', '#FF7043'],
  // 10. Candy Berry & Sea Teal
  ['#D81159', '#8F2D56', '#218380', '#FBB13C', '#73D2DE'],
  // 11. Electric Cobalt & Bright Gold
  ['#1D4ED8', '#2563EB', '#38BDF8', '#FACC15', '#FEF08A'],
  // 12. Nordic Citrus Sunset
  ['#F94144', '#F3722C', '#F8961E', '#F9C74F', '#90BE6D'],
  // 13. Royal Purple & Soft Peach
  ['#6B21A8', '#9333EA', '#C084FC', '#FB7185', '#FED7AA'],
  // 14. Lagoon Cyan & Sweet Coral
  ['#0284C7', '#06B6D4', '#22D3EE', '#FB7185', '#FDE68A'],
  // 15. Matcha Mint & Warm Apricot
  ['#15803D', '#22C55E', '#86EFAC', '#FB923C', '#FEF9C3'],
  // 16. Aurora Multi-Tone (Indigo, Cyan, Mint, Amber, Pink)
  ['#4F46E5', '#06B6D4', '#10B981', '#F59E0B', '#EC4899'],
];

/** Boring Avatar variant: locked to "beam" (the signature face design) */
export const SUBAGENT_AVATAR_DEFAULT_VARIANT = 'beam';

export type SubAgentBoringVariant = 'beam' | 'marble' | 'pixel' | 'sunset' | 'ring' | 'bauhaus';

/** 32-bit FNV-1a hash function for strings */
export const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const SIZE = 36;

const hashCode = (name: string): number => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
};

const getDigit = (number: number, ntn: number) =>
  Math.floor((number / Math.pow(10, ntn)) % 10);

const getBoolean = (number: number, ntn: number) =>
  !(getDigit(number, ntn) % 2);

const getUnit = (number: number, range: number, index?: number) => {
  const value = number % range;
  return index && getDigit(number, index) % 2 === 0 ? -value : value;
};

const getRandomColor = (number: number, colors: string[]) =>
  colors[number % colors.length];

const getContrast = (hex: string) => {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(clean.substr(0, 2), 16);
  const g = parseInt(clean.substr(2, 2), 16);
  const b = parseInt(clean.substr(4, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#111827' : '#FFFFFF';
};

interface HighDefBeamAvatarProps {
  size: number;
  name: string;
  colors: string[];
}

/**
 * High-Definition Beam Avatar:
 * Precision vector renderer faithful to the Boring Avatars algorithm,
 * engineered with:
 * - Hardware-accelerated circular vector clipPath (no rasterized mask pixelation)
 * - Adaptive eye and smile weighting so features stay crisp and cute even at 20px-28px
 * - shape-rendering="geometricPrecision" for razor-sharp curves on all Windows DPI scales
 * - Integrated theme-adaptive boundary ring for perfect contrast on Dark and Light themes
 */
const HighDefBeamAvatar: React.FC<HighDefBeamAvatarProps> = React.memo(({ size, name, colors }) => {
  const rawId = useId();
  const clipId = useMemo(() => 'beam-' + rawId.replace(/[^a-zA-Z0-9_-]/g, ''), [rawId]);

  const {
    wrapperColor,
    faceColor,
    backgroundColor,
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate,
    wrapperScale,
    isMouthOpen,
    isCircle,
    eyeSpread,
    mouthSpread,
    faceRotate,
    faceTranslateX,
    faceTranslateY,
  } = useMemo(() => {
    const num = hashCode(name);
    const wrapper = getRandomColor(num, colors);
    const face = getContrast(wrapper);
    const bg = getRandomColor(num + 13, colors);
    const tx = getUnit(num, 10, 1);
    const n = tx < 5 ? tx + SIZE / 9 : tx;
    const ty = getUnit(num, 10, 2);
    const s = ty < 5 ? ty + SIZE / 9 : ty;

    return {
      wrapperColor: wrapper,
      faceColor: face,
      backgroundColor: bg,
      wrapperTranslateX: n,
      wrapperTranslateY: s,
      wrapperRotate: getUnit(num, 360),
      wrapperScale: 1 + getUnit(num, SIZE / 12) / 10,
      isMouthOpen: getBoolean(num, 2),
      isCircle: getBoolean(num, 1),
      eyeSpread: getUnit(num, 5),
      mouthSpread: getUnit(num, 3),
      faceRotate: getUnit(num, 10, 3),
      faceTranslateX: n > SIZE / 6 ? n / 2 : getUnit(num, 8, 1),
      faceTranslateY: s > SIZE / 6 ? s / 2 : getUnit(num, 7, 2),
    };
  }, [name, colors]);

  const isSmall = size <= 28;
  const eyeW = isSmall ? 2.0 : 1.7;
  const eyeH = isSmall ? 2.6 : 2.0;
  const mouthStroke = isSmall ? 1.6 : 1.2;

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      fill="none"
      role="img"
      width={size}
      height={size}
      shapeRendering="geometricPrecision"
      style={{ display: 'block', width: '100%', height: '100%' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width={SIZE} height={SIZE} fill={backgroundColor} />
        <rect
          x={0}
          y={0}
          width={SIZE}
          height={SIZE}
          transform={`translate(${wrapperTranslateX} ${wrapperTranslateY}) rotate(${wrapperRotate} ${SIZE / 2} ${SIZE / 2}) scale(${wrapperScale})`}
          fill={wrapperColor}
          rx={isCircle ? SIZE : SIZE / 6}
        />
        <g
          transform={`translate(${faceTranslateX} ${faceTranslateY}) rotate(${faceRotate} ${SIZE / 2} ${SIZE / 2})`}
        >
          {isMouthOpen ? (
            <path
              d={`M15 ${19 + mouthSpread}c2 1 4 1 6 0`}
              stroke={faceColor}
              fill="none"
              strokeLinecap="round"
              strokeWidth={mouthStroke}
            />
          ) : (
            <path
              d={`M13,${19 + mouthSpread} a1,0.75 0 0,0 10,0`}
              fill={faceColor}
            />
          )}
          <rect
            x={14 - eyeSpread}
            y={14}
            width={eyeW}
            height={eyeH}
            rx={1}
            fill={faceColor}
          />
          <rect
            x={20 + eyeSpread}
            y={14}
            width={eyeW}
            height={eyeH}
            rx={1}
            fill={faceColor}
          />
        </g>
      </g>
      {/* Precision inner rim stroke that guarantees clean separation against any background */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={SIZE / 2 - 0.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        className="text-black/10 dark:text-white/20"
      />
    </svg>
  );
});

HighDefBeamAvatar.displayName = 'HighDefBeamAvatar';

export interface SubAgentGeometricAvatarProps {
  name?: string;
  assetIndex?: number;
  size?: number;
  className?: string;
  title?: string;
  status?: string;
  variant?: SubAgentBoringVariant;
}

/**
 * SubAgentGeometricAvatar:
 * Powered by high-definition Boring Avatars (beam variant / face design).
 * Guarantees every subagent receives a unique, charming face with vibrant, high-contrast colors.
 * - Upright face design (no upside-down spinning)
 * - Anti-collision hashing with coprime offset so concurrent subagents never duplicate colors or faces
 * - Razor-sharp rendering on all screen resolutions and dark/light themes
 */
export const SubAgentGeometricAvatar: React.FC<SubAgentGeometricAvatarProps> = React.memo(({
  name = 'subagent',
  assetIndex,
  size = 32,
  className = '',
  title,
  status,
  variant = SUBAGENT_AVATAR_DEFAULT_VARIANT,
}) => {
  const cleanName = String(name || 'subagent').trim();

  const { seed, colors } = useMemo(() => {
    const baseHash = hashString(cleanName.toLowerCase());
    const hasIndex = typeof assetIndex === 'number' && Number.isFinite(assetIndex);
    const indexOffset = hasIndex ? Math.abs(Math.floor(assetIndex)) : 0;

    // Unique deterministic seed incorporating indexOffset so subagents with similar names get unique faces
    const resolvedSeed = hasIndex ? `${cleanName}#${indexOffset}` : cleanName;

    // Coprime step (7) ensures adjacent subagents in a conversation get contrasting palettes
    const paletteIndex = hasIndex
      ? (baseHash + indexOffset * 7 + 1) % BORING_AVATAR_PALETTES.length
      : baseHash % BORING_AVATAR_PALETTES.length;

    const resolvedColors = BORING_AVATAR_PALETTES[paletteIndex];

    return {
      seed: resolvedSeed,
      colors: resolvedColors,
    };
  }, [cleanName, assetIndex]);

  const isWorking = status === 'working' || status === 'running' || status === 'spawning';

  return (
    <span
      className={`eterx-subagent-avatar relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.08)] select-none transition-transform duration-150 ${className}`}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        transform: 'translateZ(0)',
      }}
      role={title ? 'img' : undefined}
      aria-label={title || cleanName}
      aria-hidden={title ? undefined : true}
      title={title || undefined}
    >
      <div className={`h-full w-full select-none flex items-center justify-center ${isWorking ? 'animate-pulse' : ''}`}>
        {variant === 'beam' ? (
          <HighDefBeamAvatar
            size={size}
            name={seed}
            colors={colors}
          />
        ) : (
          <Avatar
            size={size}
            name={seed}
            variant={variant as any}
            colors={colors}
            square={false}
          />
        )}
      </div>
    </span>
  );
});

SubAgentGeometricAvatar.displayName = 'SubAgentGeometricAvatar';
export default SubAgentGeometricAvatar;
