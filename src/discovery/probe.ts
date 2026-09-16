/**
 * Probing the unhappy paths, and verifying the model's guesses against them.
 *
 * This closes the most dangerous gap in the record-once model. A model that
 * has seen one successful run proposes business outcomes by *guessing the
 * wording* — it offers a `MEMBER_NOT_FOUND` detector looking for "Member not
 * found" when the application actually says "No member record found for the
 * number entered". That detector never fires. The run does not report the
 * outcome; it times out and reports a failure instead, which is exactly the
 * distinction the whole result contract rests on, silently broken.
 *
 * The fix is to stop guessing. A probe case is one cheap piece of human
 * knowledge — "member 99999 does not exist" — and from it we can replay the
 * *just-recorded* flow deterministically, see what the application really
 * says, and build the detector from that. No extra model calls; the flow we
 * replay is the one we just recorded.
 *
 * Two safety properties matter here:
 *
 *   - probes run with `riskyActions: 'block'`, so a probe can never execute a
 *     step the capability declares irreversible. Probing a flow that posts a
 *     transaction must not post one.
 *   - a detector built from a probe is cross-checked against the success
 *     screen and against every *other* probe screen, so a marker that fires on
 *     two different conditions is rejected rather than silently preferred.
 */
import type { Capability, Condition, Interstitial, Outcome } from '../artifact/schema.js';
import type { Observation, Surface } from '../surface/types.js';
import type { LiveControl } from '../surface/web/playwright-surface.js';
import type { CredentialProvider } from '../safety/credentials.js';
import type { Redactor } from '../safety/redact.js';
import type { RunLog } from '../observability/run-log.js';
import type { Policy } from '../safety/policy.js';
import { SessionControl } from '../escalation/control.js';
import { ReplayEngine } from '../replay/engine.js';
import { evaluate } from '../replay/conditions.js';
import type { Bindings } from '../replay/template.js';

export interface ProbeCase {
  /** The outcome or interstitial code this input is expected to produce. */
  code: string;
  description: string;
  inputs: Record<string, string>;
  /**
   * `business_outcome` — the flow should stop and report `code`.
   * `success` — the flow should still complete, because `code` names an
   * interstitial that the recorded recovery is supposed to clear.
   */
  expect?: 'business_outcome' | 'success';
}

export interface ProbeResult {
  case: ProbeCase;
  status: string;
  observation: Observation | null;
  /** The most prominent message on the screen the probe ended on. */
  alert?: string;
}

export interface ProbeDeps {
  surface: Surface & Partial<LiveControl>;
  policy: Policy;
  credentials: CredentialProvider;
  log: RunLog;
  redactor: Redactor;
  runId: string;
}

export async function runProbes(
  capability: Capability,
  cases: ProbeCase[],
  deps: ProbeDeps
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const c of cases) {
    deps.log.event('note', { message: 'probing unhappy path', code: c.code, inputs: Object.keys(c.inputs) });
    const engine = new ReplayEngine({
      runId: deps.runId,
      surface: deps.surface,
      policy: deps.policy,
      credentials: deps.credentials,
      log: deps.log,
      redactor: deps.redactor,
      control: new SessionControl(`${deps.runId}-probe-${c.code}`),
      allowEscalation: false,
      riskyActions: 'block',
      requireApproval: false,
    });

    const result = await engine.run(capability, c.inputs);
    const observation = engine.lastObservation;
    results.push({
      case: c,
      status: result.status === 'business_outcome' ? `business_outcome:${result.code}` : result.status,
      observation,
      alert: observation ? prominentAlert(observation) : undefined,
    });
    deps.log.event('note', {
      message: 'probe finished', code: c.code, status: result.status,
      alert: observation ? prominentAlert(observation) : undefined,
    });
  }

  return results;
}

/**
 * Rewrites the capability's declared outcomes so that each probed code is
 * detected by what the application actually says.
 */
