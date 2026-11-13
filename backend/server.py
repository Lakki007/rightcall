"""RightCall server: live simulation, decision API, triage, benchmark, persistence.
Run:  python backend/server.py   (then open http://localhost:8000)
"""
from __future__ import annotations
import asyncio, csv, hmac, io, json, os, sqlite3, statistics, sys, threading, time, urllib.request
from collections import defaultdict, deque
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))
from engine import Sim, run_headless, AREAS   # noqa: E402
from triage import Triage                     # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.environ.get("RIGHTCALL_DB", ROOT / "rightcall.db"))
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(loop())
    yield
    task.cancel(); R.finish()

VERSION = "1.1.0"
STARTED = time.time()
CONTROL_KEY = os.environ.get("RIGHTCALL_CONTROL_KEY", "")        # set on a shared/public deployment: only key holders can change the city
TRUST_PROXY = os.environ.get("RIGHTCALL_TRUST_PROXY", "") == "1"  # behind a hosting proxy: use X-Forwarded-For for rate limits
MAX_BODY = 16 * 1024
MAX_WS = 40
LIMITS = {"/api/reports": (30, 60), "/api/benchmark": (6, 60), "*": (240, 60)}   # requests per window (s), per client, POST only
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

app = FastAPI(title="RightCall", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
_hits: dict = defaultdict(deque)


def _client(req: Request) -> str:
    if TRUST_PROXY and req.headers.get("x-forwarded-for"): return req.headers["x-forwarded-for"].split(",")[0].strip()
    return req.client.host if req.client else "?"


def has_control(req: Request) -> bool:
    if not CONTROL_KEY: return True
    k = req.headers.get("x-rightcall-key") or req.cookies.get("rc_key") or ""
    return hmac.compare_digest(k, CONTROL_KEY)


class BodyCap:
    """Pure ASGI: abort any request body over MAX_BODY, including chunked bodies with no Content-Length."""
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http": return await self.app(scope, receive, send)
        seen = 0
        async def rx():
            nonlocal seen
            m = await receive(); seen += len(m.get("body", b""))
            if seen > MAX_BODY: raise HTTPException(413, "Request too large.")
            return m
        try: await self.app(scope, rx, send)
        except HTTPException:
            await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"detail":"Request too large."}'})


@app.middleware("http")
async def guard(req: Request, call_next):
    """Body-size limit, per-client rate limit, optional control key, security headers."""
    if req.method == "GET" and CONTROL_KEY and req.query_params.get("key") is not None:      # /live?key=... grants control in this browser
        ok = hmac.compare_digest(req.query_params["key"], CONTROL_KEY)
        r = RedirectResponse(req.url.path, status_code=303)
        if ok: r.set_cookie("rc_key", CONTROL_KEY, httponly=True, samesite="strict", secure=req.url.scheme == "https", max_age=12 * 3600)
        return r
    if req.method == "POST":
        if int(req.headers.get("content-length") or 0) > MAX_BODY:
            return JSONResponse({"detail": "Request too large."}, status_code=413)
        if req.url.path.startswith("/api/") and not has_control(req):
            return JSONResponse({"detail": "This shared demo is view-only. Ask the RightCall team for the control link."}, status_code=403)
        lim, win = LIMITS.get(req.url.path, LIMITS["*"]); key = (_client(req), req.url.path if req.url.path in LIMITS else "*")
        q = _hits[key]; now = time.time()
        while q and q[0] < now - win: q.popleft()
        if len(q) >= lim: return JSONResponse({"detail": "Too many requests. Wait a minute and try again."}, status_code=429)
        q.append(now)
    resp = await call_next(req)
    resp.headers["X-Content-Type-Options"] = "nosniff"; resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    if resp.headers.get("content-type", "").startswith("text/html"): resp.headers["Content-Security-Policy"] = CSP
    return resp
triage = Triage()


