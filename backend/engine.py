"""RightCall simulation + decision engine.

Everything here is deterministic given a seed. Two "lanes" run on the SAME simulated
city (same incidents, same walk-in patients, same treatment times):
  - baseline: nearest capable hospital (common practice)
  - ours:     fleet-evidence ranking + confirm call to the top pick (+ re-route)
A third policy, phone-ahead (call nearest until one says yes), is used in benchmarks.

Hidden truth (hospital queues, walk-ins) is never read by the 'ours' ranking. It is
read only (a) to answer a confirm call, which is what a phone call does, and (b) by
the UI's optional "reveal truth" view.
"""
from __future__ import annotations
import heapq, math, random, statistics
from dataclasses import dataclass, field

COLS, ROWS, SPACING = 14, 10, 1.6          # road grid, km
SCENE_MIN = 4.0                            # minutes on scene
REFUSE_AT = 4                              # ED refuses an ambulance when this many are queued
BAY_MIN = 45.0                             # mean treatment-bay occupancy, minutes
HALF_LIFE, REF_TAU, PRIOR_WAIT, PRIOR_W = 10.0, 60.0, 10.0, 0.5
TURNAWAY_PENALTY, REROUTE_SAVING, BUSY_WAIT = 40.0, 5.0, 30.0
REASSIGN_MAX = 15.0                        # only divert an ambulance that can reach the sicker patient within this many minutes
SEVERITY_W = {"critical": 10, "urgent": 6, "routine": 1}
KINDS = ["cardiac", "trauma", "general"]
SUFFIX = ["General", "Civil", "Heart Institute", "Government", "Trauma Centre", "District", "Medical", "Community"]
HOSPITAL_NAMES = SUFFIX  # invented names: area + suffix, not real hospitals
AREAS = {  # area name -> (col, row) on the stylised grid
    "ameerpet": (5, 4), "kukatpally": (3, 2), "secunderabad": (9, 3), "charminar": (8, 7),
    "gachibowli": (1, 6), "lb nagar": (11, 8), "uppal": (12, 4), "mehdipatnam": (5, 6),
    "banjara hills": (6, 5), "begumpet": (7, 3), "dilsukhnagar": (10, 7), "miyapur": (1, 1),
    "madhapur": (3, 5), "koti": (8, 6), "tarnaka": (10, 3), "hitec city": (2, 5),
}


