/* RightCall 3D world (three.js r170, MIT, bundled). One scene, one camera, a pose per page.
   Data-bearing: hospital towers (estimated wait from fleet evidence only), ambulances, waiting patients,
   turn-away bursts, rain, replay journeys and pickup rankings. Decorative: auto-spin, stars, galaxy,
   road light pulses, warp transitions. */
import * as THREE from '/static/vendor/three.module.min.js';

const RC = window.RC, page = RC.page, reduce = RC.reduce;
const $ = s => document.querySelector(s);
const CX = 10.4, CZ = 7.2, R_DISC = 13.6;
const COL = { green: 0x35e0a1, amber: 0xffb020, red: 0xff2a14, unknown: 0x8a8f99, critical: 0xff2a14, urgent: 0xffb020, routine: 0x22b5ff };
if (!RC.has3d) throw new Error('WebGL unavailable: 2D fallback in use');
const queued = window.World?._q || {};

const canvas = $('#world');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  if (!renderer.getContext()) throw new Error('no webgl');
} catch (e) {
  canvas.hidden = true; RC.has3d = false; document.documentElement.classList.add('no3d'); window.dispatchEvent(new Event('rc-no3d'));
  throw new Error('WebGL unavailable: 2D fallback in use');
}
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.documentElement.classList.add('has3d');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, .1, 3000);
const city = new THREE.Group(), dyn = new THREE.Group(), overlay = new THREE.Group();
scene.add(city); city.add(dyn); city.add(overlay);
scene.add(new THREE.HemisphereLight(0xffd8c0, 0x2a0a04, .9));
const key = new THREE.DirectionalLight(0xffc29a, 2.2); key.position.set(-14, 26, 12); scene.add(key);
const rim = new THREE.DirectionalLight(0x4cc3ff, 1.6); rim.position.set(16, 8, -18); scene.add(rim);

function seeded(seed) { let s = seed * 9301 + 49297; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); }
function glowTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, inner); g.addColorStop(.45, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256); return new THREE.CanvasTexture(c);
}
const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/* ---------------- space: stars, warp streaks, galaxy, nebulae ---------------- */
const NSTAR = 3600, starPos = new Float32Array(NSTAR * 3), starCol = new Float32Array(NSTAR * 3);
{ const r = seeded(77); for (let i = 0; i < NSTAR; i++) {
  const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = 420 + r() * 380, s = Math.sqrt(1 - u * u);
  starPos.set([rad * s * Math.cos(th), rad * u, rad * s * Math.sin(th)], i * 3);
  const c = new THREE.Color().setHSL(r() < .2 ? .58 : .07, .5, .75 + r() * .25); starCol.set([c.r, c.g, c.b], i * 3); } }
