"""Phase 4 robustness study: fresh seeds, paired confidence intervals, negative controls, assumption checks.

Run:  python eval/robustness.py            (about 5-8 minutes on 2 cores)
Writes eval/robustness_results.json and prints a table.

Seeds 9000+ were never used while building or tuning the engine (tuning used 1000-4023).
Each condition swaps ONE simulator assumption by monkeypatching engine globals, so the
decision code under test is unchanged.
"""
from __future__ import annotations
import json, math, random, statistics, sys, time
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import engine  # noqa: E402

POLICIES = ("nearest", "phone", "blind", "ours")
MINUTES = 180


def run(args):
    seed, policy, cond = args
    E = engine
    saved = dict(REFUSE_AT=E.REFUSE_AT)
    orig_refuse, orig_ev, orig_truth = E.Lane.would_refuse, E.Lane._ev, E.Lane.call_truth
    try:
        rate, surges, fleet = .26, True, None
        if cond == "no_surges": surges = False
        if cond == "quiet": rate = .12
        if cond == "busy": rate = .34
        if cond == "refuse_at_3": E.REFUSE_AT = 3
        if cond == "refuse_at_6": E.REFUSE_AT = 6
        if cond == "small_fleet": fleet = 10
        if cond == "random_diversion":
            # NEGATIVE CONTROL: refusals unrelated to load. Each hospital diverts in 15% of 10-minute windows.
            def would_refuse(self, hid):
                w = int(self.t // 10)
                return hid in self.sh.closed or random.Random(seed * 7919 + hid * 104729 + w).random() < .15
            E.Lane.would_refuse = would_refuse
        if cond == "noisy_gps":
            # GPS dwell times wrong by up to x2 either way and 30% of fleet events lost.
            def _ev(self, hid, typ, value=None, amb=None, note=""):
                r = random.Random(hash((seed, self._eid, typ, hid)) & 0xffffffff)
                if typ in ("handover_wait", "turn_away", "arrive") and r.random() < .3:
                    self._eid += 1; return
                if typ == "handover_wait" and value is not None: value = value * math.exp(r.uniform(-.7, .7))
                return orig_ev(self, hid, typ, value, amb, note)
            E.Lane._ev = _ev
        if cond == "wrong_answers":
            # Hospitals answer the phone wrongly 25% of the time (say yes when they will refuse, or no when free).
            def call_truth(self, hid):
                a = orig_truth(self, hid)
                r = random.Random(seed * 31337 + hid * 7 + int(self.t * 10))
                if r.random() < .25: return "yes" if a == "no" else "no"
                return a
            E.Lane.call_truth = call_truth
        sim = E.Sim(seed, (policy,), rate=rate)
        if fleet:
            lane = sim.lanes[policy]; lane.amb = lane.amb[:fleet]
        r = random.Random(seed * 97 + 5)
        plan = [(r.randrange(8), r.uniform(20, MINUTES - 80), r.uniform(45, 90)) for _ in range(3)] if surges else []
        while sim.t < MINUTES + 120:
            sim.sh.surge = {h: 4.0 for (h, s, d) in plan if s <= sim.t < s + d}
            if sim.t > MINUTES: sim.auto = False
            sim.step(.1)
        L = sim.lanes[policy]; m = L.metrics()
        created = sim.inc_id
        return dict(seed=seed, policy=policy, cond=cond, created=created, transports=m["transports"], turnaways=m["turnaways"],
                    mean=m["mean"], p90=m["p90"], calls=m["calls"], unfinished=created - m["transports"],
                    weighted=m["weighted"])
    finally:
        E.REFUSE_AT = saved["REFUSE_AT"]; E.Lane.would_refuse = orig_refuse; E.Lane._ev = orig_ev; E.Lane.call_truth = orig_truth


def boot_ci(diffs, n=4000, seed=1):
    r = random.Random(seed); k = len(diffs)
    means = sorted(statistics.mean(r.choice(diffs) for _ in range(k)) for _ in range(n))
    return round(means[int(.025 * n)], 2), round(means[int(.975 * n)], 2)


def summarise(rows, cond):
    by = {p: {x["seed"]: x for x in rows if x["policy"] == p and x["cond"] == cond} for p in POLICIES}
    seeds = sorted(by["ours"])
    out = dict(cond=cond, cities=len(seeds))
    for p in POLICIES:
        v = [by[p][s] for s in seeds]
        out[p] = dict(ta_per_100_incidents=round(100 * sum(x["turnaways"] for x in v) / sum(x["created"] for x in v), 2),
                      ta_per_100_transports=round(100 * sum(x["turnaways"] for x in v) / sum(x["transports"] for x in v), 2),
                      mean=round(statistics.mean(x["mean"] for x in v), 2), p90=round(statistics.mean(x["p90"] for x in v), 1),
                      calls_per_transport=round(sum(x["calls"] for x in v) / sum(x["transports"] for x in v), 2),
                      unfinished=sum(x["unfinished"] for x in v))
    for b in ("phone", "blind"):
        dta = [100 * (by["ours"][s]["turnaways"] - by[b][s]["turnaways"]) / by[b][s]["created"] for s in seeds]
        dt = [by["ours"][s]["mean"] - by[b][s]["mean"] for s in seeds]
        out[f"vs_{b}"] = dict(ta_diff_per_100=round(statistics.mean(dta), 2), ta_ci95=boot_ci(dta),
                              fewer=sum(d < 0 for d in dta), tied=sum(d == 0 for d in dta), more=sum(d > 0 for d in dta),
                              time_diff_min=round(statistics.mean(dt), 2), time_ci95=boot_ci(dt), faster=sum(d < 0 for d in dt))
    return out


if __name__ == "__main__":
    plan = {"fresh": range(9000, 9200), "no_surges": range(9000, 9100), "quiet": range(9000, 9100), "busy": range(9000, 9100),
            "refuse_at_3": range(9000, 9100), "refuse_at_6": range(9000, 9100), "small_fleet": range(9000, 9100),
            "random_diversion": range(9000, 9100), "noisy_gps": range(9000, 9100), "wrong_answers": range(9000, 9100)}
    only = sys.argv[1:] or list(plan)
    jobs = [(s, p, c) for c in only for s in plan[c] for p in POLICIES]
    t0 = time.time()
    with Pool(2) as pool: rows = pool.map(run, jobs, chunksize=8)
    res = [summarise(rows, c) for c in only]
    out = ROOT / "eval" / "robustness_results.json"
    prev = json.loads(out.read_text()) if out.exists() else {}
    prev.update({r["cond"]: r for r in res}); out.write_text(json.dumps(prev, indent=1))
    for r in res:
        print(f"\n== {r['cond']} ({r['cities']} cities)")
        for p in POLICIES:
            x = r[p]; print(f"  {p:8s} TA/100 inc {x['ta_per_100_incidents']:6.2f} (per transport {x['ta_per_100_transports']:6.2f})  mean {x['mean']:6.2f}  p90 {x['p90']:5.1f}  calls {x['calls_per_transport']:.2f}  unfinished {x['unfinished']}")
        for b in ("phone", "blind"):
            v = r[f"vs_{b}"]; print(f"  ours-{b}: TA {v['ta_diff_per_100']:+.2f}/100 CI{v['ta_ci95']} fewer/tied/more {v['fewer']}/{v['tied']}/{v['more']} | time {v['time_diff_min']:+.2f} CI{v['time_ci95']} faster {v['faster']}")
    print(f"\n{len(jobs)} runs in {time.time() - t0:.0f} s")
