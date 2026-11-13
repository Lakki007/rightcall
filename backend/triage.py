"""Report triage: deterministic extraction + a trained severity classifier.

- Extraction (condition, patient count, area) is keyword/regex based so facts never
  depend on generated text. An optional LLM (GROQ_API_KEY) can refine extraction; if it
  is configured but fails, we say so and use the local extractor.
- Severity is a logistic-regression model over severity-cue counts + word TF-IDF, trained at
  start-up on SYNTHETIC template reports and scored on a separate hand-written set.
  (A first char-n-gram model scored 1.0 on a random split but 0.25 on unseen templates:
  it had memorised the templates. That is why the test set is now separate.)
"""
from __future__ import annotations
import json, os, random, re, urllib.request
from pathlib import Path
import numpy as np
import scipy.sparse as sp
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, recall_score
from engine import AREAS

LEX = {
    "cardiac": ["chest pain", "chest me dard", "chest mein dard", "chest lo noppi", "chest dard", "chest tightness", "chest", "heart attack", "heart", "cardiac", "gunde", "chhati", "chaati", "seene mein dard",
                "seene me dard", "dil ka daura", "collapsed", "not breathing", "no pulse", "unconscious", "behosh",
                "spruha ledu", "gunde noppi", "chest lo noppi", "saans nahi", "oopiri adatam ledu"],
    "trauma": ["accident", "crash", "fell down", "fall from", "slipped", "collision", "bleeding", "blood", "khoon", "raktam", "fracture", "fell", "gir gaya",
               "gir gayi", "padipoyadu", "padipoyindi", "burn", "jal gaya", "injury", "injured", "hit by", "takkar",
               "lorry", "bike skid", "head injury", "tala ki debba", "chot", "gaayam", "debba"],
    "general": ["fever", "bukhar", "jwaram", "vomiting", "ulti", "vanthulu", "stomach", "pet dard", "kadupu noppi",
                "dizzy", "chakkar", "weak", "kamzori", "breathless", "saans", "oopiri", "asthma", "pregnant", "delivery",
                "labour", "labor", "seizure", "fits", "stroke", "paralysis", "diabetic", "sugar", "snake bite", "poison",
                "pain", "dard", "noppi", "sick", "ill", "bimaar", "help", "emergency", "ambulance"],
}
NUMWORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "ek": 1, "do": 2, "teen": 3, "char": 4,
            "paanch": 5, "okaru": 1, "iddaru": 2, "mugguru": 3, "naluguru": 4, "aiduguru": 5}
PEOPLE = r"(people|persons|patients|log|logon|mandi|members|injured|victims|passengers|aadmi)"
VULN = ["child", "baby", "bachcha", "pillalu", "papa", "elderly", "old man", "old woman", "grandmother", "grandfather",
        "dadi", "nani", "ammamma", "nanamma", "thatha", "pregnant", "garbhini"]

T = {  # synthetic training templates
    "critical": ["{who} has severe chest pain and is sweating", "{who} collapsed and is not breathing",
                 "{who} ko seene mein dard hai, saans nahi aa rahi", "{who} behosh ho gaya, no pulse",
                 "{who} ki gunde noppi, oopiri adatam ledu", "{who} spruha ledu, please fast",
                 "major accident near {area}, heavy bleeding from head", "lorry ne takkar maari, bahut khoon beh raha hai",
                 "bike accident ayindi, tala ki debba, raktam chala pothundi", "heart attack laga hai {who} ko jaldi aao",
                 "{who} unconscious after crash at {area}", "severe burn, {who} jal gaya, not responding",
                 "stroke symptoms, {who} face drooping cannot speak", "{who} having fits continuously, turning blue",
                 "pregnant lady heavy bleeding at {area} urgent"],
    "urgent": ["{who} fell from stairs, leg fracture, in pain", "{who} gir gaya, haath toot gaya lagta hai",
               "{who} padipoyadu, kaalu fracture ayindi", "bike skid near {area}, injured but talking",
               "high fever and vomiting since morning, {who} very weak", "{who} ko tez bukhar aur ulti, chakkar aa raha hai",
               "{who} ki jwaram chala undi, vanthulu avuthunnayi", "asthma attack, {who} breathless but conscious",
               "deep cut on hand, bleeding controlled with cloth", "labour pains started for {who} at {area}",
               "snake bite on leg, {who} is awake", "diabetic {who} sugar very low, dizzy",
               "{who} ko pet dard bahut zyada hai", "minor collision, two people injured, walking"],
    "routine": ["{who} has mild fever since two days", "{who} ko halka bukhar hai, hospital jaana hai",
                "{who} ki konchem jwaram undi, checkup kavali", "need ambulance for dialysis appointment at {area}",
                "{who} has stomach pain, not severe", "{who} ko kamzori lag rahi hai, stable hai",
                "old patient transfer to hospital for checkup", "small cut, no bleeding now, need dressing",
                "{who} kadupu noppi konchem undi", "back pain since week, {who} cannot walk far",
                "{who} feeling dizzy sometimes, wants doctor visit", "scheduled discharge transport from {area}"],
}
WHO = ["my father", "my mother", "mera bhai", "meri maa", "maa nanna", "maa amma", "an old man", "a child", "my wife",
       "mere papa", "neighbour uncle", "maa thatha", "a woman", "driver", "my friend", "naa friend"]


