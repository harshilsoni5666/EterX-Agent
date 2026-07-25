import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const vertexShaderSource = `varying vec3 vNormal;
varying vec3 vPosition;
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
  // Pure local harmonic oscillation — Mesh stays 100% fixed in orientation
  float f = morph * cnoise(normal * 0.4 + vec3(sin(time * 0.8), cos(time * 0.7), sin(time * 0.9)) * 0.35);
  vec4 pos = vec4(position + f * normal, 1.0);
  vPosition = pos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * pos;
}`;

const fragmentShaderSource = `varying vec3 vNormal;
varying vec3 vPosition;
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

void main() {
  // Oscillating harmonic time offsets (clouds move in place, never drift across hemispheres)
  vec3 oscOffset = vec3(sin(time * 0.85) * 0.35, cos(time * 0.72) * 0.35, sin(time * 0.95) * 0.35);

  // 1. Blue Domain internal clouds (bottom hemisphere)
  float blueTurb1 = cnoise(RGBr * (vNormal * 1.8 + oscOffset));
  float blueTurb2 = cnoise(RGBg * (vNormal * 3.2 - oscOffset * 1.1)) * 0.5;
  float blueCloud = (blueTurb1 + blueTurb2) * 0.5;

  // 2. White Domain internal clouds (top hemisphere)
  float whiteTurb1 = cnoise(RGBr * (vNormal * 2.2 + oscOffset * 0.9));
  float whiteTurb2 = cnoise(RGBg * (vNormal * 3.8 - oscOffset * 1.2)) * 0.4;
  float whiteCloud = (whiteTurb1 + whiteTurb2) * 0.5;

  // Palette: Deep Sky Blue & Azure Cyan for Blue; Pure White & Soft Cyan Mist for White
  vec3 skyBlueDeep = vec3(0.00, 0.42, 0.98);   // Vibrant Deep Sky Blue (#006CFF)
  vec3 skyBlueBright = vec3(0.12, 0.70, 0.98); // Bright Azure Cyan (#1EB2FF)
  vec3 cloudWhite = vec3(0.98, 0.99, 1.0);     // Crisp Pure Cloud White (#FAFBFF)
  vec3 cloudSoft = vec3(0.86, 0.94, 1.0);      // Soft Mist Tint

  vec3 blueRegionColor = mix(skyBlueDeep, skyBlueBright, blueCloud * 0.5 + 0.5);
  vec3 whiteRegionColor = mix(cloudWhite, cloudSoft, whiteCloud * 0.5 + 0.5);

  // FIXED TOP WHITE / BOTTOM BLUE DIVISION
  // vNormal.y > 0 is TOP (White), vNormal.y < 0 is BOTTOM (Blue)
  float boundaryRipple = sin(vNormal.x * 4.0 + time * 1.2) * 0.04 + cos(vNormal.z * 4.0 + time * 1.1) * 0.04;
  float splitFactor = smoothstep(-0.15, 0.25, vNormal.y + boundaryRipple);

  vec3 baseColor = mix(blueRegionColor, whiteRegionColor, splitFactor);

  // Fresnel Rim Highlight for 3D Luminous Polish
  vec3 viewDir = normalize(-vPosition);
  float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.6);
  baseColor = mix(baseColor, vec3(0.96, 0.98, 1.0), fresnel * 0.42);

  // Soft Ambient & Specular Lighting
  vec3 lightDir = normalize(vec3(0.5, 1.25, 1.35));
  float diff = max(dot(vNormal, lightDir), 0.58);
  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(vNormal, halfDir), 0.0), 28.0);

  vec3 finalColor = baseColor * (diff * 0.55 + 0.52) + vec3(0.42) * spec;

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
    cameraZoom = 150,
    className = '',
    style,
  } = props;

  const mountRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const width = container.clientWidth || 115;
    const height = container.clientHeight || 115;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(20, width / height, 1, 1000);
    camera.position.set(0, 5, cameraZoom);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.background = 'transparent';
    renderer.domElement.style.backgroundColor = 'transparent';
    renderer.domElement.style.outline = 'none';

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
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
      vertexShader: vertexShaderSource,
      fragmentShader: fragmentShaderSource,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // Fixed mesh orientation so Top is ALWAYS White and Bottom is ALWAYS Sky Blue!
    mesh.rotation.set(0, 0, 0);
    scene.add(mesh);

    let animationFrameId: number;
    let clock = 0;

    const animate = () => {
      const p = propsRef.current;
      const curPerlinTime = p.perlinTime ?? 25.0;
      const curPerlinMorph = p.perlinMorph ?? 25.0;

      clock += (curPerlinTime / 8000);
      uniforms.time.value = clock;
      uniforms.morph.value = Math.min(6.0, curPerlinMorph * 0.12);

      // Keep 3D mesh object rotation 100% static so orientation NEVER flips upside down!
      mesh.rotation.set(0, 0, 0);

      camera.lookAt(scene.position);
      renderer.render(scene, camera);
      animationFrameId = requestAnimationFrame(animate);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 115;
      const h = container.clientHeight || 115;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
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
      style={{ background: 'transparent', backgroundColor: 'transparent', ...style }}
      className={`bg-transparent overflow-hidden ${className || ''}`}
    />
  );
};

export default AbstractBall;