class _Conn(sqlite3.Connection):
    """`with db() as c:` commits AND closes (plain sqlite3 only commits, leaking a handle per request)."""
    def __exit__(self, *a):
        r = super().__exit__(*a); self.close(); return r


def db():
    c = sqlite3.connect(DB, factory=_Conn); c.row_factory = sqlite3.Row
    c.executescript("""
    create table if not exists runs(id integer primary key, seed int, started real, ended real, sim_minutes real, summary text);
    create table if not exists evidence(run int, id int, t real, hospital int, type text, value real, amb int, note text);
    create table if not exists decisions(run int, id int, t real, body text);
    create table if not exists settings(k text primary key, v text);""")
    return c


class Runner:
    def __init__(self):
        self.lock = threading.RLock(); self.clients: set[WebSocket] = set()
        with db() as c: saved = {r["k"]: json.loads(r["v"]) for r in c.execute("select * from settings")}
        self.speed = saved.get("speed", 30); self.manual = saved.get("manual", False)
        self.paused = True; self.acc = 0.0; self.call_deadline = None; self.run_id = None
        self.new(saved.get("seed", 7))

    def save_setting(self, k, v):
        with db() as c: c.execute("insert or replace into settings values(?,?)", (k, json.dumps(v)))

    def new(self, seed):
        with self.lock:
            self.finish()
            self.sim = Sim(seed, ("nearest", "ours"), manual_calls=False)
            while self.sim.t < WARM: self.sim.step(.1)          # warm start: a city already in motion
            self.sim.lanes["ours"].manual = self.manual
            self.flushed_e = self.flushed_d = 0; self.acc = 0.0; self.paused = True; self.call_deadline = None
            with db() as c:
                self.run_id = c.execute("insert into runs(seed, started) values(?,?)", (seed, time.time())).lastrowid
            self.save_setting("seed", seed)

    def finish(self):
        if getattr(self, "sim", None) is None or self.run_id is None: return
        self.flush()
        with db() as c:
            if self.sim.t < WARM + 1: c.execute("delete from runs where id=?", (self.run_id,))
            else: c.execute("update runs set ended=?, sim_minutes=?, summary=? where id=?",
                            (time.time(), self.sim.t, json.dumps({k: l.metrics() for k, l in self.sim.lanes.items()}), self.run_id))

    def flush(self):
        ours = self.sim.lanes["ours"]
        with db() as c:
            for e in ours.evidence[self.flushed_e:]:
                c.execute("insert into evidence values(?,?,?,?,?,?,?,?)", (self.run_id, e["id"], e["t"], e["hospital"], e["type"], e["value"], e["amb"], e["note"]))
            for d in ours.decisions[self.flushed_d:]:
                c.execute("insert into decisions values(?,?,?,?)", (self.run_id, d["id"], d["t"], json.dumps(d)))
        self.flushed_e, self.flushed_d = len(ours.evidence), len(ours.decisions)

    def tick(self, real_dt):
        with self.lock:
            ours = self.sim.lanes["ours"]
            if ours.pending_call:                                   # sim waits for the judge's answer
                if self.call_deadline is None: self.call_deadline = time.time() + 20
                if time.time() > self.call_deadline:
                    ours.answer_call(ours.call_truth(ours.pending_call["hospital"])); self.call_deadline = None
                return
            self.call_deadline = None
            if self.paused: return
            self.acc += real_dt * self.speed / 60.0
            n = 0
            while self.acc >= .1 and n < 40 and not ours.pending_call:
                self.sim.step(.1); self.acc -= .1; n += 1
            if len(ours.evidence) - self.flushed_e > 40: self.flush()

    def snapshot(self):
        with self.lock:
            s = self.sim; out = dict(t=round(s.t, 2), speed=self.speed, paused=self.paused, seed=s.seed, run=self.run_id,
                                     rain=s.sh.rain, dropgo=s.sh.dropgo, manual=self.manual,
                                     surge=sorted(s.sh.surge), surge_mult={str(k): v for k, v in s.sh.surge.items()}, closed=sorted(s.sh.closed), lanes={})
            for name, l in s.lanes.items():
                ambs = []
                for a in l.amb:
                    x, y = l.amb_pos(a)
                    st = "out" if a["state"] == "idle" and a.get("down_until", 0) > s.t else a["state"]
                    ambs.append(dict(id=a["id"], x=round(x, 3), y=round(y, 3), state=st, hosp=a["hosp"],
                                     kind=a["inc"]["kind"] if a["inc"] else None,
                                     sev=a["inc"]["severity"] if a["inc"] else None,
                                     dest=a["path"][-1] if a["state"] in ("to_scene", "to_hospital") and a["path"] else None))
                lane = dict(amb=ambs, metrics=l.metrics(), feed=l.feed[-12:], dispatch_log=l.dispatch_log[-8:],
                            waiting=[dict(id=i["id"], node=i["node"], kind=i["kind"], severity=i["severity"],
                                          since=round(s.t - i["t"], 1), source=i["source"]) for i in l.waiting],
                            truth=[dict(queue=len(h["queue"]), amb_q=sum(1 for q in h["queue"] if q["k"] == "A"),
                                        bays=len(h["bays"])) for h in l.hos],
                            parked=[len(l.parked(h["id"])) for h in s.world.hospitals])
                if name == "ours":
                    lane["nowcast"] = [l.nowcast(h["id"]) for h in s.world.hospitals]
                    lane["decisions"] = l.decisions[-12:]
                    pc = l.pending_call
                    lane["pending_call"] = None if not pc else dict(
                        hospital=pc["hospital"], kind=pc["kind"], eta=pc["eta"], amb=pc["amb"],
                        seconds_left=max(0, round((self.call_deadline or time.time() + 20) - time.time())),
                        truth_hint=l.call_truth(pc["hospital"]))
                out["lanes"][name] = lane
            return out


