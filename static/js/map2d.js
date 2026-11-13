/* RightCall 2D tactical map. Used for the two side-by-side lanes on /live, and as the full-screen
   fallback when WebGL is unavailable (or ?no3d=1), so every page still works without 3D. */
(function () {
  const RC = window.RC;
  const C = { red: '#ff2a14', amber: '#ffb020', green: '#35e0a1', cy: '#22b5ff', grey: '#8a8f99', ink: '#f6f2ec' };
  const SEV = { critical: C.red, urgent: C.amber, routine: C.cy };
  const LEVEL = { red: C.red, amber: C.amber, green: C.green, unknown: C.grey };
  const FONT = '"Archivo", system-ui, sans-serif';

  class MapView {
    constructor(canvas, lane, opts = {}) {
      Object.assign(this, { c: canvas, x: canvas.getContext('2d'), lane, full: !!opts.full, onPick: opts.onPick, onSelect: opts.onSelect });
      this.pos = {}; this.trail = {}; this.bursts = []; this.seen = new Set(); this.hit = []; this.rot = this.full ? .42 : -.12; this.rain = [];
      this.showTruth = false; this.picking = false; this.pickedNode = null; this.journey = null; this.pickup = null; this.zoom = 1;
      canvas.addEventListener('click', e => this.click(e));
    }
    size() {
      const d = Math.min(devicePixelRatio || 1, 2), r = this.c.getBoundingClientRect();
      if (this.c.width !== Math.round(r.width * d) || this.c.height !== Math.round(r.height * d)) { this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); }
      this.w = r.width; this.h = r.height; this.x.setTransform(d, 0, 0, d, 0, 0);
    }
    proj(X, Y, z = 0) {
      const dx = X - 10.4, dy = Y - 7.2, c = Math.cos(this.rot), s = Math.sin(this.rot);
      const rx = dx * c - dy * s, ry = dx * s + dy * c, depth = (ry + 13) / 26;
      const base = (this.full ? Math.min(this.w / 26, this.h / 16) : Math.min(this.w / 23, this.h / 15.4)) * this.zoom;
      const sc = base * (.8 + .32 * depth);
      return [this.w * .5 + rx * sc, this.h * (this.full ? .56 : .53) + ry * sc * .8 - z * sc, ry, sc];
    }
    draw(now) {
      const W = RC.W, S = RC.S; if (!W || !S) return;
      this.size(); const x = this.x, L = S.lanes[this.lane]; x.clearRect(0, 0, this.w, this.h);
      if (this.full && !RC.reduce && !this.journey && !this.pickup) this.rot = .42 + Math.sin(now / 12000) * .18;
      if (!this.full) { const g = x.createRadialGradient(this.w * .5, this.h * .5, 10, this.w * .5, this.h * .5, this.w * .7); g.addColorStop(0, this.lane === 'ours' ? '#0d1820' : '#171214'); g.addColorStop(1, '#07070a'); x.fillStyle = g; x.fillRect(0, 0, this.w, this.h); }
      x.lineCap = 'round';
      for (const [a, b, art] of W.edges) { const p = this.proj(...W.nodes[a]), q = this.proj(...W.nodes[b]); x.strokeStyle = art ? 'rgba(255,190,160,.32)' : 'rgba(255,255,255,.09)'; x.lineWidth = art ? 2 : 1; x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); }
      if (!RC.reduce) W.edges.forEach(([a, b, art], i) => { if (!art || i % 3) return; const f = ((now / 2400) + i * .37) % 1, A = W.nodes[a], B = W.nodes[b], p = this.proj(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f); x.fillStyle = 'rgba(255,214,184,.35)'; x.beginPath(); x.arc(p[0], p[1], 1.4, 0, 7); x.fill(); });
      if (!this.journey && !this.pickup) for (const inc of L.waiting) { const p = this.proj(...W.nodes[inc.node]), r = 5 + (RC.reduce ? 0 : 3 * Math.abs(Math.sin(now / 300))); x.strokeStyle = SEV[inc.severity]; x.lineWidth = 2; x.beginPath(); x.arc(p[0], p[1], r, 0, 7); x.stroke(); x.fillStyle = SEV[inc.severity]; x.beginPath(); x.arc(p[0], p[1], 2.2, 0, 7); x.fill(); }
      if (this.pickedNode != null) { const p = this.proj(...W.nodes[this.pickedNode]); x.strokeStyle = C.ink; x.setLineDash([4, 4]); x.beginPath(); x.arc(p[0], p[1], 11, 0, 7); x.stroke(); x.setLineDash([]); }
      this.hit = [];
      const nc = S.lanes.ours.nowcast;
      const order = W.hospitals.map(h => ({ h, p: this.proj(...W.nodes[h.node]) })).sort((a, b) => a.p[2] - b.p[2]);
      for (const { h, p } of order) {
        const n = W.nodes[h.node], est = this.lane === 'ours' ? nc[h.id] : null, tr = L.truth[h.id];
        let col = '#d9d3cc', ht = .5, alpha = .4;
        if (est) { col = LEVEL[est.level]; ht = .35 + Math.min(60, est.wait + 40 * est.risk) / 60 * 3.1; alpha = est.level === 'unknown' ? .35 : .88; }
        this.pillar(n, ht, col, alpha, now, RC.selected === h.id, est && est.level === 'unknown');
        if (this.showTruth) { const th = .3 + Math.min(8, tr.queue) / 8 * 3.1, a = this.proj(n[0], n[1], 0), b = this.proj(n[0], n[1], th); x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.setLineDash([3, 3]); x.strokeRect(a[0] - 11, b[1], 22, a[1] - b[1]); x.setLineDash([]); if (S.closed.includes(h.id)) { x.fillStyle = '#fff'; x.font = `700 10px ${FONT}`; x.fillText('CLOSED', p[0] - 20, p[1] + 28); } }
        for (let k = 0; k < Math.min(6, L.parked[h.id]); k++) { x.fillStyle = C.amber; x.fillRect(p[0] + 14 + k * 7, p[1] + 3, 5, 3); }
        x.fillStyle = RC.selected === h.id ? C.ink : 'rgba(246,242,236,.72)'; x.font = `${RC.selected === h.id ? 700 : 500} 11px ${FONT}`; x.textAlign = 'center';
        const tw = x.measureText(h.name).width / 2 + 4; x.fillText(h.name, Math.max(tw, Math.min(this.w - tw, p[0])), p[1] + 17); x.textAlign = 'left';
        const top = this.proj(n[0], n[1], ht); this.hit.push({ id: h.id, x: p[0], y: (p[1] + top[1]) / 2, r: Math.max(22, (p[1] - top[1]) / 2 + 12) });
      }
      const primed = this.seen.has('run:' + S.run); this.seen.add('run:' + S.run);
      for (const f of L.feed) { const key = `${S.run}:${f.t}:${f.amb}:${f.hospital}`; if (!this.seen.has(key)) { this.seen.add(key); if (primed) this.bursts.push({ h: f.hospital, t0: now }); } }
      this.bursts = this.bursts.filter(b => now - b.t0 < 1500);
      for (const b of this.bursts) { const p = this.proj(...W.nodes[W.hospitals[b.h].node]), f = (now - b.t0) / 1500; x.strokeStyle = `rgba(255,42,20,${1 - f})`; x.lineWidth = 3; x.beginPath(); x.ellipse(p[0], p[1], 10 + f * 46, (10 + f * 46) * .56, 0, 0, 7); x.stroke(); x.fillStyle = `rgba(255,173,159,${1 - f})`; x.font = `700 11px ${FONT}`; x.fillText('TURNED AWAY', p[0] + 16, p[1] - 18 - f * 16); }
      if (!this.journey && !this.pickup) for (const a of L.amb) {
        const cur = this.pos[a.id] || (this.pos[a.id] = { x: a.x, y: a.y }); cur.x += (a.x - cur.x) * .25; cur.y += (a.y - cur.y) * .25;
        if (a.state === 'at_hospital') continue;
        if (a.state === 'out') { const p = this.proj(cur.x, cur.y); x.strokeStyle = '#ff5a46'; x.lineWidth = 2; x.beginPath(); x.moveTo(p[0] - 4, p[1] - 4); x.lineTo(p[0] + 4, p[1] + 4); x.moveTo(p[0] + 4, p[1] - 4); x.lineTo(p[0] - 4, p[1] + 4); x.stroke(); continue; }
        const p = this.proj(cur.x, cur.y), col = a.state === 'idle' ? '#5b5753' : SEV[a.sev] || C.cy, moving = a.state === 'to_scene' || a.state === 'to_hospital';
        const tr = this.trail[a.id] || (this.trail[a.id] = []); if (moving) { tr.push([cur.x, cur.y]); if (tr.length > 26) tr.shift(); } else tr.length = 0;
        if (tr.length > 1) { for (let i = 1; i < tr.length; i++) { const u = this.proj(...tr[i - 1]), v = this.proj(...tr[i]); x.strokeStyle = col; x.globalAlpha = i / tr.length * .7; x.lineWidth = 2.4; x.beginPath(); x.moveTo(u[0], u[1]); x.lineTo(v[0], v[1]); x.stroke(); } x.globalAlpha = 1; }
        x.shadowColor = col; x.shadowBlur = moving ? 14 : 0; x.fillStyle = col; x.beginPath(); x.arc(p[0], p[1], moving ? 4.4 : 3, 0, 7); x.fill(); x.shadowBlur = 0;
        if (a.state === 'awaiting_confirm') { x.strokeStyle = C.ink; x.beginPath(); x.arc(p[0], p[1], 9 + 3 * Math.sin(now / 150), 0, 7); x.stroke(); }
      }
      if (this.journey) this.drawJourney(now);
      if (this.pickup) this.drawPickup(now);
      if (S.rain > 1 && !RC.reduce) { const want = Math.round(120 * Math.min(1, S.rain - 1)); while (this.rain.length < want) this.rain.push({ x: Math.random() * this.w, y: Math.random() * this.h, v: 6 + Math.random() * 6 }); this.rain.length = want; x.strokeStyle = 'rgba(200,220,255,.3)'; x.lineWidth = 1; for (const d of this.rain) { d.y += d.v; d.x -= d.v * .25; if (d.y > this.h) { d.y = -10; d.x = Math.random() * this.w * 1.2; } x.beginPath(); x.moveTo(d.x, d.y); x.lineTo(d.x + 2.5, d.y - 10); x.stroke(); } } else this.rain.length = 0;
    }
    arcPath(a, b, col, width, prog, lift = 1) {
      const x = this.x, p = this.proj(...a), q = this.proj(...b), mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2 - Math.hypot(q[0] - p[0], q[1] - p[1]) * .28 * lift;
      x.strokeStyle = col; x.lineWidth = width; x.beginPath(); const N = 40, end = Math.max(1, Math.round(N * prog));
      for (let i = 0; i <= end; i++) { const t = i / N, X = (1 - t) ** 2 * p[0] + 2 * (1 - t) * t * mx + t * t * q[0], Y = (1 - t) ** 2 * p[1] + 2 * (1 - t) * t * my + t * t * q[1]; i ? x.lineTo(X, Y) : x.moveTo(X, Y); }
      x.stroke();
    }
    drawJourney(now) {
      const W = RC.W, j = this.journey, prog = Math.min(1, (now - j.t0) / 1400), x = this.x;
      const path = (visits, col, w, lift) => { let from = W.nodes[j.row.node]; visits.forEach(v => { const to = W.nodes[W.hospitals[v.h].node]; this.arcPath(from, to, col, w, prog, lift); if (!v.ok) { const p = this.proj(...to); x.strokeStyle = C.red; x.lineWidth = 3; x.beginPath(); x.moveTo(p[0] - 8, p[1] - 8); x.lineTo(p[0] + 8, p[1] + 8); x.moveTo(p[0] + 8, p[1] - 8); x.lineTo(p[0] - 8, p[1] + 8); x.stroke(); } from = to; }); };
      path(j.row.today.visits, 'rgba(255,138,122,.9)', 2.5, 1.2); path(j.row.ours.visits, C.cy, 4, .8);
      const s = this.proj(...W.nodes[j.row.node]); x.fillStyle = '#fff'; x.beginPath(); x.arc(s[0], s[1], 5, 0, 7); x.fill(); x.strokeStyle = '#fff'; x.beginPath(); x.arc(s[0], s[1], 8 + (now / 60) % 14, 0, 7); x.stroke();
    }
    drawPickup(now) {
      const W = RC.W, pk = this.pickup, prog = Math.min(1, (now - pk.t0) / 1200), x = this.x;
      pk.ranked.slice(0, 5).reverse().forEach((r, k, arr) => { const rank = arr.length - 1 - k; this.arcPath(W.nodes[pk.node], W.nodes[W.hospitals[r.hospital].node], rank === 0 ? C.cy : r.hospital === pk.nearest ? C.amber : 'rgba(255,255,255,.35)', rank === 0 ? 4 : 1.5, prog, rank === 0 ? .9 : .6); });
      const s = this.proj(...W.nodes[pk.node]); x.fillStyle = '#fff'; x.beginPath(); x.arc(s[0], s[1], 5, 0, 7); x.fill();
    }
    pillar(n, ht, col, alpha, now, sel, unknown) {
      const x = this.x, a = this.proj(n[0], n[1], 0), b = this.proj(n[0], n[1], ht), w = 9;
      x.fillStyle = col; x.globalAlpha = .16; x.beginPath(); x.ellipse(a[0], a[1], 26, 14, 0, 0, 7); x.fill();
      x.globalAlpha = alpha; const g = x.createLinearGradient(0, b[1], 0, a[1]); g.addColorStop(0, col); g.addColorStop(1, col + '22');
      x.fillStyle = g; x.fillRect(a[0] - w, b[1], w * 2, a[1] - b[1]);
      x.globalAlpha = Math.min(1, alpha + .15); x.fillStyle = col; x.beginPath(); x.ellipse(b[0], b[1], w, w * .5, 0, 0, 7); x.fill(); x.globalAlpha = 1;
      if (unknown) { x.fillStyle = '#e4e7ec'; x.font = `700 12px ${FONT}`; x.fillText('?', b[0] - 3.5, b[1] - 8); }
      if (sel) { x.strokeStyle = C.ink; x.lineWidth = 1.5; x.beginPath(); x.ellipse(a[0], a[1], 30 + 2 * Math.sin(now / 250), 16, 0, 0, 7); x.stroke(); }
      if (!unknown && col === C.red && !RC.reduce) { const f = (now / 1200) % 1; x.strokeStyle = col; x.globalAlpha = .5 * (1 - f); x.beginPath(); x.ellipse(a[0], a[1], 26 + 30 * f, (26 + 30 * f) * .54, 0, 0, 7); x.stroke(); x.globalAlpha = 1; }
    }
    nearestNode(px, py) { let best = 0, bd = 1e9; RC.W.nodes.forEach((n, i) => { const p = this.proj(...n), d = (p[0] - px) ** 2 + (p[1] - py) ** 2; if (d < bd) { bd = d; best = i; } }); return best; }
    click(ev) {
      if (!RC.W) return;
      const r = this.c.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
      if (this.picking && this.onPick) { this.onPick(this.nearestNode(px, py)); return; }
      const h = this.hit.find(h => Math.abs(px - h.x) < 26 && Math.abs(py - h.y) < h.r);
      if (this.onSelect) this.onSelect(h ? h.id : null);
    }
  }
  window.MapView = MapView;
  MapView.loop = views => { (function frame(now) { if (!document.hidden) for (const v of views()) { const r = v.c.getBoundingClientRect(); if (r.bottom > 0 && r.top < innerHeight) v.draw(now); } requestAnimationFrame(frame); })(0); };

  /* ---------- full-screen fallback when there is no WebGL ---------- */
  function fallback() {
    if (window.__rc2d) return; window.__rc2d = true;
    const page = RC.page; if (!['home', 'mechanism', 'replay'].includes(page)) { installWarp(); return; }
    const c = document.createElement('canvas'); c.id = 'world2d'; c.setAttribute('aria-hidden', 'true'); document.body.prepend(c);
    const v = new MapView(c, 'ours', { full: true, onSelect: id => RC.select(id === RC.selected ? null : id), onPick: n => window.dispatchEvent(new CustomEvent('rc-pickup', { detail: n })) });
    if (page === 'mechanism') { v.picking = true; c.style.cursor = 'crosshair'; }
    if (page === 'home') { c.style.opacity = .9; }
    const q = window.World?._q || {};
    window.World = {
      warpOut: cb => warp2d(cb), setLabels() { }, highlight() { }, focus() { },
      setJourney(row) { v.journey = row ? { row, t0: performance.now() } : null; v.zoom = row ? 1.08 : 1; },
      setPickup(node, ranked, nearest) { v.pickup = node == null ? null : { node, ranked, nearest, t0: performance.now() }; },
    };
    if (q.journey) window.World.setJourney(...q.journey); if (q.pickup) window.World.setPickup(...q.pickup);
    MapView.loop(() => [v]);
    window.dispatchEvent(new Event('rc-2d-ready'));
  }
  function warp2d(cb) {
    if (RC.reduce) return cb();
    const f = document.getElementById('flash'); document.body.animate([{ transform: 'scale(1)', filter: 'blur(0)' }, { transform: 'scale(1.15)', filter: 'blur(8px)' }], { duration: 520, easing: 'cubic-bezier(.6,0,.9,.4)', fill: 'forwards' });
    if (f) f.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 520, fill: 'forwards' }); setTimeout(cb, 500);
  }
  function installWarp() { window.World = Object.assign(window.World || {}, { warpOut: warp2d, setJourney() { }, setPickup() { }, setLabels() { }, highlight() { }, focus() { } }); }
  if (!RC.has3d) document.addEventListener('DOMContentLoaded', fallback);
  addEventListener('rc-no3d', fallback);
})();