const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3)); starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
const dotTex = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,.35)');
const starMat = new THREE.PointsMaterial({ size: 2.4, map: dotTex, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
const stars = new THREE.Points(starGeo, starMat); scene.add(stars);
const streakPos = new Float32Array(NSTAR * 6), streakGeo = new THREE.BufferGeometry(); streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
const streakMat = new THREE.LineBasicMaterial({ color: 0xffe6d8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const streaks = new THREE.LineSegments(streakGeo, streakMat); streaks.frustumCulled = false; scene.add(streaks);
// spiral galaxy
const NG = 16000, galPos = new Float32Array(NG * 3), galCol = new Float32Array(NG * 3);
{ const r = seeded(5), cIn = new THREE.Color(0xffb07a), cOut = new THREE.Color(0x3fb6ff), c = new THREE.Color();
  for (let i = 0; i < NG; i++) {
    const arm = i % 3, d = Math.pow(r(), 1.6) * 140, a = d * .055 + arm * 2.094 + (r() - .5) * .5 * (1 - d / 160);
    const sp = (r() - .5) * (6 + d * .12);
    galPos.set([Math.cos(a) * d + sp, (r() - .5) * (4 + 10 * Math.exp(-d / 20)), Math.sin(a) * d + sp], i * 3);
    c.copy(cIn).lerp(cOut, Math.min(1, d / 120)); galCol.set([c.r, c.g, c.b], i * 3); } }
const galGeo = new THREE.BufferGeometry(); galGeo.setAttribute('position', new THREE.BufferAttribute(galPos, 3)); galGeo.setAttribute('color', new THREE.BufferAttribute(galCol, 3));
const galMat = new THREE.PointsMaterial({ size: 2.2, map: dotTex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
const galaxy = new THREE.Points(galGeo, galMat); galaxy.position.set(70, -110, -380); galaxy.rotation.set(.9, 0, .35); scene.add(galaxy);
const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,220,180,1)', 'rgba(255,120,60,.35)'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
core.scale.set(120, 120, 1); galaxy.add(core);
const nebulae = [[0xff4a1c, [-260, 80, -520], 520], [0x22b5ff, [320, -40, -600], 600], [0x8a2be2, [40, 220, -700], 500]].map(([c, p, s]) => {
  const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,.55)', 'rgba(255,255,255,.12)'), color: c, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.position.set(...p); m.scale.set(s, s, 1); scene.add(m); return m;
});

/* ---------------- the city ---------------- */
const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,190,120,.95)', 'rgba(255,90,30,.35)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
halo.scale.set(64, 40, 1); halo.position.set(0, 1, -12); scene.add(halo);
const disc = new THREE.Mesh(new THREE.CylinderGeometry(R_DISC, 12.6, 1.4, 128, 1), new THREE.MeshStandardMaterial({ color: 0x1a110e, roughness: .75, metalness: .25 }));
disc.position.y = -.7; city.add(disc);
const top = new THREE.Mesh(new THREE.CircleGeometry(R_DISC, 128), new THREE.MeshStandardMaterial({ color: 0x221713, roughness: .95 }));
top.rotation.x = -Math.PI / 2; top.position.y = .001; city.add(top);
const edge = new THREE.Mesh(new THREE.TorusGeometry(R_DISC, .07, 8, 160), new THREE.MeshBasicMaterial({ color: 0xff7a3d })); edge.rotation.x = Math.PI / 2; city.add(edge);
const under = new THREE.Mesh(new THREE.TorusGeometry(12.6, .05, 8, 160), new THREE.MeshBasicMaterial({ color: 0x22b5ff, transparent: true, opacity: .7 })); under.rotation.x = Math.PI / 2; under.position.y = -1.4; city.add(under);
const shock = new THREE.Mesh(new THREE.TorusGeometry(1, .12, 8, 120), new THREE.MeshBasicMaterial({ color: 0xffd0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending })); shock.rotation.x = Math.PI / 2; city.add(shock);

let built = null;
const P = n => new THREE.Vector3(RC.W.nodes[n][0] - CX, 0, RC.W.nodes[n][1] - CZ);
function build(W) {
  if (built) { city.remove(built.root); built.root.traverse(o => o.geometry?.dispose()); }
  const root = new THREE.Group(), rnd = seeded(W.seed);
  const pos = { art: [], min: [] };
  for (const [a, b, art] of W.edges) {
    const A = P(a), B = P(b), d = B.clone().sub(A), nrm = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(art ? .11 : .05), y = art ? .03 : .02;
    const q = [A.clone().add(nrm), A.clone().sub(nrm), B.clone().sub(nrm), B.clone().add(nrm)];
    for (const i of [0, 1, 2, 0, 2, 3]) (art ? pos.art : pos.min).push(q[i].x, y, q[i].z);
  }
  for (const [k, color] of [['art', 0x9a6b5a], ['min', 0x4a3530]]) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos[k], 3));
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
  }
  const hosp = W.hospitals.map(h => P(h.node)), boxes = [];
  for (let j = 0; j < 9; j++) for (let i = 0; i < 13; i++) {
    const c = [j * 14 + i, j * 14 + i + 1, (j + 1) * 14 + i, (j + 1) * 14 + i + 1].map(P).reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(.25);
    if (hosp.some(h => h.distanceTo(c) < 1.1)) continue;
    const centre = 1 - Math.min(1, c.length() / 13);
    for (let k = 0; k < 4; k++) {
      if (rnd() < .22) continue;
      boxes.push([c.x + (k % 2 ? .3 : -.3) + (rnd() - .5) * .1, .1 + rnd() * (.28 + centre * .75), c.z + (k > 1 ? .3 : -.3) + (rnd() - .5) * .1, .2 + rnd() * .24, .2 + rnd() * .24, rnd()]);
    }
  }
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: .85, metalness: .1 }), boxes.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  boxes.forEach(([x, h, z, sx, sz, r], i) => { m.compose(new THREE.Vector3(x, h / 2, z), new THREE.Quaternion(), new THREE.Vector3(sx, h, sz)); inst.setMatrixAt(i, m); inst.setColorAt(i, col.setHSL(.03, .18, .07 + r * .06)); });
  root.add(inst);
  const beamTex = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,.2)');
  const towers = W.hospitals.map(h => {
    const g = new THREE.Group(); g.position.copy(P(h.node));
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(.85, .9, .08, 40), new THREE.MeshStandardMaterial({ color: 0x2c201c, roughness: .6 })); pad.position.y = .04;
    const mat = new THREE.MeshStandardMaterial({ color: COL.unknown, emissive: COL.unknown, emissiveIntensity: .7, roughness: .35, metalness: .2, transparent: true, opacity: .93 });
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(.55, .6, 1, 32), mat); tower.geometry.translate(0, .5, 0); tower.position.y = .08;
    const cross = new THREE.Group(), cm = new THREE.MeshBasicMaterial({ color: 0xffffff });
    cross.add(new THREE.Mesh(new THREE.BoxGeometry(.66, .1, .2), cm), new THREE.Mesh(new THREE.BoxGeometry(.2, .1, .66), cm));
    const ring = new THREE.Mesh(new THREE.RingGeometry(.95, 1.08, 48), new THREE.MeshBasicMaterial({ color: COL.red, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = .05;
    const sel = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.3, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide })); sel.rotation.x = -Math.PI / 2; sel.position.y = .06;
    const beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: beamTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .55 })); beam.scale.set(2.6, 2.6, 1);
    g.add(pad, tower, cross, ring, sel, beam); root.add(g); tower.userData.hid = h.id;
    return { g, tower, mat, cross, ring, sel, beam, h: .5, id: h.id };
  });
  const arts = W.edges.filter(e => e[2]).map(([a, b]) => [P(a), P(b)]), NP = reduce ? 0 : 70;
  const pulses = new THREE.InstancedMesh(new THREE.SphereGeometry(.06, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd6b8 }), Math.max(1, NP)); pulses.count = NP; root.add(pulses);
  const pulseSeeds = Array.from({ length: NP }, () => [Math.floor(rnd() * arts.length), rnd(), .15 + rnd() * .35]);
  city.add(root);
  const first = !built; built = { root, towers, seed: W.seed, arts, pulses, pulseSeeds };
  ambs.forEach(a => dyn.remove(a.g)); ambs.clear(); clearOverlay();
  if (!first && !reduce) bang = performance.now();
  if (wantOverlay) { const w = wantOverlay; wantOverlay = null; w(); }
}
let wantOverlay = null;

