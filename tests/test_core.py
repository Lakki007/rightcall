"""Regression tests for the failures that would break RightCall's core promise.
Run:  python -m unittest discover -s tests -v      (takes ~1-2 minutes)"""
import os, sys, statistics, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ["RIGHTCALL_DB"] = str(Path(tempfile.mkdtemp()) / "test.db")
os.environ["OPEN_METEO_URL"] = "http://127.0.0.1:9/unreachable"     # simulate a dead dependency
from engine import Sim, run_headless                                  # noqa: E402
from triage import Triage                                             # noqa: E402


def advance(sim, minutes):
    while sim.t < minutes: sim.step(.1)


class Mechanism(unittest.TestCase):
    def test_same_seed_same_city(self):
        a, b = Sim(21), Sim(21); advance(a, 90); advance(b, 90)
        self.assertEqual(a.lanes["ours"].metrics(), b.lanes["ours"].metrics())
        self.assertEqual(a.lanes["ours"].evidence, b.lanes["ours"].evidence)

    def test_ranking_never_reads_hidden_hospital_state(self):
        sim = Sim(5); advance(sim, 60); lane = sim.lanes["ours"]
        before = lane.rank(0, "general")
        for h in lane.hos:                                    # flood every hidden queue; no ambulance has seen it yet
            h["queue"] += [dict(k="W", id=-i, t=lane.t, svc=45) for i in range(30)]
        self.assertEqual(before, lane.rank(0, "general"), "ranking changed without any new fleet evidence")

    def test_turn_away_is_seen_as_evidence(self):
        sim = Sim(5); advance(sim, 50); lane = sim.lanes["ours"]
        lane.t = sim.t; lane._ev(3, "turn_away", amb=1)
        self.assertGreater(lane.nowcast(3)["risk"], .9)

    def test_removing_fleet_evidence_raises_turnaways(self):
        ours = [run_headless(s, "ours") for s in range(4000, 4008)]
        blind = [run_headless(s, "blind") for s in range(4000, 4008)]
        self.assertLess(sum(x["turnaways"] for x in ours), sum(x["turnaways"] for x in blind))

    def test_rightcall_beats_nearest_hospital(self):
        ours = [run_headless(s, "ours") for s in range(4100, 4106)]
        near = [run_headless(s, "nearest") for s in range(4100, 4106)]
        self.assertLess(statistics.mean(x["mean"] for x in ours), statistics.mean(x["mean"] for x in near))
        self.assertLess(sum(x["turnaways"] for x in ours), sum(x["turnaways"] for x in near))

    def test_confirm_call_no_moves_to_next_ranked(self):
        sim = Sim(9, manual_calls=True); lane = sim.lanes["ours"]
        while not lane.pending_call and sim.t < 200: sim.step(.1)
        self.assertIsNotNone(lane.pending_call)
        first = lane.pending_call["ranked"][0]["hospital"]; second = lane.pending_call["ranked"][1]["hospital"]
        lane.answer_call("no")
        self.assertEqual(lane.pending_call["hospital"] if lane.pending_call else lane.decisions[-1]["chosen"], second)
        self.assertNotEqual(second, first)

    def test_evidence_index_matches_full_scan(self):
        import math
        from engine import HALF_LIFE, PRIOR_W, PRIOR_WAIT, REF_TAU
        sim = Sim(8); advance(sim, 150); lane = sim.lanes["ours"]
        for h in range(len(sim.world.hospitals)):
            waits = [e for e in lane.evidence if e["hospital"] == h and e["type"] == "handover_wait"][-5:]
            num = sum(0.5 ** ((lane.t - e["t"]) / HALF_LIFE) * e["value"] for e in waits); den = sum(0.5 ** ((lane.t - e["t"]) / HALF_LIFE) for e in waits)
            refs = [e["t"] for e in lane.evidence if e["hospital"] == h and e["type"] in ("turn_away", "call_no")]
            nc = lane.nowcast(h)
            if not lane.parked(h): self.assertAlmostEqual(nc["wait"], round((num + PRIOR_W * PRIOR_WAIT) / (den + PRIOR_W), 1))
            self.assertAlmostEqual(nc["risk"], round(max([math.exp(-(lane.t - x) / REF_TAU) for x in refs] + [0.0]), 2))

    def test_breakdown_returns_patient_and_city_recovers(self):
        sim = Sim(9); advance(sim, 70); lane = sim.lanes["ours"]
        busy = next(a for a in lane.amb if a["state"] in ("to_scene", "to_hospital"))
        inc = busy["inc"]["id"]; sim.breakdown(busy["id"], 30)
        self.assertIn(inc, {i["id"] for i in lane.waiting} | {a["inc"]["id"] for a in lane.amb if a["inc"]}, "patient lost after breakdown")
        self.assertEqual(lane.amb[busy["id"]]["state"], "idle"); self.assertGreater(lane.amb[busy["id"]]["down_until"], sim.t)
        advance(sim, 75)
        self.assertNotIn(busy["id"], [a["id"] for a in lane.amb if a["inc"] and a["inc"]["id"] == inc and a["id"] == busy["id"]])
        advance(sim, 160)
        self.assertTrue(any(d["incident"] == inc for d in lane.done), "patient never reached a bed after the breakdown")

    def test_critical_patient_can_take_ambulance_from_routine_call(self):
        sim = Sim(11); advance(sim, 41); lane = sim.lanes["ours"]
        for a in lane.amb:                                    # every ambulance busy driving to routine calls
            if a["state"] == "idle":
                r = sim.make_incident(a["node"] + 1 if a["node"] + 1 < sim.world.N else 0, "general", "routine"); a["inc"] = r; lane._route(a, r["node"], "to_scene")
        free = [a for a in lane.amb if a["state"] == "idle"]
        self.assertFalse(free)
        crit = sim.make_incident(lane.amb[0]["path"][-1] if lane.amb[0]["path"] else 0, "cardiac", "critical")
        lane.waiting.append(crit); lane.step(sim.t + .1, [], [])
        if any(a["state"] == "to_scene" and a["inc"]["severity"] in ("routine", "urgent") for a in lane.amb):
            self.assertTrue(any(a["inc"] and a["inc"]["id"] == crit["id"] for a in lane.amb) or lane.reassignments == 0)
        self.assertGreaterEqual(lane.reassignments, 0)

    def test_evidence_index_matches_full_scan(self):
        import math
        from engine import HALF_LIFE, PRIOR_W, PRIOR_WAIT, REF_TAU
        sim = Sim(8); advance(sim, 150); lane = sim.lanes["ours"]
        for h in range(len(sim.world.hospitals)):
            waits = [e for e in lane.evidence if e["hospital"] == h and e["type"] == "handover_wait"][-5:]
            num = sum(0.5 ** ((lane.t - e["t"]) / HALF_LIFE) * e["value"] for e in waits); den = sum(0.5 ** ((lane.t - e["t"]) / HALF_LIFE) for e in waits)
            refs = [e["t"] for e in lane.evidence if e["hospital"] == h and e["type"] in ("turn_away", "call_no")]
            nc = lane.nowcast(h)
            if not lane.parked(h): self.assertAlmostEqual(nc["wait"], round((num + PRIOR_W * PRIOR_WAIT) / (den + PRIOR_W), 1))
            self.assertAlmostEqual(nc["risk"], round(max([math.exp(-(lane.t - x) / REF_TAU) for x in refs] + [0.0]), 2))

    def test_breakdown_returns_patient_and_city_recovers(self):
        sim = Sim(9); advance(sim, 70); lane = sim.lanes["ours"]
        busy = next(a for a in lane.amb if a["state"] in ("to_scene", "to_hospital"))
        inc = busy["inc"]["id"]; sim.breakdown(busy["id"], 30)
        self.assertIn(inc, {i["id"] for i in lane.waiting}, "patient lost after breakdown")
        self.assertEqual(lane.amb[busy["id"]]["state"], "idle"); self.assertGreater(lane.amb[busy["id"]]["down_until"], sim.t)
        advance(sim, 260)
        self.assertTrue(any(d["incident"] == inc for d in lane.done), "patient never reached a bed after the breakdown")

    def test_critical_patient_takes_ambulance_from_routine_call(self):
        sim = Sim(11, auto_incidents=False); lane = sim.lanes["ours"]; sim.t = lane.t = 1.0
        far = max(range(sim.world.N), key=lambda n: sim.world.dist[0][n])
        for a in lane.amb:                                    # every ambulance is driving to a routine call
            r = sim.make_incident(far, "general", "routine"); a["inc"] = r; lane._route(a, far, "to_scene")
        a0 = lane.amb[0]; crit = sim.make_incident(a0["node"], "cardiac", "critical")
        lane.waiting.append(crit); lane.step(sim.t + .1, [], [])
        self.assertEqual(lane.reassignments, 1)
        self.assertTrue(any(a["inc"] and a["inc"]["id"] == crit["id"] for a in lane.amb))
        self.assertEqual(len([i for i in lane.waiting if i["severity"] == "routine"]), 1, "the routine patient must go back to the queue, not vanish")


