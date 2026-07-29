import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const ORB_STARTUP_FALLBACK = `
  radial-gradient(circle at 62% 72%, rgba(255,255,255,0.96) 0 15%, rgba(224,239,255,0.92) 34%, transparent 58%),
  linear-gradient(180deg, #3158ec 0%, #668ff4 54%, #eef6ff 100%)
`;

const vertexShaderSource = `varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPos;
uniform float time;
uniform float morph;

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
  return mod289(((x * 34.0) + 1.0) * x);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float cnoise(vec3 P) {
  vec3 Pi0 = floor(P);
  vec3 Pi1 = Pi0 + vec3(1.0);
  Pi0 = mod289(Pi0);
  Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P);
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
  vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
  vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
  vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
  vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
  return 1.2 * n_xyz;
}

void main() {
  vNormal = normalize(normalMatrix * normal);
  vLocalPos = normal;
  // Maintain a smooth, 100% uniform perfect sphere boundary
  vec4 pos = vec4(position, 1.0);
  vPosition = pos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * pos;
}`;

const fragmentShaderSource = `varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPos;
uniform float time;
uniform float RGBr;
uniform float RGBg;

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
  return mod289(((x * 34.0) + 1.0) * x);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float cnoise(vec3 P) {
  vec3 Pi0 = floor(P);
  vec3 Pi1 = Pi0 + vec3(1.0);
  Pi0 = mod289(Pi0);
  Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P);
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
  vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
  vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
  vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
  vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
  return 2.2 * n_xyz;
}

// 4-Octave Volumetric Cloud fBm
float fbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  vec3 flow = vec3(sin(time * 1.35) * 0.4, -time * 0.95, cos(time * 1.25) * 0.4);
  for (int i = 0; i < 4; i++) {
    value += amplitude * cnoise((p + flow) * frequency);
    frequency *= 2.05;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec3 p = vLocalPos * 1.6;
  float cloudDensity = fbm(p * RGBr);

  // Dynamic Shifting Dark Blue to Purplish Cloud Palette (NOT LIGHT)
  float shadeShift = sin(time * 0.95) * 0.5 + 0.5;

  vec3 deepOceanBlue    = vec3(0.00, 0.28, 0.88); // Rich Deep Royal Blue (#0048E0)
  vec3 deepIndigoPurple = vec3(0.24, 0.08, 0.62); // Deep Electric Purplish (#3D159E)
  vec3 darkAzureBlue    = vec3(0.00, 0.45, 0.98); // Vivid Dark Azure (#0073FF)

  vec3 pureCloudWhite   = vec3(1.00, 1.00, 1.00);
  vec3 softMistTint     = vec3(0.88, 0.96, 1.00);

  vec3 dynamicDarkShade = mix(deepOceanBlue, deepIndigoPurple, shadeShift);
  vec3 blueCloud        = mix(dynamicDarkShade, darkAzureBlue, cloudDensity * 0.5 + 0.5);
  vec3 whiteCloud       = mix(pureCloudWhite, softMistTint, cloudDensity * 0.4 + 0.2);

  float normY = vLocalPos.y + cloudDensity * 0.35;
  float splitFactor = smoothstep(-0.45, 0.45, normY);

  // Deep blue above, with the soft cloud bank settling toward the bottom.
  vec3 baseColor = mix(whiteCloud, blueCloud, splitFactor);

  vec3 viewDir = normalize(-vPosition);
  float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.2);
  baseColor = mix(baseColor, vec3(1.0, 1.0, 1.0), fresnel * 0.40);

  vec3 sunDir = normalize(vec3(0.5, 1.3, 1.2));
  float diff  = max(dot(vNormal, sunDir), 0.75);
  vec3 halfDir = normalize(sunDir + viewDir);
  float spec  = pow(max(dot(vNormal, halfDir), 0.0), 36.0);

  vec3 finalColor = baseColor * (diff * 0.35 + 0.68) + vec3(0.38) * spec;

  gl_FragColor = vec4(finalColor, 1.0);
}`;

export interface AbstractBallProps {
  perlinTime?: number;
  perlinMorph?: number;
  chromaRGBr?: number;
  chromaRGBg?: number;
  chromaRGBb?: number;
  cameraSpeedY?: number;
  cameraSpeedX?: number;
  cameraZoom?: number;
  className?: string;
  style?: React.CSSProperties;
  liveState?: 'idle' | 'connecting' | 'connected' | 'listening' | 'thinking' | 'speaking';
  audioVolume?: number;
}

