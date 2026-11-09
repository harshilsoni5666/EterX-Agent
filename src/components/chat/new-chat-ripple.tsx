'use client';

import { memo, useEffect, useRef, type RefObject } from 'react';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import styles from './new-chat-ripple.module.css';

const CLICK_DURATION = 3200;
const ENTRY_DURATION = 4100;
const ENTRY_DELAY = 420;
const RELEASE_DURATION = 220;
const MAX_RIPPLES = 3;
const MAX_CANVAS_PIXELS = 8_000_000;
const TILE_WIDTH = 18;
const TILE_HEIGHT = 22;
const PALETTES = {
  dark: {
    inks: ['#c5d6dc', '#83b8c0', '#a3a8c5', '#c5b69c'],
    hazeCore: '91, 155, 165',
    hazeEdge: '131, 135, 176',
    hazeOpacity: 0.035,
    intensity: 1,
  },
  light: {
    inks: ['#526e81', '#508278', '#837396', '#947c65'],
    hazeCore: '126, 173, 190',
    hazeEdge: '177, 156, 191',
    hazeOpacity: 0.07,
    intensity: 0.74,
  },
};
const INTERACTIVE_TARGETS = [
  'a', 'button', 'input', 'textarea', 'select', 'label', 'summary',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="dialog"]',
  '[role="menu"]', '[role="listbox"]', '[role="option"]',
  '[contenteditable]:not([contenteditable="false"])', '[draggable="true"]',
  '[tabindex]:not([tabindex="-1"])', '.eterx-composer-shell', '.eterx-proxy-dock',
].join(',');

type Cell = {
  x: number;
  y: number;
  distance: number;
  directionX: number;
  directionY: number;
  band: number;
  strength: number;
  ink: number;
  digit: number;
};

type Ripple = {
  x: number;
  y: number;
  startedAt: number;
  radius: number;
  duration: number;
  intensity: number;
  width: number;
  height: number;
  releasedAt?: number;
  cells: Cell[];
};

const smoothstep = (value: number) => {
  const t = Math.max(0, Math.min(value, 1));
  return t * t * (3 - 2 * t);
};

const noiseAt = (x: number, y: number, seed: number) => {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return value - Math.floor(value);
};