class TriageSafety(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.t = Triage()

    def test_injury_and_chest_pain_never_routine(self):
        for q in ["bike accident near Koti", "fell down, small bruise on knee", "slight chest pain since morning"]:
            self.assertNotEqual(self.t.analyse(q)["severity"], "routine", q)

    def test_rejects_non_emergency(self):
        self.assertFalse(self.t.analyse("hello what is the cricket score today")["ok"])

    def test_handwritten_set_is_scored(self):
        self.assertEqual(self.t.info["test"], 36)
        adv = self.t.info["sets"]["post_review_only"]
        self.assertEqual(adv["n"], 36)
        self.assertGreaterEqual(adv["pipeline"]["recall"]["critical"], .9, "critical recall on post-review reports fell below 0.9")

    def test_negation_and_red_flags(self):
        t = self.t.analyse("no chest pain, just a routine checkup"); self.assertNotEqual(t["kind"], "cardiac"); self.assertEqual(t["severity"], "routine")
        self.assertEqual(self.t.analyse("my mother fell down at home, she is not moving")["severity"], "critical")
        self.assertEqual(self.t.analyse("saans nahi aa rahi, behosh hai")["severity"], "critical")   # negation inside a red flag is kept
        self.assertEqual(self.t.analyse("mere papa ko chest me dard hai Uppal")["kind"], "cardiac")
        self.assertEqual(self.t.analyse("high fever near Dilsukhnagar")["kind"], "general")


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import server
        cls.c = TestClient(server.app); cls.server = server

    def test_input_validation(self):
        c = self.c
        self.assertEqual(c.post("/api/control", json={"action": "speed", "speed": 999}).status_code, 422)
        self.assertEqual(c.post("/api/control", json={"action": "reset", "seed": 0}).status_code, 422)
        self.assertEqual(c.post("/api/chaos", json={"type": "surge", "hospital": 99}).status_code, 422)
        self.assertEqual(c.post("/api/chaos", json={"type": "rain", "value": 3}).status_code, 422)
        self.assertEqual(c.post("/api/reports", json={"text": "help"}).status_code, 422)
        self.assertEqual(c.post("/api/reports", json={"text": "what is the cricket score"}).status_code, 422)
        self.assertEqual(c.post("/api/reports", json={"text": "chest pain at ameerpet", "node": 99999}).status_code, 422)
        self.assertEqual(c.post("/api/call/answer", json={"answer": "yes"}).status_code, 409)
        self.assertEqual(c.get("/api/compare?only=nonsense").status_code, 422)
        self.assertEqual(c.get("/api/export/nothing.csv").status_code, 404)

    def test_dead_weather_dependency_is_reported_not_faked(self):
        before = self.c.get("/api/state").json()["rain"]
        r = self.c.post("/api/weather/live", json={})
        self.assertEqual(r.status_code, 502); self.assertIn("could not be reached", r.json()["detail"])
        self.assertEqual(self.c.get("/api/state").json()["rain"], before)

    def test_report_creates_incident_in_both_lanes(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 33})
        r = c.post("/api/reports", json={"text": "Uppal ke paas lorry ne takkar maari, 3 log injured"}).json()
        self.assertTrue(r["created"]); self.assertEqual(len(r["incident_ids"]), 3)
        sim = self.server.R.sim; sim.step(.1)
        for lane in sim.lanes.values():
            ids = {i["id"] for i in lane.waiting} | {a["inc"]["id"] for a in lane.amb if a["inc"]}
            self.assertTrue(set(r["incident_ids"]) <= ids)

    def test_compare_matches_lane_records(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 10})
        sim = self.server.R.sim
        while sim.t < 140: sim.step(.1)
        data = c.get("/api/compare?limit=200").json()
        base = {d["incident"]: d for d in sim.lanes["nearest"].done}; ours = {d["incident"]: d for d in sim.lanes["ours"].done}
        self.assertEqual(data["summary"]["patients"], len(set(base) & set(ours)))
        for r in data["rows"]:
            self.assertAlmostEqual(r["today"]["minutes"], round(base[r["incident"]]["pickup_to_bay"], 1))
            self.assertAlmostEqual(r["ours"]["minutes"], round(ours[r["incident"]]["pickup_to_bay"], 1))
            self.assertAlmostEqual(r["delta"], round(r["today"]["minutes"] - r["ours"]["minutes"], 1), places=0)
            self.assertEqual(r["today"]["hops"], sum(not v["ok"] for v in r["today"]["visits"]))

    def test_reset_is_repeatable(self):
        c = self.c; out = []
        for _ in range(2):
            c.post("/api/control", json={"action": "reset", "seed": 44}); sim = self.server.R.sim
            while sim.t < 100: sim.step(.1)
            out.append(sim.lanes["ours"].metrics())
        self.assertEqual(out[0], out[1])

    def test_rank_endpoint_matches_engine_and_formula(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 12}); sim = self.server.R.sim
        while sim.t < 80: sim.step(.1)
        r = c.get("/api/rank?node=40&kind=cardiac").json()
        self.assertEqual(r["ranked"], sim.lanes["ours"].rank(40, "cardiac"))
        caps = {h["id"]: h["caps"] for h in sim.world.public()["hospitals"]}
        self.assertTrue(all("cardiac" in caps[x["hospital"]] for x in r["ranked"]))
        for x in r["ranked"]: self.assertAlmostEqual(x["score"], x["travel"] + x["wait"] + 40 * x["risk"], delta=.2)
        self.assertEqual(c.get("/api/rank?node=-1").status_code, 422)
        self.assertEqual(c.get("/api/rank?node=3&kind=dental").status_code, 422)

    def test_duplicate_report_held_then_forced(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 15})
        t = "chest pain at ameerpet, my father collapsed"
        self.assertTrue(c.post("/api/reports", json={"text": t}).json()["created"])
        self.assertEqual(c.post("/api/reports", json={"text": t}).status_code, 409)
        self.assertTrue(c.post("/api/reports", json={"text": t, "force": True}).json()["created"])

    def test_native_script_and_mass_casualty(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 16})
        r = c.post("/api/reports", json={"text": "అమీర్‌పేట్‌లో గుండె నొప్పి"})
        self.assertEqual(r.status_code, 422); self.assertIn("Roman letters", r.json()["detail"])
        r = c.post("/api/reports", json={"text": "bus accident at Mehdipatnam, 12 people injured, bleeding"}).json()
        self.assertEqual(len(r["incident_ids"]), 6); self.assertTrue(r["capped"])

    def test_every_hospital_closed_escalates_then_recovers(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 17}); sim = self.server.R.sim
        for h in range(len(sim.world.hospitals)): c.post("/api/chaos", json={"type": "close", "hospital": h})
        while sim.t < 130: sim.step(.1)
        lane = sim.lanes["ours"]; m = lane.metrics()
        self.assertGreater(m["escalations"], 0, "nobody escalated with every door closed")
        self.assertTrue(all(len([v for v in d["visits"] if not v["ok"]]) <= len(sim.world.hospitals) for d in lane.done), "a crew circled forever")
        for h in range(len(sim.world.hospitals)): c.post("/api/chaos", json={"type": "restore", "hospital": h})
        done = len(lane.done)
        while sim.t < 220: sim.step(.1)
        self.assertGreater(len(lane.done), done + 5, "city did not recover after restore")

    def test_pages_and_404(self):
        for path in ("/", "/mechanism", "/live", "/replay", "/proof", "/limits", "/live.html"):
            r = self.c.get(path); self.assertEqual(r.status_code, 200, path); self.assertIn('id="nav"', r.text)
        r = self.c.get("/no-such-page"); self.assertEqual(r.status_code, 404); self.assertIn("404", r.text)
        for js in ("core", "map2d", "world3d", "home", "mechanism", "live", "replay", "proof"):
            self.assertEqual(self.c.get(f"/static/js/{js}.js").status_code, 200, js)

    def test_benchmark_reports_ablation_and_refuses_overlap(self):
        import time
        c = self.c; r = c.post("/api/benchmark", json={"runs": 4})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(c.post("/api/benchmark", json={"runs": 4}).status_code, 409)
        for _ in range(300):
            b = c.get("/api/benchmark").json()
            if b["state"] != "running": break
            time.sleep(.1)
        res = b["results"]; self.assertEqual(set(res["policies"]), {"nearest", "phone", "blind", "ours"})
        v = res["turnaways_vs_phone"]; self.assertEqual(v["fewer"] + v["tied"] + v["more"], 4)
        self.assertEqual(c.post("/api/benchmark", json={"runs": 500}).status_code, 422)

    def test_health_headers_and_limits(self):
        c = self.c; h = c.get("/api/health").json()
        self.assertTrue(h["ok"]); self.assertEqual(h["controls"], "open")
        r = c.get("/live"); self.assertIn("default-src 'self'", r.headers["content-security-policy"]); self.assertEqual(r.headers["x-frame-options"], "DENY")
        self.assertEqual(c.get("/docs").status_code, 404)                       # no debug/API explorer exposed
        self.assertEqual(c.post("/api/reports", content=b'{"text":"' + b"a" * 20000 + b'"}', headers={"content-type": "application/json"}).status_code, 413)

    def test_control_key_locks_mutations(self):
        srv = self.server; old = srv.CONTROL_KEY; srv.CONTROL_KEY = "s3cret"
        try:
            c = self.c
            self.assertEqual(c.post("/api/control", json={"action": "pause"}).status_code, 403)
            self.assertEqual(c.get("/api/state").status_code, 200)                  # viewing stays open
            self.assertEqual(c.post("/api/control", json={"action": "pause"}, headers={"x-rightcall-key": "s3cret"}).status_code, 200)
            r = c.get("/live?key=wrong", follow_redirects=False); self.assertNotIn("rc_key", r.headers.get("set-cookie", ""))
            r = c.get("/live?key=s3cret", follow_redirects=False); self.assertIn("rc_key", r.headers.get("set-cookie", ""))
        finally:
            srv.CONTROL_KEY = old; self.c.cookies.clear()

    def test_breakdown_endpoint(self):
        c = self.c; c.post("/api/control", json={"action": "reset", "seed": 18})
        r = c.post("/api/chaos", json={"type": "breakdown"}); self.assertEqual(r.status_code, 200)
        s = r.json(); self.assertEqual(s["lanes"]["ours"]["metrics"]["breakdowns"], 1); self.assertEqual(s["lanes"]["nearest"]["metrics"]["breakdowns"], 1)
        self.assertTrue(any(a["state"] == "out" for a in s["lanes"]["ours"]["amb"]))


if __name__ == "__main__":
    unittest.main()
