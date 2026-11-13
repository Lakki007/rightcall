/* Limits page: the tested edge cases, each with a "try it" link. */
(function () {
  const E = [
    ['An ambulance breaks down', 'The same ambulance fails in both cities for 60 min. Its patient goes back to the queue, and a sicker patient can take an ambulance that is driving to a minor call. Every change is explained under Waiting & dispatch.', '/live'],
    ['"no chest pain, just a checkup"', 'Negated words are ignored, so it is routine and not cardiac. Phrases that are negations by meaning ("not breathing", "saans nahi") are kept as red flags and are always critical.', '/live#report'],
    ['A shared, public link', 'With a control key set, everyone can watch but only browsers that opened the control link can change the city. Other attempts get a clear "view-only" message.', ''],
    ['Every hospital refuses', 'Close all eight on Live. Crews stop circling: once every capable hospital has refused a patient, the next one must admit (logged as "escalation"). Restore and the city recovers.', '/live'],
    ['The same emergency reported twice', 'Send the same report again within 15 sim minutes. It is held as a likely duplicate, with a "Dispatch anyway" button for a genuinely different patient.', '/live#report'],
    ['Telugu or Devanagari script', 'Typed in native script, the report is not guessed at: you are asked to use Roman letters.', '/live#report'],
    ['A bus crash with 12 hurt', 'At most 6 ambulances per report; the rest is flagged as a mass-casualty call instead of emptying the fleet.', '/live#report'],
    ['Two areas in one report', 'The first area named is used, and the others are shown so the dispatcher can correct it.', '/live#report'],
    ['No location given', 'Not dispatched. It asks for an area name or a point on the map.', '/live#report'],
    ['Not an emergency at all', '"what is the cricket score" is refused, not classified.', '/live#report'],
    ['An injury the model calls routine', 'Chest pain and injuries are raised to at least urgent, and the screen says so.', '/live#report'],
    ['A hospital nobody has visited lately', 'Shown as unknown (grey), assumed average, never free. The confirm call decides.', '/mechanism'],
    ['Drop-and-go crews', 'Crews leave after 15 minutes, hiding the wait signal. Turn-aways still fall, by less.', '/proof'],
    ['Heavy rain', 'Every road slows. Rankings shift because drive times change, not because of any rule about rain.', '/'],
    ['Surge at every hospital', 'Little room to choose: the advantage shrinks, and we show it shrinking.', '/live'],
    ['Nobody answers the confirm call', 'With manual calls on, the call auto-answers after 20 seconds with the hospital\'s true state.', '/live'],
    ['Benchmark started twice, or page refreshed mid-run', 'The second start is refused; a refreshed page reattaches to the running job.', '/proof'],
    ['Server stopped', 'A banner says so, the status dot turns red, and the page reconnects by itself.', ''],
    ['Slow server', 'Requests give up after 10 seconds with a plain message. Nothing changes on screen.', ''],
    ['Weather service down', 'Reported as an error. The rain setting is left unchanged, never faked.', '/live'],
    ['Bad LLM key', 'The extractor status says it failed and the local extractor is used.', '/live#report'],
    ['No WebGL', 'Every page falls back to a 2D map with the same data. Try any page with ?no3d=1.', '/mechanism?no3d=1'],
    ['Reduced motion', 'With the OS setting on, there is no warp, no spin, no pulsing.', ''],
    ['A wrong URL', 'A real 404 page, not a blank screen.', '/nowhere'],
    ['Replay link to an unfinished patient', 'Explains that the patient has not reached a bed in both cities yet.', '/replay?incident=99999'],
    ['Two tabs open', 'Both show the same city: there is one simulation on the server.', ''],
    ['Back and forward buttons', 'Pages rebuild cleanly instead of showing a frozen 3D scene.', ''],
    ['Same city number twice', 'Resetting to the same city replays identical emergencies, so results can be reproduced.', '/live'],
  ];
  document.getElementById('edges').innerHTML = E.map(([b, p, h]) => `<div class="edge"><b>${b}</b>${h ? `<a class="tag" href="${h}" style="text-decoration:none">try it →</a>` : '<span></span>'}<p>${p}</p></div>`).join('');
})();