/** One welcome wave per visit, then quiet until the user clicks the background. */
export const NewChatRipple = memo(function NewChatRipple({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext('2d');
    const atlas = document.createElement('canvas');
    const atlasContext = atlas.getContext('2d');
    if (!context || !atlasContext) return;

    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forcedColors = window.matchMedia('(forced-colors: active)');
    // Every wave reveals the same texture for this visit. Only its contour
    // varies, so overlapping clicks don't introduce offset, competing grids.
    const fieldSeed = Math.random() * 100;
    const readPalette = () => root.dataset.theme === 'light'
      || (!root.dataset.theme && root.classList.contains('light')) ? PALETTES.light : PALETTES.dark;
    let palette = readPalette();
    let atlasPalette: typeof palette | null = null;
    let ripples: Ripple[] = [];
    let frame = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let atlasTileWidth = 0;
    let atlasTileHeight = 0;
    let lastClick = -Infinity;
    let entryPlayed = false;
    let entryTimer = 0;

    const canAnimate = () => !reducedMotion.matches
      && !forcedColors.matches
      && isAppVisible();

    // Clear the actual bitmap, not a rounded CSS-sized rectangle. At fractional
    // Windows scaling the latter can leave a stale right/bottom pixel strip.
    const clearPixels = () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };

    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      ripples = [];
      clearPixels();
    };

    // Rasterize the eight glyph/color combinations once per pixel density.
    // Animation then only composites sprites, without laying out text each frame.
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      // Keep large/high-DPI windows from allocating an unbounded decorative bitmap.
      const nextRatio = Math.min(window.devicePixelRatio || 1, 2,
        Math.sqrt(MAX_CANVAS_PIXELS / Math.max(bounds.width * bounds.height, 1)));
      const nextPalette = readPalette();
      if (width !== bounds.width || height !== bounds.height || pixelRatio !== nextRatio) {
        width = bounds.width;
        height = bounds.height;
        pixelRatio = nextRatio;
        canvas.width = Math.max(1, Math.ceil(width * pixelRatio));
        canvas.height = Math.max(1, Math.ceil(height * pixelRatio));
      }

      // Integer sprite boundaries prevent neighboring glyphs from bleeding
      // through texture interpolation at 125% / 150% display scale.
      const nextTileWidth = Math.ceil(TILE_WIDTH * pixelRatio);
      const nextTileHeight = Math.ceil(TILE_HEIGHT * pixelRatio);
      if (atlasTileWidth === nextTileWidth && atlasTileHeight === nextTileHeight && atlasPalette === nextPalette) return;
      atlasTileWidth = nextTileWidth;
      atlasTileHeight = nextTileHeight;
      palette = nextPalette;
      atlasPalette = nextPalette;
      atlas.width = atlasTileWidth * palette.inks.length * 2;
      atlas.height = atlasTileHeight;
      atlasContext.setTransform(atlasTileWidth / TILE_WIDTH, 0, 0, atlasTileHeight / TILE_HEIGHT, 0, 0);
      atlasContext.font = '11px "SFMono-Regular", Consolas, "Liberation Mono", monospace';
      atlasContext.textAlign = 'center';
      atlasContext.textBaseline = 'middle';
      palette.inks.forEach((ink, index) => {
        atlasContext.fillStyle = ink;
        for (let digit = 0; digit < 2; digit += 1) {
          atlasContext.fillText(String(digit), (index * 2 + digit + 0.5) * TILE_WIDTH, TILE_HEIGHT / 2);
        }
      });
    };

    const draw = (now: number) => {
      frame = 0;
      clearPixels();
      if (!canAnimate() || !width || !height) {
        ripples = [];
        return;
      }
      ripples = ripples.filter(ripple => now - ripple.startedAt < ripple.duration
        && (ripple.releasedAt === undefined || now - ripple.releasedAt < RELEASE_DURATION));

      for (const ripple of ripples) {
        // Adapt the wave's position to resizing while keeping the glyphs at
        // their native aspect ratio and size.
        const scaleX = width / ripple.width;
        const scaleY = height / ripple.height;
        context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
        const age = now - ripple.startedAt;
        const progress = age / ripple.duration;
        const radius = 6 + ripple.radius * (1 - Math.pow(1 - progress, 1.7));
        const release = ripple.releasedAt === undefined ? 1 : 1 - smoothstep((now - ripple.releasedAt) / RELEASE_DURATION);
        const envelope = smoothstep(age / 240) * (1 - smoothstep((progress - 0.12) / 0.88))
          * ripple.intensity * palette.intensity * release;

        // A barely visible pool of light ties the type to the ambient home glow.
        const hazeX = ripple.x * scaleX;
        const hazeY = ripple.y * scaleY;
        const hazeRadius = (80 + radius * 0.6) * Math.sqrt(scaleX * scaleY);
        const haze = context.createRadialGradient(hazeX, hazeY, 0, hazeX, hazeY, hazeRadius);
        haze.addColorStop(0, `rgba(${palette.hazeCore}, ${palette.hazeOpacity * envelope})`);
        haze.addColorStop(0.45, `rgba(${palette.hazeEdge}, ${palette.hazeOpacity * 0.5 * envelope})`);
        haze.addColorStop(1, `rgba(${palette.hazeEdge}, 0)`);
        context.globalAlpha = 1;
        context.fillStyle = haze;
        context.fillRect(hazeX - hazeRadius, hazeY - hazeRadius, hazeRadius * 2, hazeRadius * 2);

        for (const cell of ripple.cells) {
          const band = cell.band + progress * 26;
          const front = (cell.distance - radius) / band;
          if (front > 2.8 || front < -6) continue;
          const crest = Math.exp(-front * front);
          const trail = (cell.distance - radius + 68) / (band * 1.9);
          const strength = Math.min((crest + Math.exp(-trail * trail) * 0.16) * envelope * cell.strength, 0.54);
          if (strength < 0.008) continue;

          const displacement = crest * (1 - progress) * 2;
          // Each digit changes just once as the wave passes, with a crossfade.
          // Keep its color stable too; hard swaps made the old crest shimmer.
          const morph = smoothstep((0.8 - front) / 1.6);
          for (let layer = 0; layer < 2; layer += 1) {
            const opacity = strength * (layer === 0 ? 1 - morph : morph);
            if (opacity < 0.004) continue;
            const digit = layer === 0 ? cell.digit : 1 - cell.digit;
            context.globalAlpha = opacity;
            context.drawImage(
              atlas,
              (cell.ink * 2 + digit) * atlasTileWidth, 0,
              atlasTileWidth, atlasTileHeight,
              (cell.x + cell.directionX * displacement) * scaleX - TILE_WIDTH / 2,
              (cell.y + cell.directionY * displacement) * scaleY - TILE_HEIGHT / 2,
              TILE_WIDTH, TILE_HEIGHT,
            );
          }
        }
      }
      context.globalAlpha = 1;
      // No ongoing animation, timers, or React renders once the last wave settles.
      if (ripples.length) frame = requestAnimationFrame(draw);
    };

    const emitRipple = (x: number, y: number, isEntry = false) => {
      if (!canAnimate() || !width || !height) return;
      const now = performance.now();
      const bounds = canvas.getBoundingClientRect();
      const radius = isEntry
        ? Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) * 1.05
        : Math.min(760, Math.max(300, Math.min(width, height) * 0.74));
      const wavePhase = Math.random() * Math.PI * 2;
      const stretch = isEntry ? 0.96 : 0.9 + Math.random() * 0.14;
      const cells: Cell[] = [];
      const quietZones = Array.from(container.querySelectorAll(
        '.eterx-composer-shell, .eterx-home-greeting, .eterx-chat-disclaimer > div',
      )).map(element => {
        const rect = element.getBoundingClientRect();
        return {
          left: (rect.left - bounds.left) * width / bounds.width,
          right: (rect.right - bounds.left) * width / bounds.width,
          top: (rect.top - bounds.top) * height / bounds.height,
          bottom: (rect.bottom - bounds.top) * height / bounds.height,
        };
      });

      // A stable, fine grid with missing clusters; the wavefront bends through it.
      // Precompute spatial noise and distances only on interaction.
      const reach = radius * 1.35;
      const gridScale = Math.max(1, Math.sqrt(width * height / (165 * 9000)));
      const rowHeight = 15 * gridScale;
      const columnWidth = 11 * gridScale;
      for (let row = Math.max(0, Math.floor((y - reach) / rowHeight)); row * rowHeight < Math.min(height, y + reach); row += 1) {
        for (let column = Math.max(0, Math.floor((x - reach) / columnWidth)); column * columnWidth < Math.min(width, x + reach); column += 1) {
          const noise = noiseAt(column, row, fieldSeed);
          const cellX = (column + 0.5) * columnWidth + Math.sin(row * 0.65 + fieldSeed) * 1.2;
          const cellY = (row + 0.5) * rowHeight;
          const cluster = Math.sin(cellX * 0.023 + fieldSeed) * Math.cos(cellY * 0.019 - fieldSeed);
          if (noise < 0.26 + cluster * 0.16) continue;

          const dx = cellX - x;
          const dy = cellY - y;
          const actualDistance = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          const bend = 1 + Math.sin(angle * 3 + wavePhase) * 0.06 + Math.cos(angle * 5 - wavePhase) * 0.03;
          const distance = Math.hypot(dx, dy / stretch) * bend + cluster * 11;
          if (distance > radius + 80) continue;

          // Feather the type away from the greeting and composer, rather than
          // letting decoration compete with the text the user is trying to read.
          let clearance = smoothstep(Math.min(cellX, width - cellX, cellY, height - cellY) / 36);
          for (const zone of quietZones) {
            const gap = Math.hypot(
              Math.max(zone.left - cellX, 0, cellX - zone.right),
              Math.max(zone.top - cellY, 0, cellY - zone.bottom),
            );
            const feather = Math.min(gap / 48, 1);
            clearance = Math.min(clearance, feather * feather * (3 - 2 * feather));
          }
          if (clearance < 0.02) continue;

          const tint = noiseAt(row, column, fieldSeed + 1);
          cells.push({
            x: cellX,
            y: cellY,
            distance,
            directionX: dx / (actualDistance || 1),
            directionY: dy / (actualDistance || 1),
            band: 36 + cluster * 6 + noise * 5,
            strength: (0.18 + noise * 0.4) * clearance * (0.85 + cluster * 0.15),
            ink: tint < 0.48 ? 0 : tint < 0.8 ? 1 : tint < 0.96 ? 2 : 3,
            digit: noise > 0.5 ? 1 : 0,
          });
        }
      }

      const activeRipples = ripples.filter(ripple => ripple.releasedAt === undefined);
      if (activeRipples.length >= MAX_RIPPLES) activeRipples[0].releasedAt = now;
      ripples.push({
        x, y, startedAt: now, radius, cells, width, height,
        duration: isEntry
          ? ENTRY_DURATION + Math.min(1300, Math.max(0, radius - 800) * 0.8)
          : CLICK_DURATION + Math.max(0, radius - 560) * 0.5,
        intensity: isEntry ? 0.76 : 1,
      });
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const queueEntry = () => {
      window.clearTimeout(entryTimer);
      if (entryPlayed || !canAnimate() || !width || !height) return;
      // Resizes postpone this once-only entrance until the home layout settles.
      entryTimer = window.setTimeout(() => {
        entryTimer = 0;
        if (!canAnimate() || !width || !height) return;
        const bounds = canvas.getBoundingClientRect();
        const composer = container.querySelector('.eterx-new-chat-composer-surface')?.getBoundingClientRect();
        const x = composer?.width ? (composer.left + composer.width / 2 - bounds.left) * width / bounds.width : width / 2;
        const y = composer?.height ? (composer.top + composer.height / 2 - bounds.top) * height / bounds.height : height * 0.45;
        entryPlayed = true;
        emitRipple(x, y, true);
      }, ENTRY_DELAY);
    };

    const onClick = (event: MouseEvent) => {
      if (!canAnimate() || event.defaultPrevented || event.button !== 0 || event.detail === 0
        || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!(event.target instanceof Element) || event.target.closest(INTERACTIVE_TARGETS)) return;
      if (window.getSelection()?.isCollapsed === false) return;
      const now = performance.now();
      if (now - lastClick < 100) return;
      lastClick = now;
      resize();
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      emitRipple((event.clientX - bounds.left) * width / bounds.width, (event.clientY - bounds.top) * height / bounds.height);
    };

    const onPreferenceChange = () => {
      if (!canAnimate()) {
        window.clearTimeout(entryTimer);
        clear();
      } else {
        // Rebuild the glyph palette on a theme change without replaying the
        // entrance. The bitmap may also have been hidden by accessibility settings.
        resize();
        if (!entryPlayed) queueEntry();
      }
    };
    const themeObserver = new MutationObserver(onPreferenceChange);
    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (!entryPlayed) queueEntry();
    });
    resize();
    resizeObserver.observe(container);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    reducedMotion.addEventListener('change', onPreferenceChange);
    forcedColors.addEventListener('change', onPreferenceChange);
    const unsubscribeVisibility = subscribeAppVisibility(onPreferenceChange);
    container.addEventListener('click', onClick);
    queueEntry();

    return () => {
      window.clearTimeout(entryTimer);
      clear();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      reducedMotion.removeEventListener('change', onPreferenceChange);
      forcedColors.removeEventListener('change', onPreferenceChange);
      unsubscribeVisibility();
      container.removeEventListener('click', onClick);
    };
  }, [containerRef]);

  return <canvas ref={canvasRef} className={styles.field} aria-hidden="true" />;
});
