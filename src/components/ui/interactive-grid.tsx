"use client";

import React, { useEffect, useRef } from 'react';

export const InteractiveGrid = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let particles: Particle[] = [];
    let animationFrameId: number | null = null;
    let mx = 9999;
    let my = 9999;
    let cols = 0;
    let rows = 0;
    let isVisible = document.visibilityState !== 'hidden';
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Strict void configuration matching the screenshot exactly
    const SPACING = 24;
    const REPEL_RADIUS = 100;
    const PUSH_SPEED = 0.35;
    const RETURN_SPEED = 0.12;
    const DOT_BASE_RADIUS = 1.3;

    class Particle {
      x: number;
      y: number;
      ox: number;
      oy: number;

      constructor(x: number, y: number) {
        this.ox = x;
        this.oy = y;
        this.x = x;
        this.y = y;
      }

      update(mouse_x: number, mouse_y: number) {
        // Calculate distance from original point to mouse
        const dx = this.ox - mouse_x;
        const dy = this.oy - mouse_y;
        const distanceSquared = dx * dx + dy * dy;
        let targetX = this.ox;
        let targetY = this.oy;
        let speed = RETURN_SPEED;

        if (distanceSquared < REPEL_RADIUS * REPEL_RADIUS) {
          // Push strictly to the edge of the radius — creating a complete void
          const distance = Math.sqrt(distanceSquared);
          targetX = mouse_x + (distance === 0 ? 1 : dx / distance) * REPEL_RADIUS;
          targetY = mouse_y + (distance === 0 ? 0 : dy / distance) * REPEL_RADIUS;
          speed = PUSH_SPEED;
        }

        // Land exactly on the target after the subpixel easing tail. Pointer
        // presence alone is not movement: a settled grid needs no more frames.
        this.x = Math.abs(targetX - this.x) < 0.001 ? targetX : this.x + (targetX - this.x) * speed;
        this.y = Math.abs(targetY - this.y) < 0.001 ? targetY : this.y + (targetY - this.y) * speed;
        return this.x !== targetX || this.y !== targetY;
      }

      draw(context: CanvasRenderingContext2D) {
        // Uniform color, strictly honoring the "pure dots" reference
        context.fillStyle = `rgba(232, 230, 227, 0.25)`;
        context.beginPath();
        context.arc(this.x, this.y, DOT_BASE_RADIUS, 0, Math.PI * 2);
        context.fill();
      }
    }

    let rect = { left: 0, top: 0, width: 0, height: 0 } as DOMRect;

    const init = () => {
      // Match exactly to the parent container to account for Sidebar offets
      const width = canvas.parentElement?.clientWidth || window.innerWidth;
      const height = canvas.parentElement?.clientHeight || window.innerHeight;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      particles = [];
      cols = Math.ceil(width / SPACING) + 1;
      rows = Math.ceil(height / SPACING) + 1;

      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          particles.push(new Particle(c * SPACING, r * SPACING));
        }
      }

      // Update cached bounding rect
      rect = canvas.getBoundingClientRect();
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < particles.length; i++) {
        particles[i].draw(ctx);
      }
    };

    const animate = () => {
      if (!isVisible || prefersReducedMotion.matches) {
        animationFrameId = null;
        drawStatic();
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let moving = false;

      for (let i = 0; i < particles.length; i++) {
        if (particles[i].update(mx, my)) moving = true;
        particles[i].draw(ctx);
      }

      animationFrameId = moving ? requestAnimationFrame(animate) : null;
    };

    const requestDraw = () => {
      if (isVisible && animationFrameId === null) animationFrameId = requestAnimationFrame(animate);
    };

    init();
    drawStatic();

    const onResize = () => {
      init();
      drawStatic();
    };

    const onScroll = () => {
      rect = canvas.getBoundingClientRect();
    };
    
    // IMPORTANT: Calculate mouse relative to canvas layout box, not window screen
    // HIGH PERFORMANCE: Uses the cached bounding rect to prevent synchronous layout reflows!
    const onMouseMove = (e: MouseEvent) => {
      const nextX = e.clientX - rect.left;
      const nextY = e.clientY - rect.top;
      if (mx === nextX && my === nextY) return;
      mx = nextX;
      my = nextY;
      requestDraw();
    };
    
    const onMouseLeave = () => {
      mx = 9999;
      my = 9999;
      requestDraw();
    };

    const onVisibilityChange = () => {
      isVisible = document.visibilityState !== 'hidden';
      if (isVisible) requestDraw();
      else if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', onMouseLeave, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-10 opacity-100"
      style={{ background: 'transparent' }}
    />
  );
};
