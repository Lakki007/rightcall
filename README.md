# RightCall: call the right hospital first

Yuktik 2026 · PS10 (Intelligent Real-Time Emergency Coordination). Release **1.1.0**, a working prototype.
**Everything in it is simulated. It is not production-ready and makes no real-world claim.**

RightCall ranks hospitals for an ambulance by drive time + estimated wait + 40 × turn-away risk, where the wait and risk are
estimated only from what the ambulance fleet has just seen (gate waits, crews parked at the gate, refusals). The crew then
confirms the top pick with one phone call. A simulated city runs every emergency twice, once today's way and once with RightCall.

## Run it (2 minutes)

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt                     # Python 3.10-3.13; no GPU, no API key needed
python backend/server.py                            # then open http://localhost:8000
pip install -r requirements-dev.txt && python -m unittest discover -s tests   # optional: 28 tests, ~5 s
```

Port busy? `PORT=8080 python backend/server.py`. Other devices on the network: `HOST=0.0.0.0`. See `RUNBOOK.md` for
deployment, environment variables, reset, rollback and troubleshooting, and `DEMO.md` for the judge demonstration.

## The site: six pages in one 3D world

| Page | What it answers | Try |
| --- | --- | --- |
| `/` Overview | What is this? | Drag the city, click a tower, Guided demo |
| `/mechanism` | How does it decide? | Click the city to drop a patient; compare with "evidence removed" |
| `/live` | Does it beat today's way? | Flood or close a hospital, break down an ambulance, type a report |
| `/replay` | What happened to one patient? | Pick a patient, follow both journeys (`?incident=N` deep links) |
| `/proof` | Is it one lucky city? | Run 20/60/100 held-out cities, 4 policies; evidence log + CSV |
| `/limits` | Where does it break? | Real vs simulated, tested edge cases |

Without WebGL every page falls back to a 2D map (`?no3d=1` to test). With "reduce motion" on, transitions are instant.

## Measured in this build (simulation; held-out cities never used while building or tuning, seeds 9000+)

In-app benchmark, 100 held-out cities (seeds 9000-9099), normal crews:

| Policy | Turned away /100 | Avg pickup->bed | Worst 10% | Calls /patient |
| --- | --- | --- | --- | --- |
| Nearest hospital | 20.6 | 23.2 min | 48.8 min | 0 |
| Phone ahead (non-AI) | 5.7 | 21.3 min | 43.0 min | 1.27 |
| RightCall, fleet evidence removed | 4.9 | 20.7 min | 40.9 min | 1.31 |
| RightCall | 2.1 | 20.4 min | 39.4 min | 1.12 |
| Oracle that sees true queues (ceiling, eval only) | 1.0 | 18.2 min | 34.3 min | - |

200 held-out cities (`eval/robustness.py`), paired 95% bootstrap intervals, RightCall minus baseline:

- vs phone-ahead: **-3.35 turn-aways per 100 patients [-4.06, -2.70]**, **-1.20 min [-1.55, -0.85]** average time.
- vs evidence removed (the ablation): -2.61 per 100 [-3.29, -1.97], -0.56 min [-0.90, -0.23].
- RightCall captures about 75% of the turn-away reduction an all-seeing oracle could get over phone-ahead.

Where it does not help, or hurts (negative controls, same script): in a **quiet city** the gain is not significant
(-0.71 per 100 [-1.47, +0.03]). When **refusals are random and unrelated to load**, turn-aways still fall but average time is
**3.5 min worse** than without evidence. When **hospitals answer the phone wrongly 25% of the time**, turn-aways fall but time is
**1.9 min worse** than phone-ahead. Full table: `eval/robustness_results.json`.

Triage end to end (`eval/end_to_end.py`, busy city, 10 ambulances, incidents arrive as text): critical patients reach a bed in
45.1 min with perfect triage, **48.6 min with our classifier**, 71.9 min with no triage. Classifier on 36 reports written after
the external review (not used to build it): macro-F1 0.88, critical recall 0.93 (14 of 15). Same team wrote them, so optimistic.

Wait-estimator check: a simpler "last observed wait" predicts the next wait better (MAE 7.7 vs 9.0 min), but makes worse
decisions (20.7 vs 20.0 min average, chosen on development cities, confirmed once on held-out). We keep the current estimator.

## Real, simulated, incomplete

- **Real (runs here):** ranking + confirm + re-route; evidence engine and nowcast; dispatch with sickest-first, breakdowns and
  reassignment; severity classifier with negation handling and red-flag floor; benchmark; SQLite log, CSV export; WebSocket view.
- **Simulated:** the city (a stylised grid, not real roads), hospitals, patients, walk-ins, ambulances, phone answers.
- **Not built / unproven:** no real 108 GPS data; no OSM roads or traffic feed; no flood/fire incident types; no hospital
  console; LLM extraction untested with a real key; no vision, GNN or RL (deliberately: they do not address the bottleneck).

## Security and operations (summary; details in RUNBOOK.md)

Binds to 127.0.0.1 by default. Optional `RIGHTCALL_CONTROL_KEY` makes a shared deployment view-only except for browsers that
opened `/?key=...` once. Request bodies capped at 16 KB, per-client rate limits on POSTs, at most 40 live viewers, CSP and
anti-framing headers, no API explorer exposed, `/api/health` for monitoring, dependencies pinned and audited (`pip-audit`: none).

## Files

- `backend/engine.py` - city, hidden truth, lanes, evidence, nowcast, ranking, confirm, re-route, escalation, breakdowns, reassignment
- `backend/triage.py` - extraction with negation masking, severity classifier, red-flag and injury floors (+ optional LLM)
- `backend/server.py` - API, WebSocket, guards, health, benchmark, persistence, exports
- `static/` - six pages + 404, design system, 3D world, 2D maps
- `tests/test_core.py` - 28 regression tests; `eval/` - robustness, end-to-end, estimator and load measurements with results
- `samples/` - example reports, the original and post-review triage test sets
- `Dockerfile`, `render.yaml`, `.env.example` - deployment

Licences of what we reuse: three.js r170 (MIT, bundled), FastAPI (MIT), Uvicorn (BSD-3), scikit-learn (BSD-3),
Open-Meteo data (CC BY 4.0), Archivo (SIL OFL, via Google Fonts).