WARM = 40.0
R = Runner()
BENCH_SEED0 = 9000          # held-out cities: never used while building or tuning the engine (tuning used 1000-4023)
BENCH = dict(state="idle", done=0, total=0, results=None, error=None, cancel=False)


async def loop():
    last = time.time()
    n = 0
    while True:
        await asyncio.sleep(.1)
        now = time.time(); R.tick(now - last); last = now; n += 1
        if R.clients and n % 2 == 0:                          # push 5 times a second; the browser interpolates between frames
            msg = json.dumps(R.snapshot(), separators=(",", ":"))
            async def push(ws):
                try: await asyncio.wait_for(ws.send_text(msg), timeout=1.0)
                except Exception: R.clients.discard(ws)          # a slow or dead client never stalls the city
            await asyncio.gather(*(push(ws) for ws in list(R.clients)))




@app.websocket("/ws")
async def ws(sock: WebSocket):
    if len(R.clients) >= MAX_WS:
        await sock.close(code=1013); return                     # too many viewers: the page falls back to polling
    await sock.accept(); R.clients.add(sock)
    try:
        while True: await sock.receive_text()
    except WebSocketDisconnect: pass
    finally: R.clients.discard(sock)


@app.get("/api/health")
def health(req: Request):
    try:
        with db() as c: c.execute("select 1").fetchone(); db_ok = True
    except Exception: db_ok = False
    return dict(ok=db_ok, version=VERSION, uptime_s=round(time.time() - STARTED), sim_minute=round(R.sim.t, 1), city=R.sim.seed,
                run=R.run_id, paused=R.paused, websocket_clients=len(R.clients), benchmark=BENCH["state"],
                controls="locked" if CONTROL_KEY else "open", can_control=has_control(req),
                llm="configured" if os.environ.get("GROQ_API_KEY") else "off", db=str(DB.name))


@app.get("/api/world")
def world(): return R.sim.world.public()


@app.get("/api/state")
def state(): return R.snapshot()


class Control(BaseModel):
    action: str
    seed: int | None = Field(None, ge=1, le=99999)
    speed: int | None = None