class World:
    """Static city: road graph, hospitals, ambulance bases. Stylised, NOT real OSM roads."""

    def __init__(self, seed: int):
        r = random.Random(seed)
        self.seed = seed
        self.nodes = []
        for j in range(ROWS):
            for i in range(COLS):
                self.nodes.append((i * SPACING + r.uniform(-.38, .38), j * SPACING + r.uniform(-.38, .38)))
        self.N = len(self.nodes)
        nid = lambda i, j: j * COLS + i
        edges = {}
        for j in range(ROWS):
            for i in range(COLS):
                for di, dj in ((1, 0), (0, 1)):
                    a, b = i + di, j + dj
                    if a < COLS and b < ROWS:
                        arterial = (dj == 0 and j in (2, 5, 8)) or (di == 0 and i in (3, 7, 11))
                        edges[(nid(i, j), nid(a, b))] = arterial
        removable = [e for e, art in edges.items() if not art]
        r.shuffle(removable)
        for e in removable[: int(len(removable) * .14)]:
            del edges[e]
            if not self._connected(edges):
                edges[e] = False
        self.edges = [(a, b, art) for (a, b), art in edges.items()]
        self.adj = [[] for _ in range(self.N)]
        for a, b, art in self.edges:
            mins = math.dist(self.nodes[a], self.nodes[b]) / (40 if art else 24) * 60
            self.adj[a].append((b, mins)); self.adj[b].append((a, mins))
        self.dist, self.prev = [], []
        for s in range(self.N):
            d, p = self._dijkstra(s); self.dist.append(d); self.prev.append(p)
        # hospitals by farthest-point sampling
        picks = [r.randrange(self.N)]
        while len(picks) < len(HOSPITAL_NAMES):
            picks.append(max(range(self.N), key=lambda n: min(math.dist(self.nodes[n], self.nodes[p]) for p in picks)))
        self.hospitals = []; used = set()
        for k, n in enumerate(picks):
            caps = ["general"]
            if k in (0, 2, 6) or r.random() < .25: caps.append("cardiac")
            if k in (0, 4, 5) or r.random() < .3: caps.append("trauma")
            near = sorted(AREAS, key=lambda a: math.dist(self.nodes[n], self.nodes[AREAS[a][1] * COLS + AREAS[a][0]]))
            area = next(a for a in near if a not in used); used.add(area)
            self.hospitals.append(dict(id=k, name=area.title() + " " + SUFFIX[k], node=n, bays=r.randint(3, 6), caps=caps,
                                       walk=r.uniform(.025, .05)))
        self.bases = [r.randrange(self.N) for _ in range(14)]

    def _connected(self, edges):
        adj = {}
        for a, b in edges: adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
        seen, st = {0}, [0]
        while st:
            for m in adj.get(st.pop(), []):
                if m not in seen: seen.add(m); st.append(m)
        return len(seen) == COLS * ROWS

    def _dijkstra(self, s):
        d = [math.inf] * self.N; p = [-1] * self.N; d[s] = 0; pq = [(0, s)]
        while pq:
            c, u = heapq.heappop(pq)
            if c > d[u]: continue
            for v, w in self.adj[u]:
                if c + w < d[v]: d[v] = c + w; p[v] = u; heapq.heappush(pq, (c + w, v))
        return d, p

    def path(self, a, b):
        out = [b]
        while out[-1] != a: out.append(self.prev[a][out[-1]])
        return out[::-1]

    def area_node(self, name):
        i, j = AREAS[name]; return j * COLS + i

    def public(self):
        share = [0] * len(self.hospitals)                  # how many road nodes default to each hospital as "nearest"
        for n in range(self.N): share[min(range(len(self.hospitals)), key=lambda h: self.dist[n][self.hospitals[h]["node"]])] += 1
        return dict(seed=self.seed, default_share=share, nodes=[[round(x, 3), round(y, 3)] for x, y in self.nodes],
                    edges=[[a, b, int(art)] for a, b, art in self.edges],
                    hospitals=[dict(id=h["id"], name=h["name"], node=h["node"], bays=h["bays"], caps=h["caps"])
                               for h in self.hospitals],
                    areas={k: self.area_node(k) for k in AREAS})


@dataclass
class Shared:
    """State that both lanes experience identically."""
    rain: float = 1.0
    dropgo: bool = False
    surge: dict = field(default_factory=dict)     # hospital id -> multiplier
    closed: set = field(default_factory=set)


