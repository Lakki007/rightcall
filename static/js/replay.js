/* Replay page: /api/compare rows, both journeys as timelines + 3D arcs, and the exact ranking RightCall used. */
(function () {
  const RC = window.RC, $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)], esc = RC.esc;
  const qs = new URLSearchParams(location.search);
  let filter = 'differ', data = null, sel = qs.has('incident') ? +qs.get('incident') : null, wantBest = qs.has('best'), lastRun = null, err = null;
  if (sel != null && !Number.isInteger(sel)) sel = null;
  if (sel != null) filter = 'all';
  $$('#filt button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.f === filter)); b.onclick = () => { filter = b.dataset.f; $$('#filt button').forEach(o => o.setAttribute('aria-pressed', String(o === b))); load(); }; });

  async function load() {
    try { data = await RC.api(`/api/compare?limit=200&only=${filter}`, null, { timeout: 8000 }); err = null; }
    catch (e) { err = e.message; }
    if (data && wantBest && data.rows.length) { sel = data.rows[0].incident; wantBest = false; }
    render();
  }
  RC.on('state', s => { if (s.run !== lastRun) { const first = lastRun == null; lastRun = s.run; if (!first) { sel = null; } load(); } });
  setInterval(() => { if (RC.S && !RC.S.paused && !document.hidden) load(); }, 5000);

  const nm = id => RC.W ? RC.hname(id) : 'Hospital ' + id;
  function render() {
    if (err) { $('#list').innerHTML = `<p class="err">${esc(err)} <button class="btn xs" type="button" id="retry">Retry</button></p>`; $('#retry').onclick = load; return; }
    if (!data || !RC.W) return;
    const s = data.summary;
    $('#sum').innerHTML = s.patients ? `
      <div><b>${s.patients}</b><span>patients finished in both cities</span></div>
      <div><b class="rd">${s.turnaways_today}</b><span>turned away at the door, today's way</span></div>
      <div><b class="cy">${s.turnaways_ours}</b><span>turned away with RightCall</span></div>
      <div><b>${s.ours_faster} / ${s.ours_slower} / ${s.same}</b><span>RightCall faster / slower / same (±0.5 min)</span></div>
      <div><b>${s.mean_delta > 0 ? '−' : s.mean_delta < 0 ? '+' : ''}${Math.abs(s.mean_delta).toFixed(1)} min</b><span>average change in pickup → bed time with RightCall</span></div>`
      : `<p class="empty">No patient has finished in both cities yet. ${RC.S?.paused ? 'Press play (top right) and wait a few seconds.' : 'Give it a few seconds.'}</p>`;
    const rows = data.rows, L = $('#list');
    L.innerHTML = rows.length ? rows.map(r => `<button class="pt" type="button" data-id="${r.incident}" aria-pressed="${r.incident === sel}">
        <b>Patient ${r.incident} · ${r.kind}</b><span class="delta ${r.delta > .5 ? 'pos' : r.delta < -.5 ? 'neg' : 'zero'}">${r.delta > .5 ? `${r.delta} min faster` : r.delta < -.5 ? `${-r.delta} min slower` : 'same'}</span>
        <small><span class="tag ${r.severity}">${r.severity}</span> Today: ${r.today.hops} refusal${r.today.hops === 1 ? '' : 's'}, ${r.today.minutes} min · RightCall: ${r.ours.hops}, ${r.ours.minutes} min</small></button>`).join('')
      : `<p class="empty">${s.patients ? 'No patients match this filter yet.' : 'Nothing to replay yet.'}</p>`;
    $$('#list .pt').forEach(b => b.onclick = () => { sel = +b.dataset.id; history.replaceState(null, '', '/replay?incident=' + sel); render(); });
    detail();
  }

  function track(visits, decisions, row, ours) {
    const steps = [`<div class="jstep"><b>Picked up</b> <small>emergency reported at ${RC.fmtClock(row.called)}</small></div>`];
    const calls = ours ? decisions.flatMap(d => d.calls.map(c => ({ ...c, t: d.t, rr: d.reroute }))) : [];
    let ci = 0;
    visits.forEach((v, i) => {
      while (ci < calls.length && calls[ci].t <= v.t) { const c = calls[ci++]; steps.push(`<div class="jstep call">☎ Phoned <b>${esc(nm(c.hospital))}</b>: ${c.answer}${c.rr ? ' (re-route check)' : ''}<small>${RC.fmtClock(c.t)}</small></div>`); }
      steps.push(`<div class="jstep ${v.ok ? 'yes' : 'no'}"><b>${v.ok ? 'Admitted' : 'Turned away'}</b> at ${esc(nm(v.h))}${v.escalated ? ' <span class="tag amber">escalated: every capable hospital had refused, so this one must admit</span>' : ''}<small>arrived ${RC.fmtClock(v.t)}${!v.ok ? ' · patient still on board, crew drives on' : ''}</small></div>`);
    });
    while (ci < calls.length) { const c = calls[ci++]; steps.push(`<div class="jstep call">☎ Phoned <b>${esc(nm(c.hospital))}</b>: ${c.answer}<small>${RC.fmtClock(c.t)}</small></div>`); }
    return steps.join('');
  }
  function detail() {
    const D = $('#detail');
    if (sel == null) { D.innerHTML = '<h2 class="kicker">Journey</h2><p class="empty">Choose a patient on the left.</p>'; window.World.setJourney(null); return; }
    const row = data.rows.find(r => r.incident === sel);
    if (!row) {
      D.innerHTML = `<h2 class="kicker">Journey</h2><p class="empty">Patient ${esc(sel)} is not in this list. Either they have not reached a bed in both cities yet (check back in a few seconds), they belong to an earlier city, or the filter hides them.</p><button class="btn xs" type="button" id="showAll">Show all patients</button>`;
      $('#showAll').onclick = () => $('#filt button[data-f=all]').click(); window.World.setJourney(null); return;
    }
    const first = row.ours.decisions[0];
    D.innerHTML = `<h2 class="kicker">Journey · patient ${row.incident}</h2>
      <p class="small" style="margin-top:6px"><span class="tag ${row.severity}">${row.severity}</span> ${row.kind} · same pickup point, same moment, both cities</p>
      <div class="journey today"><h4>TODAY'S WAY <b>${row.today.minutes} min</b></h4><div class="jtrack">${track(row.today.visits, [], row, false)}</div></div>
      <div class="journey ours"><h4 style="color:var(--cy)">RIGHTCALL <b>${row.ours.minutes} min</b></h4><div class="jtrack">${track(row.ours.visits, row.ours.decisions, row, true)}</div></div>
      ${first ? `<div class="knew"><b>What RightCall knew when it chose</b> <span class="fine">(fleet evidence only, at ${RC.fmtClock(first.t)})</span><p style="margin-top:6px">${esc(first.reason)}</p>
        <table><tr><th>Hospital</th><th>drive</th><th>est. wait</th><th>risk</th><th>score</th></tr>${first.ranked.map(r => `<tr class="${r.hospital === first.chosen ? 'ch' : ''}"><td>${esc(nm(r.hospital))}${r.hospital === first.nearest ? ' (nearest)' : ''}</td><td>${r.travel}</td><td>${r.wait}</td><td>${r.risk}</td><td>${r.score}</td></tr>`).join('')}</table></div>` : ''}
      <p class="fine" style="margin-top:12px">${row.delta > .5 ? `RightCall saved this patient ${row.delta} minutes.` : row.delta < -.5 ? `RightCall was ${-row.delta} minutes slower for this patient. It happens: a further hospital or a busy confirm call can cost time. We show these cases too.` : 'Same outcome in both cities.'}</p>`;
    window.World.setJourney(row);
  }
  window.World.setLabels(() => {
    if (!data || sel == null || !RC.W) return [];
    const row = data.rows.find(r => r.incident === sel); if (!row) return [];
    const L = [{ key: 'p', at: { node: row.node, dy: 1.4 }, html: `<b>Pickup</b><small>patient ${row.incident}</small>` }];
    const seen = new Map();
    row.today.visits.forEach(v => { if (!v.ok) seen.set(v.h, { key: 't' + v.h, at: { tower: v.h, dy: 1.6 }, cls: 'red', html: `<b>✕ refused</b><small>${esc(nm(v.h))} · today</small>` }); });
    row.ours.visits.forEach(v => seen.set(v.h, { key: 'o' + v.h, at: { tower: v.h, dy: 2.4 }, cls: v.ok ? 'cy' : 'red', html: `<b>${v.ok ? '✓ RightCall' : '✕ refused'}</b><small>${esc(nm(v.h))}</small>` }));
    const tEnd = row.today.visits.at(-1); if (tEnd && tEnd.ok && !seen.has(tEnd.h)) seen.set(tEnd.h, { key: 'te' + tEnd.h, at: { tower: tEnd.h, dy: 1.6 }, html: `<b>✓ today</b><small>${esc(nm(tEnd.h))}</small>` });
    return L.concat([...seen.values()]);
  });
  RC.on('world', () => render());

  const d = RC.demo.get();
  if (d && d.phase === 'replay') {
    const c = $('#caption'); c.hidden = false;
    c.innerHTML = `<b>GUIDED DEMO · STEP 6 OF 6</b>One patient from that run. Faint red arcs: today's way, a cross at each door that refused. Cyan: RightCall's trip. The table is exactly what it knew when it chose. That is the whole idea.<div class="row"><a class="btn xs white" href="/mechanism">Try it yourself</a><a class="btn xs" href="/proof">See 100 cities</a><button class="btn xs" type="button" id="demoEnd">Close</button></div>`;
    RC.demo.set(null); $('#demoEnd').onclick = () => c.hidden = true;
  }
})();