/* ambulances */
const bodyG = new THREE.BoxGeometry(.6, .3, .3), cabG = new THREE.BoxGeometry(.2, .22, .28), barG = new THREE.BoxGeometry(.14, .06, .24), stripeG = new THREE.BoxGeometry(.61, .05, .31);
const bodyM = new THREE.MeshStandardMaterial({ color: 0xf4f1ec, roughness: .4 }), idleM = new THREE.MeshStandardMaterial({ color: 0x8b8580, roughness: .6 }), stripeM = new THREE.MeshBasicMaterial({ color: 0xff3b1f });
const lightR = new THREE.MeshBasicMaterial({ color: 0xff2a14 }), lightB = new THREE.MeshBasicMaterial({ color: 0x22b5ff }), lightOff = new THREE.MeshBasicMaterial({ color: 0x333333 });
const glowTex = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,.25)'), ambs = new Map();
function amb(id) {
  if (ambs.has(id)) return ambs.get(id);
  const g = new THREE.Group(), body = new THREE.Mesh(bodyG, bodyM), cab = new THREE.Mesh(cabG, bodyM), bar = new THREE.Mesh(barG, lightR), stripe = new THREE.Mesh(stripeG, stripeM);
  body.position.y = .2; cab.position.set(.38, .16, 0); bar.position.set(-.05, .38, 0); stripe.position.y = .2;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff2a14, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); glow.scale.set(1.3, 1.3, 1); glow.position.y = .4;
  g.add(body, cab, stripe, bar, glow); dyn.add(g);
  const o = { g, body, cab, bar, glow, x: null, z: null, yaw: 0 }; ambs.set(id, o); return o;
}
const ringG = new THREE.RingGeometry(.28, .38, 32);
const rings = Array.from({ length: 40 }, () => { const r = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false })); r.rotation.x = -Math.PI / 2; r.visible = false; dyn.add(r); return r; });
const bursts = [], seenFeed = new Set();
const RAIN = 1400, rainPos = new Float32Array(RAIN * 6), rainV = new Float32Array(RAIN);
for (let i = 0; i < RAIN; i++) { const x = (Math.random() - .5) * 40, y = Math.random() * 22, z = (Math.random() - .5) * 40; rainPos.set([x, y, z, x + .18, y + .9, z], i * 6); rainV[i] = .22 + Math.random() * .22; }
const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xdfeaff, transparent: true, opacity: .45 })); city.add(rain);

