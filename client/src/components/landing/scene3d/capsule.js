import {
  Color, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, LatheGeometry, Matrix4,
  Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, SphereGeometry, TorusGeometry, Vector2,
} from 'three';
import { PRESETS } from './presets';

export { PRESETS };

/*
 * The composite pharmacy capsule: rig -> body -> parts.
 *
 * `rig` carries the scroll pose (position, scale, spin). `body` holds the shell halves, which separate along Y
 * as `explode` rises, so the micro-pellets inside become visible. Everything built here is returned in `dispose`
 * so the caller can release it on unmount.
 */


const PELLETS = 38;
const MOTES = 36;

/** Half a capsule shell: a straight wall of `height` closed by a hemispherical dome. */
function shellProfile(radius, height, segments = 24) {
  const pts = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * (Math.PI / 2);
    pts.push(new Vector2(Math.sin(a) * radius, height + Math.cos(a) * radius));
  }
  pts.push(new Vector2(radius, 0));
  return pts;
}

export function buildCapsule({ cheap = false } = {}) {
  const trash = [];
  const keep = (o) => { trash.push(o); return o; };

  const rig = new Group();
  const body = new Group();
  rig.add(body);

  // 1. translucent upper cap
  const capMat = keep(cheap
    ? new MeshStandardMaterial({
      color: PRESETS.emerald.cap, roughness: 0.18, metalness: 0.05,
      transparent: true, opacity: 0.88, side: DoubleSide,
    })
    : new MeshPhysicalMaterial({
      color: PRESETS.emerald.cap,
      roughness: 0.12,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      iridescence: 0.38,
      iridescenceIOR: 1.35,
      transparent: true,
      opacity: 0.88,
      side: DoubleSide,
    }));
  const capGeo = keep(new LatheGeometry(shellProfile(0.34, 0.38, cheap ? 12 : 24), cheap ? 24 : 48));
  const cap = new Mesh(capGeo, capMat);
  body.add(cap);

  // 2. satin ceramic lower sleeve
  const sleeveMat = keep(cheap
    ? new MeshStandardMaterial({ color: PRESETS.emerald.body, roughness: 0.34, side: DoubleSide })
    : new MeshPhysicalMaterial({ color: PRESETS.emerald.body, roughness: 0.28, clearcoat: 0.65, side: DoubleSide }));
  const sleeveGeo = keep(new LatheGeometry(shellProfile(0.312, 0.4, cheap ? 12 : 24), cheap ? 24 : 48));
  const sleeve = new Mesh(sleeveGeo, sleeveMat);
  sleeve.rotation.z = Math.PI; // dome points down
  body.add(sleeve);

  // 3. brushed titanium locking collar
  const collarMat = keep(new MeshStandardMaterial({ color: 0xd0cbc0, roughness: 0.22, metalness: 0.9 }));
  const collarGeo = keep(new TorusGeometry(0.33, 0.018, 16, 48));
  const collar = new Mesh(collarGeo, collarMat);
  collar.rotation.x = Math.PI / 2;
  body.add(collar);

  // 4. sustained-release micro-pellets, golden-angle spiral inside the shell
  const pelletGeo = keep(new SphereGeometry(0.046, cheap ? 8 : 12, cheap ? 6 : 10));
  const pelletMat = keep(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.05 }));
  const pellets = new InstancedMesh(pelletGeo, pelletMat, PELLETS);
  pellets.instanceMatrix.setUsage(DynamicDrawUsage);
  const dummy = new Object3D();
  const home = [];
  for (let i = 0; i < PELLETS; i += 1) {
    const a = i * 2.39996;
    const t = (i + 0.5) / PELLETS;
    const r = 0.2 * Math.sqrt(t);
    home.push({ x: Math.cos(a) * r, y: (t - 0.5) * 0.74, z: Math.sin(a) * r });
    dummy.position.set(home[i].x, home[i].y, home[i].z);
    dummy.updateMatrix();
    pellets.setMatrixAt(i, dummy.matrix);
    pellets.setColorAt(i, new Color(PRESETS.emerald.pellets[i % 3]));
  }
  pellets.instanceMatrix.needsUpdate = true;
  if (pellets.instanceColor) pellets.instanceColor.needsUpdate = true;
  body.add(pellets);

  // 5. dual molecular calibration rings + interval nodes
  const rings = new Group();
  const ringMat = keep(new MeshStandardMaterial({ color: PRESETS.emerald.ring, roughness: 0.3, metalness: 0.85 }));
  const ringA = new Mesh(keep(new TorusGeometry(0.64, 0.008, cheap ? 6 : 12, cheap ? 40 : 96)), ringMat);
  const ringB = new Mesh(keep(new TorusGeometry(0.76, 0.006, cheap ? 6 : 12, cheap ? 40 : 96)), ringMat);
  ringA.rotation.x = Math.PI / 2.3;
  ringB.rotation.x = Math.PI / 1.7;
  ringB.rotation.y = 0.5;
  rings.add(ringA, ringB);
  const nodeGeo = keep(new SphereGeometry(0.022, 10, 8));
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2;
    const n = new Mesh(nodeGeo, ringMat);
    n.position.set(Math.cos(a) * 0.64, 0, Math.sin(a) * 0.64);
    ringA.add(n.clone());
    n.geometry = nodeGeo;
    rings.add(n);
  }
  rig.add(rings);

  // 6. ambient motes drifting through the depth of the viewport
  const moteGeo = keep(new SphereGeometry(0.028, 8, 6));
  const moteMat = keep(new MeshStandardMaterial({
    color: 0xcfe0da, roughness: 0.6, transparent: true, opacity: 0.28,
  }));
  const motes = new InstancedMesh(moteGeo, moteMat, MOTES);
  motes.instanceMatrix.setUsage(DynamicDrawUsage);
  const moteSeed = [];
  for (let i = 0; i < MOTES; i += 1) {
    moteSeed.push({
      x: (Math.random() - 0.5) * 9,
      y: (Math.random() - 0.5) * 6,
      z: -1.5 - Math.random() * 2.5,
      sp: 0.1 + Math.random() * 0.25,
      ph: Math.random() * Math.PI * 2,
    });
  }

  const setPreset = (name) => {
    const p = PRESETS[name] || PRESETS.emerald;
    capMat.color.set(p.cap);
    sleeveMat.color.set(p.body);
    ringMat.color.set(p.ring);
    for (let i = 0; i < PELLETS; i += 1) pellets.setColorAt(i, new Color(p.pellets[i % 3]));
    if (pellets.instanceColor) pellets.instanceColor.needsUpdate = true;
  };

  /** Opens the shell and lets the pellets spread as `e` goes 0 -> 1. */
  const applyExplode = (e) => {
    cap.position.y = 0.02 + e * 0.46;
    sleeve.position.y = -0.02 - e * 0.3;
    collar.position.y = e * 0.08;
    capMat.opacity = 0.88 - e * 0.26;
    const m = new Matrix4();
    for (let i = 0; i < PELLETS; i += 1) {
      const h = home[i];
      const k = 1 + e * 0.9;
      m.makeTranslation(h.x * k, h.y * (1 + e * 0.35), h.z * k);
      pellets.setMatrixAt(i, m);
    }
    pellets.instanceMatrix.needsUpdate = true;
  };

  const tickMotes = (elapsed) => {
    const m = new Matrix4();
    for (let i = 0; i < MOTES; i += 1) {
      const s = moteSeed[i];
      m.makeTranslation(s.x + Math.sin(elapsed * s.sp + s.ph) * 0.4, s.y + Math.cos(elapsed * s.sp * 0.8 + s.ph) * 0.3, s.z);
      motes.setMatrixAt(i, m);
    }
    motes.instanceMatrix.needsUpdate = true;
  };

  const dispose = () => {
    trash.forEach((o) => o.dispose?.());
    pellets.dispose();
    motes.dispose();
  };

  applyExplode(0);
  tickMotes(0);
  return { rig, body, rings, motes, setPreset, applyExplode, tickMotes, dispose };
}