class Lane:
    def __init__(self, world: World, policy: str, shared: Shared, manual_calls=False):
        self.w, self.policy, self.sh = world, policy, shared
        self.manual = manual_calls
        self.t = 0.0
        self.hos = [dict(bays=[], queue=[]) for _ in world.hospitals]
        self.amb = [dict(id=i, node=n, state="idle", path=None, t0=0, t1=0, inc=None, hosp=None, tried=None,
                         until=0, arrived_at=0) for i, n in enumerate(world.bases)]
        self.waiting, self.done = [], []           # incidents waiting / completed transports
        self.evidence, self.decisions, self.feed = [], [], []
        self.calls = self.turnaways = self.reroutes = self.escalations = 0
        self.pending_call = None
        self._last_min = -1
        self._eid = 0
        self.waits_by_h = {h["id"]: [] for h in world.hospitals}     # handover waits per hospital (index of the evidence log)
        self.last_ref = {}; self.last_ev = {}                        # most recent refusal / any event per hospital
        self.reassignments = self.breakdowns = 0
        self.dispatch_log = []                                       # ambulance reassignments and breakdowns, with reasons

    # ---------- evidence (what the fleet can observe) ----------
    def _ev(self, hid, typ, value=None, amb=None, note=""):
        self._eid += 1
        e = dict(id=self._eid, t=round(self.t, 2), hospital=hid, type=typ, value=None if value is None else round(value, 1), amb=amb, note=note)
        self.evidence.append(e); self.last_ev[hid] = e["t"]
        if typ == "handover_wait": self.waits_by_h[hid].append(e)
        if typ in ("turn_away", "call_no"): self.last_ref[hid] = e["t"]

    def parked(self, hid):
        if self.sh.dropgo: return []
        return [self.t - q["t"] for q in self.hos[hid]["queue"] if q["k"] == "A"]

    def nowcast(self, hid):
        t = self.t
        if self.policy == "blind":            # ablation: same ranking + confirm call, fleet evidence removed
            return dict(hospital=hid, wait=PRIOR_WAIT, risk=0.0, n=0.0, parked=0, parked_max=0, last_turnaway=None,
                        evidence_age=None, level="unknown")
        waits = self.waits_by_h[hid][-5:]
        num = den = 0.0
        for e in waits:
            wt = 0.5 ** ((t - e["t"]) / HALF_LIFE); num += wt * e["value"]; den += wt
        est = (num + PRIOR_W * PRIOR_WAIT) / (den + PRIOR_W)
        parked = self.parked(hid)
        if parked:
            est = max(est, max(parked) + len(parked) * BAY_MIN / self.w.hospitals[hid]["bays"] * .5)
        lr = self.last_ref.get(hid)
        refs = [lr] if lr is not None else []
        risk = max([math.exp(-(t - x) / REF_TAU) for x in refs] + [0.0])
        last = self.last_ev.get(hid, -1)
        return dict(hospital=hid, wait=round(est, 1), risk=round(risk, 2), n=round(den, 2), parked=len(parked),
                    parked_max=round(max(parked), 1) if parked else 0,
                    last_turnaway=round(t - max(refs), 1) if refs else None,
                    evidence_age=round(t - last, 1) if last >= 0 else None,
                    level="unknown" if den < .15 and not parked and risk < .2 else
                          "red" if est + TURNAWAY_PENALTY * risk >= 40 else
                          "amber" if est + TURNAWAY_PENALTY * risk >= 20 else "green")

    # ---------- hidden truth (hospital side) ----------
    def true_wait(self, hid):
        h = self.hos[hid]; c = self.w.hospitals[hid]["bays"]
        return len(h["queue"]) * BAY_MIN / c if len(h["bays"]) >= c else 0.0

    def would_refuse(self, hid):
        return hid in self.sh.closed or len(self.hos[hid]["queue"]) >= REFUSE_AT

    def call_truth(self, hid):
        if self.would_refuse(hid): return "no"
        return "busy" if self.true_wait(hid) > BUSY_WAIT else "yes"

    # ---------- routing ----------
    def tt(self, a, b): return self.w.dist[a][b] * self.sh.rain

    def capable(self, kind, exclude=()):
        allc = [h["id"] for h in self.w.hospitals if kind in h["caps"]] or [h["id"] for h in self.w.hospitals]
        c = [h for h in allc if h not in exclude]
        if c: return c
        last = getattr(self, "_at", None)                 # everything tried: go round again, but not the door we are at
        return [h for h in allc if h != last] or allc

    def rank(self, node, kind, exclude=()):
        rows = []
        for hid in self.capable(kind, exclude):
            nc = self.nowcast(hid); tr = self.tt(node, self.w.hospitals[hid]["node"])
            rows.append(dict(hospital=hid, travel=round(tr, 1), wait=nc["wait"], risk=nc["risk"], n=nc["n"],
                             parked=nc["parked"], parked_max=nc["parked_max"], last_turnaway=nc["last_turnaway"],
                             score=round(tr + nc["wait"] + TURNAWAY_PENALTY * nc["risk"], 1)))
        rows.sort(key=lambda x: x["score"])
        return rows

    def _reason(self, ranked, chosen, nearest, calls):
        name = lambda h: self.w.hospitals[h]["name"]
        c = next(x for x in ranked if x["hospital"] == chosen)
        txt = f"Go to {name(chosen)} ({c['travel']:.0f} min drive, est. wait {c['wait']:.0f} min)."
        if nearest != chosen:
            nr = next((x for x in ranked if x["hospital"] == nearest), None)
            if nr:
                why = []
                if nr["parked"]: why.append(f"{nr['parked']} ambulance{'s' if nr['parked'] > 1 else ''} waiting up to {nr['parked_max']:.0f} min at its gate")
                if nr["last_turnaway"] is not None and nr["risk"] > .15: why.append(f"one turned away {nr['last_turnaway']:.0f} min ago")
                if not why and nr["wait"] > c["wait"] + 3: why.append(f"recent handovers there took about {nr['wait']:.0f} min")
                said_no = [x for x in calls if x["hospital"] == nearest and x["answer"] != "yes"]
                if said_no: why.append(f"it answered '{said_no[0]['answer']}' on the confirm call")
                if why: txt += f" Not the nearest ({name(nearest)}, {nr['travel']:.0f} min): " + "; ".join(why) + "."
        else:
            txt += " Nearest is also the best-ranked."
        if c["n"] < .15 and not c["parked"]:
            txt += " No recent fleet evidence here: status unknown, so the confirm call decided."
        return txt

    def choose_destination(self, a, exclude=(), reroute=False):
        """Return hospital id, or None if waiting on a manual confirm call."""
        inc = a["inc"]; node = a["node"]
        cands = self.capable(inc["kind"], exclude)
        nearest = min(cands, key=lambda h: self.tt(node, self.w.hospitals[h]["node"]))
        if self.policy == "nearest":
            return nearest
        if self.policy == "phone":
            order = sorted(cands, key=lambda h: self.tt(node, self.w.hospitals[h]["node"]))
            for h in order:
                self.calls += 1
                if self.call_truth(h) != "no": return h
            return order[1] if len(order) > 1 and self.tt(node, self.w.hospitals[order[0]]["node"]) < .01 else nearest
        ranked = self.rank(node, inc["kind"], exclude)
        if self.manual and not reroute:
            self.pending_call = dict(amb=a["id"], incident=inc["id"], ranked=ranked, idx=0, calls=[],
                                     nearest=nearest, hospital=ranked[0]["hospital"], kind=inc["kind"],
                                     eta=ranked[0]["travel"])
            return None
        calls, chosen = [], None
        for k, row in enumerate(ranked[:3]):
            ans = self.call_truth(row["hospital"]); self._register_call(row["hospital"], ans, a["id"])
            calls.append(dict(hospital=row["hospital"], answer=ans))
            if self._accept(ans, row, ranked[k + 1] if k + 1 < len(ranked) else None, node):
                chosen = row["hospital"]; break
        if chosen is None: chosen = ranked[0]["hospital"]
        self._record_decision(a, ranked, calls, chosen, nearest, reroute)
        return chosen

    def _accept(self, ans, row, nxt, node):
        if ans == "yes": return True
        if ans == "no": return False
        return nxt is None or nxt["score"] >= row["travel"] + BUSY_WAIT     # "busy": only if nothing better

    def _register_call(self, hid, ans, amb):
        self.calls += 1
        self._ev(hid, "call_" + ans, amb=amb, note="confirm call answered " + ans)

    def _record_decision(self, a, ranked, calls, chosen, nearest, reroute):
        inc = a["inc"]
        d = dict(id=len(self.decisions) + 1, t=round(self.t, 2), incident=inc["id"], amb=a["id"], kind=inc["kind"],
                 severity=inc["severity"], ranked=ranked[:5], calls=calls, chosen=chosen, nearest=nearest,
                 reroute=reroute, reason=self._reason(ranked, chosen, nearest, calls))
        self.decisions.append(d); inc.setdefault("dec", []).append(d["id"])

    def answer_call(self, answer):
        """Manual confirm-call answer from the UI (yes/no/busy). Returns True when resolved."""
        pc = self.pending_call
        if not pc: return False
        a = self.amb[pc["amb"]]; row = pc["ranked"][pc["idx"]]
        self._register_call(row["hospital"], answer, a["id"]); pc["calls"].append(dict(hospital=row["hospital"], answer=answer))
        nxt = pc["ranked"][pc["idx"] + 1] if pc["idx"] + 1 < len(pc["ranked"]) else None
        if self._accept(answer, row, nxt, a["node"]) or pc["idx"] >= 2 or nxt is None:
            chosen = row["hospital"] if answer != "no" or nxt is None else nxt["hospital"]
            self._record_decision(a, pc["ranked"], pc["calls"], chosen, pc["nearest"], False)
            self.pending_call = None; self._go_hospital(a, chosen); return True
        pc["idx"] += 1; pc["hospital"] = nxt["hospital"]; pc["eta"] = nxt["travel"]
        return False

    # ---------- movement ----------
    def _route(self, a, dest, state):
        a["path"] = self.w.path(a["node"], dest); a["t0"] = self.t; a["t1"] = self.t + self.tt(a["node"], dest)
        a["state"] = state

    def _go_hospital(self, a, hid):
        a["hosp"] = hid; a["tried"] = (a["tried"] or set()) | {hid}
        self._route(a, self.w.hospitals[hid]["node"], "to_hospital")

    def amb_pos(self, a):
        if a["state"] not in ("to_scene", "to_hospital") or not a["path"] or a["t1"] <= a["t0"]:
            return self.w.nodes[a["node"]]
        f = min(1.0, max(0.0, (self.t - a["t0"]) / (a["t1"] - a["t0"])))
        p = a["path"]; total = self.w.dist[p[0]][p[-1]] or 1e-9; target = f * total; acc = 0.0
        for u, v in zip(p, p[1:]):
            seg = self.w.dist[u][v]
            if acc + seg >= target:
                g = (target - acc) / (seg or 1e-9); (x1, y1), (x2, y2) = self.w.nodes[u], self.w.nodes[v]
                return (x1 + (x2 - x1) * g, y1 + (y2 - y1) * g)
            acc += seg
        return self.w.nodes[p[-1]]

    def _current_node(self, a):
        """Nearest path node behind the ambulance (for re-routing)."""
        p = a["path"]; f = (self.t - a["t0"]) / max(1e-9, a["t1"] - a["t0"]); total = self.w.dist[p[0]][p[-1]]
        acc = 0.0; cur = p[0]
        for u, v in zip(p, p[1:]):
            acc += self.w.dist[u][v]
            if acc <= f * total: cur = v
        return cur

    # ---------- one simulation step ----------
    def step(self, t, new_incidents, walkins):
        self.t = t
        for inc in new_incidents: self.waiting.append(dict(inc))
        for (hid, wid, svc) in walkins: self.hos[hid]["queue"].append(dict(k="W", id=wid, t=t, svc=svc))
        # hospitals: move queue into free bays
        for hid, h in enumerate(self.hos):
            h["bays"] = [f for f in h["bays"] if f > t]
            cap = 0 if hid in self.sh.closed else self.w.hospitals[hid]["bays"]
            while h["queue"] and len(h["bays"]) < cap:
                q = h["queue"].pop(0); h["bays"].append(t + q["svc"])
                if q["k"] == "A":
                    inc = q["inc"]; wait = t - q["t"]
                    self.done.append(dict(incident=inc["id"], kind=inc["kind"], severity=inc["severity"], hospital=hid,
                                          call_to_bay=t - inc["t"], pickup_to_bay=t - inc["pickup"], wait=wait,
                                          hops=inc.get("hops", 0), t=t, node=inc["node"], pickup=inc["pickup"],
                                          called=inc["t"], visits=list(inc.get("visits", [])), dec=list(inc.get("dec", []))))
                    if not self.sh.dropgo:
                        self._ev(hid, "handover_wait", wait, q["amb"], "GPS dwell at gate")
                        a = self.amb[q["amb"]]; a["state"] = "idle"; a["inc"] = None; a["hosp"] = None; a["tried"] = None; a["reassigned"] = False
        # ambulances
        for a in self.amb:
            if a["state"] == "to_scene" and t >= a["t1"]:
                a["node"] = a["path"][-1]; a["state"] = "on_scene"; a["until"] = t + SCENE_MIN
            elif a["state"] == "on_scene" and t >= a["until"]:
                a["inc"].setdefault("pickup", t); a["tried"] = set()
                if self.pending_call: continue                      # one manual call at a time
                hid = self.choose_destination(a)
                if hid is None: a["state"] = "awaiting_confirm"
                else: self._go_hospital(a, hid)
            elif a["state"] == "to_hospital" and t >= a["t1"]:
                a["node"] = a["path"][-1]; hid = a["hosp"]; self._at = hid
                if self.would_refuse(hid) and not a.get("escalate"):
                    allc = [h["id"] for h in self.w.hospitals if a["inc"]["kind"] in h["caps"]] or [h["id"] for h in self.w.hospitals]
                    if set(allc) <= (a["tried"] or set()):           # every capable hospital has refused this patient
                        a["escalate"] = True; self.escalations += 1; a["tried"] = {hid}
                        self._ev(hid, "escalation", amb=a["id"], note="refused by every capable hospital: next hospital must admit (control-room escalation)")
                    self.turnaways += 1; a["inc"]["hops"] = a["inc"].get("hops", 0) + 1
                    a["inc"].setdefault("visits", []).append(dict(h=hid, t=round(t, 1), ok=False))
                    self._ev(hid, "turn_away", amb=a["id"], note="left with patient aboard / crew tapped 'refused'")
                    self.feed.append(dict(t=round(t, 1), kind="turn_away", hospital=hid, amb=a["id"]))
                    nh = self.choose_destination(a, exclude=a["tried"], reroute=bool(self.pending_call))
                    if nh is None: a["state"] = "awaiting_confirm"
                    else: self._go_hospital(a, nh)
                else:
                    a["inc"].setdefault("visits", []).append(dict(h=hid, t=round(t, 1), ok=True, escalated=bool(a.get("escalate"))))
                    a["escalate"] = False
                    self.hos[hid]["queue"].append(dict(k="A", id=a["inc"]["id"], t=t, svc=a["inc"]["svc"], amb=a["id"], inc=a["inc"]))
                    self._ev(hid, "arrive", amb=a["id"], note="entered hospital geofence with patient")
                    if self.sh.dropgo: a["state"] = "idle"; a["inc"] = None; a["hosp"] = None; a["tried"] = None; a["reassigned"] = False
                    else: a["state"] = "at_hospital"; a["arrived_at"] = t
        # dispatch: sickest first, nearest idle ambulance
        self.waiting.sort(key=lambda i: (-SEVERITY_W[i["severity"]], i["t"]))
        idle = [a for a in self.amb if a["state"] == "idle" and a.get("down_until", 0) <= t]
        for inc in list(self.waiting):
            if not idle: break
            a = min(idle, key=lambda a: self.tt(a["node"], inc["node"])); idle.remove(a); self.waiting.remove(inc)
            a["inc"] = inc; inc["assigned"] = t; self._route(a, inc["node"], "to_scene")
        # reassignment: a sicker patient still waiting may take an ambulance that is driving to a less urgent scene
        for inc in [i for i in self.waiting if i["severity"] != "routine"]:
            cands = [a for a in self.amb if a["state"] == "to_scene" and a["inc"] and not a.get("reassigned")
                     and SEVERITY_W[a["inc"]["severity"]] < SEVERITY_W[inc["severity"]]]
            if not cands: continue
            a = min(cands, key=lambda a: self.tt(self._current_node(a), inc["node"]))
            cur = self._current_node(a)
            if self.tt(cur, inc["node"]) > REASSIGN_MAX: continue
            old_inc = a["inc"]; a["node"] = cur; a["reassigned"] = True
            self.waiting.remove(inc); self.waiting.append(old_inc); self.reassignments += 1
            a["inc"] = inc; inc["assigned"] = t; self._route(a, inc["node"], "to_scene")
            self.dispatch_log.append(dict(t=round(t, 1), type="reassign", amb=a["id"], to=inc["id"], frm=old_inc["id"],
                                          reason=f"Ambulance {a['id']} diverted from a {old_inc['severity']} {old_inc['kind']} call to a {inc['severity']} {inc['kind']} call {self.tt(cur, inc['node']):.0f} min away; the {old_inc['severity']} patient waits for the next free ambulance."))
        # re-route check once per simulated minute (ours only)
        if self.policy == "ours" and int(t) != self._last_min:
            self._last_min = int(t)
            for a in self.amb:
                if a["state"] != "to_hospital" or a["t1"] - t < 1.5: continue
                cur = self._current_node(a); ranked = self.rank(cur, a["inc"]["kind"])
                mine = next((x for x in ranked if x["hospital"] == a["hosp"]), None)
                best = ranked[0]
                if mine and best["hospital"] != a["hosp"] and mine["score"] - best["score"] > REROUTE_SAVING \
                        and best["hospital"] not in a["inc"].setdefault("rr", set()):
                    a["inc"]["rr"].add(best["hospital"])
                    ans = self.call_truth(best["hospital"]); self._register_call(best["hospital"], ans, a["id"])
                    if ans == "yes":
                        a["node"] = cur; self.reroutes += 1
                        self._record_decision(a, ranked, [dict(hospital=best["hospital"], answer=ans)], best["hospital"], a["hosp"], True)
                        self._go_hospital(a, best["hospital"])

    def breakdown(self, aid, minutes):
        """Ambulance aid goes out of service. Its patient (if any) goes back to the queue at the current spot."""
        a = self.amb[aid]; t = self.t
        if a["state"] in ("to_scene", "to_hospital"): a["node"] = self._current_node(a)
        a["down_until"] = t + minutes; self.breakdowns += 1
        inc = a["inc"]
        if self.pending_call and self.pending_call["amb"] == aid: self.pending_call = None
        if a["state"] == "at_hospital":                 # patient already at the gate: handover continues, the vehicle is out afterwards
            self.dispatch_log.append(dict(t=round(t, 1), type="breakdown", amb=aid, reason=f"Ambulance {aid} broke down at the hospital gate; its patient is already there."))
            return
        if inc is not None:
            if a["state"] == "to_hospital": inc["node"] = a["node"]          # picked-up patient waits for a backup ambulance here
            self.waiting.append(inc)
        a["state"] = "idle"; a["inc"] = None; a["hosp"] = None; a["tried"] = None; a["path"] = None; a["reassigned"] = False
        self.dispatch_log.append(dict(t=round(t, 1), type="breakdown", amb=aid, reason=f"Ambulance {aid} out of service for {minutes:.0f} min" + (f"; its {inc['severity']} patient goes back to the queue for the nearest free ambulance." if inc else ".")))

    def metrics(self):
        ts = [d["pickup_to_bay"] for d in self.done]
        return dict(transports=len(ts), mean=round(statistics.mean(ts), 1) if ts else None,
                    p90=round(sorted(ts)[int(.9 * (len(ts) - 1))], 1) if ts else None,
                    turnaways=self.turnaways, calls=self.calls, reroutes=self.reroutes, escalations=self.escalations,
                    waiting=len(self.waiting),
                    weighted=round(sum(SEVERITY_W[d["severity"]] * d["pickup_to_bay"] for d in self.done), 0),
                    critical_mean=round(statistics.mean(c), 1) if (c := [d["pickup_to_bay"] for d in self.done if d["severity"] == "critical"]) else None,
                    reassignments=self.reassignments, breakdowns=self.breakdowns)


