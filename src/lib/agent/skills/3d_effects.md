---
name: 3d-effects
description: >
  Deep skill for CSS 3D transforms, perspective effects, depth illusions, and
  three-dimensional UI elements without WebGL. Load when user asks for: 3D card flip,
  3D button, perspective tilt, CSS 3D scene, depth effect, layered parallax, rotating
  cube, folding cards, 3D text, isometric UI, skew effects, transform-style preserve-3d,
  or any spatial/dimensional visual effect achievable with CSS transforms.
  Depends on: ui-engine. Works with: hover-effects, motion-animations.
  Triggers: "3D effect", "3D card", "card flip", "perspective", "depth", "tilt",
  "rotate 3D", "cube", "3D transform", "isometric", "spatial UI", "layered depth".
---

# 3D Effects — Deep UI Skill

CSS 3D transforms give interfaces **physical presence** without WebGL or Three.js. Mastering `perspective`, `transform-style: preserve-3d`, and the depth axis (`translateZ`) unlocks a dimension most developers never use.

---

## The CSS 3D Mental Model

```
Scene hierarchy for CSS 3D:

[perspective container]   ← Sets the camera distance
  └── [3D stage]          ← transform-style: preserve-3d
        └── [elements]    ← translateZ, rotateX/Y control depth
```

**Critical rules:**
- `perspective` goes on the **parent**, not the element
- `transform-style: preserve-3d` allows children to exist in 3D space
- `backface-visibility: hidden` hides the back face (essential for card flips)
- GPU compositing: 3D transforms are hardware accelerated by default

---

## Pattern Library

### 1. Card Flip (Classic)

```css
.flip-scene {
  perspective: 800px;
  width: 300px;
  height: 200px;
}

.flip-card {
  width: 100%;
  height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 600ms var(--ease-smooth);
  cursor: pointer;
}

.flip-scene:hover .flip-card,
.flip-card.flipped {
  transform: rotateY(180deg);
}

.flip-card-front,
.flip-card-back {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-xl);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  display: grid;
  place-items: center;
  padding: var(--space-6);
}

.flip-card-front {
  background: var(--color-primary);
  color: white;
}

.flip-card-back {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  transform: rotateY(180deg);
  color: var(--color-text-primary);
}
```

---

### 2. 3D Rotating Cube

```css
.cube-scene {
  perspective: 600px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 300px;
}

.cube {
  width: 120px;
  height: 120px;
  position: relative;
  transform-style: preserve-3d;
  animation: rotateCube 8s linear infinite;
}

@keyframes rotateCube {
  0%   { transform: rotateX(0deg) rotateY(0deg); }
  100% { transform: rotateX(360deg) rotateY(360deg); }
}

.cube-face {
  position: absolute;
  width: 120px;
  height: 120px;
  border: 2px solid rgba(255,255,255,0.3);
  background: rgba(59, 130, 246, 0.15);
  backdrop-filter: blur(8px);
  display: grid;
  place-items: center;
  font-size: var(--text-lg);
  font-weight: 700;
  color: white;
  backface-visibility: visible;
}

.cube-face.front  { transform: translateZ(60px); }
.cube-face.back   { transform: rotateY(180deg) translateZ(60px); }
.cube-face.right  { transform: rotateY(90deg) translateZ(60px); }
.cube-face.left   { transform: rotateY(-90deg) translateZ(60px); }
.cube-face.top    { transform: rotateX(90deg) translateZ(60px); }
.cube-face.bottom { transform: rotateX(-90deg) translateZ(60px); }
```

---

### 3. Perspective Tilt on Hover (Advanced)

```css
.tilt-wrapper {
  perspective: 1200px;
  display: inline-block;
}

.tilt-element {
  transform-style: preserve-3d;
  transition: transform 100ms linear;
  border-radius: var(--radius-xl);
  overflow: hidden;
  will-change: transform;
}

/* Floating layers within the 3D card */
.tilt-layer-1 { transform: translateZ(20px); }
.tilt-layer-2 { transform: translateZ(40px); }
.tilt-layer-3 { transform: translateZ(60px); }
.tilt-shine {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.15) 0%, transparent 60%);
  opacity: 0;
  transition: opacity var(--duration-fast);
  pointer-events: none;
}
```