/* ---------------- overlays: replay journeys, pickup rankings ---------------- */
let journey = null, pickup = null, overlayT0 = 0, frameTarget = null;
function clearOverlay() { overlay.children.slice().forEach(o => { overlay.remove(o); o.geometry?.dispose(); }); journey = pickup = null; frameTarget = null; }
function arc(a, b, color, radius, lift = 1) {
  const mid = a.clone().add(b).multiplyScalar(.5); mid.y += Math.max(1.2, a.distanceTo(b) * .32) * lift;
  const curve = new THREE.QuadraticBezierCurve3(a.clone().setY(.15), mid, b.clone().setY(.15));
  const geo = new THREE.TubeGeometry(curve, 64, radius, 10, false);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .95 }));
  mesh.userData.total = geo.index.count; geo.setDrawRange(0, 0); return mesh;
}
function cross(at, color) {
  const g = new THREE.Group(), m = new THREE.MeshBasicMaterial({ color });
  const a = new THREE.Mesh(new THREE.BoxGeometry(1.5, .14, .2), m), b = a.clone(); a.rotation.y = Math.PI / 4; b.rotation.y = -Math.PI / 4;
  g.add(a, b); g.position.copy(at).setY(.25); return g;
}
function beacon(at, color) {
  const g = new THREE.Group();
  const r = new THREE.Mesh(new THREE.RingGeometry(.45, .62, 48), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false })); r.rotation.x = -Math.PI / 2; r.position.y = .1;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, 6, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .55, blending: THREE.AdditiveBlending })); beam.position.y = 3;
  g.add(r, beam); g.position.copy(at); g.userData.pulse = r; return g;
}
function frameFor(points) {
  const c = points.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
  const spread = Math.max(...points.map(p => p.distanceTo(c)), 3);
  return { look: c.clone().setY(.5), dist: 10 + spread * 2.1, spread };
}
const setJourney = row => {
  if (!built) { wantOverlay = () => setJourney(row); return; }
  clearOverlay(); if (!row) return;
  const start = P(row.node), pts = [start], today = [start], ours = [start];
  row.today.visits.forEach(v => today.push(built.towers[v.h].g.position.clone()));
  row.ours.visits.forEach(v => ours.push(built.towers[v.h].g.position.clone()));
  const add = (path, visits, color, r, lift) => path.slice(1).forEach((p, i) => { overlay.add(arc(path[i], p, color, r, lift)); if (!visits[i].ok) overlay.add(cross(p, 0xff2a14)); pts.push(p); });
  add(today, row.today.visits, 0xff8a7a, .09, 1.15); add(ours, row.ours.visits, 0x22b5ff, .14, .8);
  overlay.add(beacon(start, 0xffffff));
  journey = row; overlayT0 = performance.now(); frameTarget = frameFor(pts);
};
const setPickup = (node, ranked, nearest) => {
  if (!built) { wantOverlay = () => setPickup(node, ranked, nearest); return; }
  clearOverlay(); if (node == null) return;
  const start = P(node), pts = [start];
  overlay.add(beacon(start, 0xffffff));
  ranked.slice(0, 5).reverse().forEach((r, k, arr) => {
    const rank = arr.length - 1 - k, to = built.towers[r.hospital].g.position.clone(); pts.push(to);
    overlay.add(arc(start, to, rank === 0 ? 0x22b5ff : r.hospital === nearest ? 0xffb020 : 0xffffff, rank === 0 ? .16 : .06, rank === 0 ? .9 : .6));
    if (rank > 0) overlay.children.at(-1).material.opacity = .45;
  });
  pickup = { node }; overlayT0 = performance.now(); frameTarget = frameFor(pts);
};
let labelFn = queued.labels || null, hi = queued.hl || null, focusId = queued.focus ?? null;
window.World = { setJourney, setPickup, setLabels: fn => { labelFn = fn; }, highlight: k => { hi = k; }, focus: id => { focusId = id; }, warpOut: cb => cb() };
if (queued.journey) setJourney(...queued.journey);
if (queued.pickup) setPickup(...queued.pickup);

/* ---------------- labels anchored in 3D ---------------- */
const labelLayer = $('#labels3d'), labelEls = new Map();
let labelData = [], lastLabels = 0;
function anchor(a) {
  if (!built) return null;
  if (a.tower != null) { const t = built.towers[a.tower]; return new THREE.Vector3(0, t.h + (a.dy ?? 1.1), 0).applyMatrix4(t.g.matrixWorld); }
  if (a.node != null) return P(a.node).setY(a.dy ?? 1.2).applyMatrix4(city.matrixWorld);
  return null;
}
function drawLabels(now) {
  if (!labelLayer) return;
  if (now - lastLabels > 300) { lastLabels = now; labelData = labelFn ? (labelFn() || []) : []; }
  const keep = new Set();
  for (const L of labelData) {
    keep.add(L.key); let el = labelEls.get(L.key);
    if (!el) { el = document.createElement('div'); el.className = 'l3d'; labelLayer.append(el); labelEls.set(L.key, el); }
    if (el._html !== L.html) { el.innerHTML = L.html; el._html = L.html; }
    el.className = 'l3d ' + (L.cls || '');
    const w = anchor(L.at); if (!w) { el.style.opacity = 0; continue; }
    const v = w.clone().project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    el.style.opacity = vis ? (L.dim ? .55 : 1) : 0;
    el.style.left = ((v.x * .5 + .5) * innerWidth) + 'px'; el.style.top = ((-v.y * .5 + .5) * innerHeight - 18) + 'px';
  }
  for (const [k, el] of labelEls) if (!keep.has(k)) { el.remove(); labelEls.delete(k); }
}

