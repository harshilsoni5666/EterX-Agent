'use client';

import React, { useLayoutEffect, useRef } from 'react';

type FaceValue = number | string;
type FaceTarget = Record<string, FaceValue | FaceValue[]>;
type FaceTiming = {
  duration?: number;
  delay?: number;
  repeat?: number;
  times?: number[];
  ease?: string | readonly number[];
};
type FaceTransition = FaceTiming & { [property: string]: unknown };
type FaceAnimationProps = { animate: FaceTarget; transition?: FaceTransition };

// Keep the face's independent keyframe tracks on the browser animation
// timeline. In particular, blinking must retain its own offsets and duration
// while gaze, breathing, and highlights continue at their original pace.
const transformProperties = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'];
const isTransform = (property: string) => transformProperties.includes(property);
const cssValue = (property: string, value: FaceValue): string | number => {
  switch (property) {
    case 'x': return `translateX(${typeof value === 'number' ? `${value}px` : value})`;
    case 'y': return `translateY(${typeof value === 'number' ? `${value}px` : value})`;
    case 'rotate': return `rotate(${typeof value === 'number' ? `${value}deg` : value})`;
    case 'scale': case 'scaleX': case 'scaleY': return `${property}(${value})`;
    case 'width': return typeof value === 'number' ? `${value}px` : value;
    default: return value;
  }
};
const cssEasing = (ease: FaceTiming['ease']): string => {
  if (Array.isArray(ease)) return `cubic-bezier(${ease.join(',')})`;
  switch (ease) {
    case 'easeInOut': return 'ease-in-out';
    case 'easeIn': return 'ease-in';
    case 'easeOut': return 'ease-out';
    default: return typeof ease === 'string' ? ease : 'ease-in-out';
  }
};

type Track = { animation: Animation; signature: string };

function useFaceAnimation(animate: FaceTarget, transition: FaceTransition = {}) {
  const ref = useRef<HTMLElement | SVGSVGElement | null>(null);
  const tracks = useRef(new Map<string, Track>());

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const current = tracks.current;
    // Additive transform effects compose in creation order, matching the
    // original translate -> scale -> rotate transform order.
    const properties = [
      ...transformProperties.filter(property => property in animate),
      ...Object.keys(animate).filter(property => !isTransform(property)),
    ];
    for (const [property, track] of current) {
      if (!(property in animate)) {
        track.animation.cancel();
        current.delete(property);
      }
    }
    for (const property of properties) {
      const value = animate[property];
      const override = transition[property];
      const timing: FaceTiming = typeof override === 'object' && override !== null
        ? { ...transition, ...override }
        : transition;
      const signature = JSON.stringify([value, timing]);
      const existing = current.get(property);
      // Parent renders and ambient gaze changes must not restart every blink
      // or create another set of infinite animations.
      if (existing?.signature === signature) continue;

      const values = Array.isArray(value) ? value : [value];
      const animated = values.length > 1;
      const propertyName = isTransform(property) ? 'transform' : property;
      const offsets = timing.times?.length === values.length ? timing.times : undefined;
      const easing = cssEasing(timing.ease);
      const keyframes: Keyframe[] = values.map((entry, index) => ({
        [propertyName]: cssValue(property, entry),
        ...(offsets ? { offset: offsets[index] } : {}),
        easing,
      }));
      const options: KeyframeEffectOptions = {
        duration: animated ? (timing.duration ?? 0.3) * 1000 : 0,
        delay: animated ? (timing.delay ?? 0) * 1000 : 0,
        iterations: animated ? (timing.repeat === Infinity ? Infinity : (timing.repeat ?? 0) + 1) : 1,
        fill: 'both',
        composite: isTransform(property) ? 'add' : 'replace',
      };
      if (existing) {
        const effect = existing.animation.effect as KeyframeEffect;
        effect.setKeyframes(keyframes);
        effect.updateTiming(options);
        existing.animation.currentTime = 0;
        existing.animation.play();
        existing.signature = signature;
      } else {
        current.set(property, { animation: element.animate(keyframes, options), signature });
      }
    }
  });

  useLayoutEffect(() => {
    const current = tracks.current;
    return () => {
      current.forEach(track => track.animation.cancel());
      current.clear();
    };
  }, []);

  return ref;
}

function FaceDiv({ animate, transition, style, ...props }: React.HTMLAttributes<HTMLDivElement> & FaceAnimationProps) {
  const ref = useFaceAnimation(animate, transition);
  return <div {...props} ref={ref as React.Ref<HTMLDivElement>} style={{ ...style, ...(Object.keys(animate).some(isTransform) ? { transform: 'none' } : {}) }} />;
}

function FaceSpan({ animate, transition, style, ...props }: React.HTMLAttributes<HTMLSpanElement> & FaceAnimationProps) {
  const ref = useFaceAnimation(animate, transition);
  return <span {...props} ref={ref as React.Ref<HTMLSpanElement>} style={{ ...style, ...(Object.keys(animate).some(isTransform) ? { transform: 'none' } : {}) }} />;
}

function FaceSvg({ animate, transition, style, ...props }: React.SVGProps<SVGSVGElement> & FaceAnimationProps) {
  const ref = useFaceAnimation(animate, transition);
  return <svg {...props} ref={ref as React.Ref<SVGSVGElement>} style={{ ...style, transformBox: 'fill-box', transformOrigin: '50% 50%', ...(Object.keys(animate).some(isTransform) ? { transform: 'none' } : {}) }} />;
}

export const FaceMotion = { div: FaceDiv, span: FaceSpan, svg: FaceSvg };