@app.post("/api/control")
def control(c: Control):
    if c.action == "play": R.paused = False
    elif c.action == "pause": R.paused = True
    elif c.action == "reset": R.new(c.seed or R.sim.seed)
    elif c.action == "speed":
        if c.speed not in (10, 30, 60, 120): raise HTTPException(422, "Speed must be 10, 30, 60 or 120.")
        R.speed = c.speed; R.save_setting("speed", c.speed)
    else: raise HTTPException(422, "Unknown action.")
    return R.snapshot()


class Chaos(BaseModel):
    type: str
    hospital: int | None = None
    on: bool = True
    value: float | None = Field(None, ge=0, le=6)   # rain: 0..1 intensity; surge: walk-in multiplier 1..6


@app.post("/api/chaos")
def chaos(c: Chaos):
    sh = R.sim.sh; nh = len(R.sim.world.hospitals)
    if c.type in ("surge", "close", "restore") and (c.hospital is None or not 0 <= c.hospital < nh):
        raise HTTPException(422, "Pick a hospital on the map first.")
    with R.lock:
        if c.type == "surge":
            m = 5.0 if c.value is None else c.value
            if m <= 1.0: sh.surge.pop(c.hospital, None)
            else: sh.surge[c.hospital] = m
        elif c.type == "close": sh.closed.add(c.hospital)
        elif c.type == "restore": sh.surge.pop(c.hospital, None); sh.closed.discard(c.hospital)
        elif c.type == "rain":
            if c.value is not None and c.value > 1: raise HTTPException(422, "Rain intensity must be between 0 and 1.")
            sh.rain = round(1.0 + c.value, 2) if c.value is not None else (1.5 if c.on else 1.0)
        elif c.type == "dropgo": sh.dropgo = c.on
        elif c.type == "breakdown":
            aid = R.sim.breakdown(c.hospital if c.hospital is not None and 0 <= c.hospital < len(R.sim.world.bases) else None, 60.0)
            if aid is None: raise HTTPException(409, "Every ambulance is already out of service.")
        elif c.type == "manual":
            R.manual = c.on; R.sim.lanes["ours"].manual = c.on; R.save_setting("manual", c.on)
            if not c.on and R.sim.lanes["ours"].pending_call:
                l = R.sim.lanes["ours"]
                while l.pending_call: l.answer_call(l.call_truth(l.pending_call["hospital"]))
        else: raise HTTPException(422, "Unknown chaos type.")
    return R.snapshot()


class Report(BaseModel):
    text: str
    node: int | None = None
    dry_run: bool = False
    force: bool = False          # dispatch even if it looks like a duplicate of a recent report

MAX_PATIENTS = 6


@app.post("/api/reports")
def report(r: Report):
    text = " ".join(r.text.split())
    if not text: raise HTTPException(422, "The report is empty. Say what happened and where.")
    if len(text) < 8: raise HTTPException(422, "The report is too short. Say what happened and where.")
    if len(text) > 500: raise HTTPException(422, "Keep the report under 500 characters.")
    letters = [ch for ch in text if ch.isalpha()]
    if letters and sum(not ("a" <= ch.lower() <= "z") for ch in letters) / len(letters) > .3:
        raise HTTPException(422, "Telugu and Hindi script are not supported in this prototype yet. Please type in Roman letters, e.g. 'gunde noppi', 'seene mein dard'.")
    res = triage.analyse(text)
    if not res["ok"]: raise HTTPException(422, res["error"])
    node = r.node
    if node is None and res["area"]: node = R.sim.world.area_node(res["area"])
    if node is not None and not 0 <= node < R.sim.world.N: raise HTTPException(422, "That map location is not valid.")
    res["node"] = node; res["llm_status"] = triage.llm_last
    if r.dry_run or node is None:
        res["created"] = False
        if node is None and not r.dry_run:
            raise HTTPException(422, "Where is it? Name an area (e.g. Ameerpet, Uppal, Charminar) or click the map.")
        return res
    with R.lock:
        dup = next((i for i in reversed(R.sim.incidents) if i.get("source") == "report" and i.get("text", "").lower() == text.lower()
                    and R.sim.t - i["t"] < 15), None)
        if dup and not r.force:
            raise HTTPException(409, f"This looks like a duplicate of incident {dup['id']} reported {R.sim.t - dup['t']:.0f} sim min ago. Real callers often report the same emergency twice. Send it again with 'Dispatch anyway' if it is a different patient.")
        n = min(res["patients"], MAX_PATIENTS)
        ids = [R.sim.add_user_incident(node, res["kind"], res["severity"], text)["id"] for _ in range(n)]
    res["created"] = True; res["incident_ids"] = ids
    res["capped"] = res["patients"] > MAX_PATIENTS or (res.get("patients_stated") or 0) > MAX_PATIENTS
    return res