/* ---------------- camera poses per page ---------------- */
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const cur = { pos: V(0, 60, 120), look: V(0, 0, 0), fov: 40 };
function stageRect() {
  const el = document.querySelector('.stage'); if (!el) return null;
  const r = el.getBoundingClientRect(); if (r.width < 80 || r.height < 80) return null;
  const top = Math.max(r.top, 84), bottom = Math.min(r.bottom, innerHeight - 10);
  const h = bottom - top < 280 ? Math.min(r.height, innerHeight - 100) : bottom - top, cy = bottom - top < 280 ? Math.min(innerHeight - h / 2 - 10, Math.max(84 + h / 2, r.top + r.height / 2)) : (top + bottom) / 2;
  return { cx: r.left + r.width / 2, cy, w: r.width, h };
}
function pose() {
  const narrow = innerWidth < 900, k = narrow ? 1.35 : 1;
  let p, sky = 0, space = 0;
  if (page === 'home') {
    const s = Math.min(1, scrollY / innerHeight);
    p = { pos: V(0, 19, 43).lerp(V(0, 46, 64), s), look: V(0, 3.2, 0).lerp(V(0, -2, 0), s), fov: narrow ? 42 : 34.5 };
    if (narrow) { p.pos = V(0, 26, 38).lerp(V(0, 50, 70), s); p.look = V(0, -1, 0); }
    sky = s; space = s;
    if (focusId != null && built && s < .3) { const t = built.towers[focusId].g.position.clone().applyMatrix4(city.matrixWorld); p = { pos: t.clone().add(V(4, 6 + built.towers[focusId].h, 10)), look: t.clone().setY(built.towers[focusId].h * .6), fov: 36 }; }
  } else if (page === 'mechanism' || page === 'replay') {
    // frame the city (or the current pickup / journey) inside the transparent .stage column
    const st = stageRect(), size = frameTarget ? Math.max(8, frameTarget.spread * 2 + 5) : 30;
    const look = frameTarget ? frameTarget.look.clone().applyMatrix4(city.matrixWorld) : V(0, 0, 0);
    const tanV = Math.tan(19 * Math.PI / 180), tanH = tanV * innerWidth / innerHeight;
    const sw = st ? st.w : innerWidth * .6, sh = st ? st.h : innerHeight * .7;
    const D = Math.max(size * innerWidth / (2 * tanH * .9 * sw), .8 * size * innerHeight / (2 * tanV * .9 * sh), 14);
    p = { pos: look.clone().add(V(0, .76, .65).normalize().multiplyScalar(D)), look, fov: 38, off: st ? [innerWidth / 2 - st.cx, innerHeight / 2 - st.cy] : [0, 0] };
    space = .6;
  } else if (page === 'live') {
    p = { pos: V(-40, 90, 260), look: V(60, -90, -380), fov: 46 }; space = 1;
  } else if (page === 'proof') {
    p = { pos: V(0, 120, 230), look: V(-30, -60, -200), fov: 46 }; space = 1;
  } else if (page === 'limits') {
    p = { pos: V(-90, 70, 190), look: V(40, -50, -260), fov: 46 }; space = 1;
  } else {
    p = { pos: V(0, 40, 260), look: V(70, -110, -380), fov: 46 }; space = 1;
  }
  return { ...p, sky, space };
}

/* ---------------- interaction ---------------- */
let spin = 0, tilt = 0, drag = null, autoSpin = page !== 'replay' && page !== 'mechanism', hover = null;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function setNdc(e) { ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); }
function pickTower(e) { if (!built) return null; setNdc(e); const h = ray.intersectObjects(built.towers.map(t => t.tower), false)[0]; return h ? h.object.userData.hid : null; }
function pickNode(e) {
  if (!RC.W) return null; setNdc(e);
  const inv = city.matrixWorld.clone().invert(), o = ray.ray.origin.clone().applyMatrix4(inv), d = ray.ray.direction.clone().transformDirection(inv);
  if (Math.abs(d.y) < 1e-6) return null; const t = -o.y / d.y; if (t < 0) return null;
  const hit = o.add(d.multiplyScalar(t)); if (Math.hypot(hit.x, hit.z) > R_DISC) return null;
  let best = null, bd = 1e9; RC.W.nodes.forEach((n, i) => { const dd = (n[0] - CX - hit.x) ** 2 + (n[1] - CZ - hit.z) ** 2; if (dd < bd) { bd = dd; best = i; } });
  return best;
}
const interactive = ['home', 'mechanism', 'replay'].includes(page);
if (interactive) canvas.classList.add('interactive');
canvas.addEventListener('pointerdown', e => { if (!interactive) return; drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); autoSpin = false; });
canvas.addEventListener('pointermove', e => {
  if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy); spin += dx * .006; tilt = Math.max(-.25, Math.min(.35, tilt + dy * .003)); drag.x = e.clientX; drag.y = e.clientY; }
  else if (interactive) { hover = pickTower(e); canvas.style.cursor = hover != null || page === 'mechanism' ? 'pointer' : 'grab'; }
});
canvas.addEventListener('pointerup', e => {
  if (drag && drag.moved < 6) {
    if (page === 'mechanism') { const n = pickNode(e); if (n != null) window.dispatchEvent(new CustomEvent('rc-pickup', { detail: n })); }
    else if (page === 'home') { const id = pickTower(e); RC.select(id === RC.selected ? null : id); focusId = id === focusId ? null : id; }
  }
  drag = null; if (page === 'home') setTimeout(() => autoSpin = true, 5000);
});
canvas.addEventListener('keydown', e => {
  if (!RC.W || page !== 'home') return; const n = RC.W.hospitals.length, c = RC.selected;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const id = c == null ? (e.key === 'ArrowRight' ? 0 : n - 1) : (c + (e.key === 'ArrowRight' ? 1 : n - 1)) % n; RC.select(id); focusId = id; }
  if (e.key === 'Escape') { RC.select(null); focusId = null; }
});
RC.on('select', id => { if (page === 'home' && id == null) focusId = null; });