CUES = {  # severity cue phrases (English / Hindi / Telugu in Roman script)
    "crit": ["not breathing", "no pulse", "unconscious", "behosh", "spruha", "collapsed", "severe", "heavy bleeding",
             "bleeding heavily", "bahut khoon", "khoon beh", "raktam chala", "saans nahi", "saans ruk", "oopiri", "heart attack",
             "dil ka daura", "gunde", "seene mein dard", "chest", "turning blue", "not responding", "not waking", "stroke",
             "fits continuously", "head injury", "tala", "major accident", "cannot speak", "bol nahi", "gambhir", "badly burnt", "cpr",
             "not moving", "unresponsive", "fainted", "hil nahi", "kadalatledu", "kadaladam ledu", "chest me dard", "chest mein dard"],
    "urg": ["accident", "fracture", "broken", "toot", "virigindi", "fever", "bukhar", "jwaram", "vomiting", "ulti", "vanthulu", "asthma",
            "breathless", "difficulty", "deep cut", "labour", "delivery", "noppulu", "snake", "sugar", "dizzy", "chakkar",
            "pet dard", "pet mein", "injured", "chot", "fell", "gir gaya", "padipoyadu", "in pain", "very weak", "skid", "fit"],
    "mild": ["mild", "halka", "konchem", "stable", "checkup", "appointment", "not severe", "small", "sometimes", "scheduled",
             "transfer", "dressing", "no bleeding", "since two days", "since a week", "doctor visit", "discharge", "not urgent",
             "serious kaadu", "koi emergency nahi", "follow-up", "tomorrow", "regular", "dialysis"],
}


# Red flags: if any appears (not negated), the patient is at least critical, whatever the model says.
RED_FLAGS = ["not breathing", "no pulse", "unconscious", "unresponsive", "not responding", "not moving", "not waking",
             "collapsed", "heavy bleeding", "bleeding heavily", "behosh", "spruha ledu", "oopiri adatam ledu", "saans nahi",
             "saans ruk", "turning blue", "hil nahi", "kadalatledu", "kadaladam ledu", "cpr"]
PRE_NEG = {"no", "not", "without", "denies", "never", "nil"}           # English: negates the next words
POST_NEG = {"nahi", "nahin", "ledu", "kaadu", "ledhu"}                # Hindi / Telugu: negates the words before
PROTECT = sorted({p for ws in (RED_FLAGS, ["not severe", "no bleeding", "not urgent", "serious kaadu", "koi emergency nahi"]) for p in ws}, key=len, reverse=True)


