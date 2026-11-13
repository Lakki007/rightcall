/* Overview page: hero controls, waveform (live estimated waits), barcode (real fleet observations), run numbers. */
(function () {
  const RC = window.RC, $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const SPEEDS = [10, 30, 60, 120];
  $('#hWave').innerHTML = '<i></i>'.repeat(40);
  $('#wbars').innerHTML = Array.from({ length: 38 }, (_, i) => `<i style="height:${18 + Math.round(70 * Math.abs(Math.sin(i * 1.7)) * (1 - Math.abs(i - 19) / 24))}px;animation-delay:${(i % 7) * -.17}s"></i>`).join('');
  const fail = e => RC.toast(e.message, 'bad');
  const setFill = el => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%');

  function sync(force) {
    const S = RC.S, W = RC.W; if (!S || !W) return;
    const busy = el => !force && (document.activeElement === el || el.dataset.drag === '1');
    const hp = $('#hPlay'); hp.textContent = S.paused ? '▶' : '❚❚'; hp.setAttribute('aria-label', S.paused ? 'Play the simulation' : 'Pause the simulation');
    const rain = Math.round((S.rain - 1) * 100); $('#hRainV').textContent = rain + '%'; if (!busy($('#hRain'))) $('#hRain').value = rain;
    $('#hSpeedV').textContent = S.speed + '×'; if (!busy($('#hSpeed'))) $('#hSpeed').value = Math.max(0, SPEEDS.indexOf(S.speed));
    const sel = RC.selected, m = sel != null ? (S.surge_mult?.[sel] ?? 1) : 1;
    $('#hSurge').disabled = sel == null; $('#hSurgeName').textContent = sel != null ? RC.hname(sel) : 'click a tower';
    $('#hSurgeV').textContent = '×' + m; if (!busy($('#hSurge'))) $('#hSurge').value = m;
    $$('.h-panel input[type=range]').forEach(setFill);
    // waveform: one band of five bars per hospital; height = RightCall's live estimated wait there
    const nc = S.lanes.ours.nowcast;
    $$('#hWave i').forEach((b, i) => { const n = nc[Math.floor(i / 5) % nc.length], env = [.45, .8, 1, .8, .45][i % 5];
      const v = n.level === 'unknown' ? 10 : 22 + Math.min(60, n.wait + 40 * n.risk) * 2.2; b.style.height = Math.max(6, v * env) + 'px'; b.style.opacity = n.level === 'unknown' ? .45 : .95; });
    const a = S.lanes.nearest.metrics, o = S.lanes.ours.metrics;
    $('#hfTurn').textContent = a.turnaways; $('#hfMin').textContent = o.turnaways; $('#hfCalls').textContent = o.transports ? (o.calls / o.transports).toFixed(1) : '–';
  }
  RC.on('state', () => sync()); RC.on('select', () => sync(true));

  $('#hPlay').onclick = () => RC.api('/api/control', { action: RC.S && !RC.S.paused ? 'pause' : 'play' }).catch(fail);
  const bind = (id, show, fn) => {
    const el = $(id);
    el.addEventListener('pointerdown', () => el.dataset.drag = '1');
    el.addEventListener('input', () => { show(+el.value); setFill(el); });
    el.addEventListener('change', () => { el.dataset.drag = '0'; fn(+el.value); });
  };
  bind('#hRain', v => $('#hRainV').textContent = v + '%', v => RC.api('/api/chaos', { type: 'rain', value: v / 100 }).catch(fail));
  bind('#hSpeed', v => $('#hSpeedV').textContent = SPEEDS[v] + '×', v => RC.api('/api/control', { action: 'speed', speed: SPEEDS[v] }).catch(fail));
  bind('#hSurge', v => $('#hSurgeV').textContent = '×' + v, v => {
    const id = RC.selected; if (id == null) return RC.toast('Click a hospital tower first.', 'bad');
    RC.api('/api/chaos', { type: 'surge', hospital: id, value: v })
      .then(() => RC.toast(v > 1 ? `${RC.hname(id)}: walk-ins ×${v}. RightCall has not been told; watch its tower react only as crews report back.` : `${RC.hname(id)}: walk-ins back to normal.`)).catch(fail);
  });
  $('#demoBtn').onclick = () => RC.demo.start();

  // barcode of real fleet observations (latest first, newest on the left)
  async function barcode() {
    const c = $('#hBarcode'); if (!c || document.hidden || c.getBoundingClientRect().bottom < 0) return;
    let r; try { r = await RC.api('/api/evidence?limit=120', null, { timeout: 4000 }); } catch { return; }
    const d = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight; c.width = w * d; c.height = h * d; const x = c.getContext('2d'); x.scale(d, d);
    let px = 0; for (const e of r.rows) { const bw = e.type === 'handover_wait' ? 3 : e.type.startsWith('call') ? 1 : 2, ref = e.type === 'turn_away' || e.type === 'call_no';
      x.fillStyle = ref ? '#22b5ff' : '#ffffff'; x.fillRect(px, ref ? 0 : 4, bw, ref ? h : h - 8); px += bw + 2; if (px > w) break; }
    if (!r.rows.length) { x.fillStyle = 'rgba(255,255,255,.5)'; x.font = '12px Archivo, sans-serif'; x.fillText('No observations yet: press play.', 0, h / 2 + 4); }
  }
  setInterval(barcode, 3000); setTimeout(barcode, 900);
  // a motion page should move: start the city on first visit if it is still sitting at its warm start
  setTimeout(() => { const S = RC.S; if (S && S.paused && S.t < 42) RC.api('/api/control', { action: 'play' }).catch(() => { }); }, 1200);
})();