/* ---------------- warp transitions ---------------- */
const flash = $('#flash'), skyNight = $('#skyNight');
let warp = null, bang = 0;
try { const t = +sessionStorage.getItem('rc-warp'); if (t && Date.now() - t < 6000 && !reduce) warp = { mode: 'in', t0: performance.now(), dur: 1900 }; sessionStorage.removeItem('rc-warp'); } catch { }
window.World.warpOut = cb => { if (reduce) return cb(); warp = { mode: 'out', t0: performance.now(), dur: 820, cb }; };
function updateStreaks(len) {
  const cp = camera.position;
  for (let i = 0; i < NSTAR; i++) {
    const x = starPos[i * 3], y = starPos[i * 3 + 1], z = starPos[i * 3 + 2], dx = x - cp.x, dy = y - cp.y, dz = z - cp.z, d = Math.hypot(dx, dy, dz) || 1;
    streakPos.set([x, y, z, x + dx / d * len, y + dy / d * len, z + dz / d * len], i * 6);
  }
  streakGeo.attributes.position.needsUpdate = true;
}

/* ---------------- frame loop ---------------- */
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
const tmp = new THREE.Vector3(), mtx = new THREE.Matrix4();
let last = performance.now(), firstPose = true; const curOff = [0, 0];
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  const W = RC.W, S = RC.S;
  if (W && (!built || built.seed !== W.seed)) build(W);
  // ---- target pose + damping
  const tp = pose();
  if (firstPose) { cur.pos.copy(tp.pos); cur.look.copy(tp.look); cur.fov = tp.fov; if (tp.off) curOff.splice(0, 2, ...tp.off); firstPose = false; }
  const k = 1 - Math.exp(-dt * 3.2); cur.pos.lerp(tp.pos, k); cur.look.lerp(tp.look, k); cur.fov += (tp.fov - cur.fov) * k;
  let camPos = cur.pos.clone(), fov = cur.fov, streak = 0, flashA = 0, spaceBoost = 0;
  if (warp) {
    const t = Math.min(1, (now - warp.t0) / warp.dur);
    if (warp.mode === 'in') {
      const f = 1 - easeIO(t), back = cur.pos.clone().sub(cur.look).normalize();
      camPos.add(back.multiplyScalar(f * f * 900)); camPos.applyAxisAngle(V(0, 1, 0), f * 1.2);
      fov += 55 * f; streak = f; spaceBoost = f; flashA = Math.max(0, 1 - t * 3.2);
    } else {
      const f = easeIO(t); camPos.lerp(cur.look, f * .82); fov += 70 * f * f; streak = f; spaceBoost = f; flashA = Math.pow(t, 3);
    }
    if (t >= 1) { const cb = warp.cb; warp = null; if (cb) { flash.style.opacity = 1; cb(); return; } }
  }
  const to = tp.off || [0, 0]; curOff[0] += (to[0] - curOff[0]) * k; curOff[1] += (to[1] - curOff[1]) * k;
  camera.position.copy(camPos); camera.lookAt(cur.look); camera.fov = fov;
  if (Math.abs(curOff[0]) + Math.abs(curOff[1]) > .5) camera.setViewOffset(innerWidth, innerHeight, curOff[0], curOff[1], innerWidth, innerHeight); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  flash.style.opacity = flashA.toFixed(3);
  // ---- space visibility
  const spaceA = Math.min(1, tp.space + spaceBoost);
  starMat.opacity = .25 + spaceA * .75; galMat.opacity = Math.max(.08, spaceA) * .9; core.material.opacity = spaceA * .6;
  nebulae.forEach(n => n.material.opacity = spaceA * .22);
  if (!reduce) { galaxy.rotation.y += dt * .02; stars.rotation.y += dt * .002; }
  streaks.visible = streak > .02; streakMat.opacity = Math.min(1, streak * 1.4);
  if (streaks.visible) updateStreaks(streak * 160);
  if (skyNight) skyNight.style.opacity = page === 'home' ? Math.min(1, tp.sky * 1.2 + spaceBoost).toFixed(3) : '1';
  halo.material.opacity = page === 'home' ? (1 - tp.sky) * (.85 + .15 * Math.sin(now / 1800)) : .18;
  // ---- city transform
  if (autoSpin && !reduce && !warp) spin += dt * .055;
  let scale = 1;
  if (bang) { const t = Math.min(1, (now - bang) / 1600); scale = Math.max(.05, easeOutBack(t)); shock.scale.setScalar(1 + t * 28); shock.material.opacity = (1 - t) * .9; if (t >= 1) { bang = 0; shock.material.opacity = 0; } }
  city.visible = page !== 'live'; halo.visible = page !== 'live';
  city.scale.setScalar(scale); city.rotation.set(.08 + tilt, spin, 0); city.updateMatrixWorld();
  if (!W || !S || !built) { renderer.render(scene, camera); return; }
  const L = S.lanes.ours, nc = L.nowcast;
  // ---- hospitals
  built.towers.forEach(t => {
    const n = nc[t.id], target = n.level === 'unknown' ? .5 : .9 + Math.min(60, n.wait + 40 * n.risk) / 60 * 5.5;
    t.h += (target - t.h) * .08; t.tower.scale.y = t.h; t.cross.position.y = .08 + t.h + .06;
    const c = COL[n.level]; t.mat.color.setHex(c); t.mat.emissive.setHex(c); t.mat.opacity = n.level === 'unknown' ? .45 : .93;
    const lit = hi === 'wait' ? 1.6 : 1;
    t.mat.emissiveIntensity = (n.level === 'red' ? 1.1 + .4 * Math.sin(now / 160) : n.level === 'unknown' ? .35 : .85) * (hover === t.id ? 1.4 : 1) * lit;
    if ((n.level === 'red' || (hi === 'refusal' && n.risk > .15)) && !reduce) { const f = (now / 1300 + t.id * .3) % 1; t.ring.scale.setScalar(1 + f * 2.4); t.ring.material.opacity = .8 * (1 - f); } else t.ring.material.opacity = 0;
    t.beam.position.y = t.h + .3; t.beam.material.color.setHex(c); t.beam.material.opacity = n.level === 'unknown' ? .15 : .55;
    t.sel.material.opacity = RC.selected === t.id ? .9 : 0; if (RC.selected === t.id) t.sel.rotation.z = now / 900;
  });
  // ---- ambulances
  const blink = Math.floor(now / 220) % 2;
  for (const a of L.amb) {
    const o = amb(a.id), tx = a.x - CX, tz = a.y - CZ;
    if (o.x === null) { o.x = tx; o.z = tz; }
    const dx = tx - o.x, dz = tz - o.z;
    if (dx * dx + dz * dz > .0004) { let d = Math.atan2(-dz, dx) - o.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); o.yaw += d * .25; }
    o.x += dx * .2; o.z += dz * .2;
    const parked = a.state === 'at_hospital', moving = a.state === 'to_scene' || a.state === 'to_hospital';
    o.g.position.set(o.x + (parked ? ((a.id % 4) - 1.5) * .36 : 0), .06, o.z + (parked ? 1.15 + Math.floor((a.id % 8) / 4) * .4 : 0));
    o.g.rotation.y = parked ? 0 : o.yaw;
    const hl = hi === 'parked' && parked; o.g.scale.setScalar(hl ? 1.6 + .2 * Math.sin(now / 150) : 1);
    o.body.material = o.cab.material = a.state === 'idle' || a.state === 'out' ? idleM : bodyM; if (a.state === 'out') o.g.rotation.z = .5; else o.g.rotation.z = 0;
    o.bar.material = moving || a.state === 'awaiting_confirm' || hl ? (blink ? lightR : lightB) : lightOff;
    o.glow.visible = moving || hl; o.glow.material.color.setHex(hl ? 0xffb020 : blink ? 0xff2a14 : 0x22b5ff);
  }
  rings.forEach((r, i) => {
    const w = L.waiting[i]; r.visible = !!w && !journey && !pickup; if (!r.visible) return;
    const n = W.nodes[w.node]; r.position.set(n[0] - CX, .08, n[1] - CZ);
    const f = reduce ? .5 : (now / 900 + i * .21) % 1; r.scale.setScalar(.8 + f * 1.4); r.material.color.setHex(COL[w.severity]); r.material.opacity = 1 - f * .8;
  });
  const primed = seenFeed.has('run:' + S.run); seenFeed.add('run:' + S.run);      // first sight of a run: old refusals do not burst
  for (const f of L.feed) {
    const key = `${S.run}:${f.t}:${f.amb}:${f.hospital}`;
    if (!seenFeed.has(key)) { seenFeed.add(key); if (primed) { const m = new THREE.Mesh(new THREE.TorusGeometry(1, .06, 8, 64), new THREE.MeshBasicMaterial({ color: 0xff2a14, transparent: true })); m.rotation.x = Math.PI / 2; m.position.copy(built.towers[f.hospital].g.position); m.position.y = .3; dyn.add(m); bursts.push({ m, t0: now }); } }
  }
  for (let i = bursts.length - 1; i >= 0; i--) { const b = bursts[i], f = (now - b.t0) / 1600; if (f >= 1) { dyn.remove(b.m); b.m.geometry.dispose(); bursts.splice(i, 1); continue; } b.m.scale.setScalar(1 + f * 4); b.m.position.y = .3 + f * 2; b.m.material.opacity = 1 - f; }
  built.pulseSeeds.forEach(([e, o, sp], i) => { const [A, B] = built.arts[e], f = (o + now / 1000 * sp) % 1; tmp.lerpVectors(A, B, f); tmp.y = .08; built.pulses.setMatrixAt(i, mtx.makeTranslation(tmp.x, tmp.y, tmp.z)); });
  built.pulses.instanceMatrix.needsUpdate = true;
  // ---- overlays draw in
  const ot = Math.min(1, (now - overlayT0) / 1400);
  overlay.children.forEach((o, i) => {
    if (o.userData.total) o.geometry.setDrawRange(0, Math.floor(o.userData.total * easeIO(Math.min(1, ot * 1.4 - i * .05 > 0 ? ot * 1.4 - i * .05 : 0)) / 3) * 3);
    if (o.userData.pulse) { const f = (now / 1000) % 1; o.userData.pulse.scale.setScalar(1 + f * 1.5); o.userData.pulse.material.opacity = 1 - f; }
  });
  // ---- rain
  const rainLvl = Math.max(0, Math.min(1, S.rain - 1));
  rain.geometry.setDrawRange(0, Math.floor(RAIN * rainLvl) * 2); rain.visible = rainLvl > 0;
  if (rainLvl > 0 && !reduce) {
    for (let i = 0; i < RAIN * rainLvl; i++) { const q = i * 6, v = rainV[i] * (1 + rainLvl); rainPos[q + 1] -= v; rainPos[q + 4] -= v; rainPos[q] -= v * .2; rainPos[q + 3] -= v * .2; if (rainPos[q + 1] < -2) { const x = (Math.random() - .5) * 40, z = (Math.random() - .5) * 40; rainPos.set([x, 22, z, x + .18, 22.9, z], q); } }
    rain.geometry.attributes.position.needsUpdate = true;
  }
  document.documentElement.style.setProperty('--rain', rainLvl.toFixed(2));
  if (page === 'home') heroCallout(now, S, W);
  drawLabels(now);
  renderer.render(scene, camera);
}

