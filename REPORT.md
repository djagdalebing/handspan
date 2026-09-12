# Design write-up

## 1. Architecture

One TypeScript process, five hard boundaries. Not distributed, deliberately:
nothing here is throughput-bound, and a queue adds operational surface without
answering any question the brief asks.

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
list of controls — role, accessible name, frame path, bounds, value — and actions
are human-scale verbs against one of them. Nothing above that line knows what a
DOM is, and those are the same fields a Win32/UIA tree gives you.

So not Playwright locators: a CSS selector cannot cross the seam, an accessible
name can. The driver derives a name from whatever the page offers, falling back —
the case that matters — to *the text in the table cell to the left of the field*.
On an app with no `id`, no `label` and no ARIA, that is what makes "the textbox
labelled Member Number" resolvable.

Discovery and replay share everything except the decision-maker: the model picks
from the same control list the engine resolves against and never writes a
selector, which is what makes a run *recordable* rather than reverse-engineered
from a transcript.

## 2. Artifact schema

`src/artifact/schema.ts`, shaped by three audiences at once: an agent that needs
a signature, a reviewer who must approve it without reading my source, and an
engine that executes it with no model available.

- **Targets are semantic, never selectors** — each field of a `Target` is an
  independent signal, the only identity a reviewer can check and the only one
  that survives a change of surface technology.
- **The error taxonomy lives in the artifact.** Which screens are business
  outcomes, recoverable interstitials or application failures is knowledge about
  *the application*; in engine code, every new app needs an engine change.
- **One condition language, three uses** — checkpoints, outcomes and
  interstitials are all `Condition`s: one grammar, one evaluator.
- **Risk is per step**, because a real flow is nine navigational steps and one
  that posts a journal entry.

Also carried: parameter **sensitivity**, declared rather than inferred, because a
guessing redactor eventually guesses wrong on regulated data; `secretRef`, so
credentials never enter the artifact; per-step **fingerprints**, so drift is a
signal rather than a mystery failure months later; and `approval`, because a
model-authored flow does not promote itself.

Beyond serialising the trace the recorder **minimises and verifies** each
descriptor, adding disambiguators only while it still fails to re-resolve
uniquely against the screen it was recorded on; **canonicalises** values into
parameters, including those buried in panel headings and row text, where
record-specific data hides; and **validates the model's proposals**, discarding a
detector that also fires on the success screen.

## 3. Determinism & error handling

**Resolution refuses to guess.** A selector ladder silently acts on the *wrong*
control, because rung four matches what rung one did not mean — fatal where two
adjacent buttons are "Post" and "Cancel". Every candidate is scored against every
recorded signal and a *unique* winner is required; ambiguity is a hard failure.
One concession, reported as drift: if the strict match finds nothing, a
punctuation-normalised retry runs, accepted only if exactly one candidate
survives. Legacy apps churn "Member Number:" into "Member No." far more often
than they restructure a screen.

**Every step is self-verifying.** Each postcondition is derived from what
happened next, so waiting is condition-based rather than timed, which also
absorbs transient slowness. Settling polls *every frame's* `readyState`: on a
frameset a link inside `main` does not reload the top document, so
`waitForLoadState` returns instantly and you observe a blank frame.

**The result contract separates whose problem it is** — `success` /
`business_outcome` / `needs_human` / `failure`, with thirteen failure classes.
"No such member" is an answer; returning it as an error trains callers to retry
on it. A recognised *application* failure reports as `APP_ERROR` carrying the
app's own error code, not "could not find the Search button".

