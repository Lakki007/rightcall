"""Does a better-predicting wait estimator make better decisions?

The current estimator (recency-weighted mean of the last 5 waits, half-life 10 min, prior 10 min) had a higher
error than "last observed wait" and an EWMA in eval/end_to_end.py. Here each variant drives the full decision engine.
Protocol: choose on DEVELOPMENT cities (seeds 1000-1099) only, then report once on HELD-OUT cities (9000-9199).

Run: python eval/estimators.py dev     then     python eval/estimators.py heldout
"""
from __future__ import annotations
import json, random, statistics, sys
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import engine  # noqa: E402

VARIANTS = ("decayed", "last", "ewma")


def estimator(kind):
    base = engine.Lane.nowcast
    def nowcast(self, hid):
        nc = base(self, hid)
        if kind == "decayed" or self.policy != "ours": return nc
        hist = [e["value"] for e in self.waits_by_h[hid]]
        if not hist: return nc
        if kind == "last": est = hist[-1]
        else:
            est = None
            for v in hist[-10:]: est = v if est is None else .5 * v + .5 * est
        p = self.parked(hid)
        if p: est = max(est, max(p) + len(p) * engine.BAY_MIN / self.w.hospitals[hid]["bays"] * .5)
        nc = dict(nc, wait=round(est, 1)); return nc
    return nowcast


def job(args):
    seed, kind = args
    saved = engine.Lane.nowcast; engine.Lane.nowcast = estimator(kind)
    try: m = engine.run_headless(seed, "ours")
    finally: engine.Lane.nowcast = saved
    return dict(seed=seed, kind=kind, ta=m["turnaways"], tr=m["transports"], mean=m["mean"], p90=m["p90"])


if __name__ == "__main__":
    split = sys.argv[1] if len(sys.argv) > 1 else "dev"
    seeds = range(1000, 1100) if split == "dev" else range(9000, 9200)
    with Pool(2) as p: rows = p.map(job, [(s, k) for s in seeds for k in VARIANTS], chunksize=10)
    out = {}
    for k in VARIANTS:
        v = [r for r in rows if r["kind"] == k]
        out[k] = dict(ta_per_100=round(100 * sum(x["ta"] for x in v) / sum(x["tr"] for x in v), 2), mean=round(statistics.mean(x["mean"] for x in v), 2),
                      p90=round(statistics.mean(x["p90"] for x in v), 1))
    f = ROOT / "eval" / "estimators_results.json"; prev = json.loads(f.read_text()) if f.exists() else {}
    prev[split] = out; f.write_text(json.dumps(prev, indent=1)); print(split, json.dumps(out, indent=1))
