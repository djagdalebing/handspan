# Design write-up

## 1. Architecture

One TypeScript process, five hard boundaries. Not distributed, deliberately:
nothing here is throughput-bound, and a queue would add operational surface
without answering any question the brief asks.

```
      discovery (LLM in the loop)            replay (no LLM, ever)
                │                                      │
                ├──────────── artifact ────────────────┤
                ▼         (typed, versioned)           ▼
      ┌────────────────────────────────────────────────────┐
      │  Surface:  observe() → UiNode[]  ·  act(Action)     │  ← the seam
      └────────────────────────────────────────────────────┘
             web (Playwright)  │  desktop (designed, not built)
   cross-cutting: policy · redaction · run log · session control
```

**The load-bearing decision is the surface seam.** Perception returns a flat
list of controls — role, accessible name, frame path, bounds, value — and
actions are human-scale verbs against one of them. Nothing above that line knows
what a DOM is. Those are the same fields a Win32/UIA tree gives you, which is
what makes the model plausible beyond a browser.

That meant *not* using Playwright locators as identity: a CSS selector cannot
cross the seam, an accessible name can. The web driver derives a name from
whatever the page offers, falling back — the case that matters — to *the text in
the table cell to the left of the field*. On an app with no `id`, no `label` and
no ARIA, that one heuristic is what makes "the textbox labelled Member Number" a
resolvable thing to say. Acting uses real element handles (perception parks live
references on `window` and returns indices), giving trusted input events without
stamping synthetic attributes into a bank's DOM or letting anything
selector-shaped reach an artifact.

Discovery and replay share everything except the decision-maker: the model picks
from the same control list the engine resolves against, by ephemeral `ref`, and
never writes a selector. That is what makes a run *recordable* rather than
something to reverse-engineer from a transcript. The cost of one process is that
the console reaches the session by reference rather than RPC — but the control
model is written as "ask the lease, then act", so the wire can get longer
without the design changing.

## 2. Artifact schema

`src/artifact/schema.ts`. Shaped by serving three audiences at once — a calling
agent needing a signature, a reviewer at a regulated institution who must
approve it without reading my source, and an engine that must execute it with no
model available. Four decisions did the work:

- **Targets are semantic, never selectors.** A step says *"the button named
  'Search' in the `main` frame"*. Each field of a `Target` is an independent
  signal, not a query. It is the only identity a reviewer can check and the only
  one that survives a change of surface technology.
- **The error taxonomy lives in the artifact.** Which screens are business
  outcomes (`MEMBER_NOT_FOUND`), recoverable interstitials (`COMPLIANCE_ACK`) or
  application failures (`SYSTEM_ERROR`) is knowledge about *the application*,
  discovered once and reviewed. In engine code, every new app would need an
  engine change — which does not scale to thousands of app instances.
- **One condition language, three uses.** Checkpoints, outcome detection and
  interstitial detection are all `Condition`s. One grammar to learn, one
  evaluator, and `describe()` renders any of them as English.
- **Risk is per step.** A real flow is nine navigational steps and one that
  posts a journal entry. Guardrails act on the step.

Also carried because it turned out to matter: parameter **sensitivity**
(declared, never inferred — a guessing redactor eventually guesses wrong on
regulated data); `secretRef`, so credentials resolve at run time and never enter
the artifact; per-step **fingerprints** of the control skeleton, so drift is a
signal rather than a mystery failure months later; and `approval`, because a
model-authored flow against a bank system does not get to promote itself.

The recorder does three things beyond serialising the trace. It **minimises and
verifies** each descriptor, starting from role + name + frame and adding
disambiguators only while it still fails to uniquely re-resolve *against the
screen it was recorded on*. It **canonicalises** values into parameters,
including those embedded in panel headings and row text (`"MEMBER DETAIL —
12345"` → `"… — {{memberId}}"`), which is where record-specific data hides. And
it **validates the model's proposals rather than trusting them** — a detector
that also fires on the success screen is discarded, an output that cannot be
extracted is dropped with a warning.

## 3. Determinism & error handling

**Resolution refuses to guess.** The usual approach — an ordered selector ladder,
take the first hit — has the wrong failure mode: it silently acts on the wrong
control, because rung four matches something rung one did not mean. Where two
adjacent buttons are "Post" and "Cancel", that is the worst available behaviour.
Instead every candidate is scored against every recorded signal and a *unique*
winner is required; ambiguity is a hard failure. One concession: if the strict
name match finds nothing, a punctuation-normalised retry runs and is accepted
only if it yields exactly one candidate — legacy apps churn "Member Number:"
into "Member No." far more often than they restructure a screen. That retry is
reported as drift, so it never quietly becomes the new normal.

