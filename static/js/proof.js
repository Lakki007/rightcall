/* Proof page: 4-policy benchmark (survives refresh: it reattaches to a running job), evidence log, saved runs. */
(function () {
  const RC = window.RC, $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)], esc = RC.esc, fail = e => RC.toast(e.message, 'bad');
  const NAMES = { nearest: 'Nearest hospital', phone: 'Phone ahead (non-AI)', blind: 'RightCall, evidence removed', ours: 'RightCall' };
  const COLS = { nearest: '#a59e96', phone: '#ffb020', blind: '#ff8a7a', ours: '#22b5ff' };
  const ORDER = ['nearest', 'phone', 'blind', 'ours'];
  let runs = 20, timer = null;
  $$('#nSeg button').forEach(b => b.onclick = () => { runs = +b.dataset.n; $$('#nSeg button').forEach(o => o.setAttribute('aria-pressed', String(o === b))); });

  $('#bRun').onclick = async () => { try { await RC.api('/api/benchmark', { runs, dropgo: $('#bDrop').checked }); poll(); } catch (e) { fail(e); if (e.status === 409) poll(); } };
  $('#bCancel').onclick = () => RC.api('/api/benchmark/cancel', {}).catch(fail);
  function poll() {
    clearInterval(timer);
    timer = setInterval(async () => {
      let b; try { b = await RC.api('/api/benchmark', null, { timeout: 4000 }); } catch { return; }
      const run = b.state === 'running'; $('#bRun').disabled = run; $('#bCancel').disabled = !run; const p = $('#bProg'); p.hidden = !run;
      if (run) { $('i', p).style.width = (100 * b.done / b.total) + '%'; $('span', p).textContent = `${b.done} of ${b.total} simulated city-runs finished (${b.total / 4} cities × 4 policies)`; return; }
      clearInterval(timer); render(b);
    }, 300);
  }
  function render(b) {
    const o = $('#bOut');
    if (b.state === 'idle') return;
    if (b.state === 'cancelled') { o.innerHTML = '<p class="empty">Benchmark cancelled. No partial results are shown.</p>'; return; }
    if (b.state === 'error') { o.innerHTML = `<p class="err">Benchmark failed: ${esc(b.error)}</p>`; return; }
    const r = b.results, P = r.policies;
    const t = (a, z) => (P[a].turnaways_per_100 - P[z].turnaways_per_100).toFixed(1), dm = (P.phone.mean - P.ours.mean).toFixed(1);
    o.innerHTML = `<div class="scroll" style="max-height:none"><table class="t"><thead><tr><th>Policy</th><th class="n">Turned away /100 patients</th><th class="n">Avg pickup → bed</th><th class="n">Worst 10%</th><th class="n">Calls / patient</th></tr></thead><tbody>
      ${ORDER.map(k => `<tr class="${k === 'ours' ? 'us' : ''}"><td><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${COLS[k]};margin-right:8px"></i>${NAMES[k]}</td><td class="n">${P[k].turnaways_per_100}</td><td class="n">${P[k].mean} min</td><td class="n">${P[k].p90} min</td><td class="n">${P[k].calls_per_transport}</td></tr>`).join('')}</tbody></table></div>
      <p class="verdict">Turn-aways: <b class="cy">${P.ours.turnaways_per_100}</b> per 100 patients with RightCall, vs ${P.phone.turnaways_per_100} phoning ahead and ${P.nearest.turnaways_per_100} today. Against phone-ahead, city by city: fewer in <b>${r.turnaways_vs_phone.fewer}</b>, tied in ${r.turnaways_vs_phone.tied}, more in ${r.turnaways_vs_phone.more} of ${r.runs}.</p>
      <p class="small">Remove the fleet evidence and turn-aways rise from ${P.ours.turnaways_per_100} to ${P.blind.turnaways_per_100} (${t('blind', 'ours') > 0 ? '+' : ''}${t('blind', 'ours')}): that gap is the fleet evidence itself, on top of the phone call (fewer in ${r.turnaways_vs_blind.fewer}, tied in ${r.turnaways_vs_blind.tied}, more in ${r.turnaways_vs_blind.more} cities). Average time: ${dm > 0 ? `${dm} min faster` : dm < 0 ? `${-dm} min slower` : 'the same'} than phone-ahead, faster in ${r.ours_beats_phone_runs} of ${r.runs} cities${r.dropgo ? ', with drop-and-go crews' : ''}.</p>
      <canvas id="strip" role="img" aria-label="Turned away per 100 patients in each simulated city, one dot per city, for each policy. The bar marks the overall rate."></canvas>
      <p class="fine">One dot per city (seeds ${r.seeds}): turned away per 100 patients. Bar = overall rate. Finished ${new Date(r.finished * 1000).toLocaleTimeString()}.</p>`;
    strip(P);
  }
  function strip(P) {
    const c = $('#strip'), d = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight; c.width = w * d; c.height = h * d; const x = c.getContext('2d'); x.scale(d, d);
    const all = ORDER.flatMap(k => P[k].per_run_turnaways), hi = Math.max(5, ...all) * 1.05, left = Math.min(200, w * .36), X = v => left + v / hi * (w - left - 16);
    x.font = '12px Archivo, system-ui, sans-serif';
    const step = hi > 30 ? 10 : 5;
    for (let v = 0; v <= hi; v += step) { x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(X(v), 6, 1, h - 30); x.fillStyle = 'rgba(255,255,255,.5)'; x.fillText(String(v), X(v) - 4, h - 8); }
    ORDER.forEach((k, i) => {
      const y = 22 + i * ((h - 40) / 4); x.fillStyle = COLS[k]; x.fillText(NAMES[k].replace(' (non-AI)', ''), 0, y + 4);
      x.globalAlpha = .6; P[k].per_run_turnaways.forEach((v, j) => { x.beginPath(); x.arc(X(v), y + ((j * 7) % 13) - 6, 3, 0, 7); x.fill(); }); x.globalAlpha = 1;
      x.fillRect(X(P[k].turnaways_per_100) - 1.5, y - 12, 3, 24);
    });
  }
  RC.api('/api/benchmark').then(b => { if (b.state === 'running') poll(); else render(b); }).catch(() => { });

  // ---------- evidence ----------
  RC.on('world', W => { const s = $('#evHos'), v = s.value; s.innerHTML = '<option value="">All</option>' + W.hospitals.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join(''); s.value = v; loadEvidence(); loadRuns(); });
  async function loadEvidence() {
    const tb = $('#evTable tbody');
    try {
      const q = new URLSearchParams({ limit: 300 }); if ($('#evHos').value) q.set('hospital', $('#evHos').value); if ($('#evType').value) q.set('type', $('#evType').value);
      const r = await RC.api('/api/evidence?' + q);
      $('#evCount').textContent = `${r.matched} of ${r.total} observations this run${r.matched > r.rows.length ? ` (latest ${r.rows.length} shown)` : ''}`;
      tb.innerHTML = r.rows.length ? r.rows.map(e => `<tr><td>${RC.fmtClock(e.t)}</td><td>${esc(RC.hname(e.hospital))}</td><td><span class="tag ${e.type === 'turn_away' || e.type === 'call_no' ? 'red' : e.type === 'call_busy' || e.type === 'escalation' ? 'amber' : e.type === 'call_yes' ? 'green' : 'unknown'}">${e.type.replace('_', ' ')}</span></td><td class="n">${e.value == null ? '' : e.value + ' min'}</td><td class="n">${e.amb ?? ''}</td><td>${esc(e.note)}</td></tr>`).join('')
        : `<tr><td colspan="6">${r.total ? 'Nothing matches these filters.' : 'No evidence yet. Press play (top right).'}</td></tr>`;
    } catch (e) { tb.innerHTML = `<tr><td colspan="6"><span class="err">${esc(e.message)}</span></td></tr>`; }
  }
  $('#evRefresh').onclick = loadEvidence; $('#evHos').onchange = loadEvidence; $('#evType').onchange = loadEvidence;
  setInterval(() => { if (RC.S && !RC.S.paused && !document.hidden) loadEvidence(); }, 4000);
  async function loadRuns() {
    try {
      const rs = await RC.api('/api/runs');
      $('#runs').innerHTML = rs.length ? rs.map(r => `<div class="runc glass"><b>Run ${r.id}</b> · city ${r.seed} · ${Math.round(r.sim_minutes)} sim min<br>Today's way: ${r.summary.nearest.turnaways} turned away, ${r.summary.nearest.mean ?? '–'} min avg<br><span class="cy">RightCall: ${r.summary.ours.turnaways} turned away, ${r.summary.ours.mean ?? '–'} min avg, ${r.summary.ours.calls} calls</span></div>`).join('')
        : '<p class="empty">No finished runs yet. A run is saved each time the city is reset on the Live page.</p>';
    } catch { $('#runs').innerHTML = '<p class="err">Could not load run history.</p>'; }
  }
})();