export function verifyWithProbes(
  capability: Capability,
  probes: ProbeResult[],
  successObs: Observation,
  bindings: Bindings
): {
  capability: Capability;
  warnings: string[];
  notes: string[];
  synthesised: string[];
  /** Detector codes that were built or repaired here and still need proving. */
  pending: string[];
} {
  const cap = JSON.parse(JSON.stringify(capability)) as Capability;
  const warnings: string[] = [];
  const notes: string[] = [];
  /** Codes whose recovery was proposed here and still needs re-probing. */
  const synthesised: string[] = [];
  /** Outcome codes whose detector was built or repaired and is not yet proven. */
  const pending: string[] = [];

  for (const probe of probes) {
    const expect = probe.case.expect ?? 'business_outcome';

    if (!probe.observation) {
      warnings.push(`probe ${probe.case.code}: captured no screen, so it could not be verified`);
      continue;
    }

    // An interstitial probe is verified by the run still completing: if the
    // recorded recovery had not cleared the screen, this would have failed.
    if (expect === 'success') {
      const hit = cap.interstitials.find((i) => i.code === probe.case.code);
      if (probe.status === 'success' && hit) {
        hit.verified = true;
        notes.push(`interstitial ${probe.case.code} verified: the flow hit it and recovered`);
        continue;
      }
      if (probe.status === 'success' && !hit) {
        warnings.push(`probe ${probe.case.code}: the flow succeeded but no interstitial of that code is declared`);
        continue;
      }

      // The flow got stuck on the screen it was supposed to clear. We are
      // looking at that screen, so rather than only reporting the gap we can
      // propose the recovery from it: the message to detect it by, and the
      // control an operator would press to move on. It is proposed, not
      // trusted — the caller re-probes to find out whether it actually works.
      const synth = synthesiseInterstitial(probe);
      if (!synth) {
        warnings.push(
          `probe ${probe.case.code}: expected the flow to recover and complete, but it returned ` +
          `${probe.status}, and the screen offers no obvious way to clear it`
        );
        continue;
      }
      if (evaluate(synth.when, successObs, bindings, [])) {
        warnings.push(`probe ${probe.case.code}: the screen's message also appears on the success screen; cannot detect it`);
        continue;
      }
      const idx = cap.interstitials.findIndex((i) => i.code === probe.case.code);
      if (idx >= 0) cap.interstitials[idx] = synth;
      else cap.interstitials.push(synth);
      synthesised.push(probe.case.code);
      notes.push(
        `interstitial ${probe.case.code} proposed from the screen the flow stalled on ` +
        `(clear it with "${(synth.do[0] as { target: { name: string } }).target.name}")`
      );
      continue;
    }

    const matching = cap.outcomes.filter((o) => evaluate(o.when, probe.observation!, bindings, []));

    if (matching.length === 1 && matching[0]!.code === probe.case.code) {
      // Firing on the captured screen is necessary but not sufficient. What
      // `verified` is supposed to mean — and what a calling agent reads it as —
      // is that this detector actually produced this outcome on a real run. So
      // the run's own verdict decides; a detector that matches a screen the
      // engine nonetheless failed on is not verified, it is a candidate.
      if (probe.status === `business_outcome:${probe.case.code}`) {
        matching[0]!.verified = true;
        notes.push(`outcome ${probe.case.code} verified: the run reported it`);
      } else {
        matching[0]!.verified = false;
        pending.push(probe.case.code);
        notes.push(
          `outcome ${probe.case.code} matches the screen but the run returned ${probe.status}; re-probing`
        );
      }
      continue;
    }

    if (matching.length > 1) {
      warnings.push(
        `probe ${probe.case.code}: ${matching.map((m) => m.code).join(' and ')} both fire on this screen; ` +
        `the detectors are ambiguous and need a reviewer`
      );
      continue;
    }

    // Nothing matched, or the wrong code matched. Build the detector from
    // what the application actually said.
    const marker = markerFrom(probe.observation);
    if (!marker) {
      warnings.push(
        `probe ${probe.case.code}: the flow returned ${probe.status} but the screen carries no message ` +
        `to detect it by; a reviewer needs to supply one`
      );
      continue;
    }

    const condition: Condition = {
      type: 'textMatches',
      value: { mode: 'contains', value: marker, caseSensitive: false },
    };

    // Refuse a marker that also fires on success or on another probe.
    if (evaluate(condition, successObs, bindings, [])) {
      warnings.push(`probe ${probe.case.code}: the observed message "${marker}" also appears on the success screen; skipped`);
      continue;
    }
    const collides = probes.find(
      (other) => other !== probe && other.observation && evaluate(condition, other.observation, bindings, [])
    );
    if (collides) {
      warnings.push(
        `probe ${probe.case.code}: the observed message "${marker}" also appears on the ` +
        `${collides.case.code} screen; skipped as ambiguous`
      );
      continue;
    }

    const existing = cap.outcomes.find((o) => o.code === probe.case.code);
    if (existing) {
      const was = describeMatcher(existing.when);
      existing.when = condition;
      existing.verified = false;
      pending.push(probe.case.code);
      notes.push(`outcome ${probe.case.code} repaired: ${was} → "${marker}" (what the app actually says)`);
      warnings.push(
        `outcome ${probe.case.code} was proposed as ${was}, which never matches this application; ` +
        `replaced with the observed message`
      );
    } else {
      cap.outcomes.push({
        code: probe.case.code,
        description: probe.case.description,
        when: condition,
        classification: 'business',
        afterSteps: [],
        terminal: true,
        outputs: [],
        // Proposed, not proven. The re-probe below decides.
        verified: false,
      } satisfies Outcome);
      pending.push(probe.case.code);
      notes.push(`outcome ${probe.case.code} added from a probe: "${marker}"`);
    }
  }

  warnings.push(...unverifiedWarnings(cap));
  return { capability: cap, warnings, notes, synthesised, pending };
}