**Every step is self-verifying.** The recorder derives each postcondition from
what actually happened next — usually "the control the next step needs is now
present". Waiting is condition-based, not time-based, which is also how
transient slowness is absorbed: the injected 6.5-second load needs no special
handling.

**Waiting is frame-aware.** A real bug worth naming: on a frameset, when a link
inside `main` navigates, the *top* document never reloads, so
`page.waitForLoadState` returns immediately and you observe a blank frame.
Settling polls every frame's `readyState`. Before that fix, discovery recorded a
flow with a missing step.

**The result contract separates whose problem it is** — `success` /
`business_outcome` / `needs_human` / `failure`, with eleven failure classes. The
distinction that matters most is outcome versus failure: "no such member" is an
answer, and returning it as an error trains callers to retry on it. Conversely a
recognised *application* failure reports as `APP_ERROR` with the app's own error
code, rather than a confusing "could not find the Search button".

Two behaviours I got wrong first, both visible in the evidence timings:
recoverable conditions are now cleared *during* the wait rather than after it
expires (18s → 3s), and a recognised outcome aborts the wait immediately
(17s → 2s). Recovery that only runs after a timeout still works, but in
production reads as a hang rather than as the handled condition it is.

**Detectors are verified against real screens, not trusted.** This closes the
most dangerous gap in the approach, and I only found it by running a real model.
A model that has seen one successful run guesses at the wording: Gemini offered
a `MEMBER_NOT_FOUND` detector matching *"No matching member found"*, which this
application never prints. It never fires, so a legitimate outcome surfaces as a
step timeout — the exact distinction the result contract rests on, broken
silently. So discovery probes. A job declares one cheap piece of human knowledge
("member 99999 does not exist"), the recorded flow is replayed against it, and
the detector is rebuilt from what the app actually says, preferring its own
error code (`MCS-0404`) over prose. Markers are rejected if they also fire on
the success screen or another probe's. A missing recovery is read off the screen
the flow stalled on — the message and the single button that clears it — and a
*second* probe proves it works. Probes cost no model calls and run with
irreversible steps blocked. What no probe covers ships flagged
`verified: false`.

Session expiry gets specific treatment because it cannot be resumed from:
re-authenticating leaves you at the home screen, not where you were. The
reviewed artifact recovers by running a *separate sign-on capability* — so
credentials stay in the credential provider — then restarts the flow. The engine
honours that restart **only for read-only capabilities**: for anything mutating
there is no way to tell from the UI whether the pre-expiry attempt committed, so
it escalates instead.

Drift is reported, never fatal on its own: changed skeletons, relaxed matches
and frame moves come back on every result.

## 4. Heterogeneity & multi-tenant

**Other surfaces.** A desktop driver supplies role, name, window path and bounds
from UIA/AX and implements six verbs. Nothing in the schema, locator, condition
language, engine or escalation model changes — `framePath` becomes a window
path, and `domHint` goes unused, which is why it is declared the weakest signal
and never sufficient alone. Legacy web is not a different surface at all; it is
the case the web driver was written for, which is why the target app is a
frameset with no test IDs rather than a React demo.

**Cross-tenant reuse.** A tenant gets not a copy but a short list of typed
patches against a **pinned base version**, so the base improves once and is
inherited everywhere while each institution's delta stays reviewable. The pin
means a base change cannot silently re-target a patch at a step that moved, and
an unresolvable patch is *rejected and reported*, never created.

Building it surfaced a weakness: renaming one button needs patching two places —
the step that clicks it and the condition that waits for it — and I missed the
second, producing a flow that clicked the right button then timed out waiting
for the old one. Hence a `rename` patch that rewrites a label at every reference
and reports the site count, so zero is visible. `evidence/11` runs the same
capability against a second institution with four patches, one touching two
sites; the relabelled `Member No.` resolves automatically and reports `relaxed
match at [s04]`. Per-step fingerprints are the other half: recorded at discovery
and recompared every replay, so a diverged tenant reports drift on runs that
still succeed — which is when you want to know.

## 5. Escalation & handoff

"Stuck" is detected four ways, each with its own reason code: a target that will
not resolve or resolves ambiguously; a step that acted but whose postcondition
never appeared; an interstitial that will not clear; and — in discovery — a
screen signature unchanged across three actions, or the model asking for help.
Separately, a step whose declared risk meets the confirmation threshold raises an
intervention *before* acting.

