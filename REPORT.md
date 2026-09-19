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
- **Risk is per step** — a real flow is nine navigational steps and one that
  posts a journal entry.

Also carried: parameter **sensitivity**, declared rather than inferred, because a
guessing redactor eventually guesses wrong on regulated data; `secretRef`, so
credentials never enter the artifact; per-step **fingerprints**, so drift is a
signal rather than a mystery failure later; and `approval`, because a
model-authored flow does not promote itself.

Beyond serialising the trace the recorder **minimises** each descriptor, adding
disambiguators only while it still fails to re-resolve uniquely against the
screen it was recorded on; **canonicalises** values into parameters, including
those buried in panel headings and row text; and **validates the model's
proposals**, discarding a detector that also fires on the success screen.

## 3. Determinism & error handling

**Resolution refuses to guess.** A selector ladder silently acts on the *wrong*
control — fatal where two adjacent buttons are "Post" and "Cancel". Every
candidate is scored against every recorded signal and a *unique* winner is
required; ambiguity is a hard failure. One concession, reported as drift: if the
strict match finds nothing, a punctuation-normalised retry runs, accepted only
if exactly one candidate survives. Legacy apps churn "Member Number:" into
"Member No." far more often than they restructure a screen.

**Every step is self-verifying.** Each postcondition is derived from what
happened next, so waiting is condition-based rather than timed, which also
absorbs transient slowness. Settling polls *every frame's* `readyState`: on a
frameset a link inside `main` does not reload the top document, so a page-level
load wait returns instantly and you observe a blank frame. Polling readyState
is still not enough on its own: a click submits into `main` before the new
document begins loading, so every frame reads `complete` and settling finishes
on the screen the click left. Settling now waits for a frame to actually
depart, capped at 1.2s.

**The loop tells the model what changed, not where it is.** Reporting the
top-level URL after each action is a constant on a frameset — the surface this
exists for — so the model's only feedback signal was fixed. It clicked Search,
was told it was still at `/desk`, re-clicked the navigation link, wiped the
form it had just filled, and stalled. Each turn now reports the controls that
appeared and vanished, values that changed, and any new message on screen; an
action that changed nothing says so in those words. I found this by watching a
live run fail on it, not by reading the code.

**The result contract separates whose problem it is** — `success` /
`business_outcome` / `needs_human` / `failure`, with thirteen failure classes.
"No such member" is an answer; returning it as an error trains callers to retry
on it. A recognised *application* failure reports as `APP_ERROR` carrying the
app's own error code, not "could not find the Search button".

**Detectors are verified against real screens, not trusted** — which I only found
by running a real model. Gemini proposed a `MEMBER_NOT_FOUND` detector matching
text this app never prints, so it would never fire and a legitimate outcome would
surface as a step timeout. So discovery probes: a job declares one cheap fact
("member 99999 does not exist"), the recorded flow is replayed against it, and
the detector is rebuilt from what the app actually says, preferring its error
code to prose. Markers that also fire on the success screen or another probe's are rejected.
A repaired detector is not trusted on the strength of having scraped some text:
it is re-probed, and `verified` is set only when the run itself reports that
outcome — which is what a calling agent reads the flag as meaning. Same for a
recovery read off a stalled screen. Probes cost no model calls and run with
irreversible steps blocked; what no probe proves ships `verified: false`.

Session expiry cannot be resumed from, so recovery runs a separate sign-on
capability and restarts — but **only for read-only capabilities**, since for
anything mutating the UI cannot tell you whether the pre-expiry attempt
committed.

## 4. Heterogeneity & multi-tenant

**The seam is proven, not asserted.** There are two `Surface` implementations.
The second is a 3270-style green screen over a socket — no DOM, no element ids,
no accessibility tree, no URL, just an 80x24 grid of characters, which is what a
great many credit-union back offices actually are. A control is recovered there
the way a human recovers one, from the label printed beside it: on the web that
was the table cell to the left, on the terminal the text before the colon. Same
idea, completely different mechanism.