@app.get("/api/rank")
def rank(node: int, kind: str = "general"):
    """Read-only: how RightCall would rank hospitals for a pickup at this point right now (fleet evidence only)."""
    if kind not in ("cardiac", "trauma", "general"): raise HTTPException(422, "kind must be cardiac, trauma or general.")
    if not 0 <= node < R.sim.world.N: raise HTTPException(422, "That map location is not valid.")
    with R.lock:
        lane = R.sim.lanes["ours"]; ranked = lane.rank(node, kind)
        nearest = min(lane.capable(kind), key=lambda h: lane.tt(node, R.sim.world.hospitals[h]["node"]))
    return dict(node=node, kind=kind, t=round(R.sim.t, 1), ranked=ranked, nearest=nearest, pick=ranked[0]["hospital"],
                note="Before the confirm call. The call can still move the patient to the next hospital.")


@app.get("/api/triage/info")
def triage_info(): return dict(model=triage.info, llm=triage.llm_last, areas=sorted(AREAS))


class Answer(BaseModel):
    answer: str


@app.post("/api/call/answer")
def call_answer(a: Answer):
    if a.answer not in ("yes", "no", "busy"): raise HTTPException(422, "Answer must be yes, no or busy.")
    with R.lock:
        l = R.sim.lanes["ours"]
        if not l.pending_call: raise HTTPException(409, "No confirm call is waiting.")
        l.answer_call(a.answer); R.call_deadline = None
    return R.snapshot()


@app.get("/api/compare")
def compare(limit: int = 40, only: str = "all"):
    """Same patient, two outcomes: every incident finished in BOTH lanes, with each lane's journey."""
    if only not in ("all", "differ", "better", "worse"): raise HTTPException(422, "only must be all, differ, better or worse.")
    with R.lock:
        base = {d["incident"]: d for d in R.sim.lanes["nearest"].done}
        ours_l = R.sim.lanes["ours"]; decs = {d["id"]: d for d in ours_l.decisions}
        rows = []
        for d in ours_l.done:
            b = base.get(d["incident"])
            if not b: continue
            delta = round(b["pickup_to_bay"] - d["pickup_to_bay"], 1)
            first = decs.get(d["dec"][0]) if d["dec"] else None
            rows.append(dict(incident=d["incident"], kind=d["kind"], severity=d["severity"], node=d["node"], called=round(d["called"], 1),
                             delta=delta,
                             today=dict(minutes=round(b["pickup_to_bay"], 1), hops=b["hops"], visits=b["visits"], hospital=b["hospital"]),
                             ours=dict(minutes=round(d["pickup_to_bay"], 1), hops=d["hops"], visits=d["visits"], hospital=d["hospital"],
                                       decisions=[decs[i] for i in d["dec"] if i in decs])))
    n = len(rows); better = sum(r["delta"] > .5 for r in rows); worse = sum(r["delta"] < -.5 for r in rows)
    summary = dict(patients=n, ours_faster=better, ours_slower=worse, same=n - better - worse,
                   turnaways_today=sum(r["today"]["hops"] for r in rows), turnaways_ours=sum(r["ours"]["hops"] for r in rows),
                   mean_delta=round(statistics.mean(r["delta"] for r in rows), 2) if rows else None)
    keep = {"all": lambda r: True, "differ": lambda r: abs(r["delta"]) > .5 or r["today"]["hops"] != r["ours"]["hops"],
            "better": lambda r: r["delta"] > .5, "worse": lambda r: r["delta"] < -.5}[only]
    rows = [r for r in rows if keep(r)]
    rows.sort(key=lambda r: (-(r["today"]["hops"] - r["ours"]["hops"]), -r["delta"]))
    return dict(summary=summary, rows=rows[:max(1, min(limit, 200))])