Control transfer is a lease with a single-writer invariant:
`AUTOMATION → PENDING → HUMAN → AUTOMATION`. `PENDING` exists because raising a
request and a human picking it up are seconds-to-minutes apart, and the
automation must already be stopped during that window rather than still clicking
while a request sits in a queue. Both sides re-check the lease on every action,
so a stale console tab cannot drive a session it no longer holds.

Two defects in this mechanism were found by adversarial review, both in the
part that authorises irreversible work. Release signals were cached and reused,
so one operator clearing an unrelated popup silently satisfied *every* later
handoff in the run; they are now scoped to the handoff that asked for them. And
`POST /resolve` checked nothing at all — not the lease, not who was calling —
so the approval gate on a posting was satisfiable by a bare unauthenticated
POST, recorded against a default operator name. Releasing now requires holding
the lease, `SessionControl.release()` refuses anyone who is not the current
holder, and `/input` authorises the *caller* rather than whoever last claimed.
`tests/broker.test.ts` and `tests/control.test.ts` cover both; neither had any
coverage before, which is why both shipped.

An escalation nobody answers is bounded by `escalationTimeoutMs` and returns
`needs_human` with the intervention id. "Escalate" without a bound is not a
safety property, it is a hang.

The human gets *the same session* — the part that makes this real rather than a
notification, since a bank session carries authentication, a navigation
position, a half-filled form and often a server-side lock. The console polls
screenshots of the live page and forwards clicks and keystrokes to it. Context
is captured *before* the automation stops, because the screen is the most useful
thing the operator gets and it will not survive the wait.

Control returns with an explicit disposition, and the three differ. **Resume**
means an obstacle was cleared — and the engine then checks whether the step's own
postcondition already holds, because if the operator made it true, re-running
the recorded action would at best fail to find its target and at worst repeat
something. **I finished it** means the human did the work, so the engine skips
to verifying the checkpoint and extracting outputs rather than replaying steps
over a screen that has moved on (`evidence/09` returns real outputs after 10 of
11 steps). **Abort** stops and tells the caller.

Everything the human did is recorded — each click with coordinates, each
keystroke — but typed *content* is logged as a character count only, because
they are typing into a live banking screen and we have no declaration of what it
is.

## 6. Safety

**The allowlist is the hard boundary.** Origin, scheme and path prefixes,
checked on every navigation in discovery and replay, and on operator navigation
too — the console is reachable over HTTP and would otherwise be a confused
deputy. It is the intersection of the deployment's policy and the capability's
own declared origins.

Making that second half mean anything took three fixes. The recorder used to
stamp the deployment's entire allowlist onto every capability — and a
deployment serving many institutions lists all their hosts, so every capability
declared permission to drive every one of them and the guard was vacuous.
Capabilities now declare only the origins their recording actually touched.
Origins legitimately differ per tenant, so they come from a deployment-owned
registry (`config/tenants.json`) keyed by tenant rather than from the overlay
asking for them. And "fails closed" had to be made literal: declining to *set*
origins for an unknown tenant left the base's in place, so an unknown tenant now
resolves to an empty list, and an empty list denies every navigation rather than
permitting any.

**Risk classification is a heuristic floor, not a guarantee.** During discovery
we guess from a label whether "Post Account" commits something, and label
heuristics are defeatable. So the guess only decides *when to stop and ask*; it
never authorises. The durable control is that every recorded step carries an
explicit reviewed risk label and unattended replay requires `approved`.

That holds only if the label cannot be edited downstream, and originally it
could: a tenant overlay patching `steps[10].risk` to `"safe"` posted a real
irreversible transaction with no human involved. My first fix denylisted
guarded *path spellings*, and that was the wrong shape of control — it lost
immediately to patching one level up, rewriting the whole of `steps[10]` with
`risk: "safe"` through a path the denylist never saw. Anything that enumerates
ways of saying a thing loses to someone who says it differently.

The check is now on the resolved artifact rather than the patch: apply
everything, then compare a set of invariants — approval, capability risk, the
step sequence, every step's risk label, the confirmation threshold, the step
budget, outcome classifications — against the base by value, and revert
anything that moved. Path spelling becomes irrelevant. The overlaid capability
is then re-validated against the schema, because the one code path that mutates
a typed artifact is the last place to skip it: an out-of-enum `confirmAtRisk`
ranks as `undefined` and opens the gate rather than closing it.

The same reasoning applies inside a recoverable-condition handler: its `do`
list is a plain action list, so a recovery declared as "click Post Account"
would have walked straight through the gate. Recovery actions are now
risk-classified like any other step, and the effective threshold is the
stricter of the deployment's and the capability's.