Nothing above `Surface` changed to make that work. Both halves of the loop run
there: `evidence/14` records a capability *from the character grid* — probes
included, repairing a hallucinated detector into `MCS-0404` exactly as on the
web — and then replays the capability a model recorded against the *frameset
web app* against the green screen. One limit worth stating plainly: I wrote both
applications, and they print the same `MCS-` error codes, which is exactly what
lets the detectors port. A genuine cross-vendor pair would not hand you that,
and the honest claim is that the *perception and action seam* holds, not that
detector portability comes free — same steps, same semantic targets, same outputs, same checkpoint, and
the same `MEMBER_NOT_FOUND`/`MEMBER_RESTRICTED` detectors, which fire because
both surfaces print the same `MCS-` codes. The entire tenant delta is two
patches: where the session starts, and one heading the terminal renders with a
hyphen where the web app uses an em dash. `framePath` goes unused (a terminal
has one screen; a desktop driver would carry the window path) and `bounds` are
row/column rather than pixels. Building it also forced the allowlist to stop
being web-shaped: a location is a URI of any scheme, so `tn3270://host:port` is
checked exactly as `http://host:port`.

**Cross-tenant reuse.** A tenant gets typed patches against a **pinned base
version**, so the base improves once and is inherited everywhere while each
institution's delta stays reviewable, and the pin stops a base change silently
re-targeting a patch at a step that moved. Renaming one button needs patching
two places — the step that clicks it and the condition that waits for it — and
missing the second produced a flow that clicked the right button then timed out
on the old one; hence a `rename` that rewrites a label at every reference and
reports the count. Per-step fingerprints are the other half, recompared every
replay, so a diverged tenant reports drift on runs that still succeed.

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
outputs (`evidence/09`: real outputs after 10 of 11 steps). **Abort** stops and
tells the caller. An unanswered escalation is bounded and returns `needs_human`.
Human actions are recorded, typed *content* only as a character count.

## 6. Safety

**The allowlist is the hard boundary**, enforced by one function every *replay*
navigation passes through — step, recovery handler, nested capability, operator
console, any surface — as the intersection of the deployment's policy, the
capability's declared origins, and, for a nested capability, the origins its
caller was confined to. That last term was missing, and its absence made
composition a way out of a tenant: a capability overlaid onto one institution
hit `SESSION_EXPIRED`, ran the shared sign-on capability, and *that* artifact's
declaration — the instance it happened to be recorded against — replaced the
caller's. A session bound to one credit union typed its operator's credential
into another's application and the run reported success. A composed capability
may narrow what it can reach; it may never widen it, and an empty intersection
denies everything rather than guessing which origin was meant.
Discovery checks the deployment policy alone,
because the capability whose origins would form the other half does not exist
yet; the entry point's origin bounds the operator instead. It lived only in the engine for a while, so the
console was checked against the deployment policy alone; in the target
environment one deployment lists every tenant's origin, which made that the
difference between isolation and none. For that second half to mean anything, a
capability declares only the origins its recording touched, per-tenant origins
come from a deployment-owned registry rather than from the overlay asking for
them, and an empty list denies everything. The files naming those rules come
from the host environment, not argv: a caller who can point `--policy` at their
own file has replaced the rules rather than bent them, and the override check
used to load the very file it was checking.

**Risk classification is a heuristic floor, not a guarantee.** Guessing from a
label whether "Post Account" commits something is defeatable, so the guess only
decides *when to stop and ask*; it never authorises. The durable controls are a
reviewed risk label on every step and `approved` for unattended replay, and
neither is switchable off by the caller: `--risky proceed` and `--allow-draft`
need the *deployment* to opt in, and `invoke` refuses them outright, because an
agent calling capabilities by name is the untrusted side.

That label is itself a floor. An overlay may not relabel a step's risk but may
legitimately *retarget* one, so the gate resolves the target first and re-derives
risk from the control it is about to operate, taking whichever is higher.

Overlay integrity took three attempts. A denylist of path *spellings* lost to
patching one level up. Comparing a hand-enumerated set of fields by value
afterwards still missed `sensitivity`, and "restored" injected outcome codes by
looking them up in a base where they did not exist — reporting a revert that had
not happened, which is worse than no guardrail. It is now an **allow-list**: a
patch is refused unless its path is one tenant specialisation actually needs,
and refused *before* being applied, so the audit line cannot lie. Paths that change what *counts* as success stay patchable, since tenants word
them differently, but require `conditionsReviewedBy` to be filled in. That is a
*declaration*, not a control: it is free text in the same file, so it forces the
question to be answered rather than proving the answer. Making it a control
means signed overlays, which is a real gap and not something a required string
papers over. Recovery actions are risk-gated too, and a composed
`run_capability` is version-pinned.

