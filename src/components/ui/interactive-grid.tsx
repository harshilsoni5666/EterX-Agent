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
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < REPEL_RADIUS) {
          // Push strictly to the edge of the radius — creating a complete void
          const angle = Math.atan2(dy, dx);
          const tx = mouse_x + Math.cos(angle) * REPEL_RADIUS;
          const ty = mouse_y + Math.sin(angle) * REPEL_RADIUS;
          
          this.x += (tx - this.x) * PUSH_SPEED;
          this.y += (ty - this.y) * PUSH_SPEED;
        } else {
          // Natural return to original grid position
          this.x += (this.ox - this.x) * RETURN_SPEED;
          this.y += (this.oy - this.y) * RETURN_SPEED;
        }
      }

      draw(context: CanvasRenderingContext2D) {
        // Uniform color, strictly honoring the "pure dots" reference
        context.fillStyle = `rgba(232, 230, 227, 0.25)`;
        context.beginPath();
        context.arc(this.x, this.y, DOT_BASE_RADIUS, 0, Math.PI * 2);
        context.fill();
      }
    }

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
      let moving = mx !== 9999 || my !== 9999;

      for (let i = 0; i < particles.length; i++) {
        const beforeX = particles[i].x;
        const beforeY = particles[i].y;
        particles[i].update(mx, my);
        if (Math.abs(particles[i].x - beforeX) > 0.02 || Math.abs(particles[i].y - beforeY) > 0.02) {
          moving = true;
        }
        particles[i].draw(ctx);
      }

      animationFrameId = moving ? requestAnimationFrame(animate) : null;
    };

    const requestDraw = () => {
      if (animationFrameId === null) animationFrameId = requestAnimationFrame(animate);
    };

    init();
    drawStatic();

    const onResize = () => {
      init();
      drawStatic();
    };
    
    // IMPORTANT: Calculate mouse relative to canvas layout box, not window screen
    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mx = e.clientX - rect.left;
      my = e.clientY - rect.top;
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

    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', onResize);
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
