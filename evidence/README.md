# Evidence

Every directory here is a real run against the local MERIDIAN instances. Nothing
is transcribed by hand. Regenerate the whole set with:

```bash
./scripts/capture-evidence.sh
```

Each run directory contains `events.jsonl` (the structured run log, redacted on
write), PNG screenshots, and — on failures and escalations — a full dump of the
perceived control list at the moment things went wrong. Replay runs also
contain `result.json` — the structured result the caller received, passed
through the redactor on the way to disk, so a declared-PII output appears there
as a pseudonym rather than its value.

| Run | What it shows | Result |
|---|---|---|
| `00-discovery-gemini-live` | **A genuine Gemini-driven run.** `gemini-2.5-flash-lite` drove the live app, and probing repaired its guessed outcome detector. See the note below. | recorded, `approval=draft` |
| `01-discovery` | The model drives the app; probes verify its proposed detectors; a draft capability falls out. | recorded, `approval=draft` |
| `01-discovery` (review) | `scripts/apply-review.ts` promotes the draft to `@1.1.0`, fixing what discovery cannot know. | approved |
| `02-replay-success` | Deterministic replay, no model in the loop. | `success` + 3 typed outputs |
| `03-replay-business-outcome` | Member 99999 does not exist. | `business_outcome` / `MEMBER_NOT_FOUND` |
| `04-replay-recovered-interstitial` | An acknowledgement screen appears mid-flow and is cleared. | `success`, `COMPLIANCE_ACK×1` |
| `05-replay-session-recovered` | The session expires; a nested sign-on capability re-authenticates and the flow restarts. | `success`, `SESSION_EXPIRED×1` |
| `06-replay-app-error` | The application returns MCS-0500. A *recognised* failure, not a confusing one. | `failure` / `APP_ERROR` |
| `07-replay-invalid-input` | `memberId=abc` fails the declared pattern. | `failure` / `INVALID_INPUT`, 0 steps, browser never opened |
| `08-escalation-approve-irreversible` | The posting step is gated; an operator reviews and approves. | `success`, 11 steps |
| `09-escalation-human-takeover` | The operator posts it themselves in the live session, then releases with "complete". | `success`, **10** steps — the engine verified the checkpoint instead of replaying the step the human did |
| `10-escalation-stuck-recovery` | The *unreviewed* draft's recovery fails, the run gets stuck, and an operator signs the session back on by hand. | `success` after handoff |
| `11-cross-tenant-overlay` | The same capability run against a second institution via a tenant overlay. | `success`, drift reported |
| `14-surface-seam-terminal` | Discovery **and** replay on a 3270-style green screen over a socket: a capability recorded from a character grid, then the **web-recorded** capability replayed against the same surface. Output in `14-green-screen.txt`. | recorded + `success` + `business_outcome` |
| `13-guardrails-hostile-overlay` | Two tenant overlays attempting privilege escalation, both refused. Output in `13-hostile-overlays.txt`. | `POLICY_DENIED` / `NEEDS_HUMAN` |
| `12-agent-invocation` | What a calling agent gets back. | see `agent-invocation.json` |

`catalog.json` is the agent-facing capability catalog. The `*.json` capability
artifacts at the top level are copies of what is in `/capabilities`.

## What probing found

Discovery does not stop once the goal is reached. It replays the flow it just
recorded against inputs the job declares as known-bad, and rebuilds the outcome
detectors from what the application actually prints. In `01-discovery` that
produced four results worth reading in the log:

- **A guessed detector was repaired.** The model proposed detecting a missing
  member by the text *"No matching member found"*. This application never
  prints that. Left alone, `MEMBER_NOT_FOUND` would never fire and a legitimate
  business outcome would surface as a step timeout — the exact distinction the
  result contract is built on, silently broken. The probe replaced it with
  `MCS-0404`, the application's own error code.
- **A detector was added.** `MEMBER_RESTRICTED` (`MCS-0403`) was not proposed at
  all; the probe for member 77777 discovered it.
- **A recovery was proposed and then proven.** The model offered no way to clear
  the compliance acknowledgement screen. The probe stalled on it, read the
  recovery off that screen ("Acknowledge"), and a second probe confirmed the
  proposed recovery actually clears it and the flow completes.
- **Two detectors were flagged unverified**, because no probe covers them.
  `SESSION_EXPIRED` is then fixed in review; `INVALID_MEMBER_NUMBER` ships
  labelled.

Probes cost no model calls — they replay the artifact that was just recorded —
and they run with irreversible steps blocked, so probing a flow that posts a
transaction cannot post one.

## Guardrails, demonstrated rather than asserted

An earlier version of this system asserted two safety properties in its
write-up that the code did not have, and both were bypassable with a four-line
tenant overlay. `13-hostile-overlays.txt` is the regression evidence:

