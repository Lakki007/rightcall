/* RightCall shared core: nav, live state, API, toasts, warp navigation, guided-demo state.
   Loaded synchronously right after <header id="nav"> on every page. */
(function () {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const page = document.body.dataset.page;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const has3d = (() => { if (/[?&]no3d=1/.test(location.search)) return false; try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } })();
  if (!has3d) document.documentElement.classList.add('no3d');
  const PAGES = [['/', 'home', 'Overview'], ['/mechanism', 'mechanism', 'Mechanism'], ['/live', 'live', 'Live'], ['/replay', 'replay', 'Replay'], ['/proof', 'proof', 'Proof'], ['/limits', 'limits', 'Limits']];
  const logo = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#ff4a1c"/><path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="#fff"/><circle cx="16" cy="16" r="15" fill="none" stroke="#fff" stroke-opacity=".35"/></svg>`;

  // ---------- nav (glass pill) ----------
  const nav = $('#nav');
  nav.className = 'nav';
  nav.innerHTML = `<a class="logo" href="/" aria-label="RightCall, overview">${logo}<span>RightCall</span></a>
    <nav class="links" aria-label="Pages">${PAGES.map(([h, k, l]) => `<a href="${h}" ${k === page ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <div class="status" id="status" role="status" title="A simulated city: every ambulance, hospital and patient here is generated, not real."><span class="dot" aria-hidden="true"></span><span id="simCity">City</span><time id="simClock">--:--</time>
      <button class="iconbtn" id="navPlay" aria-label="Pause the simulation">❚❚</button></div>
    <button class="iconbtn menubtn" id="menuBtn" aria-label="Open page menu" aria-expanded="false">☰</button>`;
  let sheet = null;
  $('#menuBtn').onclick = () => {
    if (sheet) { sheet.remove(); sheet = null; $('#menuBtn').setAttribute('aria-expanded', 'false'); return; }
    sheet = document.createElement('nav'); sheet.className = 'sheet'; sheet.setAttribute('aria-label', 'Pages');
    sheet.innerHTML = PAGES.map(([h, k, l]) => `<a href="${h}" ${k === page ? 'aria-current="page"' : ''}>${l}</a>`).join('');
    document.body.append(sheet); $('#menuBtn').setAttribute('aria-expanded', 'true'); sheet.querySelector('a').focus();
  };

  // ---------- helpers ----------
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtClock = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  async function api(path, body, { method, timeout = 10000 } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    let r;
    try {
      r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), signal: ctl.signal, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? `The server took longer than ${timeout / 1000} s to answer. Nothing was changed on screen; try again.` : 'Could not reach the RightCall server. Is “python backend/server.py” still running?');
    } finally { clearTimeout(timer); }
    let j = null; try { j = await r.json(); } catch { }
    if (!r.ok) { const e = new Error((j && (typeof j.detail === 'string' ? j.detail : j.detail?.[0]?.msg)) || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return j;
  }
  function toast(msg, kind = '') {
    let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'assertive'); document.body.append(box); }
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; box.append(t); setTimeout(() => t.remove(), 5600);
  }

  // ---------- live state ----------
  const listeners = { state: [], world: [], select: [] };
  const RC = window.RC = {
    page, reduce, has3d, esc, fmtClock, api, toast, W: null, S: null, selected: null,
    on(ev, fn) { listeners[ev].push(fn); if (ev === 'state' && RC.S) fn(RC.S); if (ev === 'world' && RC.W) fn(RC.W); },
    select(id) { RC.selected = id; try { sessionStorage.setItem('rc-sel', id == null ? '' : String(id)); } catch { } listeners.select.forEach(f => f(id)); },
    hname: id => RC.W ? RC.W.hospitals[id].name : '',
  };
  try { const v = sessionStorage.getItem('rc-sel'); if (v) RC.selected = +v; } catch { }
  async function loadWorld() { RC.W = await api('/api/world'); listeners.world.forEach(f => f(RC.W)); }
  let lastSeed = null, ws = null, poll = null;
  function onState(s) {
    RC.S = s;
    if (s.seed !== lastSeed || !RC.W) { lastSeed = s.seed; loadWorld().catch(() => { }); }
    if (!RC.W) return;
    $('#simClock').textContent = fmtClock(s.t); $('#simCity').textContent = (RC.health && !RC.health.can_control ? 'View only · ' : '') + 'City ' + s.seed;
    const st = $('#status'); st.classList.toggle('paused', s.paused); st.classList.remove('off');
    const pb = $('#navPlay'); pb.textContent = s.paused ? '▶' : '❚❚'; pb.setAttribute('aria-label', s.paused ? 'Play the simulation' : 'Pause the simulation');
    listeners.state.forEach(f => { try { f(s); } catch (e) { console.error(e); } });
  }
  function banner(on) {
    let b = $('#banner');
    if (!on) { b?.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'banner'; b.className = 'banner'; b.setAttribute('role', 'alert'); document.body.append(b); }
    b.textContent = 'Lost contact with the simulation server, so nothing on screen is updating. Check that “python backend/server.py” is still running. This page reconnects by itself.';
    $('#status').classList.add('off');
  }
  function startPoll() { if (poll) return; poll = setInterval(async () => { try { onState(await api('/api/state', null, { timeout: 4000 })); banner(false); } catch { banner(true); } }, 600); }
  function connect() {
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch { startPoll(); return; }
    ws.onopen = () => { clearInterval(poll); poll = null; banner(false); };
    ws.onmessage = m => onState(JSON.parse(m.data));
    ws.onclose = () => { startPoll(); setTimeout(connect, 3000); };
  }
  $('#navPlay').onclick = () => api('/api/control', { action: RC.S && !RC.S.paused ? 'pause' : 'play' }).catch(e => toast(e.message, 'bad'));

  // ---------- 3D world stub: calls made before the 3D module (or 2D fallback) loads are queued and replayed ----------
  window.World = { _q: {}, warpOut: cb => cb(), setJourney(r) { this._q.journey = [r]; }, setPickup(...a) { this._q.pickup = a; },
    setLabels(f) { this._q.labels = f; }, highlight(k) { this._q.hl = k; }, focus(id) { this._q.focus = id; } };

  // ---------- warp navigation between pages ----------
  RC.go = function (href) {
    try { sessionStorage.setItem('rc-warp', String(Date.now())); } catch { }
    if (reduce || !window.World?.warpOut) { location.assign(href); return; }
    window.World.warpOut(() => location.assign(href));
  };
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || a.target || a.hasAttribute('download') || url.pathname.startsWith('/api') || url.pathname.startsWith('/static')) return;
    if (url.pathname === location.pathname) { if (url.hash) return; e.preventDefault(); scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); return; }
    e.preventDefault(); RC.go(url.pathname + url.search + url.hash);
  });
  addEventListener('pageshow', e => { if (e.persisted) location.reload(); });      // back/forward cache: rebuild the 3D scene cleanly

  // ---------- guided demo (spans pages) ----------
  RC.demo = {
    get() { try { return JSON.parse(sessionStorage.getItem('rc-demo') || 'null'); } catch { return null; } },
    set(d) { try { d ? sessionStorage.setItem('rc-demo', JSON.stringify(d)) : sessionStorage.removeItem('rc-demo'); } catch { } },
    async start() {
      RC.demo.set({ step: 0 });
      if (page !== 'live') RC.go('/live'); else location.reload();
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const m = document.querySelector('main'); if (m && !reduce) m.classList.add('enter');
    api('/api/state').then(onState).catch(() => banner(true)); connect();
    api('/api/health').then(h => { RC.health = h; if (!h.can_control) { document.documentElement.classList.add('viewonly'); $('#simCity').textContent = 'View only'; $('#status').title = 'This shared demo is view-only. Ask the RightCall team for the control link.'; } }).catch(() => { });
  });
})();
