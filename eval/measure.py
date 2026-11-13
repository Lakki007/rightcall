"""Operational measurements against a running server. Usage: python eval/measure.py http://localhost:8001 <server pid>
Conditions are printed with the results; numbers are from whatever machine runs this (here a 2-vCPU cloud container)."""
import json, os, statistics, sys, threading, time, urllib.request
from pathlib import Path
B, PID = sys.argv[1], int(sys.argv[2])
def get(p, body=None):
    t = time.perf_counter(); r = urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body else None, headers={"Content-Type": "application/json"} if body else {}), timeout=30); d = r.read()
    return (time.perf_counter() - t) * 1000, d
def rss(): return int([l for l in open(f"/proc/{PID}/status") if l.startswith("VmRSS")][0].split()[1]) // 1024
def cpu(): f = open(f"/proc/{PID}/stat").read().split(); return (int(f[13]) + int(f[14])) / os.sysconf("SC_CLK_TCK")
out = {"conditions": f"{os.cpu_count()} vCPU container, server and load generator on the same machine, Python {sys.version.split()[0]}"}
get("/api/control", {"action": "reset", "seed": 10}); get("/api/control", {"action": "speed", "speed": 120}); get("/api/control", {"action": "play"})
c0, t0 = cpu(), time.time(); time.sleep(20); out["cpu_percent_playing_120x_no_viewers"] = round(100 * (cpu() - c0) / (time.time() - t0), 1)
out["rss_mb_after_20s_play"] = rss()
lat = {}
for name, p, body in [("state", "/api/state", None), ("world", "/api/world", None), ("rank", "/api/rank?node=40&kind=cardiac", None),
                      ("compare", "/api/compare?limit=200", None), ("evidence", "/api/evidence?limit=300", None), ("health", "/api/health", None),
                      ("report_dry_run", "/api/reports", {"text": "Uppal ke paas lorry ne takkar maari, 3 log injured", "dry_run": True}), ("page_home", "/", None)]:
    n = 20 if body else 40                          # POST /api/reports is rate-limited to 30/min per client
    ms = sorted(get(p, body)[0] for _ in range(n)); lat[name] = dict(p50=round(ms[n // 2], 1), p95=round(ms[int(n * .95) - 1], 1))
out["latency_ms"] = lat
size = len(get("/api/state")[1]); out["state_payload_kb"] = round(size / 1024, 1); out["websocket_kbps_per_viewer"] = round(size * 10 * 8 / 1000, 0)
# concurrency: 30 threads polling state for 15 s
res, stop = [], time.time() + 15
def worker():
    while time.time() < stop:
        try: res.append(get("/api/state")[0])
        except Exception: res.append(None)
th = [threading.Thread(target=worker) for _ in range(30)]; c0 = cpu(); [t.start() for t in th]; [t.join() for t in th]
ok = sorted(x for x in res if x is not None)
out["load_30_polling_clients"] = dict(requests=len(res), errors=len(res) - len(ok), per_s=round(len(res) / 15, 1), p50_ms=round(ok[len(ok) // 2], 1), p95_ms=round(ok[int(.95 * len(ok))], 1))
t = time.time(); get("/api/benchmark", {"runs": 100})
while json.loads(get("/api/benchmark")[1])["state"] == "running": time.sleep(1)
out["benchmark_100_cities_x4_s"] = round(time.time() - t, 1)
out["rss_mb_end"] = rss()
get("/api/control", {"action": "pause"})
static = Path(__file__).resolve().parent.parent / "static"
out["page_weight_kb_home_uncompressed"] = round(sum((static / f).stat().st_size for f in ["index.html", "css/site.css", "js/core.js", "js/map2d.js", "js/world3d.js", "js/home.js", "vendor/three.module.min.js"]) / 1024)
print(json.dumps(out, indent=1)); (Path(__file__).parent / "measure_results.json").write_text(json.dumps(out, indent=1))