/**
 * Detectors nothing has confirmed.
 *
 * Prefixed so a later pass can discard and recompute them: a recovery that was
 * proposed and then proven by a re-probe must not still be reported as
 * unverified from the first pass.
 */
const UNVERIFIED = 'unverified: ';

export function unverifiedWarnings(cap: Capability): string[] {
  const out: string[] = [];
  for (const o of cap.outcomes) {
    if (!o.verified) {
      out.push(`${UNVERIFIED}outcome ${o.code} — no probe confirmed it ever fires; review before relying on it`);
    }
  }
  for (const i of cap.interstitials) {
    if (!i.verified) {
      out.push(`${UNVERIFIED}interstitial ${i.code} — no probe confirmed its recovery works`);
    }
  }
  return out;
}

/**
 * Builds a recovery from the screen the flow stalled on: a message to
 * recognise it by, and the control to press.
 *
 * Choosing the control is the part that needs care. One button is
 * unambiguous. Several means guessing, and the guess is only safe if exactly
 * one of them reads like an acknowledgement — anything else could be a button
 * that commits something, so we decline and let a human look.
 */
function synthesiseInterstitial(probe: ProbeResult): Interstitial | null {
  const obs = probe.observation;
  if (!obs) return null;

  const marker = markerFrom(obs);
  if (!marker) return null;

  const buttons = obs.nodes.filter((n) => n.role === 'button' && n.name.trim() && !n.disabled);
  const ACKNOWLEDGING = /^(acknowledge|ok|continue|proceed|confirm|accept|dismiss|close)$/i;
  let chosen = buttons.length === 1 ? buttons[0] : undefined;
  if (!chosen) {
    const acks = buttons.filter((b) => ACKNOWLEDGING.test(b.name.trim()));
    if (acks.length === 1) chosen = acks[0];
  }
  if (!chosen) return null;

  return {
    code: probe.case.code,
    description: probe.case.description,
    when: { type: 'textMatches', value: { mode: 'contains', value: marker, caseSensitive: false } },
    do: [{
      kind: 'click',
      target: {
        role: 'button',
        name: chosen.name,
        nameMatch: 'exact',
        framePath: chosen.framePath,
      },
    }],
    maxOccurrences: 2,
    restartFlow: false,
    escalateOnFailure: true,
    verified: false,
  };
}

