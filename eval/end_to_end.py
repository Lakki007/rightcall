"""Three checks the external review asked for, on held-out cities (seeds 9000+).

1. Triage end to end: incidents arrive as TEXT (40 labelled reports), are triaged by the real classifier, and are
   dispatched on its output. Outcomes are scored on the TRUE label. Compared with perfect triage and no triage.
2. Ceiling: an oracle that sees every hospital's true queue, to show how much of the possible gain we capture.
3. Nowcast accuracy: when an ambulance arrives, how close was each estimator to the wait it then experienced?

Run:  python eval/end_to_end.py      (about 3 minutes on 2 cores). Writes eval/end_to_end_results.json.
"""
from __future__ import annotations
import json, random, statistics, sys, time
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import engine  # noqa: E402

REPORTS = json.loads((ROOT / "samples" / "triage_adversarial.json").read_text())
SEEDS = range(9000, 9100)
W = engine.SEVERITY_W


def city(seed, policy, rate=.26, fleet=None, minutes=180, hook=None):
    sim = engine.Sim(seed, (policy,), rate=rate)
    if fleet: sim.lanes[policy].amb = sim.lanes[policy].amb[:fleet]
    if hook: hook(sim)
    r = random.Random(seed * 97 + 5)
    plan = [(r.randrange(8), r.uniform(20, minutes - 80), r.uniform(45, 90)) for _ in range(3)]
    while sim.t < minutes + 120:
        sim.sh.surge = {h: 4.0 for (h, s, d) in plan if s <= sim.t < s + d}
        if sim.t > minutes: sim.auto = False
        sim.step(.1)
    return sim


TRI = None
TRIAGED = None


def triage_job(args):
    seed, mode = args
    global TRI, TRIAGED
    if TRIAGED is None:
        from triage import Triage
        TRI = Triage(); TRIAGED = [TRI.analyse(t, use_llm=False) for _, _, t, _ in REPORTS]
    def hook(sim):
        rr = random.Random(seed * 4241)
        orig = sim.make_incident
        def make(node, kind, severity, text=None, source="sim"):
            k = rr.randrange(len(REPORTS)); sev_true, kind_true = REPORTS[k][0], REPORTS[k][1]
            if mode == "perfect": sev, kd = sev_true, kind_true
            elif mode == "model": sev, kd = TRIAGED[k]["severity"], TRIAGED[k]["kind"]
            else: sev, kd = "urgent", kind_true                        # no triage: everyone equal, first come first served
            inc = orig(node, kd, sev, text, source); inc["true_sev"] = sev_true; return inc
        sim.make_incident = make
    sim = city(seed, "ours", rate=.34, fleet=10, hook=hook)
    truth = {i["id"]: i["true_sev"] for i in sim.incidents}
    done = sim.lanes["ours"].done
    crit = [d["call_to_bay"] for d in done if truth[d["incident"]] == "critical"]
    return dict(seed=seed, mode=mode, crit_call_to_bed=statistics.mean(crit) if crit else None,
                weighted=sum(W[truth[d["incident"]]] * d["call_to_bay"] for d in done) / max(1, sum(W[truth[d["incident"]]] for d in done)),
                unfinished_critical=sum(1 for i in sim.incidents if i["true_sev"] == "critical") - len(crit))


def oracle_job(args):
    seed, policy = args
    if policy == "oracle":
        def nowcast(self, hid):
            q = len(self.hos[hid]["queue"]); refuse = self.would_refuse(hid)
            return dict(hospital=hid, wait=round(self.true_wait(hid), 1), risk=1.0 if refuse else 0.0, n=9.0, parked=0, parked_max=0,
                        last_turnaway=None, evidence_age=0, level="red" if refuse else "green")
        saved = engine.Lane.nowcast; engine.Lane.nowcast = nowcast
        try: sim = city(seed, "ours"); m = sim.lanes["ours"].metrics()
        finally: engine.Lane.nowcast = saved
    else:
        sim = city(seed, policy); m = sim.lanes[policy].metrics()
    return dict(seed=seed, policy=policy, ta=m["turnaways"], created=sim.inc_id, mean=m["mean"], p90=m["p90"])


def nowcast_job(seed):
    pairs = []
    def hook(sim):
        lane = sim.lanes["ours"]; orig = engine.Lane._ev.__get__(lane); at = {}
        def ev(hid, typ, value=None, amb=None, note=""):
            if typ == "arrive":
                hist = [e["value"] for e in lane.waits_by_h[hid]]
                ew = None
                for v in hist: ew = v if ew is None else .5 * v + .5 * ew
                at[amb] = dict(h=hid, ours=lane.nowcast(hid)["wait"], flat=engine.PRIOR_WAIT,
                               last=hist[-1] if hist else engine.PRIOR_WAIT, ewma=ew if ew is not None else engine.PRIOR_WAIT)
            if typ == "handover_wait" and amb in at and at[amb]["h"] == hid:
                p = at.pop(amb); pairs.append(dict(actual=value, **{k: p[k] for k in ("ours", "flat", "last", "ewma")}))
            return orig(hid, typ, value, amb, note)
        lane._ev = ev
    city(seed, "ours", hook=hook)
    return pairs


if __name__ == "__main__":
    t0 = time.time(); out = {}
    with Pool(2) as pool:
        rows = pool.map(triage_job, [(s, m) for s in SEEDS for m in ("perfect", "model", "none")], chunksize=10)
        tri = {}
        for m in ("perfect", "model", "none"):
            v = [r for r in rows if r["mode"] == m]
            tri[m] = dict(critical_call_to_bed=round(statistics.mean(x["crit_call_to_bed"] for x in v if x["crit_call_to_bed"]), 2),
                          severity_weighted_call_to_bed=round(statistics.mean(x["weighted"] for x in v), 2),
                          unfinished_critical=sum(x["unfinished_critical"] for x in v))
        out["triage_end_to_end"] = dict(condition="busy city (0.34 calls/min), 10 ambulances, 100 held-out cities; reports drawn from samples/triage_adversarial.json", **tri)
        orows = pool.map(oracle_job, [(s, p) for s in SEEDS for p in ("phone", "blind", "ours", "oracle")], chunksize=10)
        ora = {}
        for p in ("phone", "blind", "ours", "oracle"):
            v = [r for r in orows if r["policy"] == p]
            ora[p] = dict(ta_per_100=round(100 * sum(x["ta"] for x in v) / sum(x["created"] for x in v), 2),
                          mean=round(statistics.mean(x["mean"] for x in v), 2), p90=round(statistics.mean(x["p90"] for x in v), 1))
        gap = ora["phone"]["ta_per_100"] - ora["oracle"]["ta_per_100"]
        ora["share_of_possible_turnaway_reduction_captured"] = round((ora["phone"]["ta_per_100"] - ora["ours"]["ta_per_100"]) / gap, 2) if gap > 0 else None
        out["oracle_ceiling"] = ora
        pairs = [p for ps in pool.map(nowcast_job, list(SEEDS)[:40]) for p in ps]
    mae = {k: round(statistics.mean(abs(p[k] - p["actual"]) for p in pairs), 2) for k in ("ours", "flat", "last", "ewma")}
    out["nowcast_mae_minutes"] = dict(n=len(pairs), **mae, note="error of the wait estimate at arrival vs the handover wait that ambulance then had; 40 held-out cities")
    (ROOT / "eval" / "end_to_end_results.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1)); print(f"{time.time() - t0:.0f} s")
