import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping, DirectionalLight, HemisphereLight, PerspectiveCamera,
  PMREMGenerator, Scene, SRGBColorSpace, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildCapsule } from './capsule';
import { poseAt, resolvePoses } from './poses';

/*
 * The full-viewport capsule, choreographed by scroll.
 *
 * It renders to a transparent canvas fixed behind the page content, so the porcelain gradient shows through and
 * the copy (at z-10) always sits on top. The scroll position is read in the frame loop rather than pushed in
 * through React state, so scrolling never re-renders the tree.
 */

const FOV = 30;
const CAM_Z = 10;
const DEG = Math.PI / 180;

/**
 * Software rasterisers (SwiftShader, llvmpipe) cannot afford a retina buffer, MSAA, or 60 fps.
 * Probed on a throwaway canvas so the real renderer can be built with the right settings.
 */
function detectSoftware() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|ANGLE \(Google/i.test(String(r));
  } catch { return false; }
}

export default function PharmacyScene3D({ preset = 'emerald', manualExplode = false }) {
  const mountRef = useRef(null);
  // live controls read by the frame loop, so changing them never rebuilds the scene.
  // Written in an effect, not during render: mutating a ref while rendering is not
  // safe under concurrent React.
  const ctl = useRef({ preset, manualExplode });
  useEffect(() => {
    ctl.current.preset = preset;
    ctl.current.manualExplode = manualExplode;
  }, [preset, manualExplode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const soft = detectSoftware();
    let renderer;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: !soft, powerPreference: 'high-performance' });
    } catch { return undefined; } // no WebGL: the page simply has no capsule
    const maxDpr = soft ? 0.6 : 2;
    // frame budget: full rate on a GPU, a paced ~24 fps when rasterising on the CPU
    const minFrameMs = soft ? 1000 / 24 : 0;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearAlpha(0);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new Scene();
    let pmrem = null;
    let envRT = null;
    if (!soft) {
      pmrem = new PMREMGenerator(renderer);
      envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      scene.environment = envRT.texture;
    }

    scene.add(new HemisphereLight(0xfff9ef, 0x1d3b31, 0.9));
    const key = new DirectionalLight(0xfff1dc, 1.9);
    key.position.set(4, 6, 5);
    scene.add(key);
    const rim = new DirectionalLight(0x7cc4aa, 1.5);
    rim.position.set(-5, -2, -4);
    scene.add(rim);

    const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
    camera.position.set(0, 0, CAM_Z);
    camera.lookAt(0, 0, 0);

    const capsule = buildCapsule({ cheap: soft });
    scene.add(capsule.rig);
    scene.add(capsule.motes);
    capsule.setPreset(ctl.current.preset);

    // the visible frustum at z = 0, which the poses are expressed in
    let fh = 2 * Math.tan((FOV / 2) * DEG) * CAM_Z;
    let fw = fh;

    const size = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fh = 2 * Math.tan((FOV / 2) * DEG) * CAM_Z;
      fw = fh * camera.aspect;
    };
    size();

    let poses = resolvePoses();
    const reflow = () => { poses = resolvePoses(); size(); };
    const ro = new ResizeObserver(reflow);
    ro.observe(mount);
    window.addEventListener('resize', reflow);
    // sections move as images and fonts settle, so re-resolve shortly after mount
    const settle = setTimeout(reflow, 1200);

    // ---- pose state -------------------------------------------------------
    // Start where the page is, not at the desktop hero pose: on a stacked layout that pose is a slab across the
    // headline, and the capsule would visibly shrink into place on every load.
    const cur = { x: 0.48, y: 0.06, s: 0.58, rx: 0.25, ry: 0.4, rz: -0.42, explode: 0, ...poseAt(poses, window.scrollY) };
    let elapsed = 0;
    let lastScroll = window.scrollY;
    let scrollVel = 0;
    const ptr = { x: 0, y: 0, tx: 0, ty: 0 };

    const onPointer = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      ptr.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ptr.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!still) window.addEventListener('pointermove', onPointer, { passive: true });

    let raf = 0;
    let prev = performance.now();
    let visible = true;
    const onVis = () => { visible = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    let moteTick = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (!visible) { prev = now; return; }
      if (minFrameMs && now - prev < minFrameMs) return; // paced: skip this frame entirely
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      const y = window.scrollY;
      scrollVel = (y - lastScroll) / Math.max(dt, 0.001);
      lastScroll = y;

      const target = poseAt(poses, y);
      if (!target) return;

      if (still) {
        // reduced motion: land on the pose immediately, no bob, no spin, no parallax
        Object.assign(cur, target);
      } else {
        // scroll speed makes the idle motion livelier without changing the pose
        elapsed += dt * (1 + Math.min(Math.abs(scrollVel) / 1500, 1.5));
        const k = 1 - Math.exp(-4 * dt);
        for (const p of ['x', 'y', 's', 'rx', 'ry', 'rz', 'explode']) {
          cur[p] += (target[p] - cur[p]) * k;
        }
        const pk = 1 - Math.exp(-dt / 0.12);
        ptr.x += (ptr.tx - ptr.x) * pk;
        ptr.y += (ptr.ty - ptr.y) * pk;
      }

      const explode = Math.min(1, cur.explode + (ctl.current.manualExplode ? 1 : 0));
      capsule.applyExplode(explode);
      // 36 instanced matrices per frame is wasted work on a CPU rasteriser
      moteTick += 1;
      if (!still && (!soft || moteTick % 3 === 0)) capsule.tickMotes(elapsed);

      // the capsule is 1 unit tall before scaling, so s maps straight onto the frustum height
      const scale = (cur.s * fh) / 1.0;
      capsule.rig.scale.setScalar(scale);
      capsule.rig.position.set(
        (cur.x * fw) / 2,
        (cur.y * fh) / 2 + (still ? 0 : Math.sin(elapsed * 1.1) * 0.02 * fh),
        0,
      );
      capsule.rig.rotation.set(cur.rx, cur.ry, cur.rz);
      if (!still) {
        capsule.rings.rotation.y = elapsed * 0.18;
        capsule.rings.rotation.z = Math.sin(elapsed * 0.3) * 0.12;
      }

      camera.rotation.x = -ptr.y * 0.022;
      camera.rotation.y = -ptr.x * 0.022;

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    // keep the preset in sync without tearing the scene down
    let lastPreset = ctl.current.preset;
    const presetWatch = setInterval(() => {
      if (ctl.current.preset !== lastPreset) {
        lastPreset = ctl.current.preset;
        capsule.setPreset(lastPreset);
      }
    }, 120);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(presetWatch);
      clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener('resize', reflow);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVis);
      capsule.dispose();
      envRT?.texture.dispose();
      pmrem?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-0 pointer-events-none" aria-hidden="true">
      <div ref={mountRef} className="absolute inset-0" />
    </div>
  );
}