/**
 * Run probes, verify the detectors against them, and — when a recovery had to
 * be proposed — run those probes again to find out whether the proposal
 * actually works. Probes cost no model calls, so proving a recovery is cheap.
 */
export async function probeAndVerify(
  capability: Capability,
  cases: ProbeCase[],
  successObs: Observation,
  bindings: Bindings,
  deps: ProbeDeps
): Promise<{ capability: Capability; warnings: string[]; notes: string[]; results: ProbeResult[] }> {
  const results = await runProbes(capability, cases, deps);
  const first = verifyWithProbes(capability, results, successObs, bindings);

  // Anything proposed or repaired in that pass is unproven by construction: the
  // detector that would have fired did not exist when the probe ran. Re-run
  // those cases against the amended capability and let the *run's verdict*
  // decide, so `verified` means "this produced this outcome on a real run"
  // rather than "some text was scraped off a screen". Probes cost no model
  // calls, which is what makes proving it affordable.
  const retryCodes = [...new Set([...first.synthesised, ...first.pending])];
  if (retryCodes.length === 0) {
    return { capability: first.capability, warnings: first.warnings, notes: first.notes, results };
  }

  const retryCases = cases.filter((c) => retryCodes.includes(c.code));
  deps.log.event('note', { message: 're-probing proposed detectors and recoveries', codes: retryCodes });
  const retryResults = await runProbes(first.capability, retryCases, deps);

  const warnings = first.warnings.filter((w) => !w.startsWith(UNVERIFIED));
  const notes = [...first.notes];
  const cap = first.capability;

  for (const r of retryResults) {
    const expect = r.case.expect ?? 'business_outcome';

    if (expect === 'success') {
      const hit = cap.interstitials.find((i) => i.code === r.case.code);
      if (!hit) continue;
      if (r.status === 'success') {
        hit.verified = true;
        notes.push(`interstitial ${r.case.code} verified: the proposed recovery cleared it and the flow completed`);
      } else {
        warnings.push(
          `interstitial ${r.case.code}: the proposed recovery still did not clear it (${r.status}); ` +
          `a reviewer needs to supply the right steps`
        );
      }
      continue;
    }

    const outcome = cap.outcomes.find((o) => o.code === r.case.code);
    if (!outcome) continue;
    if (r.status === `business_outcome:${r.case.code}`) {
      outcome.verified = true;
      notes.push(`outcome ${r.case.code} verified: the repaired detector produced it on a real run`);
    } else {
      warnings.push(
        `outcome ${r.case.code}: the detector was rebuilt from the screen but the run still returned ` +
        `${r.status}, so it ships unverified — something other than the wording is wrong`
      );
    }
  }

  warnings.push(...unverifiedWarnings(cap));
  return { capability: cap, warnings, notes, results: [...results, ...retryResults] };
}

/** The message a human would read as "what went wrong". */
function prominentAlert(obs: Observation): string | undefined {
  const alerts = obs.nodes.filter((n) => n.role === 'alert' && n.name.trim());
  if (alerts.length === 0) return undefined;
  return alerts.map((a) => a.name.replace(/\s+/g, ' ').trim()).sort((a, b) => b.length - a.length)[0];
}

/**
 * The most durable thing to detect an outcome by.
 *
 * These systems put a stable error code on the screen — `MCS-0404` — which is
 * far better than the prose around it: it is unique, it does not get reworded
 * between releases, and it does not carry record-specific data. Fall back to a
 * clipped piece of the message when there is no code.
 */
function markerFrom(obs: Observation): string | null {
  const alert = prominentAlert(obs);
  if (!alert) return null;
  const code = alert.match(/\b[A-Z]{2,6}-\d{3,6}\b/);
  if (code) return code[0];
  const prose = alert.replace(/^[^A-Za-z]*/, '').slice(0, 60).trim();
  return prose.length >= 8 ? prose : null;
}

function describeMatcher(c: Condition): string {
  return c.type === 'textMatches' ? `"${c.value.value}"` : c.type;
}
