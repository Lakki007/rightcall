# RightCall runbook (release 1.1.0)

## 1. Set up from scratch

```bash
unzip rightcall-1.1.0.zip && cd rightcall
python -m venv .venv && . .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt                         # pinned versions; ~1-2 min
pip install -r requirements-dev.txt                     # test-only extra (httpx2)
python -m unittest discover -s tests                    # expect: Ran 28 tests ... OK
python backend/server.py                                # "RightCall 1.1.0 running at http://localhost:8000"
curl http://localhost:8000/api/health                   # {"ok": true, "version": "1.1.0", ...}
```

Start-up takes about 5 s (the severity model trains at start). The SQLite file is created on first run.

## 2. Environment variables (see `.env.example`; never commit real values)

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | 8000 | Port |
| `HOST` | 127.0.0.1 | `0.0.0.0` lets other devices (judges' phones on the venue Wi-Fi) connect |
| `RIGHTCALL_DB` | `./rightcall.db` | SQLite file: runs, evidence, decisions, settings |
| `RIGHTCALL_CONTROL_KEY` | empty (open) | Set on any shared or public deployment. Everyone can watch; only browsers that opened `/?key=<value>` once can change the city |
| `RIGHTCALL_TRUST_PROXY` | 0 | 1 behind a hosting proxy (Render, nginx) so rate limits see real client addresses |
| `GROQ_API_KEY` | empty | Optional LLM extraction. Not needed |
| `OPEN_METEO_URL` | Open-Meteo Hyderabad | Override or break the weather dependency for testing |

## 3. Deployment options

1. **Venue laptop (primary for judging).** `HOST=0.0.0.0 RIGHTCALL_CONTROL_KEY=<pick one> python backend/server.py`.
   Presenter opens `http://<laptop-ip>:8000/?key=<key>`; judges open `http://<laptop-ip>:8000` and can watch. Give a judge the
   key link if they want to break things themselves.
2. **Docker.** `docker build -t rightcall:1.1.0 . && docker run -p 8000:8000 -e RIGHTCALL_CONTROL_KEY=... -v rc:/data rightcall:1.1.0`
3. **Render (free web service).** Push this folder to a GitHub repo, "New > Blueprint", pick the repo (`render.yaml`), set
   `RIGHTCALL_CONTROL_KEY` in the dashboard. Health check: `/api/health`. The free plan sleeps after inactivity (first request
   ~30-60 s) and resets the SQLite file on redeploy, which is acceptable because all data is simulated.

## 4. Operating

- **Health:** `GET /api/health` returns version, uptime, simulated minute, city, viewers, benchmark state, whether controls are locked.
- **Reset for a demo:** Live page, type `10`, "New city / reset" (or `curl -X POST -H 'content-type: application/json'
  -d '{"action":"reset","seed":10}' localhost:8000/api/control`). Same city number = identical emergencies.
- **Clean slate:** stop the server, delete the SQLite file, start again.
- **After the guided demo:** the hospital it closed stays closed. Restore it on Live or reset the city.
- **Manual calls switch** is remembered across restarts; the call dialog has "Stop asking me".
- **Logs:** the server prints only start-up and errors (log level warning). No secrets are ever printed.

## 5. Recovery

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Port 8000 is already in use" | Old copy still running | Stop it, or `PORT=8080` |
| Red banner "Lost contact" | Server stopped | Restart; pages reconnect by themselves |
| 2D map instead of 3D | No WebGL (driver, remote desktop) | Everything still works; enable hardware acceleration |
| "This shared demo is view-only" | Control key set | Open `/?key=<key>` once in that browser |
| "Too many requests" | More than 30 reports or 240 actions a minute from one client | Wait a minute |
| Fonts look plain | No internet | Layout unaffected |
| Server killed hard (`kill -9`, power loss) | Up to 40 unsaved evidence rows of the current run lost | Restart; city, speed and saved runs are kept |

## 6. Rollback

Releases are versioned zips with SHA-256 checksums (`rightcall-1.1.0.zip`, previous `rightcall-1.0.0.zip`).
Stop the server, unzip the previous release into a new folder, point `RIGHTCALL_DB` at the same file (the schema is unchanged
between 1.0.0 and 1.1.0), start it. On Render: "Manual deploy > previous commit". Verify with `/api/health` (version field).

## 7. Measured operating envelope (2-vCPU cloud container; your laptop will differ)

| Measure | Value |
| --- | --- |
| API latency (state, rank, compare, health, report dry run) | p50 1.4-3.1 ms, p95 under 5 ms |
| 30 clients polling state continuously | ~295 requests/s, p95 143 ms, 0 errors |
| Live state per update | 12-21 KB JSON, pushed 5 times/s; ~140 kbit/s per viewer compressed (estimate) |
| Server memory | ~185 MB resident |
| 100-city benchmark, 4 policies | 19.5 s |
| Snapshot cost after 50 simulated hours | 1.4 ms (evidence is indexed per hospital) |
| Home page weight | ~780 KB uncompressed, mostly three.js |
| Hosting cost | $0 on a laptop or Render free tier; no paid APIs required (estimate) |