const AbstractBall: React.FC<AbstractBallProps> = (props) => {
  const {
    perlinTime = 25.0,
    perlinMorph = 25.0,
    chromaRGBr = 7.5,
    chromaRGBg = 5.0,
    chromaRGBb = 7.0,
    cameraSpeedY = 0.3,
    cameraSpeedX = 0.2,
    cameraZoom = 70,
    className = '',
    style,
    liveState = 'idle',
    audioVolume = 0,
  } = props;

  const mountRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const width = Math.max(1, container.clientWidth || 115);
    const height = Math.max(1, container.clientHeight || 115);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(20, width / height, 1, 1000);
    camera.position.set(0, 5, cameraZoom);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        premultipliedAlpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.warn('[AbstractBall] WebGL unavailable; keeping the circular fallback.', error);
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.domElement.style.background = 'transparent';
    renderer.domElement.style.backgroundColor = 'transparent';
    renderer.domElement.style.border = 'none';
    renderer.domElement.style.outline = 'none';
    renderer.domElement.style.boxShadow = 'none';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.borderRadius = '50%';
    renderer.domElement.style.clipPath = 'circle(50% at 50% 50%)';
    (renderer.domElement.style as any).webkitClipPath = 'circle(50% at 50% 50%)';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    renderer.domElement.style.opacity = '0';
    renderer.domElement.style.transition = 'opacity 180ms ease-out';
    renderer.domElement.style.pointerEvents = 'none';

    container.appendChild(renderer.domElement);

    const geometry = new THREE.IcosahedronGeometry(11, 5);

    const uniforms = {
      time: { value: 0.0 },
      RGBr: { value: chromaRGBr / 10 },
      RGBg: { value: chromaRGBg / 10 },
      RGBb: { value: chromaRGBb / 10 },
      morph: { value: perlinMorph }
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.DoubleSide,
      transparent: true,
      vertexShader: vertexShaderSource,
      fragmentShader: fragmentShaderSource,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.set(0, 0, 0);
    scene.add(mesh);

    let animationFrameId = 0;
    let fallbackClearTimer: number | null = null;
    let clock = 0;
    let disposed = false;
    let firstFramePresented = false;
    let pageVisible = document.visibilityState !== 'hidden';

    const animate = () => {
      if (disposed) return;
      if (!pageVisible) {
        animationFrameId = requestAnimationFrame(animate);
        return;
      }
      const p = propsRef.current;
      const curPerlinTime = p.perlinTime ?? 25.0;
      const curPerlinMorph = p.perlinMorph ?? 25.0;
      const state = p.liveState || 'idle';
      const vol = p.audioVolume || 0;

      let speedMult = 1.0;
      let morphBoost = 1.0;

      if (state === 'speaking') {
        speedMult = 2.4 + vol * 1.5;
        morphBoost = 1.6 + vol * 1.2;
      } else if (state === 'listening') {
        speedMult = 1.6 + Math.sin(clock * 3.0) * 0.4;
        morphBoost = 1.3 + Math.sin(clock * 2.5) * 0.3;
      } else if (state === 'connecting') {
        speedMult = 2.0;
        morphBoost = 1.4;
      } else if (state === 'thinking') {
        speedMult = 1.9;
        morphBoost = 1.45 + Math.sin(clock * 1.8) * 0.12;
      }

      clock += (curPerlinTime / 4200) * speedMult;
      uniforms.time.value = clock;
      uniforms.morph.value = Math.min(10.0, curPerlinMorph * 0.12 * morphBoost);

      mesh.rotation.set(0, 0, 0);

      camera.lookAt(scene.position);
      renderer.render(scene, camera);
      if (!firstFramePresented) {
        firstFramePresented = true;
        requestAnimationFrame(() => {
          if (disposed) return;
          renderer.domElement.style.opacity = '1';
          fallbackClearTimer = window.setTimeout(() => {
            if (!disposed) container.style.background = 'transparent';
          }, 190);
        });
      }
      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);

    const handleResize = () => {
      if (disposed) return;
      const w = Math.max(1, container.clientWidth || 115);
      const h = Math.max(1, container.clientHeight || 115);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (fallbackClearTimer !== null) window.clearTimeout(fallbackClearTimer);
      container.style.background = ORB_STARTUP_FALLBACK;
      renderer.domElement.style.opacity = '0';
    };
    const handleContextRestored = () => {
      firstFramePresented = false;
    };
    const handleVisibilityChange = () => {
      pageVisible = document.visibilityState !== 'hidden';
    };
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(handleResize)
      : null;
    resizeObserver?.observe(container);
    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
      cancelAnimationFrame(animationFrameId);
      if (fallbackClearTimer !== null) window.clearTimeout(fallbackClearTimer);
      if (container && renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      geometry.dispose();
      material.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        background: ORB_STARTUP_FALLBACK,
        backgroundColor: '#5278ef',
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        borderRadius: '50%',
        clipPath: 'circle(50% at 50% 50%)',
        WebkitClipPath: 'circle(50% at 50% 50%)',
        overflow: 'hidden',
        position: 'relative',
        isolation: 'isolate',
        contain: 'strict',
        transform: 'translateZ(0)',
        ...style,
      }}
      className={className || ''}
    />
  );
};

export default AbstractBall;