@app.get("/api/evidence")
def evidence(hospital: int | None = None, type: str | None = None, limit: int = 200):
    with R.lock:
        ev = R.sim.lanes["ours"].evidence
        rows = [e for e in ev if (hospital is None or e["hospital"] == hospital) and (not type or e["type"] == type)]
        return dict(total=len(ev), matched=len(rows), rows=rows[-max(1, min(limit, 1000)):][::-1])


@app.get("/api/export/{what}.csv")
def export(what: str):
    if what not in ("evidence", "decisions"): raise HTTPException(404, "Export evidence or decisions.")
    with R.lock: R.flush(); run_id = R.run_id; names = [h["name"] for h in R.sim.world.hospitals]
    buf = io.StringIO(); w = csv.writer(buf)
    with db() as c:
        if what == "evidence":
            w.writerow(["run", "id", "sim_minute", "hospital", "type", "value_min", "ambulance", "note"])
            for r in c.execute("select * from evidence where run=? order by id", (run_id,)):
                w.writerow([r["run"], r["id"], r["t"], names[r["hospital"]], r["type"], r["value"], r["amb"], r["note"]])
        elif what == "decisions":
            w.writerow(["run", "id", "sim_minute", "incident", "ambulance", "condition", "severity", "chosen", "nearest", "calls", "reroute", "reason"])
            for r in c.execute("select * from decisions where run=? order by id", (run_id,)):
                d = json.loads(r["body"])
                w.writerow([r["run"], d["id"], d["t"], d["incident"], d["amb"], d["kind"], d["severity"], names[d["chosen"]], names[d["nearest"]],
                            "; ".join(f"{names[x['hospital']]}={x['answer']}" for x in d["calls"]), d["reroute"], d["reason"]])
        else: raise HTTPException(404, "Export evidence or decisions.")
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="rightcall_{what}_run{run_id}.csv"'})


@app.get("/api/runs")
def runs():
    with db() as c:
        return [dict(id=r["id"], seed=r["seed"], sim_minutes=r["sim_minutes"], summary=json.loads(r["summary"]))
                for r in c.execute("select * from runs where summary is not null order by id desc limit 12")]


class Bench(BaseModel):
    runs: int = Field(20, ge=4, le=100)
    dropgo: bool = False


