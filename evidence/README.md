# Evidence

Every directory here is a real run against the local MERIDIAN instances. Nothing
is transcribed by hand. Regenerate the whole set with:

```bash
./scripts/capture-evidence.sh
```

Each run directory contains `events.jsonl` (the structured run log, redacted on
write), PNG screenshots, and — on failures and escalations — a full dump of the
perceived control list at the moment things went wrong. Replay runs also
contain `result.json`, the exact structured result the caller received.

| Run | What it shows | Result |
|---|---|---|
| `01-discovery` | The model drives the app; a draft capability falls out. `capability.json` is the artifact it produced. | recorded, `approval=draft` |
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
| `12-agent-invocation` | What a calling agent gets back. | see `agent-invocation.json` |

`catalog.json` is the agent-facing capability catalog. The `*.json` capability
artifacts at the top level are copies of what is in `/capabilities`.

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

## Note on the discovery run

The shipped `01-discovery` was produced with the scripted model driver, because
no Gemini key was available when this was captured. The loop, prompts,
validation and recording paths are identical either way — the driver substitutes
for the model's nondeterminism, not for the pipeline. To regenerate it against
the live model:

```bash
export GEMINI_API_KEY=...
MODEL_ARGS="--model gemini" ./scripts/capture-evidence.sh
```