- An overlay patching `steps[10].risk → "safe"` once posted a real irreversible
  transaction with no human in the loop. The first fix denylisted guarded path
  spellings and was defeated by patching the ancestor path `steps[10]` instead.
  The second compared a hand-enumerated set of fields by value afterwards and
  reverted what moved — better, but still an enumeration, and it missed
  `sensitivity` entirely. What ships is neither: an **allow-list** of the paths
  a tenant specialisation actually needs, refused *before* being applied, so
  nothing has to be put back and the audit line cannot describe a revert that
  did not happen. `tests/overlay.test.ts` asserts that as a property over every
  path outside the list, not one test per historical bug.
- An overlay repointing a capability at a second institution and granting
  itself that origin once succeeded. It is now refused twice over: origins come
  from the deployment's tenant registry rather than the overlay, and the
  capability declares only the origins its recording actually touched, so the
  run is `POLICY_DENIED` at step zero.

A third attack does not appear here because it needs a live intervention:
`POST /i/<id>/resolve` once took no lease and no identity, so an unauthenticated
POST approved an irreversible posting. `tests/broker.test.ts` covers it, along
with driving the session as someone else's claim.

The fixtures are in `tests/fixtures/`, so these stay negative tests rather than
a one-off demonstration.

## The seam, exercised rather than asserted

`14-green-screen.txt` is the one I would read first, and it covers both halves
of the loop on a surface that is not the web. First it *records* a capability
from an 80x24 character grid over a TCP socket — probes included, repairing a
proposed detector that matched text the app never prints into the app's own
`MCS-0404`, exactly as on the web. Then it replays the capability a model
recorded against the **frameset web app** against that same terminal, returning
the same typed outputs and the same `MEMBER_NOT_FOUND` for member 99999.

Nothing above `Surface` changed. The steps, the semantic targets, the condition
language, the checkpoint and the outcome detectors are all inherited; the
detectors fire because both surfaces print the same `MCS-` codes, and they were
built by probing the *web* app. The entire tenant delta is two patches: where
the session starts, and one heading the terminal renders with a hyphen where the
web app uses an em dash.

## Things worth opening

- `01-discovery/capability.json` — the artifact, including `{{memberId}}`
  substituted into both the typed value and the derived postcondition, and the
  operator password recorded as `secretRef` rather than a literal.
- `10-escalation-stuck-recovery/events.jsonl` — grep for `escalation.`: the
  request with its context, the claim, each action the human took (typed
  content recorded as a character count, never the text), and the release.
- `06-replay-app-error/*.observation.json` — the full perceived screen at the
  point of failure.
- `09-escalation-human-takeover/result.json` — outputs extracted from a screen
  a human produced.

## Note on the two discovery runs

`00-discovery-gemini-live` is a real run: `gemini-2.5-flash-lite` chose every
action against the live application. It is kept separately because it cannot be
regenerated on demand — the Gemini free tier allows 20 requests per day per
model, and a discovery run costs about seven.

Three disclosures about it:

- **Its event log was scrubbed after the fact.** The model wrote the operator
  password into its own prose ("Enter the password 'demo'…"), and that run
  predates the fix which registers configured credential values with the
  redactor before discovery starts. The log was re-run through the product's
  own `Redactor`, producing what the fixed code now writes at capture time. The
  leak is the finding; the scrub is the remedy applied retroactively to one
  file.
- **Its detector flags were corrected after the fact.** That run's probes all
  ended in failure — the recorded flow does not replay cleanly — yet the
  artifact was written with `verified: true` on two outcomes, because at the
  time `verified` was stamped from having scraped a marker off the screen
  rather than from the probe's own verdict. The code no longer does that (a
  detector is re-probed and verified only when the run reports the outcome),
  but this artifact predates the fix and is not regenerated by
  `capture-evidence.sh`, so the stale flags were set to `false` by hand. The
  flags in `01-discovery` are earned; these were not.
- **Three of its outputs were dropped.** The model proposed readout labels with
  trailing colons ("Member Name:"), which perception strips — so the `contains`
  match failed and the outputs did not survive validation. That mismatch
  between two halves of the system is fixed (`labelMatches` in
  `src/replay/conditions.ts`) and covered by tests, but this artifact was
  recorded before the fix.

`01-discovery` is the run the demo path uses. It is produced by the scripted
driver so the whole evidence set regenerates without a key or a quota — but the
script is not a convenient fiction: its proposed outputs and detectors are
copied from what Gemini actually returned on the live run, *including the wrong
"No matching member found" marker and the SSN output*, so the scripted path
exercises the same weaknesses the real model has. The loop, prompts, probes,
validation and recorder are the same code on both paths.

To regenerate against the live model (needs a key with daily quota left):

```bash
export GEMINI_API_KEY=...
export HS_GEMINI_MODEL=gemini-2.5-flash-lite
MODEL_ARGS="--model gemini" ./scripts/capture-evidence.sh
```