The allow-list closed the channel and opened a narrower one, which is the more
interesting failure. Classification of an output's sensitivity keyed off the
artifact's *matcher*, and `outputs[].source.label` is a `contains` pattern a
tenant may reword legitimately — so `"N (last 4)"` matched the `SSN (last 4)`
readout, missed the sensitive-label list, and an approved overlay returned an
SSN to the calling agent under an output declared `internal`. The label that
decides is now the one the *screen* used, reported back by the extractor,
because a tenant gets no vote on what the application prints. And since
registering a value only ever protected the log, an output that reads more than
it declares now hands the *caller* a pseudonym too, with `underDeclared` naming
it — an output declared `pii` is still returned in clear, because a reviewer
approved that and the catalog shows it.

Irreversible actions **escalate rather than block**: in back-office banking the
irreversible step is usually the entire point, and a system that refuses to post
anything is not safe, it is useless, and it gets routed around.

Secrets are referenced by name and never written anywhere, and a password
field's value is never *perceived*, so it cannot reach a prompt, a log or an
artifact by any route. Everything describing the screen is redacted before it
leaves the process: masking a screenshot while shipping the same data as text in
the same request is a costume, not a control, and that is how this shipped. The
parameters block is deliberately not redacted — the model must type the member
number to do the task, which is this design's irreducible disclosure and the
reason the production answer is a model inside the boundary. Regulated fields
are identified by label, covering both spellings one arrives in (`Member Name`,
`memberName`) and the bare person-words this domain uses. PII becomes a pseudonym
salted per process — unsalted, four hex characters over a five-digit member
number is an encoding, not a pseudonym. Screenshots are masked in-page by label
*and* value. One asymmetry: the operator's live view is unmasked, because a
masked screen is useless to the person we asked to finish the task — which is
why the console binds loopback only and requires a token on every endpoint,
reads included, generating one when the deployment does not supply it. It
defaulted to no authentication at all, undocumented, which made the endpoint
that authorises a posting open to anything that could reach the port.

**Limits I would not paper over.** Three rounds of adversarial review each found
guardrails bypassable *after* I had written prose asserting they held, and the
first two rounds of fixes were themselves bypassed. My instinct is to write the
control and the claim together, and the claim is cheap; every test covering these
was written after something broke. The risk heuristic would also miss a commit
button labelled "OK", pattern redaction is best-effort, and discovery sends
masked screenshots to a third-party model — where the production answer is a
model inside the institution's boundary.

## 7. Cuts

**Cut deliberately.** No desktop surface. Two drivers exist, web and green
screen, so the seam is exercised rather than assumed, but a UIA/AX driver would
test it hardest. No real-time co-browsing: the console polls screenshots, enough to
prove the control model, and would be a CDP screencast in production. No queue,
scheduler or persistence beyond JSON on disk — git is a good store for artifacts
reviewed, versioned and diffed by humans. No user accounts on the console;
authorization is enforced, but authentication is a shared-secret env var at best.
No flakiness scoring.

**What probing did not close.** It fixes the paths a job declares an input for,
not what no probe covers — an application error page, an outage banner, a
condition needing a second operator. Those ship `verified: false` and are what
review is for.

**Verified against a live model, with two caveats** disclosed in
`evidence/README.md`: the run's log leaked the operator password into the model's
own prose and was scrubbed retroactively, and three outputs were lost to a
label-matching bug — both fixed, but that artifact predates them. The demo path
uses the scripted driver so evidence regenerates without a key, reproducing what
Gemini actually returned, wrong marker included.

**Next, in order.** Extend probing past declared inputs, with fault injection
against a staging instance. Replay-stability scoring, gating unattended execution
on the score as well as approval. A bounded, policy-checked single-step LLM
recovery on replay failure, offered to a reviewer as a patch.