def _bench(n, dropgo):
    try:
        res = {p: [] for p in ("nearest", "phone", "blind", "ours")}
        for i in range(n):
            for p in res:
                if BENCH["cancel"]: BENCH.update(state="cancelled"); return
                res[p].append(run_headless(BENCH_SEED0 + i, p, dropgo=dropgo)); BENCH["done"] += 1
        summary = {}
        for p, v in res.items():
            tr = sum(x["transports"] for x in v)
            summary[p] = dict(mean=round(statistics.mean(x["mean"] for x in v), 1), p90=round(statistics.mean(x["p90"] for x in v), 1),
                              turnaways_per_100=round(100 * sum(x["turnaways"] for x in v) / tr, 1),
                              calls_per_transport=round(sum(x["calls"] for x in v) / tr, 2), transports=tr,
                              per_run=[x["mean"] for x in v], per_run_turnaways=[round(100 * x["turnaways"] / max(1, x["transports"]), 1) for x in v])
        wins = sum(o < b for o, b in zip(summary["ours"]["per_run"], summary["phone"]["per_run"]))
        wins_blind = sum(o < b for o, b in zip(summary["ours"]["per_run"], summary["blind"]["per_run"]))
        def cmp(a, b):
            pa, pb = summary[a]["per_run_turnaways"], summary[b]["per_run_turnaways"]
            return dict(fewer=sum(x < y for x, y in zip(pa, pb)), tied=sum(x == y for x, y in zip(pa, pb)), more=sum(x > y for x, y in zip(pa, pb)))
        vs_phone, vs_blind = cmp("ours", "phone"), cmp("ours", "blind")
        fewer, fewer_blind = vs_phone["fewer"], vs_blind["fewer"]
        BENCH.update(state="done", results=dict(runs=n, dropgo=dropgo, seeds=f"{BENCH_SEED0}-{BENCH_SEED0 + n - 1}", policies=summary,
                                                ours_beats_phone_runs=wins, ours_beats_blind_runs=wins_blind,
                                                ours_fewer_turnaways_than_phone_runs=fewer, ours_fewer_turnaways_than_blind_runs=fewer_blind,
                                                turnaways_vs_phone=vs_phone, turnaways_vs_blind=vs_blind, finished=time.time()))
    except Exception as e:
        BENCH.update(state="error", error=f"{type(e).__name__}: {e}")


@app.post("/api/benchmark")
def bench_start(b: Bench):
    if BENCH["state"] == "running": raise HTTPException(409, "A benchmark is already running.")
    BENCH.update(state="running", done=0, total=b.runs * 4, results=None, error=None, cancel=False)
    threading.Thread(target=_bench, args=(b.runs, b.dropgo), daemon=True).start()
    return BENCH


@app.get("/api/benchmark")
def bench_get(): return BENCH


@app.post("/api/benchmark/cancel")
def bench_cancel():
    if BENCH["state"] == "running": BENCH["cancel"] = True
    return BENCH


@app.post("/api/weather/live")
def weather():
    """Real dependency: Open-Meteo current rain for Hyderabad. Fails loudly if unreachable."""
    url = os.environ.get("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast?latitude=17.385&longitude=78.4867&current=precipitation,rain")
    try:
        cur = json.loads(urllib.request.urlopen(url, timeout=4).read())["current"]
    except Exception as e:
        raise HTTPException(502, f"Open-Meteo could not be reached ({type(e).__name__}). Rain was not changed; use the manual rain switch.")
    mm = float(cur.get("precipitation") or 0)
    R.sim.sh.rain = 1.5 if mm >= 2 else 1.25 if mm > 0 else 1.0
    return dict(precipitation_mm=mm, rain_factor=R.sim.sh.rain, source="Open-Meteo (live), CC BY 4.0")


PAGES = {"": "index.html", "mechanism": "mechanism.html", "live": "live.html", "replay": "replay.html", "proof": "proof.html", "limits": "limits.html"}


@app.get("/")
def index(): return FileResponse(ROOT / "static" / "index.html")


@app.get("/{page}")
def page(page: str):
    if page.endswith(".html") and page[:-5] in PAGES: page = page[:-5]
    if page in PAGES: return FileResponse(ROOT / "static" / PAGES[page])
    return FileResponse(ROOT / "static" / "404.html", status_code=404)


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.add_middleware(BodyCap)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    import socket
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            sys.exit(f"Port {port} is already in use (an earlier copy of the server?). Stop it, or run:  PORT=8080 python backend/server.py")
    host = os.environ.get("HOST", "127.0.0.1")       # HOST=0.0.0.0 to let other devices on the network connect
    print(f"RightCall {VERSION} running at http://localhost:{port}  (host {host}; Ctrl+C to stop)"
          + ("" if not CONTROL_KEY else "  [controls locked: open /?key=<RIGHTCALL_CONTROL_KEY> once to unlock this browser]"))
    uvicorn.run(app, host=host, port=port, log_level="warning", proxy_headers=TRUST_PROXY, forwarded_allow_ips="*" if TRUST_PROXY else None)
