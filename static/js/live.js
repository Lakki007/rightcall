/* Live page: two lanes of the same city, judge controls, report portal, decisions, confirm-call dialog, guided demo. */
(function () {
  const RC = window.RC, $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = RC.esc, fail = e => RC.toast(e.message, 'bad');
  let pickedNode = null, picking = false, showTruth = false, lastDec = -1, tick = 0;

  // ---------- maps ----------
  const onSelect = id => RC.select(id === RC.selected ? null : id);
  const onPick = n => { pickedNode = n; setPick(false); RC.toast('Location set. Now press “Triage + dispatch”.', 'good'); };
  const views = [new MapView($('#mapBase'), 'nearest', { onSelect, onPick }), new MapView($('#mapOurs'), 'ours', { onSelect, onPick })];
  MapView.loop(() => views);
  const syncViews = () => views.forEach(v => { v.showTruth = showTruth; v.picking = picking; v.pickedNode = pickedNode; v.c.style.cursor = picking ? 'crosshair' : 'pointer'; });

  // ---------- selection + chaos ----------
  RC.on('select', id => {
    const on = id != null && RC.W;
    for (const b of ['#surgeBtn', '#closeBtn', '#restoreBtn']) $(b).disabled = !on;
    $('#selHint').innerHTML = on ? `Selected <b style="color:#fff">${esc(RC.hname(id))}</b> · ${RC.W.hospitals[id].bays} bays · ${RC.W.hospitals[id].caps.join(', ')}` : 'Select a hospital on either map, or in the Hospitals tab.';
    renderHospitals();
  });
  RC.on('world', () => RC.select(RC.selected != null && RC.selected < RC.W.hospitals.length ? RC.selected : null));
  const chaos = async (type, extra = {}) => { try { await RC.api('/api/chaos', { type, hospital: RC.selected, ...extra }); return true; } catch (e) { fail(e); return false; } };
  $('#surgeBtn').onclick = async () => { if (await chaos('surge')) RC.toast(`${RC.hname(RC.selected)} is flooded with walk-ins (×5). RightCall has not been told.`); };
  $('#closeBtn').onclick = async () => { if (await chaos('close')) RC.toast(`${RC.hname(RC.selected)} stopped accepting ambulances. Its public status still says open. RightCall has not been told.`); };
  $('#restoreBtn').onclick = async () => { if (await chaos('restore')) RC.toast(`${RC.hname(RC.selected)} is back to normal.`, 'good'); };
  $('#breakBtn').onclick = async () => { try { const s = await RC.api('/api/chaos', { type: 'breakdown' }); const log = s.lanes.ours.dispatch_log.at(-1); RC.toast(log ? log.reason : 'An ambulance broke down.'); } catch (e) { fail(e); } };
  $('#rainChk').onchange = e => chaos('rain', { on: e.target.checked });
  $('#dropChk').onchange = e => chaos('dropgo', { on: e.target.checked });
  $('#manualChk').onchange = e => chaos('manual', { on: e.target.checked });
  $('#truthChk').onchange = e => { showTruth = e.target.checked; syncViews(); renderHospitals(); };
  $('#liveRainBtn').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Asking Open-Meteo…';
    try { const r = await RC.api('/api/weather/live', {}, { timeout: 12000 }); RC.toast(`Live Hyderabad precipitation ${r.precipitation_mm} mm → road factor ${r.rain_factor}× (${r.source}).`, 'good'); } catch (err) { fail(err); }
    b.disabled = false; b.textContent = 'Use live Hyderabad rain';
  };

  // ---------- controls ----------
  $('#playBtn').onclick = () => RC.api('/api/control', { action: RC.S && !RC.S.paused ? 'pause' : 'play' }).catch(fail);
  $$('#speedSeg button').forEach(b => b.onclick = () => RC.api('/api/control', { action: 'speed', speed: +b.dataset.v }).catch(fail));
  async function reset(seed) {
    const v = seed ?? +$('#seedInp').value;
    if (!Number.isInteger(v) || v < 1 || v > 99999) { RC.toast('City number must be a whole number from 1 to 99999.', 'bad'); return false; }
    try {
      await RC.api('/api/control', { action: 'reset', seed: v });
      views.forEach(m => Object.assign(m, { pos: {}, trail: {}, bursts: [] })); pickedNode = null; syncViews(); RC.select(null); lastDec = -1;
      RC.toast(`City ${v} ready. It starts warm: 40 simulated minutes already played, so the fleet has some evidence.`, 'good'); return true;
    } catch (e) { fail(e); return false; }
  }
  $('#resetBtn').onclick = () => { RC.demo.set(null); $('#caption').hidden = true; reset(); };
  $('#seedInp').addEventListener('keydown', e => { if (e.key === 'Enter') $('#resetBtn').click(); });

  function metric(el, m, other, ours) {
    const d = (a, b) => (a == null || b == null || !ours || a === b) ? '' : `<small class="${a < b ? 'better' : 'worse'}">${a < b ? '−' : '+'}${Math.abs(a - b).toFixed(a % 1 || b % 1 ? 1 : 0)} vs today</small>`;
    el.innerHTML = `<div><dt>Turned away at the door</dt><dd>${m.turnaways}${d(m.turnaways, other.turnaways)}</dd></div><div><dt>Avg pickup → bed</dt><dd>${m.mean ?? '–'}<small>min</small>${d(m.mean, other.mean)}</dd></div><div><dt>Phone calls made</dt><dd>${m.calls}</dd></div><div><dt>Patients in a bed</dt><dd>${m.transports}</dd></div>`;
  }
  RC.on('state', s => {
    $('#clock').textContent = RC.fmtClock(s.t);
    const pb = $('#playBtn'); pb.textContent = s.paused ? '▶ Play' : '❚❚ Pause'; pb.setAttribute('aria-pressed', String(!s.paused));
    $$('#speedSeg button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v === s.speed)));
    if (document.activeElement !== $('#seedInp')) $('#seedInp').value = s.seed;
    $('#rainChk').checked = s.rain > 1; $('#dropChk').checked = s.dropgo; $('#manualChk').checked = s.manual;
    const a = s.lanes.nearest.metrics, b = s.lanes.ours.metrics; metric($('#mBase'), a, b, false); metric($('#mOurs'), b, a, true);
    const decs = s.lanes.ours.decisions, top = decs.length ? decs[decs.length - 1].id : 0; if (top !== lastDec || s.run !== lastRun) { lastDec = top; lastRun = s.run; renderDecisions(); }
    if (!(tick++ % 5)) { renderHospitals(); renderQueue(); }
    callDialog(s.lanes.ours.pending_call); demoStep();
  });
  let lastRun = null;

  // ---------- panels ----------
  $$('.tabs button').forEach(b => b.onclick = () => { $$('.tabs button').forEach(o => o.setAttribute('aria-selected', String(o === b))); for (const t of ['dec', 'hos', 'que']) $('#tab-' + t).hidden = t !== b.dataset.tab; });
  function renderDecisions() {
    const S = RC.S, el = $('#tab-dec'), ds = S.lanes.ours.decisions.slice().reverse();
    if (!ds.length) { el.innerHTML = `<p class="empty">No decisions yet. ${S.paused ? 'Press Play to start the city.' : 'Waiting for the next patient pickup.'}</p>`; return; }
    const open = new Set($$('details[open]', el).map(d => d.dataset.id));
    el.innerHTML = ds.map(d => `<article class="dec ${d.reroute ? 'rr' : ''}"><div class="top"><span>${RC.fmtClock(d.t)}</span><span class="tag ${d.severity}">${d.severity}</span><span>${d.kind} · ambulance ${d.amb}</span>${d.reroute ? '<span class="tag cy">re-routed en route</span>' : ''}${d.calls.map(c => `<span class="tag ${c.answer}">☎ ${esc(RC.hname(c.hospital).split(' ')[0])}: ${c.answer}</span>`).join('')}<a class="tag" href="/replay?incident=${d.incident}" style="text-decoration:none">replay →</a></div><p>${esc(d.reason)}</p>
    <details data-id="${d.id}" ${open.has(String(d.id)) ? 'open' : ''}><summary>The ranking behind this</summary><table><tr><th>Hospital</th><th>drive</th><th>est. wait</th><th>risk</th><th>score</th><th>evidence</th></tr>${d.ranked.map(r => `<tr class="${r.hospital === d.chosen ? 'ch' : ''}"><td>${esc(RC.hname(r.hospital))}${r.hospital === d.nearest ? ' (nearest)' : ''}</td><td>${r.travel}</td><td>${r.wait}</td><td>${r.risk}</td><td>${r.score}</td><td>${r.n < .15 && !r.parked ? 'unknown' : 'n=' + r.n}</td></tr>`).join('')}</table><p class="fine">score = drive + estimated wait + 40 × turn-away risk (minutes). Lower is better.</p></details></article>`).join('');
  }
  function renderHospitals() {
    const S = RC.S, W = RC.W; if (!S || !W) return;
    const el = $('#tab-hos'), nc = S.lanes.ours.nowcast, tr = S.lanes.ours.truth;
    if (el.children.length !== W.hospitals.length || el.dataset.seed !== String(W.seed)) {      // build once per city; afterwards update in place so clicks never land on a detached node
      el.dataset.seed = W.seed;
      el.innerHTML = W.hospitals.map(h => `<button class="hcard" type="button" data-hid="${h.id}" aria-pressed="false"><b>${esc(h.name)}</b><span class="tag"></span><small>${h.caps.join(' · ')} · ${h.bays} bays</small><small class="ev"></small><small class="tru" style="color:#fff"></small></button>`).join('');
      $$('.hcard', el).forEach(b => b.onclick = () => onSelect(+b.dataset.hid));
    }
    const set = (node, prop, v) => { if (node[prop] !== v) node[prop] = v; };
    W.hospitals.forEach(h => {
      const n = nc[h.id], b = el.children[h.id], tag = b.querySelector('.tag');
      set(b, 'ariaPressed', String(RC.selected === h.id)); b.setAttribute('aria-pressed', String(RC.selected === h.id));
      set(tag, 'className', 'tag ' + n.level); set(tag, 'textContent', n.level === 'unknown' ? 'unknown' : n.level === 'red' ? 'choking' : n.level === 'amber' ? 'building' : 'short wait');
      set(b.querySelector('.ev'), 'textContent', n.level === 'unknown' ? 'No recent fleet evidence. Shown as unknown, not as free.' : `Est. wait ${n.wait} min · ${n.parked} parked${n.parked ? ` (longest ${n.parked_max} min)` : ''}${n.last_turnaway != null ? ` · refused a crew ${n.last_turnaway} min ago` : ''} · evidence weight ${n.n}`);
      const t = b.querySelector('.tru'); t.hidden = !showTruth;
      if (showTruth) set(t, 'textContent', `Hidden truth: ${tr[h.id].queue} waiting for a bed${S.closed.includes(h.id) ? ' · NOT ACCEPTING' : ''}${S.surge.includes(h.id) ? ` · walk-ins ×${S.surge_mult[h.id]}` : ''}`);
    });
  }
  function renderQueue() {
    const q = RC.S.lanes.ours.waiting, el = $('#tab-que');
    const log = RC.S.lanes.ours.dispatch_log || [], m = RC.S.lanes.ours.metrics;
    el.innerHTML = (q.length ? q.map(i => `<div class="qrow"><span class="tag ${i.severity}">${i.severity}</span><span>${i.kind}</span><span class="fine">waiting ${i.since} min for an ambulance${i.source === 'report' ? ' · from your report' : ''}</span></div>`).join('') : '<p class="empty">No one is waiting for an ambulance. When the fleet is stretched, the sickest patient is always served first.</p>')
      + `<h4 class="kicker" style="margin:16px 0 8px">Dispatch changes · ${m.reassignments} reassigned · ${m.breakdowns} breakdowns</h4>`
      + (log.length ? log.slice().reverse().map(d => `<div class="qrow"><span class="tag ${d.type === 'breakdown' ? 'red' : 'cy'}">${d.type === 'breakdown' ? 'breakdown' : 'reassigned'}</span><span class="fine">${RC.fmtClock(d.t)} · ${esc(d.reason)}</span></div>`).join('') : '<p class="empty">None yet. Press "Break down an ambulance" to test it.</p>');
  }
  function callDialog(pc) {
    const d = $('#callDlg'); if (!pc) { if (d.open) d.close(); return; }
    $('#callTitle').textContent = RC.hname(pc.hospital); $('#callBody').textContent = `Ambulance ${pc.amb} asks: “Can you take a ${pc.kind} patient in about ${Math.round(pc.eta)} minutes?”`;
    $('#callFine').textContent = `The city is paused while the phone rings. If no one answers, it auto-answers in ${pc.seconds_left}s with the simulated hospital's real state (“${pc.truth_hint}”).`;
    if (!d.open) d.showModal();
  }
  $$('#callDlg [data-ans]').forEach(b => b.onclick = () => RC.api('/api/call/answer', { answer: b.dataset.ans }).catch(fail));
  $('#callDlg').addEventListener('cancel', e => e.preventDefault());
  $('#autoAns').onclick = () => RC.api('/api/chaos', { type: 'manual', on: false }).then(() => RC.toast('Confirm calls are answered automatically again, from each hospital\'s real state.', 'good')).catch(fail);

  // ---------- report portal ----------
  const EX = [['Telugu-English · cardiac', 'Ameerpet lo maa nanna ki gunde noppi, oopiri adatam ledu, please fast'], ['Hindi-English · crash, 3 hurt', 'Uppal ke paas lorry ne takkar maari, 3 log injured, bahut khoon beh raha hai'], ['English · routine', 'My mother has mild fever since two days, need to go to hospital from Kukatpally'],
    ['Bus crash, 12 hurt (capped)', 'bus accident at Mehdipatnam, 12 people injured, bleeding'], ['Not an emergency', 'hello what is the cricket score today'], ['No location', 'my friend fell from stairs leg fracture'], ['Telugu script', 'అమీర్‌పేట్‌లో గుండె నొప్పి'], ['Negation: no chest pain', 'no chest pain, just a routine checkup at Ameerpet'], ['Red flag: not moving', 'my mother fell down at home in Kukatpally, she is not moving']];
  $('#examples').innerHTML = EX.map((e, i) => `<button type="button" data-i="${i}">${e[0]}</button>`).join('');
  $$('#examples button').forEach(b => b.onclick = () => { $('#repText').value = EX[b.dataset.i][1]; $('#repText').focus(); });
  function setPick(on) { picking = on; syncViews(); $('#pickBtn').setAttribute('aria-pressed', String(on)); $('#pickBtn').textContent = on ? 'Click a spot on either map…' : pickedNode != null ? 'Location picked ✓ (change)' : 'Pick location on map'; }
  $('#pickBtn').onclick = () => { setPick(!picking); if (picking) $('#mapOurs').scrollIntoView({ block: 'center', behavior: RC.reduce ? 'auto' : 'smooth' }); };
  async function sendReport(dry, force = false) {
    const out = $('#repOut'), text = $('#repText').value; out.innerHTML = '<p class="empty">Analysing…</p>'; $('#analyseBtn').disabled = $('#dispatchBtn').disabled = true;
    try {
      const r = await RC.api('/api/reports', { text, node: pickedNode, dry_run: dry, force });
      const loc = r.node == null ? '<span class="fine">not found: name an area or pick on the map</span>' : pickedNode != null ? 'picked on the map' : esc(r.area) + (r.areas_found.length > 1 ? ` <span class="fine">(also mentioned: ${r.areas_found.filter(a => a !== r.area).map(esc).join(', ')}; the first one named is used)</span>` : '');
      out.innerHTML = `<dl class="kv"><dt>Condition</dt><dd>${r.kind}${r.matched.length ? ` <span class="fine">(matched: ${r.matched.map(esc).join(', ')})</span>` : ''}</dd><dt>Severity</dt><dd><span class="tag ${r.severity}">${r.severity}</span> <span class="fine">model confidence ${r.confidence}${r.red_flags && r.red_flags.length ? ` · red flag “${esc(r.red_flags[0])}”: always critical` : r.floored ? ' · raised from routine: injuries and chest pain are never routine' : ''}${r.negated ? ' · negated words ignored' : ''}</span></dd><dt>Patients</dt><dd>${r.patients}${r.vulnerable.length ? ' · vulnerable: ' + r.vulnerable.map(esc).join(', ') : ''}</dd><dt>Location</dt><dd>${loc}</dd><dt>Extractor</dt><dd class="fine">${esc(r.source)} · LLM: ${esc(r.llm_status)}</dd></dl>${r.created ? `<p class="ok">Dispatched as incident${r.incident_ids.length > 1 ? 's' : ''} ${r.incident_ids.join(', ')} in both cities.${r.capped ? ` ${r.patients} patients reported; this prototype dispatches at most 6 ambulances per report and flags the rest as a mass-casualty call.` : ''} Watch the maps, then <a href="/replay?incident=${r.incident_ids[0]}">replay it</a> once it finishes.</p>` : '<p class="fine">Analysis only. Nothing was dispatched.</p>'}`;
      if (r.created) { pickedNode = null; setPick(false); if (RC.S.paused) RC.toast('Incident queued. Press Play to see it handled.'); }
    } catch (e) {
      out.innerHTML = `<p class="err">${esc(e.message)}</p>${e.status === 409 ? '<button class="btn xs" type="button" id="forceBtn" style="margin-top:8px">Dispatch anyway: it is a different patient</button>' : ''}`;
      if (e.status === 409) $('#forceBtn').onclick = () => sendReport(false, true);
    }
    $('#analyseBtn').disabled = $('#dispatchBtn').disabled = false;
  }
  $('#analyseBtn').onclick = () => sendReport(true); $('#dispatchBtn').onclick = () => sendReport(false);
  RC.api('/api/triage/info').then(t => { $('#triInfo').textContent = `Severity model: ${t.model.model}. Macro-F1 ${t.model.macro_f1}, critical recall ${t.model.critical_recall} on ${t.model.test} ${t.model.data}. LLM extraction: ${t.llm}.`; }).catch(() => { });

  // ---------- guided demo (state survives refresh; ends on the replay page) ----------
  const DEMO = [
    { at: 40, text: 'Two copies of the same city: same emergencies, same roads, same hospitals. Left sends each patient to the nearest hospital. Right ranks hospitals from what ambulances have just seen.' },
    { at: 48, text: 'Now the busiest hospital is secretly overwhelmed and stops taking ambulances. Its public status still says open, and RightCall is not told.', act: async d => { RC.select(d.target); await RC.api('/api/chaos', { type: 'surge', hospital: d.target }); await RC.api('/api/chaos', { type: 'close', hospital: d.target }); } },
    { at: 60, text: 'Left: crews keep driving there and are turned away at the door (red bursts). Right: after the first refusal its tower turns red from fleet evidence alone, and later patients are phoned elsewhere.' },
    { at: 88, text: 'Compare “Turned away at the door” under each map. That is the claim: fewer patients driven to a door that will not open. Average time moves less, and we say so on the Proof page.' },
    { at: 112, text: 'Next: one of those patients, followed through both cities.', end: true },
  ];
  async function demoBegin(d) {
    if (!await reset(10)) { RC.demo.set(null); return; }
    const share = RC.W ? RC.W.default_share : (await RC.api('/api/world')).default_share;
    d.target = share.indexOf(Math.max(...share)); d.i = 0; d.began = true; RC.demo.set(d);
    await RC.api('/api/control', { action: 'speed', speed: 60 }); await RC.api('/api/control', { action: 'play' });
  }
  let demoBusy = false;
  function demoStep() {
    const d = RC.demo.get(); if (!d || !d.began || demoBusy || !RC.S) return;
    const st = DEMO[d.i]; if (!st || RC.S.t < st.at) return;
    const c = $('#caption'); c.hidden = false;
    c.innerHTML = `<b>GUIDED DEMO · STEP ${d.i + 1} OF ${DEMO.length + 1}</b>${esc(st.text)}<div class="row"><button class="btn xs" type="button" id="demoStop">End demo</button></div>`;
    $('#demoStop').onclick = () => { RC.demo.set(null); c.hidden = true; };
    d.i++; RC.demo.set(d); demoBusy = true;
    Promise.resolve(st.act?.(d)).catch(fail).finally(() => { demoBusy = false; });
    if (st.end) { RC.demo.set({ phase: 'replay', target: d.target }); setTimeout(() => RC.go('/replay?best=1'), 4200); }
  }
  $('#demoBtn').onclick = () => { const d = { step: 0 }; RC.demo.set(d); demoBegin(d); };
  const pending = RC.demo.get(); if (pending && pending.step === 0 && !pending.began) demoBegin(pending);
  else if (pending && pending.began && pending.i > 0) { const st = DEMO[pending.i - 1], c = $('#caption'); c.hidden = false;      // refreshed mid-demo: show where we are
    c.innerHTML = `<b>GUIDED DEMO · STEP ${pending.i} OF ${DEMO.length + 1}</b>${esc(st.text)}<div class="row"><button class="btn xs" type="button" id="demoStop">End demo</button></div>`;
    $('#demoStop').onclick = () => { RC.demo.set(null); c.hidden = true; }; }
  if (location.hash === '#report') setTimeout(() => $('#repText').focus(), 400);
})();