/* ---------------- home: circled callout + leader line ---------------- */
let lastText = 0;
function heroCallout(now, S, W) {
  const callout = $('#hCallout'); if (!callout) return;
  const nc = S.lanes.ours.nowcast; let id = RC.selected;
  if (id == null) id = nc.reduce((b, n) => (n.wait + 40 * n.risk > (nc[b].wait + 40 * nc[b].risk) ? n.hospital : b), 0);
  const t = built.towers[id], v = new THREE.Vector3(0, t.h + .5, 0).applyMatrix4(t.g.matrixWorld).project(camera);
  const px = (v.x * .5 + .5) * innerWidth, py = (-v.y * .5 + .5) * innerHeight + scrollY - (document.getElementById('hero')?.offsetTop || 0);
  const br = callout.querySelector('.ring').getBoundingClientRect(), hr = document.getElementById('hero').getBoundingClientRect();
  const line = $('#hLead line'), dot = $('#hLead circle');
  line.setAttribute('x1', br.left - hr.left + br.width * .2); line.setAttribute('y1', br.bottom - hr.top - 4); line.setAttribute('x2', px); line.setAttribute('y2', py - scrollY + (scrollY));
  dot.setAttribute('cx', px); dot.setAttribute('cy', py);
  if (now - lastText > 400) {
    lastText = now; const n = nc[id], h = W.hospitals[id];
    $('#cNum').textContent = n.level === 'unknown' ? '?' : Math.round(n.wait);
    $('#cUnit').textContent = n.level === 'unknown' ? '' : 'min';
    $('#cLabel').innerHTML = `${n.level === 'unknown' ? 'NO RECENT FLEET EVIDENCE' : 'ESTIMATED WAIT'}<br>${RC.esc(h.name.toUpperCase())}`;
    $('#cSub').textContent = n.level === 'unknown' ? 'Shown as unknown, not as free.' : `${n.parked} ambulance${n.parked === 1 ? '' : 's'} at the gate · ${n.last_turnaway != null && n.risk > .15 ? `refused ${Math.round(n.last_turnaway)} min ago` : 'no recent refusals'} · ${RC.selected == null ? 'busiest right now' : 'selected'}`;
    callout.dataset.level = n.level;
  }
}
requestAnimationFrame(frame);