class Sim:
    """Shared clock + common random numbers feeding one or more lanes."""

    def __init__(self, seed=7, policies=("nearest", "ours"), rate=.26, manual_calls=False, auto_incidents=True):
        self.seed, self.rate, self.auto = seed, rate, auto_incidents
        self.world = World(seed); self.sh = Shared(); self.t = 0.0
        self.r_inc = random.Random(seed * 31 + 1); self.r_walk = random.Random(seed * 31 + 2); self.r_svc = random.Random(seed * 31 + 3)
        self.lanes = {p: Lane(self.world, p, self.sh, manual_calls and p == "ours") for p in policies}
        self.inc_id = 0; self.walk_id = 0; self.incidents = []; self.pending_user = []

    def make_incident(self, node, kind, severity, text=None, source="sim"):
        self.inc_id += 1
        inc = dict(id=self.inc_id, t=self.t, node=node, kind=kind, severity=severity,
                   svc=self.r_svc.expovariate(1 / BAY_MIN), text=text, source=source)
        self.incidents.append(inc); return inc

    def add_user_incident(self, node, kind, severity, text):
        inc = self.make_incident(node, kind, severity, text, "report"); self.pending_user.append(inc); return inc

    def breakdown(self, aid=None, minutes=60.0):
        """Same ambulance breaks down in every lane (common random numbers)."""
        n = len(self.world.bases)
        if aid is None:
            ok = [i for i in range(n) if all(l.amb[i].get("down_until", 0) <= self.t for l in self.lanes.values())]
            if not ok: return None
            aid = random.Random(self.seed * 13 + int(self.t * 10)).choice(ok)
        for l in self.lanes.values(): l.t = self.t; l.breakdown(aid, minutes)
        return aid

    def step(self, dt=.1):
        self.t += dt; new = self.pending_user; self.pending_user = []
        if self.auto and self.r_inc.random() < self.rate * dt:
            kind = self.r_inc.choices(KINDS, [2, 3, 5])[0]
            sev = {"cardiac": "critical", "trauma": self.r_inc.choice(["critical", "urgent"]), "general": self.r_inc.choice(["urgent", "routine", "routine"])}[kind]
            new.append(self.make_incident(self.r_inc.randrange(self.world.N), kind, sev))
        walk = []
        for h in self.world.hospitals:
            rate = h["walk"] * self.sh.surge.get(h["id"], 1.0) * dt
            n = int(rate) + (self.r_walk.random() < rate - int(rate))
            for _ in range(n):
                self.walk_id += 1; walk.append((h["id"], self.walk_id, self.r_svc.expovariate(1 / BAY_MIN)))
        for lane in self.lanes.values(): lane.step(self.t, new, walk)


def run_headless(seed, policy, minutes=180, dropgo=False, surges=True):
    """One benchmark run: scripted hidden surges, no UI. Returns lane metrics."""
    sim = Sim(seed, (policy,)); sim.sh.dropgo = dropgo
    r = random.Random(seed * 97 + 5)
    plan = [(r.randrange(8), r.uniform(20, minutes - 80), r.uniform(45, 90)) for _ in range(3)] if surges else []
    while sim.t < minutes + 120:
        sim.sh.surge = {h: 4.0 for (h, s, d) in plan if s <= sim.t < s + d}
        if sim.t > minutes: sim.auto = False
        sim.step(.1)
    return sim.lanes[policy].metrics()