```javascript
document.querySelectorAll('.tilt-wrapper').forEach(wrapper => {
  const el = wrapper.querySelector('.tilt-element');
  const shine = el.querySelector('.tilt-shine');
  const MAX_TILT = 15;

  wrapper.addEventListener('mousemove', e => {
    const rect = wrapper.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    const rotateX = (y - 0.5) * -MAX_TILT * 2;
    const rotateY = (x - 0.5) * MAX_TILT * 2;

    el.style.transform = `
      rotateX(${rotateX}deg)
      rotateY(${rotateY}deg)
      scale3d(1.02, 1.02, 1.02)
    `;

    if (shine) {
      shine.style.opacity = '1';
      shine.style.background = `
        radial-gradient(
          circle at ${x * 100}% ${y * 100}%,
          rgba(255,255,255,0.2),
          transparent 60%
        )
      `;
    }
  });

  wrapper.addEventListener('mouseleave', () => {
    el.style.transition = 'transform 500ms var(--ease-spring)';
    el.style.transform = 'rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    if (shine) shine.style.opacity = '0';
    setTimeout(() => el.style.transition = 'transform 100ms linear', 500);
  });
});
```

---

### 4. Layered Depth Scene (Parallax 3D)

Create depth using multiple layers at different `translateZ` levels.

```css
.depth-scene {
  perspective: 1000px;
  perspective-origin: 50% 50%;
  overflow: hidden;
  position: relative;
  height: 500px;
}

.depth-layer {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
}

/* Layers get closer (higher z = bigger/closer) */
.depth-layer-far    { transform: translateZ(-100px) scale(1.1); }
.depth-layer-mid    { transform: translateZ(0px); }
.depth-layer-near   { transform: translateZ(80px) scale(0.92); }
.depth-layer-front  { transform: translateZ(160px) scale(0.84); }
```

```javascript
// Mouse-driven parallax on depth scene
document.querySelectorAll('.depth-scene').forEach(scene => {
  const layers = scene.querySelectorAll('[data-depth]');

  scene.addEventListener('mousemove', e => {
    const rect = scene.getBoundingClientRect();
    const x = (e.clientX - rect.left - rect.width / 2) / rect.width;
    const y = (e.clientY - rect.top - rect.height / 2) / rect.height;

    layers.forEach(layer => {
      const depth = parseFloat(layer.dataset.depth) || 0.1;
      layer.style.transform = `translate(${x * depth * 40}px, ${y * depth * 30}px)`;
    });
  });

  scene.addEventListener('mouseleave', () => {
    layers.forEach(layer => {
      layer.style.transition = 'transform 800ms var(--ease-spring)';
      layer.style.transform = 'translate(0, 0)';
      setTimeout(() => layer.style.transition = '', 800);
    });
  });
});
```

---

### 5. 3D Text Effect

```css
.text-3d {
  font-family: var(--font-display);
  font-size: var(--text-4xl);
  font-weight: 900;
  color: var(--color-primary);
  text-shadow:
    1px 1px 0 var(--color-primary-700),
    2px 2px 0 var(--color-primary-700),
    3px 3px 0 var(--color-primary-800),
    4px 4px 0 var(--color-primary-800),
    5px 5px 0 var(--color-primary-900),
    6px 6px 8px rgba(0,0,0,0.3);
  letter-spacing: -0.02em;
}

/* Isometric text */
.text-isometric {
  font-family: var(--font-display);
  font-weight: 900;
  color: #fff;
  text-shadow:
    2px 2px 0 hsl(220, 80%, 40%),
    4px 4px 0 hsl(220, 80%, 35%),
    6px 6px 0 hsl(220, 80%, 30%),
    8px 8px 0 hsl(220, 80%, 25%),
    10px 10px 12px rgba(0,0,0,0.4);
  transform: perspective(500px) rotateX(15deg);
}
```

---

### 6. Skew / Diagonal Sections

```css
/* Diagonal section divider */
.section-skewed {
  position: relative;
  padding: var(--space-10) 0;
  background: var(--color-primary);
  clip-path: polygon(0 5%, 100% 0, 100% 95%, 0 100%);
  margin: -40px 0;
}

/* Parallelogram card */
.card-skewed {
  transform: skewX(-6deg);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  overflow: hidden;
}

.card-skewed-inner {
  transform: skewX(6deg); /* Counter-skew content */
  padding: var(--space-6);
}
```

---

## Performance & Browser Notes

1. **Always use `will-change: transform`** on elements with hover-driven 3D (add/remove dynamically)
2. **`backface-visibility: hidden`** is essential for flip cards — prevents ghost rendering
3. Avoid `overflow: hidden` on `preserve-3d` containers — it flattens the 3D context
4. **Safari quirks**: Always include `-webkit-backface-visibility: hidden` for Safari
5. `perspective` values: 300px = dramatic fish-eye, 800px = balanced, 1500px = subtle
6. Higher `translateZ` = element appears closer and larger — use for layered depth effects
7. **Combine with `pointer-events: none`** on decorative 3D layers that shouldn't intercept clicks
