/* Mechanism page: drop a pickup anywhere, call the real ranking API, show the score breakdown,
   the confirm-call order, and what the same engine picks with fleet evidence removed. */
(function () {
  const RC = window.RC, $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const PRIOR_WAIT = 10;                       // engine.PRIOR_WAIT: what every hospital looks like with no evidence
  let node = null, kind = 'general', last = null, busy = false, err = null;
  try { const v = JSON.parse(sessionStorage.getItem('rc-pick') || 'null'); if (v) { node = v.node; kind = v.kind; } } catch { }

  RC.on('world', W => {
    const sel = $('#areaSel'), keep = sel.value;
    sel.innerHTML = '<option value="">choose an area…</option>' + Object.entries(W.areas).sort().map(([a, n]) => `<option value="${n}">${a.replace(/\b\w/g, c => c.toUpperCase())}</option>`).join('');
    sel.value = keep; if (node != null && node >= W.nodes.length) node = null;
    if (node != null) rank();
  });
  $('#areaSel').onchange = e => { if (e.target.value !== '') setNode(+e.target.value); };
  $('#randBtn').onclick = () => { if (RC.W) setNode(Math.floor(Math.random() * RC.W.nodes.length)); };
  $$('#kindSeg button').forEach(b => b.onclick = () => { kind = b.dataset.k; $$('#kindSeg button').forEach(o => o.setAttribute('aria-pressed', o === b)); save(); if (node != null) rank(); });
  $$('#kindSeg button').forEach(o => o.setAttribute('aria-pressed', o.dataset.k === kind));
  addEventListener('rc-pickup', e => setNode(e.detail));
  function save() { try { sessionStorage.setItem('rc-pick', JSON.stringify({ node, kind })); } catch { } }
  function setNode(n) { node = n; save(); const opt = [...$('#areaSel').options].find(o => o.value === String(n)); $('#areaSel').value = opt ? opt.value : ''; rank(); }

  async function rank() {
    if (node == null || busy) return; busy = true;
    try { last = await RC.api(`/api/rank?node=${node}&kind=${kind}`, null, { timeout: 6000 }); err = null; }
    catch (e) { err = e.message; }
    busy = false; render();
  }
  // evidence changes as the city runs: refresh the ranking every few seconds while it is playing
  setInterval(() => { if (node != null && RC.S && !RC.S.paused && !document.hidden) rank(); }, 2500);

  function render() {
    const out = $('#rankOut'), W = RC.W;
    $('#pickHint').hidden = node != null;
    if (err) { out.innerHTML = `<p class="err">${RC.esc(err)} <button class="btn xs" type="button" id="retry">Retry</button></p>`; $('#retry').onclick = rank; return; }
    if (!last || !W) return;
    const R = last.ranked, pick = R[0], near = R.find(r => r.hospital === last.nearest), max = Math.max(...R.map(r => r.score), 1);
    const blind = R.slice().sort((a, b) => (a.travel + PRIOR_WAIT) - (b.travel + PRIOR_WAIT))[0];
    const why = pick.hospital === last.nearest
      ? `The nearest hospital is also the best-ranked right now, so RightCall behaves exactly like today's way here. The advantage only appears when the nearest one is choking.`
      : `${RC.esc(RC.hname(last.nearest))} is ${near.travel} min away but scores ${near.score}: estimated wait ${near.wait} min${near.parked ? `, ${near.parked} crew${near.parked > 1 ? 's' : ''} parked at the gate` : ''}${near.risk > .05 ? `, turn-away risk ${Math.round(near.risk * 100)}%${near.last_turnaway != null ? ` (refused a crew ${Math.round(near.last_turnaway)} min ago)` : ''}` : ''}. ${RC.esc(RC.hname(pick.hospital))} is ${(pick.travel - near.travel).toFixed(1)} min further to drive and ${(near.score - pick.score).toFixed(1)} min better overall.`;
    out.innerHTML = `
      <div class="pickline"><div><p class="fine">RightCall phones first</p><b>${RC.esc(RC.hname(pick.hospital))}</b></div><span class="tag cy">score ${pick.score}</span></div>
      <p class="small">Nearest by road: <b style="color:#fff">${RC.esc(RC.hname(last.nearest))}</b> · ${near.travel} min${kind !== 'general' ? ` · only hospitals with ${kind} capability are ranked` : ''}</p>
      <div class="bars" style="margin-top:12px" role="table" aria-label="Score breakdown per hospital">
        ${R.map((r, i) => { const unk = r.n < .15 && !r.parked; return `<div class="b ${i ? '' : 'pick'}" role="row"><span class="nm" role="cell">${i + 1}. ${RC.esc(RC.hname(r.hospital))}${r.hospital === last.nearest ? ' <span class="tag amber">nearest</span>' : ''}${unk ? ' <span class="tag unknown">unknown</span>' : ''}</span>
          <span class="track" role="cell" aria-label="drive ${r.travel}, wait ${r.wait}, risk ${Math.round(40 * r.risk)} minutes"><i class="dr" style="width:${r.travel / max * 100}%"></i><i class="wt" style="width:${r.wait / max * 100}%"></i><i class="rk" style="width:${40 * r.risk / max * 100}%"></i></span>
          <span class="sc" role="cell">${r.score}</span></div>`; }).join('')}
      </div>
      <div class="legend"><span><i style="background:#d9d3cc"></i>drive</span><span><i style="background:var(--am)"></i>estimated wait</span><span><i style="background:var(--rd)"></i>40 × turn-away risk</span></div>
      <p class="why">${why}</p>
      <p class="small" style="margin-top:10px">Then the call: if ${RC.esc(RC.hname(pick.hospital))} says no or is busy, ${R[1] ? RC.esc(RC.hname(R[1].hospital)) : 'the next hospital'} is called next. Sim time ${RC.fmtClock(last.t)}${RC.S && !RC.S.paused ? ' · updating as the fleet reports' : ' · city paused'}.</p>
      <div class="ablate"><b>Remove the fleet evidence</b> and every hospital looks the same (${PRIOR_WAIT} min wait, no risk), so the same engine would phone <b>${RC.esc(RC.hname(blind.hospital))}</b>${blind.hospital === pick.hospital ? ', the same choice' : `, ${blind.hospital === last.nearest ? 'the nearest' : 'by drive time alone'}`}. ${blind.hospital === pick.hospital ? 'Here the evidence does not change the call.' : 'This is the difference the mechanism makes for this patient, right now.'} <a href="/proof">Measured over 100 cities →</a></div>`;
    window.World.setPickup(node, R, last.nearest);
  }
  RC.on('state', () => { if (!last && node != null && !busy) rank(); });

  // 3D labels: est. wait on every tower; rank + score for the hospitals in play
  window.World.setLabels(() => {
    const S = RC.S, W = RC.W; if (!S || !W || !last || node == null) return [];
    const nc = S.lanes.ours.nowcast, show = last.ranked.slice(0, 3); const nr = last.ranked.find(r => r.hospital === last.nearest);
    if (nr && !show.includes(nr)) show.push(nr);
    return show.map(r => { const i = last.ranked.indexOf(r), n = nc[r.hospital];
      return { key: 'h' + r.hospital, at: { tower: r.hospital }, cls: i === 0 ? 'cy' : n.level === 'red' ? 'red' : '',
        html: `<b>${i === 0 ? 'Call first' : '#' + (i + 1)} · ${r.score}</b><small>${RC.esc(RC.hname(r.hospital))}${r.hospital === last.nearest ? ' · nearest' : ''}</small>` }; })
;
  });
  $$('.sig').forEach(s => { const on = () => { $$('.sig').forEach(o => o.classList.toggle('on', o === s)); window.World.highlight(s.dataset.hl); }, off = () => { s.classList.remove('on'); window.World.highlight(null); };
    s.addEventListener('mouseenter', on); s.addEventListener('focus', on); s.addEventListener('mouseleave', off); s.addEventListener('blur', off); });
  addEventListener('rc-2d-ready', () => { if (last) render(); });
})();