**Detectors are verified against real screens, not trusted** — which I only found
by running a real model. Gemini proposed a `MEMBER_NOT_FOUND` detector matching
text this app never prints, so it would never fire and a legitimate outcome would
surface as a step timeout, breaking the exact distinction the contract rests on.
So discovery probes: a job declares one cheap fact ("member 99999 does not
exist"), the recorded flow is replayed against it, and the detector is rebuilt
from what the app actually says, preferring its error code to prose. Markers that
also fire on the success screen or another probe's are rejected; a missing
recovery is read off the screen the flow stalled on and proved by a second probe.
Probes cost no model calls and run with irreversible steps blocked; what no probe
covers ships `verified: false`.

Session expiry cannot be resumed from, so recovery runs a separate sign-on
capability and restarts — but **only for read-only capabilities**, since for
anything mutating the UI cannot tell you whether the pre-expiry attempt
committed.

## 4. Heterogeneity & multi-tenant

**Other surfaces.** A desktop driver supplies role, name, window path and bounds
from UIA/AX and implements six verbs; schema, locator, condition language, engine
and escalation model are unchanged, `framePath` becoming a window path and
`domHint` going unused — which is why it is declared the weakest signal and never
sufficient alone. The URL-shaped parts of the policy have no desktop analogue. Legacy web is not a
different surface at all; it is the case the driver was written for, which is why
the target app is a frameset with no test IDs.

**Cross-tenant reuse.** A tenant gets typed patches against a **pinned base
version**, so the base improves once and is inherited everywhere while each
institution's delta stays reviewable. The pin stops a base change silently
re-targeting a patch at a step that moved; an unresolvable patch is rejected,
never created. Renaming one button needs patching two places — the step that
clicks it and the condition that waits for it — and missing the second produced a
flow that clicked the right button then timed out on the old one; hence a
`rename` patch that rewrites a label at every reference and reports the count.
Per-step fingerprints are the other half, recompared every replay, so a diverged
tenant reports drift on runs that still succeed.

## 5. Escalation & handoff

"Stuck" is detected four ways, each with its own reason code: an unresolvable or
ambiguous target; a step that acted but whose postcondition never appeared; an
interstitial that will not clear; and, in discovery, an unchanged screen
signature or the model asking for help. A step whose risk meets the confirmation
threshold escalates *before* acting.

Control transfer is a lease with a single-writer invariant:
`AUTOMATION → PENDING → HUMAN → AUTOMATION`. `PENDING` exists because raising a
request and a human picking it up are minutes apart, and the automation must be
stopped through that window rather than still clicking. Release signals are
scoped to the handoff that asked for them, and only the lease-holder may release
— both were bugs first, and both are now attacked by tests.

The human gets *the same session* — what makes this real rather than a
notification, since a bank session carries authentication, a navigation position,
a half-filled form and often a server-side lock. The console polls screenshots
and forwards input to the live page; context is captured *before* the automation
stops, because it will not survive the wait.

The three dispositions differ. **Resume** means an obstacle was cleared, so the
engine first checks whether the step's postcondition already holds — if the
operator made it true, re-running would at best fail and at worst repeat
something. **I finished it** skips to verifying the checkpoint and extracting
outputs (`evidence/09` returns real outputs after 10 of 11 steps). **Abort**
stops and tells the caller. An unanswered escalation is bounded and returns
`needs_human`; unbounded "escalate" is a hang, not a safety property. Human
actions are recorded, typed *content* only as a character count — they are typing
into a live banking screen and we have no declaration of what it is.

## 6. Safety

**The allowlist is the hard boundary**, enforced at one chokepoint every
navigation passes through — discovery, replay, recovery handlers, operator
navigation — as the intersection of the deployment's policy and the capability's
declared origins. For that second half to mean anything, a capability declares
only the origins its recording touched, per-tenant origins come from a
deployment-owned registry rather than from the overlay asking for them, and an
empty list denies everything, so an unknown tenant fails closed.

**Risk classification is a heuristic floor, not a guarantee.** Guessing from a
label whether "Post Account" commits something is defeatable, so the guess only
decides *when to stop and ask*; it never authorises. The durable controls are a
reviewed risk label on every step and `approved` for unattended replay, and
neither is switchable off by the caller: `--risky proceed` and `--allow-draft`
need the *deployment* to opt in, and `invoke` refuses them outright, because an
agent calling capabilities by name is the untrusted side.

That label is itself a floor. An overlay may not relabel a step's risk but may
legitimately *retarget* one, so the gate resolves the target first and re-derives
risk from the control it is about to operate, taking whichever is higher. Overlay
integrity compares guarded fields to the base **by value**, reverts what moved,
and re-validates against the schema — guarding path *spellings* was my first
attempt and lost to someone spelling it differently. Recovery actions inside an
interstitial are risk-gated too.

Irreversible actions **escalate rather than block**: in back-office banking the
irreversible step is usually the entire point, and a system that refuses to post
anything is not safe, it is useless, and it gets routed around.

Secrets are referenced by name and never written anywhere; discovery also
registers the credential values with the redactor up front, because the model
reads the sign-on hint off the screen and types it as a literal. Regulated fields
are identified by label, covering both spellings one arrives in (`Member Name`,
`memberName`) and the bare person-words this domain uses. PII becomes a pseudonym
salted per process — unsalted, four hex characters over a five-digit member
number is an encoding, not a pseudonym. Screenshots are masked in-page before
capture, by label *and* by value. One deliberate asymmetry: the operator's live
view is unmasked, because a masked screen is useless to the person we just asked
to finish the task — which is also why the console binds loopback only.

**Limits I would not paper over.** Three rounds of adversarial review each found
guardrails bypassable *after* I had written prose asserting they held, and the
first two rounds of fixes were themselves bypassed. My instinct is to write the
control and the claim together, and the claim is cheap; every test covering these
was written after something broke. The risk heuristic would also miss a commit
button labelled "OK", pattern redaction is best-effort, and discovery sends
masked screenshots to a third-party model — where the production answer is a
model inside the institution's boundary.

## 7. Cuts

**Cut deliberately.** No desktop surface — the seam is designed, only the web
driver exists. No real-time co-browsing: the console polls screenshots, enough to
prove the control model, and would be a CDP screencast in production. No queue,
scheduler or persistence beyond JSON on disk — git is a good store for artifacts
reviewed, versioned and diffed by humans. No user accounts on the console;
authorization is enforced, but authentication is a shared-secret env var at best.
No flakiness scoring.

**What probing did not close.** It fixes the paths a job declares an input for,
not what no probe covers — an application error page, an outage banner, a
condition needing a second operator. Those ship `verified: false` and are what
review is for: the `@1.0.0`/`@1.1.0` diff, recorded in `scripts/apply-review.ts`.

**Verified against a live model, with two caveats** disclosed in
`evidence/README.md`: the run's log leaked the operator password into the model's
own prose and was scrubbed retroactively, and three outputs were lost to a
label-matching bug — both fixed, but that artifact predates the fixes. The demo
path uses the scripted driver so evidence regenerates without a key, reproducing
what Gemini actually returned, wrong marker included.

**Next, in order.** Extend probing past declared inputs, with fault injection
against a staging instance. Replay-stability scoring, gating unattended execution
on the score as well as approval. A bounded, policy-checked single-step LLM
recovery on replay failure, offered to a reviewer as a patch. A second surface
driver, because the seam is only proven once something other than a browser is
behind it.
