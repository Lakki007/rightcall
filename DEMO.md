# Judge demonstration (3 minutes)

**Before judges arrive:** server running, browser on `/` (unlocked), Live reset to city 10, manual calls off,
backup recording `rightcall-demo-recording.webm` open in another tab.

## 30-second pitch

"When a 108 ambulance has a patient on board, the crew usually drives to the nearest hospital. Nobody tells them it is full,
so patients get turned away at the door and driven on. The ambulance fleet already knows which hospitals are choking:
who is still parked at the gate, how long the last handover took, who was just refused. RightCall turns that GPS evidence into
a ranking and phones the best hospital first. On 200 cities it was never tuned on, it cut turn-aways from about 5 to 2 per 100
patients against phoning ahead, and it needs nothing from hospitals."

## Sequence

| Time | Beat | Do | Say |
| --- | --- | --- | --- |
| 0:00 | Problem and stakes | Overview: point at a red tower, then the card "turned away" | "Refused patients lose the minutes that matter most. Today nobody even counts it." |
| 0:20 | Simple baseline | Press Guided demo | "Same city twice. Left goes to the nearest hospital, which is what happens today." |
| 0:40 | Central mechanism | Step 2: busiest hospital secretly stops taking ambulances | "Its status still says open. RightCall is not told." |
| 1:00 | Visible evidence | Step 3-4: red bursts on the left; its tower turns red on the right | "One refusal is enough evidence. Later patients are phoned elsewhere." |
| 1:30 | Useful action | Replay opens on one patient | "Red is today: a refused door, then another drive. Cyan is RightCall. This table is what it knew." |
| 2:00 | Honest boundary | Mechanism: drop a patient in a quiet area | "When the nearest hospital is fine, RightCall picks it too. In a quiet city our gain is not significant, and we show that." |
| 2:20 | Proof | Proof: Run benchmark (20 cities, ~5 s) | "Cities it never saw. Remove the evidence and turn-aways go back up. That gap is the mechanism." |
| 2:45 | Sponsor value | Close | "108 operators already own the GPS. This is a software layer and a monthly refusal report for the health department." |

## Sample inputs (Live > Report an emergency)

| Input | Shows |
| --- | --- |
| `Uppal ke paas lorry ne takkar maari, 3 log injured, bahut khoon beh raha hai` | Hindi-English, 3 patients, trauma, critical |
| `Ameerpet lo maa nanna ki gunde noppi, oopiri adatam ledu, please fast` | Telugu-English cardiac, red flag kept despite "ledu" |
| `no chest pain, just a routine checkup at Ameerpet` | Negation: not cardiac, routine |
| `my mother fell down at home in Kukatpally, she is not moving` | Red flag: critical (the review's under-triage case, fixed) |
| `hello what is the cricket score today` | Refused, not guessed |
| `bus accident at Mehdipatnam, 12 people injured, bleeding` | Capped at 6 ambulances, flagged mass casualty |
| Same report twice | Held as a duplicate, "Dispatch anyway" |

Boundary case to offer judges: **Break down an ambulance** on Live. The same ambulance fails in both cities, its patient goes
back to the queue, and the Waiting & dispatch tab explains every reassignment.

## Likely questions and evidence-based answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Is the gain real or tuned? | Reported on seeds 9000+, never used while building | `eval/robustness.py`, Proof page |
| How sure are you? | -3.35 turn-aways per 100 vs phone-ahead, 95% CI [-4.06, -2.70] over 200 cities | `eval/robustness_results.json` |
| Where does it fail? | Quiet cities (no gain), random refusals (+3.5 min), wrong phone answers (+1.9 min) | same file, Limits page |
| Is a model choosing the hospital? | No. A statistical estimator plus a transparent score and one call. A better-predicting estimator made worse decisions | `eval/estimators_results.json` |
| How good is triage? | Critical recall 0.93 on 36 reports written after the review; end to end, critical patients reach a bed 3.5 min later than with perfect triage and 23 min sooner than with none | `eval/end_to_end_results.json` |
| What is the ceiling? | An oracle that sees true queues gets 1.0 per 100; we get 2.1, about 75% of the possible reduction | same |
| Isn't the simulator built to favour you? | Partly; that is why we show negative controls where it does not | Limits page |
| Real data? | None yet. Next step: replay one month of real 108 GPS logs offline | idea doc roadmap |

## Reset procedure

1. Live: city `10`, "New city / reset". 2. Turn off manual calls, rain, drop-and-go. 3. Restore any closed hospital.
4. Back to `/`. Total 15 s. If anything misbehaves: restart the server (5 s); state recovers.

## Backup

`rightcall-demo-recording.webm` is a screen recording of the guided demo on this build, labelled as a recording in its
first frame. Use it only if the laptop or network fails, and say that it is a recording.