def mask_negation(text: str) -> str:
    """'no chest pain, just a checkup' -> 'no ~ ~, just a checkup'. Phrases whose meaning IS a negation
    ('not breathing', 'saans nahi', 'spruha ledu', 'not severe') are protected and kept."""
    low = " " + re.sub(r"\s+", " ", text.lower()) + " "
    keep = [False] * len(low)
    for p in PROTECT:
        for m in re.finditer(r"(?<![a-z])" + re.escape(p) + r"(?![a-z])", low):
            for i in range(m.start(), m.end()): keep[i] = True
    toks = [(m.group(), m.start(), m.end()) for m in re.finditer(r"[a-z]+|[^a-z\s]", low)]
    neg = set()
    for k, (w, a, b) in enumerate(toks):
        if keep[a]: continue
        if w in PRE_NEG:
            for j in range(k + 1, min(len(toks), k + 4)):
                if not toks[j][0].isalpha() or keep[toks[j][1]]: break
                neg.add(j)
        elif w in POST_NEG:
            for j in range(k - 1, max(-1, k - 3), -1):
                if not toks[j][0].isalpha() or keep[toks[j][1]]: break
                neg.add(j)
    out = list(low)
    for j in neg:
        _, a, b = toks[j]
        for i in range(a, b): out[i] = "~"
    return "".join(out)


def cue_counts(texts):
    return np.array([[sum(c in t.lower() for c in CUES[k]) for k in ("crit", "urg", "mild")] for t in texts], float)


