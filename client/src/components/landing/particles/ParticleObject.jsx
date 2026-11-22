import { useEffect, useRef, useState } from 'react';
import { NormalBlending, BufferAttribute, BufferGeometry, PerspectiveCamera, Points, Scene, ShaderMaterial, Color, WebGLRenderer } from 'three';
import { SHAPES, TILT_X } from './particleShapes';

/*
 * The signature visual: a THREE.Points cloud that is a capsule, then morphs (about 2 s) into a tablet and a medical
 * cross, and back, every 8-12 s. The morph runs entirely on the GPU: each point has a "from" and a "to" position and
 * a per-point delay, so the shape pours from one form into the next.
 *
 *   variant="live"    rotating and morphing (the hero)
 *   variant="static"  one dimmed frame, no loop (reduced motion, and the closing section)
 *
 * It is confined to its parent, never takes pointer events, pauses while off screen, and degrades twice if the
 * device is slow: fewer points first, then a plain CSS glow.
 */

const VERT = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute float aSeed;
  uniform float uT;
  uniform float uSize;
  uniform float uTime;
  varying float vA;
  varying float vTint;
  void main() {
    float t = clamp((uT - aSeed * 0.35) / 0.65, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 p = mix(aFrom, aTo, t);
    p += 0.012 * vec3(sin(uTime * 0.9 + aSeed * 40.0), cos(uTime * 0.8 + aSeed * 31.0), sin(uTime * 0.7 + aSeed * 17.0));
    float scatter = sin(t * 3.14159) * 0.4;
    p += scatter * (vec3(fract(aSeed * 91.7), fract(aSeed * 53.3), fract(aSeed * 27.1)) - 0.5);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize / -mv.z;
    vA = 0.5 + 0.5 * fract(aSeed * 13.7);
    vTint = fract(aSeed * 7.3);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uWhite;
  uniform vec3 uLavender;
  uniform float uOpacity;
  varying float vA;
  varying float vTint;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = pow(smoothstep(0.5, 0.0, r), 1.7);
    gl_FragColor = vec4(mix(uWhite, uLavender, vTint), a * vA * uOpacity);
  }
`;

const REDUCED = '(prefers-reduced-motion: reduce)';

/** One probe per page load: does this browser give us a WebGL context at all? */
let webglOk;
const supportsWebgl = () => {
  if (webglOk === undefined) {
    try {
      const c = document.createElement('canvas');
      webglOk = !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      webglOk = false;
    }
  }
  return webglOk;
};

export default function ParticleObject({ variant = 'live', opacity = 0.42, className = '' }) {
  const host = useRef(null);
  const [fallback, setFallback] = useState(() => !supportsWebgl());

  useEffect(() => {
    const el = host.current;
    if (!el || !supportsWebgl()) return undefined;
    const small = window.matchMedia('(max-width: 767px)').matches;
    const still = variant === 'static' || window.matchMedia(REDUCED).matches;
    const count = still ? 2800 : small ? 2200 : 5000;

    const renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1 : 1.75));
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    el.appendChild(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(38, 1, 0.1, 50);
    const shapes = SHAPES.map((make) => make(count));

    const geometry = new BufferGeometry();
    const seeds = new Float32Array(count).map(() => Math.random());
    geometry.setAttribute('position', new BufferAttribute(shapes[0], 3)); // required by three; the shader reads aFrom/aTo
    geometry.setAttribute('aFrom', new BufferAttribute(shapes[0], 3));
    geometry.setAttribute('aTo', new BufferAttribute(shapes[0], 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));

    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      uniforms: {
        uT: { value: 1 },
        uSize: { value: 30 },
        uTime: { value: 0 },
        uOpacity: { value: opacity },
        // dark on a light page: the names are historical, the roles are base + tint
        uWhite: { value: new Color('#8fa79c') },
        uLavender: { value: new Color('#2a8566') },
      },
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    const size = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.position.z = 5.1 / Math.min(1, camera.aspect * 0.95);
      camera.updateProjectionMatrix();
      material.uniforms.uSize.value = 34 * Math.min(2, Math.max(0.6, h / 700)) * renderer.getPixelRatio();
    };
    size();
    const ro = new ResizeObserver(() => {
      size();
      if (still) renderer.render(scene, camera);
    });
    ro.observe(el);

    if (still) {
      points.rotation.set(TILT_X[0] + 0.1, 0.55, -0.12);
      renderer.render(scene, camera);
      return () => {
        ro.disconnect();
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
      };
    }

    // ---- live loop ----
    const loop = { raf: 0 };
    let visible = true;
    let last = performance.now();
    let elapsed = 0;
    let current = 0;
    let morphing = false;
    let morphT = 0;
    let nextMorphAt = 9;
    let tiltFrom = TILT_X[0];
    let tiltTo = TILT_X[0];
    let tilt = TILT_X[0];
    let frames = 0;
    let acc = 0;
    let stage = 0; // 0 full quality, 1 reduced points
    const MORPH_SECONDS = 2;

    const startMorph = () => {
      const next = (current + 1) % shapes.length;
      geometry.setAttribute('aFrom', new BufferAttribute(shapes[current], 3));
      geometry.setAttribute('aTo', new BufferAttribute(shapes[next], 3));
      tiltFrom = tilt;
      tiltTo = TILT_X[next];
      current = next;
      morphing = true;
      morphT = 0;
      material.uniforms.uT.value = 0;
    };

    const frame = (now) => {
      loop.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible) return;
      elapsed += dt;

      // adaptive quality: judge the first and then the second 90 frames
      frames += 1;
      acc += dt;
      if (frames === 90) {
        const avg = acc / frames;
        frames = 0;
        acc = 0;
        if (avg > 0.028 && stage === 0) {
          stage = 1;
          geometry.setDrawRange(0, Math.floor(count * 0.45));
        } else if (avg > 0.07 && stage === 1) {
          cancelAnimationFrame(loop.raf);
          setFallback(true);
          return;
        }
      }

      if (!morphing && elapsed >= nextMorphAt) startMorph();
      if (morphing) {
        morphT += dt / MORPH_SECONDS;
        const k = Math.min(1, morphT);
        material.uniforms.uT.value = k;
        tilt = tiltFrom + (tiltTo - tiltFrom) * (k * k * (3 - 2 * k));
        if (k >= 1) {
          morphing = false;
          nextMorphAt = elapsed + 8 + Math.random() * 4;
        }
      }
      material.uniforms.uTime.value = elapsed;
      points.rotation.x = tilt;
      points.rotation.y = Math.sin(elapsed * 0.3) * 1.0 + 0.2;
      points.rotation.z = Math.sin(elapsed * 0.2) * 0.22;
      renderer.render(scene, camera);
    };
    loop.raf = requestAnimationFrame(frame);

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      last = performance.now();
    });
    io.observe(el);

    return () => {
      cancelAnimationFrame(loop.raf);
      io.disconnect();
      ro.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [variant, opacity]);

  return (
    <div ref={host} aria-hidden="true" className={`pointer-events-none absolute inset-0 ${className}`}>
      {fallback && <div className="lp-glow" />}
    </div>
  );
}