Irreversible actions **escalate rather than block**. In back-office banking the
irreversible step is usually the entire point; a system that refuses to post
anything is not safe, it is useless, and it gets routed around. Escalation keeps
a person accountable for the consequential decision while the other nineteen
steps stay automated. The override (`--risky proceed`) writes an explicit note
into the run log.

Data handling: secrets are referenced by name, resolved at run time, registered
with the redactor and never written anywhere. Discovery is the one phase where
that is not sufficient on its own — the model reads the sign-on hint off the
screen and types the password as a literal, then writes it into its own prose
("Enter the password 'demo'…"). The real run did exactly this. So discovery
registers the configured credential values with the redactor before the loop
starts, and the recorder scrubs the literal out of the step description as well
as the action.

PII becomes a pseudonym salted per process. An unsalted hash of a five-digit
member number is 100,000 candidates — an encoding, not a pseudonym — and four
hex characters over an SSN's last four is 10,000. Salting keeps the property
that matters (one value reads the same way throughout a run, so the run stays
traceable) and drops the one that did not survive contact with an adversary.
System identifiers are exempt from the pattern sweep, because a run id contains
a long digit run and the card-number pattern was eating it: every recorded
`result.json` handed its caller an evidence path that did not exist.

A pattern sweep backstops sensitive data the *application* put on screen that
we were never told about. Screenshots are masked in-page before capture, so
sensitive pixels never reach disk — by field label *and* by declared PII value,
since label-matching only covers "Label: value" rows and misses a member number
rendered inline in a panel heading. Only values already declared PII are sent
into the page; secrets never are, and password fields are masked structurally.
One deliberate asymmetry: the operator's live view is unmasked, because a masked
screen is useless to the person we just asked to finish a real task.

Limits I would not paper over. Every guardrail above except the allowlist was
found bypassable by adversarial review *after* I had written prose asserting it
held — and the first round of fixes was itself bypassed by the obvious next
variation, because I had denylisted path spellings instead of checking values.
Two rounds of that is the honest signal here: my instinct is to write the
control and the claim at the same time, and the claim is cheap. The tests that
now cover these were all written after something broke. The risk heuristic also
has false positives (it flags "Open Sub-Account", which only opens a form) and
would miss an app whose commit button says "OK". Pattern-based redaction is best-effort by nature. And
discovery sends screenshots to a third-party model — masked, but the honest
answer for production is a model inside the institution's boundary. Replay,
where the volume is, never calls a model at all.

## 7. Cuts

**Cut deliberately.** No desktop surface — the seam is designed, only the web
driver exists. No real-time co-browsing; the console polls screenshots, enough to
prove the control model, and would be a CDP screencast in production. No queue,
scheduler or persistence beyond JSON on disk — git is a good store for artifacts
reviewed, versioned and diffed by humans. No user accounts on the operator
console (authorization is enforced; authentication is a shared-secret env var at
best). No confidence scoring or flakiness signal.

**What probing closed, and what it did not.** Running a real model showed that
every outcome detector it proposed was a guess at wording, and none matched.
Probing fixes the paths a job declares an input for, and proves proposed
recoveries by re-running them. It does not fix what no probe covers — an
application error page, an outage banner, a condition needing a second operator
to set up. Those ship `verified: false` and are what review is for: `@1.0.0`
versus `@1.1.0`, with the decisions recorded in `scripts/apply-review.ts`.

**Verified against a live model, with two caveats.** `gemini-2.5-flash-lite`
drove the real application end to end (`evidence/00-discovery-gemini-live`). Two
things are disclosed rather than tidied away: its log leaked the operator
password into the model's own prose and was scrubbed retroactively with the
product's own redactor, and three of its outputs were dropped by the
trailing-colon mismatch described above — both fixed, but that artifact predates
the fixes. The shipped demo path uses the scripted driver so the evidence
regenerates without a key, and its script reproduces what Gemini actually
returned — wrong marker and SSN output included — rather than an idealised
version.

**A practical note.** The Gemini free tier is 20 requests per day *per model*
and a discovery run costs about seven, so the provider distinguishes three
cases: per-minute limits wait out the delay the API supplies, transient 503s
back off exponentially, and a daily quota fails immediately rather than retrying
for seven minutes to arrive in the same place.

**Next, in order.** (1) Extend probing past declared inputs — fault injection
against a staging instance would cover the conditions no input can produce.
(2) Replay-stability scoring:
run N times, score, and gate unattended execution on the score as well as
approval. (3) A bounded, policy-checked single-step LLM recovery on replay
failure, recorded as evidence and offered to a reviewer as a proposed patch —
the natural next use of the escalation seam that already exists. (4) A second
surface driver, because the seam is only proven once something other than a
browser is behind it.