class Triage:
    def __init__(self, seed=11):
        r = random.Random(seed); X, y = [], []
        areas = list(AREAS)
        for label, temps in T.items():
            for tmpl in temps:
                for _ in range(22):
                    s = tmpl.format(who=r.choice(WHO), area=r.choice(areas))
                    if r.random() < .3: s = s + " " + r.choice(["please come fast", "jaldi", "twaraga randi", "near " + r.choice(areas), "help"])
                    X.append(s); y.append(label)
        self.words = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=2)
        self.words.fit(X)
        self.model = LogisticRegression(max_iter=1000, C=.3, class_weight="balanced").fit(self._feats(X), y)
        # evaluation on hand-written sets never used for training: the original 36, and 40 written AFTER an external
        # review (negations, code-mix, red flags; 4 cases from the reviewer). Same team wrote them, so still optimistic.
        sd = Path(__file__).resolve().parent.parent / "samples"
        orig = json.loads((sd / "triage_test.json").read_text())
        adv = json.loads((sd / "triage_adversarial.json").read_text())
        self.llm_last = "not configured (local extractor in use)" if not os.environ.get("GROQ_API_KEY") else "configured, not yet called"
        self.info = dict(train=len(X), model="severity cue counts + word TF-IDF, logistic regression, trained on synthetic templates; negation masking; red-flag and injury safety floors",
                         sets={"original": self.evaluate([(a, t) for a, t in orig]), "adversarial": self.evaluate([(a, t) for a, _, t, _ in adv], kinds=[k for _, k, _, _ in adv]),
                               "post_review_only": self.evaluate([(a, t) for a, _, t, w in adv if w == "post-review"], kinds=[k for _, k, _, w in adv if w == "post-review"])},
                         data="hand-written reports in samples/ (same team as the cue list, so still optimistic)")
        o = self.info["sets"]["original"]; self.info.update(test=o["n"], macro_f1=o["pipeline"]["macro_f1"], critical_recall=o["pipeline"]["recall"]["critical"])
        self.llm_last = "not configured (local extractor in use)" if not os.environ.get("GROQ_API_KEY") else "configured, not yet called"

    def evaluate(self, rows, kinds=None):
        """Severity metrics for the model alone and for the full pipeline (negation + floors), plus a confusion matrix."""
        labels = ["critical", "urgent", "routine"]; yt = [a for a, _ in rows]; texts = [t for _, t in rows]
        model = list(self.model.predict(self._feats([mask_negation(t) for t in texts])))
        res = [self.analyse(t, use_llm=False) for t in texts]
        pipe = [r["severity"] if r["ok"] else "rejected" for r in res]
        def block(pred):
            return dict(macro_f1=round(f1_score(yt, pred, labels=labels, average="macro", zero_division=0), 3),
                        recall={l: round(recall_score(yt, pred, labels=[l], average="macro", zero_division=0), 3) for l in labels},
                        confusion={t: {p: sum(1 for a, b in zip(yt, pred) if a == t and b == p) for p in labels + ["rejected"]} for t in labels},
                        under_triaged_critical=sum(1 for a, b in zip(yt, pred) if a == "critical" and b != "critical"))
        out = dict(n=len(rows), model_only=block(model), pipeline=block(pipe))
        if kinds: out["condition_accuracy"] = round(sum(r.get("kind") == k for r, k in zip(res, kinds)) / len(kinds), 3)
        out["misses"] = [dict(text=t, truth=a, got=g) for t, a, g in zip(texts, yt, pipe) if a != g][:12]
        return out

    def _feats(self, texts):
        return sp.hstack([sp.csr_matrix(cue_counts(texts) * 1.5), self.words.transform(texts)]).tocsr()

    def _llm(self, text):
        key = os.environ.get("GROQ_API_KEY")
        if not key: return None
        try:
            body = json.dumps({"model": os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant"), "temperature": 0,
                               "response_format": {"type": "json_object"},
                               "messages": [{"role": "system", "content": "Extract from the emergency report a JSON object with keys: condition (cardiac|trauma|general), patients (integer), area (string or null). Text may be English, Hindi or Telugu in Roman script."},
                                            {"role": "user", "content": text}]}).encode()
            req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", body,
                                         {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            out = json.loads(urllib.request.urlopen(req, timeout=4).read())
            self.llm_last = "ok"; return json.loads(out["choices"][0]["message"]["content"])
        except Exception as e:                                   # explicit, never silent
            self.llm_last = f"failed ({type(e).__name__}); local extractor used"; return None

    def analyse(self, text: str, use_llm=True):
        raw = " " + re.sub(r"\s+", " ", text.lower()) + " "
        low = mask_negation(text)                                    # negated words cannot trigger a condition
        hits = {k: [w for w in ws if w in low] for k, ws in LEX.items()}
        kind = "cardiac" if hits["cardiac"] else "trauma" if hits["trauma"] else "general" if hits["general"] else None
        probs = dict(zip(self.model.classes_, self.model.predict_proba(self._feats([low]))[0]))
        probs = {str(k): float(v) for k, v in probs.items()}
        sev = max(probs, key=probs.get); conf = probs[sev]
        if kind is None and cue_counts([low]).sum() == 0:            # nothing medical recognised: refuse, don't guess
            return dict(ok=False, error="I couldn't find an emergency in this text. Describe what happened, for example: 'bike accident near Ameerpet, heavy bleeding'.")
        patients = 1; patients_raw = None
        m = re.search(r"(\d+)\s*" + PEOPLE, low)
        if m: patients_raw = int(m.group(1)); patients = max(1, min(20, patients_raw))
        else:
            for w, n in NUMWORDS.items():
                if re.search(rf"\b{w}\s+{PEOPLE}", low): patients = patients_raw = n
        found = [a for a in sorted(AREAS, key=len, reverse=True) if a in low]
        found = [a for a in found if not any(a != b and a in b for b in found)]      # "hitec city" beats "city"-like overlaps
        area = min(found, key=low.index) if found else None
        source = "local keyword extractor"
        llm = self._llm(text) if use_llm else None
        if llm:
            source = "LLM extraction (checked against local rules)"
            if llm.get("condition") in ("cardiac", "trauma", "general") and kind is None: kind = llm["condition"]
            if isinstance(llm.get("area"), str) and llm["area"].lower() in AREAS and not area: area = llm["area"].lower()
        kind = kind or "general"
        floored = False
        flags = [f for f in RED_FLAGS if f in low]
        if flags and sev != "critical": sev = "critical"; floored = True                      # red flag: at least critical
        if kind in ("cardiac", "trauma") and sev == "routine": sev = "urgent"; floored = True   # safety floor: never call chest pain or injury routine
        return dict(ok=True, kind=kind, severity=sev, confidence=round(conf, 2), patients=patients, area=area,
                    vulnerable=[v for v in VULN if v in low][:3], areas_found=found, patients_stated=patients_raw, matched=(hits[kind] or [])[:4], source=source, floored=floored, red_flags=flags[:3], negated=low.count('~') > 0,
                    probabilities={k: round(float(v), 2) for k, v in probs.items()})
