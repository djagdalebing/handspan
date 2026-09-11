# handspan

Record-once / replay-many UI automation for legacy back-office banking
applications — the ones with no API, where the only way in is to drive the
screen the way an operator would.

A model drives the application once to work out how a task is done. That run is
recorded as a **capability**: a typed, versioned, reviewable artifact. From then
on the capability is replayed deterministically, with no model in the loop, and
an AI agent invokes it by name with typed arguments.

```
  goal ──▶ discovery (LLM drives a real UI) ──▶ capability artifact (reviewed, versioned)
                                                        │
                        AI agent ──▶ invoke by name ──▶ deterministic replay ──▶ typed result
                                                        │
                                            stuck / risky ──▶ human takes the live session
```

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
```

Credentials for the simulated app are read from the environment, never from an
artifact:

```bash
export HS_SECRET_MERIDIAN_OPERATOR_ID=demo
export HS_SECRET_MERIDIAN_OPERATOR_PASSWORD=demo
```

For a live discovery run you also need a model key. Everything else runs
without one:

```bash
export GEMINI_API_KEY=...      # only needed for `discover --model gemini`
```

## The target application

`target-app/` is a deliberately hostile stand-in for the real thing: a
server-rendered "MERIDIAN Core Member Services" with a frameset, table-based
layout, `<font>` tags, form controls with no `id`, no `<label for>`, no ARIA and
no test IDs. It is local rather than a public demo site for one reason: the
interesting half of this problem is the unhappy path, and you cannot ask a
public sandbox to time your session out on cue. It exposes a fault-injection
endpoint so session expiry, surprise interstitials, slow loads and application
errors can be produced deterministically.

It runs in two tenant configurations — same product, different labels — to
exercise cross-institution reuse.

```bash
npm run app                                   # tenant 1 on :4311
TENANT=northgate PORT=4321 npm run app        # tenant 2 on :4321
```

## Demo path

With the app running and the two env vars exported:

```bash
# 1. Discover: the model drives the app and a draft capability falls out.
npx tsx src/cli.ts discover --job jobs/member-savings-balance.json --model gemini
```

No key? The same pipeline runs against a scripted driver — the loop, prompts,
validation and recorder are identical:

```bash
npx tsx src/cli.ts discover --job jobs/member-savings-balance.json \
  --model scripted --script scripts/member-savings-balance.script.json
```

```bash
# 2. Review, then approve. Discovery always emits `draft`; unattended replay
#    requires `approved`.
npx tsx src/cli.ts capability approve meridian.member.savings-balance@1.1.0

# 3. Replay deterministically, with parameters. No model involved.
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=12345

# 4. A business outcome rather than a failure.
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=99999

# 5. An injected runtime condition, recovered.
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 --input memberId=12345 \
  --fault interstitial
```

### Human handoff

Start a replay of the capability that posts an irreversible transaction. It
stops at the posting step and prints a console URL:

```bash
npx tsx src/cli.ts replay meridian.member.open-sub-account --input memberId=12345 \
  --input accountType="VACATION CLUB" --input openingDeposit=50.00
```

Open `http://127.0.0.1:4312/` in a browser, click into the intervention, press
**Take control**, and you are driving the same live session the automation was
using — clicking on the screenshot clicks the real page. Then either
**Resume automation**, **I finished it**, or **Abort run**.

To see it without a browser, a scripted operator does the same thing through
the same HTTP endpoints:

```bash
npx tsx scripts/operator-demo.ts --disposition resume &     # approve and hand back
npx tsx scripts/operator-demo.ts --takeover &               # post it manually, then hand back
```

### Cross-tenant reuse

The same capability, run against the second institution via an overlay of typed
patches rather than a re-recording:

```bash
npx tsx src/cli.ts replay meridian.member.savings-balance@1.1.0 \
  --overlay capabilities/meridian.member.savings-balance@1.1.0.northgate.overlay.json \
  --input memberId=12345
```

### What an agent sees

```bash
npx tsx src/cli.ts catalog                    # typed signatures + outcomes to handle
npx tsx src/cli.ts invoke meridian.member.savings-balance@1.1.0 --input memberId=12345
```

### Everything at once

```bash
./scripts/capture-evidence.sh    # regenerates /evidence from scratch
npm test                         # 59 tests, including end-to-end against the real app
npm run typecheck
```

## Layout

```
src/surface/            the seam: normalized perception + action, surface-agnostic
  types.ts                Surface, UiNode, Action, TargetDescriptor
  web/perceive.ts         in-page: turns hostile DOM into a normalized control list
  web/playwright-surface.ts  the only file that knows Playwright exists
src/artifact/           the capability schema, storage, tenant overlays, agent catalog
src/discovery/          the LLM loop and the recorder that turns a run into an artifact
src/replay/             deterministic executor, locator, conditions, extraction, results
src/safety/             allowlist + risk policy, credential provider, redaction
src/escalation/         control-transfer state machine, intervention broker, operator console
src/observability/      structured run log and evidence capture
target-app/             the simulated legacy application (two tenant variants)
jobs/ scripts/          discovery job definitions and scripted model runs
capabilities/           recorded artifacts and tenant overlays
evidence/               captured runs — see evidence/README.md
```

## What is deliberately stood in for

- **The human operator.** The console is real and drives the live session;
  `scripts/operator-demo.ts` is a script that does what a person does, through
  the same HTTP endpoints, so the demo runs unattended.
- **The desktop surface.** Only the web surface is implemented. The seam it
  would plug into is `src/surface/types.ts`.
- **Multi-tenant infrastructure.** Overlay resolution is implemented and
  demonstrated; there is no tenant registry, queue or scheduler, deliberately.

See `REPORT.md` for the reasoning behind all of it.
