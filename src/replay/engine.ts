/**
 * Deterministic replay.
 *
 * No model is consulted here. Every decision the engine makes is either read
 * off the artifact or is a fixed policy of the engine itself, which is the
 * whole point: the expensive, non-deterministic reasoning happened once at
 * discovery time and was frozen into a reviewable document.
 *
 * The step loop is ordered deliberately:
 *
 *   observe → clear interstitials → check declared outcomes → policy gate
 *   → resolve target → act → wait for the step's postcondition
 *
 * Interstitials are cleared *before* outcomes are checked because an
 * acknowledgement screen would otherwise mask the real result underneath it.
 * Outcomes are checked *before* the policy gate because there is no point
 * asking a human to approve a risky click on a screen that has already told
 * us the member does not exist.
 */
import type { Capability, Interstitial, Outcome, Output, Risk, Sensitivity, Step, StepAction, Target } from '../artifact/schema.js';
import type { Action, Observation, Surface, UiNode } from '../surface/types.js';
import type { LiveControl } from '../surface/web/playwright-surface.js';
import type { CredentialProvider } from '../safety/credentials.js';
import type { Redactor } from '../safety/redact.js';
import { looksSensitive } from '../safety/redact.js';
import type { RunLog } from '../observability/run-log.js';
import { denyLocation, Policy } from '../safety/policy.js';

const RISK_RANK: Record<Risk, number> = { safe: 0, mutating: 1, irreversible: 2 };
import { SessionControl, type ReleaseSignal } from '../escalation/control.js';
import { broker, type EscalationReason } from '../escalation/broker.js';
import { evaluate, describe, type ConditionTrace } from './conditions.js';
import { extractOutputs } from './extract.js';
import { fingerprintObservation, resolveTarget } from './locator.js';
import { interpolateDeep, type Bindings } from './template.js';
import {
  emptyDrift,
  type DriftReport,
  type FailureClass,
  type RecoveryRecord,
  type ReplayResult,
} from './result.js';

export interface ReplayOptions {
  runId: string;
  surface: Surface & Partial<LiveControl>;
  policy: Policy;
  credentials: CredentialProvider;
  log: RunLog;
  redactor: Redactor;
  control: SessionControl;
  /** Whether an intervention may be raised. False for batch/unattended runs. */
  allowEscalation: boolean;
  /** What to do at a step whose risk meets the confirmation threshold. */
  riskyActions: 'escalate' | 'block' | 'proceed';
  /** Refuse to replay a capability that is not `approved`. */
  requireApproval: boolean;
  /** Resolves `run_capability` references, honouring a pinned version. */
  resolveCapability?: (id: string, version?: string) => Capability | undefined;
}

const POLL_MS = 350;

export class ReplayEngine {
  private drift: DriftReport = emptyDrift();
  private recoveries: RecoveryRecord[] = [];
  private stepsExecuted = 0;
  private interstitialCounts = new Map<string, number>();
  private startedAt = new Date().toISOString();
  private t0 = Date.now();
  private _lastObservation: Observation | null = null;
  /** Set when an escalation was needed but nobody resolved it. */
  private unresolvedEscalation: { escalationId?: string; reason: string } | null = null;

  /** The most recent screen this run perceived. Used by discovery probes. */
  get lastObservation(): Observation | null {
    return this._lastObservation;
  }

  constructor(private o: ReplayOptions) {}

  async run(cap: Capability, rawInputs: Record<string, unknown>, depth = 0): Promise<ReplayResult> {
    const startedAt = this.startedAt;
    const t0 = this.t0;
    const base = () => ({
      runId: this.o.runId,
      capability: { id: cap.id, version: cap.version },
      startedAt,
      durationMs: Date.now() - t0,
      stepsExecuted: this.stepsExecuted,
      evidenceDir: this.o.log.dir,
      recoveries: this.recoveries,
      drift: this.drift,
    });

    const fail = (
      cls: FailureClass,
      expected: string,
      observed: string,
      extra: { stepId?: string; detail?: string; evidence?: string[] } = {}
    ): ReplayResult => ({
      ...base(),
      status: 'failure',
      failure: {
        class: cls,
        stepId: extra.stepId,
        expected,
        observed,
        detail: extra.detail,
        evidence: extra.evidence ?? [],
      },
    });

    this.o.log.event('run.start', {
      mode: 'replay',
      capability: cap.id,
      version: cap.version,
      approval: cap.approval,
      inputs: Object.keys(rawInputs),
    });

    // -- gate 1: approval -------------------------------------------------
    if (this.o.requireApproval && cap.approval !== 'approved') {
      return fail(
        'APPROVAL_REQUIRED',
        'capability approval state "approved"',
        `capability approval state "${cap.approval}"`,
        { detail: 'unattended replay is gated on human review of the recorded flow' }
      );
    }

    // -- gate 2: typed inputs ---------------------------------------------
    const validated = this.validateInputs(cap, rawInputs);
    if ('error' in validated) {
      return fail('INVALID_INPUT', 'inputs satisfying the declared signature', validated.error);
    }
    const bindings = validated.bindings;

    try {
      // -- preconditions --------------------------------------------------
      for (const pre of cap.preconditions) {
        const obs = await this.observe();
        const trace: ConditionTrace[] = [];
        if (!evaluate(pre, obs, bindings, trace)) {
          const handled = await this.handleStuck(
            cap, 'SESSION_LOST', `precondition not satisfied: ${describe(pre)}`,
            { expected: describe(pre), observed: obs.url }
          );
          if (handled?.disposition !== 'resume' && handled?.disposition !== 'complete') {
            const dump = this.o.log.dumpObservation(obs, 'precondition-failed');
            return fail('SESSION_LOST', describe(pre), `at ${obs.url}`, { evidence: [dump] });
          }
        }
      }

      // -- steps ----------------------------------------------------------
      let humanCompleted = false;
      let restarts = 0;

      for (let i = 0; i < cap.steps.length; ) {
        const step = cap.steps[i]!;
        const elapsed = Date.now() - this.t0;
        if (elapsed > this.o.policy.config.runTimeoutMs) {
          return fail('RUN_TIMEOUT', `the run to finish within ${this.o.policy.config.runTimeoutMs}ms`,
            `still running after ${elapsed}ms at step "${step.id}"`, { stepId: step.id });
        }
        if (this.stepsExecuted >= cap.policy.maxSteps) {
          return fail('RUN_TIMEOUT', `at most ${cap.policy.maxSteps} steps`, `step budget exhausted at "${step.id}"`, { stepId: step.id });
        }

        const r = await this.runStep(cap, step, bindings, depth);
        if (r?.kind === 'result') return r.result;
        if (r?.kind === 'human_completed') { humanCompleted = true; break; }

        if (r?.kind === 'restart') {
          // Only read-only flows may be restarted automatically. For anything
          // mutating we cannot tell from the UI whether the pre-expiry attempt
          // committed, and replaying it could post the transaction twice.
          if (cap.risk !== 'safe') {
            const signal = await this.handleStuck(cap, 'SESSION_LOST',
              `the session was lost part-way through a ${cap.risk} flow and cannot be safely restarted`,
              { stepId: step.id, expected: 'an authenticated session',
                observed: 'signed out; re-running the flow risks duplicating a posted transaction' });
            if (signal?.disposition === 'complete') { humanCompleted = true; break; }
            if (signal?.disposition !== 'resume') {
              return fail('SESSION_LOST', 'an authenticated session for the whole flow',
                'session expired mid-flow', { stepId: step.id,
                  detail: 'capability is not read-only, so automatic restart is refused' });
            }
            // "Resume" means carry on from here, exactly as it does everywhere
            // else. Restarting a mutating flow from step one is the duplicate
            // posting this guard exists to prevent, so an operator saying
            // "resume" must not be the thing that triggers it.
            this.interstitialCounts.clear();
            this.o.log.event('note', {
              message: 'operator resumed a mutating flow after session loss; continuing from the current step rather than restarting',
              atStep: step.id,
            });
            continue;
          }
          if (restarts >= 1) {
            return fail('SESSION_LOST', 'an authenticated session for the whole flow',
              'the session expired again after re-authenticating', { stepId: step.id });
          }
          restarts++;
          this.interstitialCounts.clear();
          this.o.log.event('note', { message: 'session recovered; restarting the flow from the first step', atStep: step.id });
          i = 0;
          continue;
        }
        i++;
      }

      if (humanCompleted) {
        this.o.log.event('note', { message: 'operator completed the task manually; verifying checkpoint' });
      }

      // -- checkpoint -----------------------------------------------------
      const checkpointStep = cap.steps[cap.steps.length - 1]!;
      const finalWait = await this.waitUntil(cap.checkpoint, bindings, 8_000, async (o) => {
        const c = await this.clearInterstitials(cap, checkpointStep, o, bindings);
        if (c.changed) return 'changed';
        return this.matchOutcome(cap, o, bindings, null) ? 'abort' : 'unchanged';
      });
      const finalObs = finalWait.obs;

      // A declared outcome on the final screen outranks a failed checkpoint:
      // "no such member" is the answer, not a broken flow.
      const outcome = this.matchOutcome(cap, finalObs, bindings, null);
      if (outcome) return await this.finishOutcome(cap, outcome, finalObs, bindings, base());

      if (!finalWait.ok) {
        const shot = await this.o.log.screenshot(this.o.surface, 'checkpoint-failed');
        const dump = this.o.log.dumpObservation(finalObs, 'checkpoint-failed');
        return fail(
          'CHECKPOINT_FAILED',
          describe(cap.checkpoint),
          summarizeScreen(finalObs),
          {
            detail: finalWait.trace.filter((t) => !t.result).map((t) => `${t.type}: ${t.detail ?? ''}`).join('; '),
            evidence: [shot, dump].filter(Boolean) as string[],
          }
        );
      }

      // -- outputs --------------------------------------------------------
      const extraction = extractOutputs(cap.outputs, finalObs, bindings);
      for (const out of cap.outputs) {
        this.o.redactor.register(String(extraction.values[out.name] ?? ''), effectiveSensitivity(out), out.name);
      }
      if (extraction.missing.length > 0) {
        const dump = this.o.log.dumpObservation(finalObs, 'output-missing');
        return fail(
          'OUTPUT_MISSING',
          `outputs ${extraction.missing.join(', ')} present on the final screen`,
          extraction.notes.join('; ') || 'not found',
          { evidence: [dump] }
        );
      }

      await this.o.log.screenshot(this.o.surface, 'checkpoint-ok');
      this.o.log.event('run.end', { status: 'success', outputs: extraction.values });
      return { ...base(), status: 'success', outputs: extraction.values };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const shot = await this.o.log.screenshot(this.o.surface, 'surface-error').catch(() => null);
      this.o.log.event('run.end', { status: 'failure', class: 'SURFACE_ERROR', detail });
      return fail('SURFACE_ERROR', 'the surface to remain operable', detail, {
        evidence: shot ? [shot] : [],
      });
    }
  }

  // ------------------------------------------------------------- a step --

  private async runStep(
    cap: Capability,
    step: Step,
    bindings: Bindings,
    depth: number
  ): Promise<{ kind: 'result'; result: ReplayResult } | { kind: 'human_completed' } | { kind: 'restart' } | null> {
    await this.awaitControl();

    let attempt = 0;
    for (;;) {
      attempt++;
      let obs = await this.observe();

      // 1. Clear anything blocking the screen.
      const cleared = await this.clearInterstitials(cap, step, obs, bindings);
      if (cleared.escalationResult) return { kind: 'result', result: cleared.escalationResult };
      if (cleared.humanCompleted) return { kind: 'human_completed' };
      if (cleared.restartRequested) return { kind: 'restart' };
      if (cleared.changed) obs = await this.observe();

      // 2. Has the app already told us the answer?
      //
      // Only once the flow has actually done something. Before the first step
      // executes, whatever is on screen is left over from whatever came
      // before — a previous run, a session the operator had open — and
      // reporting it as this capability's outcome would be a confident,
      // completely wrong answer.
      const outcome = this.stepsExecuted > 0 ? this.matchOutcome(cap, obs, bindings, step.id) : null;
      if (outcome) {
        const result = await this.finishOutcome(cap, outcome, obs, bindings, this.baseFor(cap));
        return { kind: 'result', result };
      }

      // 3. Drift signal (never fatal on its own).
      const recorded = cap.fingerprints[step.id];
      const actual = fingerprintObservation(obs);
      if (recorded && recorded !== actual) {
        if (!this.drift.changedSteps.includes(step.id)) this.drift.changedSteps.push(step.id);
        this.o.log.event('drift.detected', { stepId: step.id, recorded, actual, url: obs.url });
      }

      // 4. Guardrails.
      const kindCheck = this.o.policy.checkActionKind(step.action.kind);
      if (kindCheck.decision === 'deny') {
        return { kind: 'result', result: this.failFor(cap, 'POLICY_DENIED', `action kind ${step.action.kind} permitted`, kindCheck.reason, step.id) };
      }
      if (step.action.kind === 'navigate') {
        // Two allowlists, intersected: the deployment's is the hard boundary,
        // the capability's declared origins are what a reviewer approved it to
        // touch. An empty declared list denies everything — that is what an
        // overlay for an unknown tenant resolves to.
        const denial = this.denyNavigation(cap, interpolateDeep(step.action.url, bindings));
        if (denial) {
          return { kind: 'result', result: this.failFor(cap, 'POLICY_DENIED', 'navigation within the permitted origins', denial, step.id) };
        }
      }

      // Resolve the target before gating, so the gate sees the control that
      // will actually be operated. The declared risk is a *floor*: an overlay
      // may retarget a step it is not allowed to relabel, so a step declared
      // safe that now points at "Post Account" is treated as irreversible.
      let resolvedNode: UiNode | null = null;
      const target = this.targetOf(step.action);
      let boundTarget: Target | null = null;
      if (target) {
        boundTarget = interpolateDeep(target, bindings) as Target;
        const probe = resolveTarget(obs, boundTarget);
        if (probe.ok) resolvedNode = probe.node;
      }
      const derived = Policy.classify(step.action.kind, resolvedNode?.name ?? boundTarget?.name);
      const effectiveRisk = RISK_RANK[derived] > RISK_RANK[step.risk] ? derived : step.risk;
      if (effectiveRisk !== step.risk) {
        this.o.log.event('policy.decision', {
          stepId: step.id, declaredRisk: step.risk, derivedRisk: derived,
          control: resolvedNode?.name ?? boundTarget?.name,
          reason: 'the control this step targets is riskier than the step declares; gating at the higher one',
        });
      }

      const riskCheck = this.o.policy.checkRisk(
        effectiveRisk, `step "${step.id}" (${step.intent})`, cap.policy.confirmAtRisk
      );
      if (riskCheck.decision === 'confirm') {
        const gate = await this.gateRiskyStep(cap, step, riskCheck.reason);
        if (gate.kind === 'result') return gate;
        if (gate.kind === 'human_completed') return { kind: 'human_completed' };
      }

      // 5. Resolve the target (re-resolved: the risk gate may have paused for
      //    a human, and the screen can have moved while they worked).
      if (boundTarget) {
        const t = boundTarget;
        const res = resolveTarget(obs, t);
        if (!res.ok) {
          if (step.optional) {
            this.o.log.event('step.end', { stepId: step.id, skipped: true, reason: res.reason });
            return null;
          }
          if (attempt < step.retry.attempts) {
            await sleep(step.retry.backoffMs);
            continue;
          }
          const cls: FailureClass = res.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND';
          const reason: EscalationReason = res.reason === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_UNRESOLVED';
          const observed = res.reason === 'ambiguous'
            ? `${res.near.length} controls matched equally: ${res.near.map((n) => `"${n.name}"`).join(', ')}`
            : `no ${t.role} named "${t.name}" among ${res.considered} controls; nearest: ${res.near.map((n) => `"${n.name}"`).join(', ') || 'none'}`;

          const signal = await this.handleStuck(cap, reason,
            `step "${step.id}" (${step.intent}) could not resolve its target`,
            { stepId: step.id, expected: `a ${t.role} named "${t.name}"`, observed });

          if (signal?.disposition === 'resume') {
            if (await this.stepAlreadySatisfied(step, bindings)) return null;
            continue;
          }
          if (signal?.disposition === 'complete') return { kind: 'human_completed' };
          const pending = this.humanRequired(cap, step.id);
          if (pending) return { kind: 'result', result: pending };

          const shot = await this.o.log.screenshot(this.o.surface, `${cls.toLowerCase()}-${step.id}`);
          const dump = this.o.log.dumpObservation(obs, `${cls.toLowerCase()}-${step.id}`);
          return {
            kind: 'result',
            result: this.failFor(cap, cls, `a ${t.role} named "${t.name}"`, observed, step.id,
              [shot, dump].filter(Boolean) as string[]),
          };
        }
        resolvedNode = res.node;
        if (res.degraded === 'relaxed-name' && !this.drift.relaxedTargets.includes(step.id)) {
          this.drift.relaxedTargets.push(step.id);
          this.o.log.event('drift.detected', { stepId: step.id, degraded: res.degraded, matched: res.node.name, recorded: t.name });
        }
        if (res.degraded === 'frame-mismatch' && !this.drift.frameMismatches.includes(step.id)) {
          this.drift.frameMismatches.push(step.id);
          this.o.log.event('drift.detected', { stepId: step.id, degraded: res.degraded, frame: res.node.framePath });
        }
      }

      // 6. Act.
      this.o.log.event('step.start', {
        stepId: step.id, intent: step.intent, kind: step.action.kind, risk: step.risk,
        target: target ? `${target.role} "${target.name}"` : undefined,
        resolved: resolvedNode?.name, attempt,
      });

      const performed = await this.perform(cap, step.action, bindings, resolvedNode, depth);
      this.stepsExecuted++;
      if (!performed.ok) {
        if (attempt < step.retry.attempts) {
          await sleep(step.retry.backoffMs);
          continue;
        }
        const shot = await this.o.log.screenshot(this.o.surface, `surface-error-${step.id}`);
        return {
          kind: 'result',
          result: this.failFor(cap, 'SURFACE_ERROR', `step "${step.id}" to be performed`, performed.error ?? 'unknown', step.id, shot ? [shot] : []),
        };
      }

      // 7. Postcondition.
      if (step.waitFor) {
        let blockedEscalation: ReplayResult | undefined;
        let blockedHumanCompleted = false;
        let blockedRestart = false;
        let earlyOutcome: Outcome | null = null;
        const w = await this.waitUntil(step.waitFor, bindings, step.timeoutMs, async (o) => {
          const c = await this.clearInterstitials(cap, step, o, bindings);
          if (c.escalationResult) blockedEscalation = c.escalationResult;
          if (c.humanCompleted) blockedHumanCompleted = true;
          if (c.restartRequested) blockedRestart = true;
          if (c.changed) return 'changed';
          earlyOutcome = this.matchOutcome(cap, o, bindings, step.id);
          return earlyOutcome ? 'abort' : 'unchanged';
        });
        if (blockedEscalation) return { kind: 'result', result: blockedEscalation };
        if (blockedHumanCompleted) return { kind: 'human_completed' };
        if (blockedRestart) return { kind: 'restart' };
        if (earlyOutcome) {
          const result = await this.finishOutcome(cap, earlyOutcome, w.obs, bindings, this.baseFor(cap));
          return { kind: 'result', result };
        }
        if (!w.ok) {
          // Something unexpected may be on screen; give recovery a chance
          // before declaring a timeout.
          const c = await this.clearInterstitials(cap, step, w.obs, bindings);
          if (c.escalationResult) return { kind: 'result', result: c.escalationResult };
          if (c.changed) {
            const w2 = await this.waitUntil(step.waitFor, bindings, Math.min(step.timeoutMs, 5_000));
            if (w2.ok) {
              this.o.log.event('step.end', { stepId: step.id, ok: true, recoveredBeforeWait: true });
              return null;
            }
          }
          const late = this.matchOutcome(cap, w.obs, bindings, step.id);
          if (late) {
            const result = await this.finishOutcome(cap, late, w.obs, bindings, this.baseFor(cap));
            return { kind: 'result', result };
          }
          if (attempt < step.retry.attempts) {
            await sleep(step.retry.backoffMs);
            continue;
          }
          const signal = await this.handleStuck(cap, 'STUCK_NO_PROGRESS',
            `step "${step.id}" acted but its expected result never appeared`,
            { stepId: step.id, expected: describe(step.waitFor), observed: summarizeScreen(w.obs) });
          if (signal?.disposition === 'resume') {
            if (await this.stepAlreadySatisfied(step, bindings)) return null;
            continue;
          }
          if (signal?.disposition === 'complete') return { kind: 'human_completed' };
          const pendingTimeout = this.humanRequired(cap, step.id);
          if (pendingTimeout) return { kind: 'result', result: pendingTimeout };

          const shot = await this.o.log.screenshot(this.o.surface, `step-timeout-${step.id}`);
          const dump = this.o.log.dumpObservation(w.obs, `step-timeout-${step.id}`);
          return {
            kind: 'result',
            result: this.failFor(cap, 'STEP_TIMEOUT', describe(step.waitFor), summarizeScreen(w.obs), step.id,
              [shot, dump].filter(Boolean) as string[]),
          };
        }
      }

      this.o.log.event('step.end', { stepId: step.id, ok: true });
      return null;
    }
  }

  // ------------------------------------------------------ interstitials --

  private async clearInterstitials(
    cap: Capability,
    step: Step,
    obs: Observation,
    bindings: Bindings
  ): Promise<{ changed: boolean; escalationResult?: ReplayResult; humanCompleted?: boolean; restartRequested?: boolean }> {
    let changed = false;
    let restartRequested = false;
    let current = obs;

    for (let guard = 0; guard < 6; guard++) {
      const hit = cap.interstitials.find((i) => evaluate(i.when, current, bindings, []));
      if (!hit) break;

      const seen = (this.interstitialCounts.get(hit.code) ?? 0) + 1;
      this.interstitialCounts.set(hit.code, seen);

      if (seen > hit.maxOccurrences) {
        const signal = hit.escalateOnFailure
          ? await this.handleStuck(cap, 'INTERSTITIAL_UNCLEARED',
              `"${hit.code}" reappeared ${seen} times and will not clear`,
              { stepId: step.id, expected: `${hit.code} cleared`, observed: summarizeScreen(current) })
          : null;
        if (signal?.disposition === 'resume') { changed = true; break; }  // operator cleared it by hand
        if (signal?.disposition === 'complete') return { changed, humanCompleted: true };
        const pendingLoop = this.humanRequired(cap, step.id);
        if (pendingLoop) return { changed, escalationResult: pendingLoop };
        const dump = this.o.log.dumpObservation(current, `interstitial-loop-${hit.code}`);
        return {
          changed,
          escalationResult: this.failFor(cap, 'INTERSTITIAL_LOOP', `${hit.code} to clear`,
            `recovery ran ${seen} times without clearing it`, step.id, [dump]),
        };
      }

      this.o.log.event('interstitial.recovered', {
        code: hit.code, description: hit.description, atStep: step.id, occurrence: seen,
      });

      for (const action of hit.do) {
        const live = await this.observe();
        const target = this.targetOf(action);
        let node: UiNode | null = null;
        if (target) {
          const r = resolveTarget(live, interpolateDeep(target, bindings) as Target);
          if (!r.ok) break;
          node = r.node;
        }

        // Recovery actions are risk-gated like any other step. Without this an
        // interstitial is a hole straight through the confirmation gate: its
        // `do` list is a plain action list, so a recovery declared as "click
        // Post Account" would commit a transaction with no human involved and
        // no declared step risk to stop it.
        const risk = Policy.classify(action.kind, node?.name);
        if (this.o.policy.checkRisk(risk, `recovery for ${hit.code}`, cap.policy.confirmAtRisk)
              .decision === 'confirm') {
          this.o.log.event('policy.decision', {
            code: hit.code, decision: 'deny', risk, control: node?.name,
            reason: 'a recoverable-condition handler may not perform a risky action',
          });
          break;
        }

        const done = await this.perform(cap, action, bindings, node, 1);
        if (!done.ok) break;
      }

      const existing = this.recoveries.find((r) => r.code === hit.code);
      if (existing) existing.occurrences = seen;
      else this.recoveries.push({ code: hit.code, atStep: step.id, occurrences: seen });

      changed = true;
      if (hit.restartFlow) restartRequested = true;
      // Wait for the interstitial to actually go away before looking again.
      // Re-observing immediately catches the page mid-navigation and counts
      // the same screen twice, which walks straight into the loop guard.
      current = await this.waitForCleared(hit, bindings);
      if (restartRequested) break;
    }

    return { changed, restartRequested };
  }

  /**
   * After a human hands control back with "resume", decide whether the step
   * they were stopped on still needs doing.
   *
   * The step's postcondition is the definition of "this step is complete", so
   * if the operator has already made it true — by signing back in, dismissing
   * the dialog, whatever the obstacle was — re-running the recorded action
   * would at best fail to find its target and at worst repeat something. The
   * postcondition is the right question to ask, and it is already in the
   * artifact.
   */
  private async stepAlreadySatisfied(step: Step, bindings: Bindings): Promise<boolean> {
    if (!step.waitFor) return false;
    const check = await this.waitUntil(step.waitFor, bindings, 2_000);
    if (check.ok) {
      this.o.log.event('step.end', { stepId: step.id, ok: true, satisfiedByOperator: true });
    }
    return check.ok;
  }

  /** Polls until `hit.when` stops matching, or 5s elapses. */
  private async waitForCleared(hit: Interstitial, bindings: Bindings): Promise<Observation> {
    const deadline = Date.now() + 5_000;
    let obs = await this.o.surface.observe();
    while (evaluate(hit.when, obs, bindings, []) && Date.now() < deadline) {
      await sleep(POLL_MS);
      obs = await this.o.surface.observe();
    }
    return obs;
  }

  // ------------------------------------------------------------ outcomes --

  private matchOutcome(
    cap: Capability,
    obs: Observation,
    bindings: Bindings,
    stepId: string | null
  ): Outcome | null {
    for (const o of cap.outcomes) {
      if (o.afterSteps.length > 0 && stepId !== null && !o.afterSteps.includes(stepId)) continue;
      if (evaluate(o.when, obs, bindings, [])) return o;
    }
    return null;
  }

  private async finishOutcome(
    cap: Capability,
    outcome: Outcome,
    obs: Observation,
    bindings: Bindings,
    base: Omit<ReplayResult, 'status'> & Record<string, unknown>
  ): Promise<ReplayResult> {
    const extraction = extractOutputs(outcome.outputs, obs, bindings);
    // The success path registers its outputs so the redactor knows them; this
    // one did not, so anything an outcome declared would have reached
    // result.json in clear. Nothing declares outcome outputs today — the
    // schema permits it, which is enough.
    for (const out of outcome.outputs) {
      this.o.redactor.register(String(extraction.values[out.name] ?? ''), effectiveSensitivity(out), out.name);
    }
    const shot = await this.o.log.screenshot(this.o.surface, `outcome-${outcome.code}`);
    this.o.log.event('outcome.detected', {
      code: outcome.code, description: outcome.description,
      classification: outcome.classification, url: obs.url, evidence: shot,
    });

    // A recognised *failure* screen. We know what it is, which makes for a
    // far better error than "could not find the Search button", but it is
    // still not an answer to the caller's question.
    if (outcome.classification === 'failure') {
      const dump = this.o.log.dumpObservation(obs, `app-error-${outcome.code}`);
      this.o.log.event('run.end', { status: 'failure', class: 'APP_ERROR', code: outcome.code });
      return {
        ...(base as object),
        status: 'failure',
        failure: {
          class: 'APP_ERROR',
          expected: 'the application to complete the request',
          observed: `${outcome.code}: ${outcome.description}`,
          detail: summarizeScreen(obs),
          evidence: [shot, dump].filter(Boolean) as string[],
        },
      } as ReplayResult;
    }
    this.o.log.event('run.end', { status: 'business_outcome', code: outcome.code });
    return {
      ...(base as object),
      status: 'business_outcome',
      code: outcome.code,
      message: outcome.description,
      outputs: extraction.values,
    } as ReplayResult;
  }

  // ---------------------------------------------------------- escalation --

  /** Raise an intervention, or return null when escalation is not permitted. */
  private async handleStuck(
    cap: Capability,
    reason: EscalationReason,
    summary: string,
    ctx: { stepId?: string; expected?: string; observed?: string }
  ): Promise<ReleaseSignal | null> {
    if (!this.o.allowEscalation) {
      // An unattended caller still needs to be told a person is required —
      // reporting this as a hard failure would read as "the automation is
      // broken" when the truth is "this one needs a human".
      this.o.log.event('note', { message: 'escalation suppressed (unattended run)', reason, summary });
      this.unresolvedEscalation = { reason: `${reason}: ${summary}` };
      return null;
    }
    // Never wait for an operator longer than the run itself is allowed to
    // live, or the run cap is decorative and the run simply hangs past it.
    const remaining = this.o.policy.config.runTimeoutMs - (Date.now() - this.t0);
    const { intervention, signal } = await broker.raise({
      timeoutMs: Math.max(5_000, Math.min(this.o.policy.config.escalationTimeoutMs, remaining)),
      runId: this.o.runId,
      mode: 'replay',
      capabilityId: `${cap.id}@${cap.version}`,
      goal: cap.description,
      reason,
      summary,
      stepId: ctx.stepId,
      expected: ctx.expected,
      observed: ctx.observed,
    });
    if (!signal) {
      this.unresolvedEscalation = {
        escalationId: intervention.id,
        reason: `${reason}: ${summary} (no operator resolved it in time)`,
      };
    }
    return signal;
  }

  /**
   * A `needs_human` result, if the last escalation went unresolved.
   *
   * This is a pending state, not a failure: the work is not wrong, it is
   * waiting on a person. Collapsing it into `failure` is what makes callers
   * retry things that will never succeed without someone looking.
   */
  private humanRequired(cap: Capability, stepId?: string): ReplayResult | null {
    const pending = this.unresolvedEscalation;
    if (!pending) return null;
    this.unresolvedEscalation = null;
    this.o.log.event('run.end', { status: 'needs_human', ...pending, stepId });
    return {
      ...(this.baseFor(cap) as object),
      status: 'needs_human',
      escalationId: pending.escalationId ?? 'not-raised',
      reason: pending.reason,
      stepId,
    } as ReplayResult;
  }

  private async gateRiskyStep(
    cap: Capability,
    step: Step,
    reason: string
  ): Promise<{ kind: 'result'; result: ReplayResult } | { kind: 'human_completed' } | { kind: 'proceed' }> {
    this.o.log.event('policy.decision', {
      stepId: step.id, risk: step.risk, decision: 'confirm', reason, mode: this.o.riskyActions,
    });

    if (this.o.riskyActions === 'proceed') {
      // An explicit, audited override — not a silent bypass.
      this.o.log.event('note', {
        message: 'risky step auto-approved by run configuration',
        stepId: step.id, risk: step.risk, intent: step.intent,
      });
      return { kind: 'proceed' };
    }
    if (this.o.riskyActions === 'block') {
      return {
        kind: 'result',
        result: this.failFor(cap, 'POLICY_DENIED', `human confirmation for ${step.risk} step`,
          'policy is configured to block rather than escalate', step.id),
      };
    }

    const signal = await this.handleStuck(cap, 'RISKY_ACTION_CONFIRMATION',
      `step "${step.id}" is ${step.risk}: ${step.intent}`,
      { stepId: step.id, expected: 'operator approval to proceed', observed: reason });

    if (!signal) {
      // Nobody approved it, so nobody approved it. Proceeding would make the
      // gate decorative; failing would say the flow is broken when it is not.
      const pending = this.humanRequired(cap, step.id);
      if (pending) return { kind: 'result', result: pending };
    }
    if (!signal || signal.disposition === 'abort') {
      return {
        kind: 'result',
        result: this.failFor(cap, 'POLICY_DENIED', `approval for ${step.risk} step "${step.id}"`,
          signal ? `operator aborted: ${signal.note}` : 'no operator available to approve', step.id),
      };
    }
    if (signal.disposition === 'complete') return { kind: 'human_completed' };
    return { kind: 'proceed' };
  }

  // ------------------------------------------------------------ plumbing --

  private async awaitControl(): Promise<void> {
    if (this.o.control.canAutomate()) return;
    this.o.log.event('note', { message: 'automation paused; control is held elsewhere', state: this.o.control.current });
    await this.o.control.requestHandoff();
  }

  private async observe(): Promise<Observation> {
    const obs = await this.o.surface.observe();
    this._lastObservation = obs;
    this.o.log.event('observe', { url: obs.url, title: obs.title, nodes: obs.nodes.length });
    return obs;
  }

  /**
   * Polls until `cond` holds.
   *
   * `onBlocked` is given each unsatisfying observation so that a known
   * interstitial can be cleared *while we wait* rather than after the timeout
   * expires. Without it an acknowledgement screen costs a full step timeout
   * before recovery even runs — the recovery still works, but a flow that
   * should take two seconds takes twenty, which in production reads as a
   * hang rather than as the handled condition it actually is.
   */
  private async waitUntil(
    cond: Parameters<typeof evaluate>[0],
    bindings: Bindings,
    timeoutMs: number,
    onBlocked?: (obs: Observation) => Promise<'changed' | 'unchanged' | 'abort'>
  ): Promise<{ ok: boolean; obs: Observation; trace: ConditionTrace[]; aborted?: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let obs = await this.observe();
    let trace: ConditionTrace[] = [];
    for (;;) {
      trace = [];
      this._lastObservation = obs;
      if (evaluate(cond, obs, bindings, trace)) return { ok: true, obs, trace };
      const verdict = onBlocked ? await onBlocked(obs) : 'unchanged';
      // A screen we recognise — a declared outcome — is an answer. Waiting out
      // the remaining timeout on it buys nothing and turns a one-second
      // "member not found" into a fifteen-second one.
      if (verdict === 'abort') return { ok: false, obs, trace, aborted: true };
      if (verdict === 'changed') {
        obs = await this.o.surface.observe();
        continue; // recovery changed the screen; re-test without burning the clock
      }
      if (Date.now() >= deadline) return { ok: false, obs, trace };
      await sleep(POLL_MS);
      obs = await this.o.surface.observe();
    }
  }

  /**
   * The single place a URL is authorised. Returns a reason when the navigation
   * must not happen: the deployment allowlist and the capability's own
   * declared origins, intersected.
   */
  private denyNavigation(cap: Capability, url: string): string | null {
    const reason = denyLocation(this.o.policy, cap.policy.allowedOrigins, url);
    this.o.log.event('policy.decision', reason ? { url, decision: 'deny', reason } : { url, decision: 'allow' });
    return reason;
  }

  private targetOf(action: StepAction): Target | null {
    return 'target' in action ? (action.target as Target) : null;
  }

  private async perform(
    cap: Capability,
    action: StepAction,
    bindings: Bindings,
    node: UiNode | null,
    depth: number
  ): Promise<{ ok: boolean; error?: string }> {
    switch (action.kind) {
      case 'navigate': {
        // Checked here rather than only in the step loop. A recovery handler's
        // `do` list calls straight into this method, so URL checking in the
        // caller left a hole: an interstitial declared as "navigate to another
        // institution" reached it with no policy decision logged at all.
        const url = interpolateDeep(action.url, bindings);
        const denial = this.denyNavigation(cap, url);
        if (denial) return { ok: false, error: denial };
        return this.o.surface.act({ kind: 'navigate', url }, null);
      }
      case 'press':
        return this.o.surface.act({ kind: 'press', key: action.key }, null);
      case 'wait':
        return this.o.surface.act({ kind: 'wait', ms: action.ms }, null);
      case 'click':
        return this.o.surface.act({ kind: 'click', target: action.target }, node);
      case 'select':
        return this.o.surface.act(
          { kind: 'select', target: action.target, option: interpolateDeep(action.option, bindings) },
          node
        );
      case 'type': {
        let text: string;
        if (action.secretRef !== undefined) {
          text = this.o.credentials.resolve(action.secretRef);
          this.o.redactor.registerSecret(text, action.secretRef);
        } else {
          text = interpolateDeep(action.text!, bindings);
        }
        return this.o.surface.act(
          { kind: 'type', target: action.target, text, clearFirst: action.clearFirst },
          node
        );
      }
      case 'run_capability': {
        if (depth >= 2) return { ok: false, error: 'capability nesting limit reached' };
        const sub = this.o.resolveCapability?.(action.capability, action.version);
        if (!sub) {
          const pin = action.version ? `@${action.version}` : '';
          return { ok: false, error: `capability "${action.capability}${pin}" is not in the catalog` };
        }
        this.o.log.event('note', {
          message: 'running nested capability',
          capability: action.capability, version: sub.version, pinned: action.version ?? null,
        });
        // A composed capability is held to the same approval bar as the one
        // that called it; inheriting `false` here would have made composition
        // a way around the gate.
        const r = await new ReplayEngine(this.o)
          .run(sub, interpolateDeep(action.inputs, bindings), depth + 1);
        return r.status === 'success'
          ? { ok: true }
          : { ok: false, error: `nested capability ${action.capability} returned ${r.status}` };
      }
      default:
        return { ok: false, error: `unsupported action` };
    }
  }

  private validateInputs(
    cap: Capability,
    raw: Record<string, unknown>
  ): { bindings: Bindings } | { error: string } {
    const bindings: Bindings = {};
    const errors: string[] = [];

    for (const p of cap.inputs) {
      const v = raw[p.name];
      if (v === undefined || v === '') {
        if (p.required) errors.push(`missing required input "${p.name}" (${p.description})`);
        continue;
      }
      const s = String(v);
      if (p.pattern && !new RegExp(p.pattern).test(s)) {
        errors.push(`input "${p.name}" does not match ${p.pattern}`);
        continue;
      }
      if (p.type === 'number' && !Number.isFinite(Number(s))) {
        errors.push(`input "${p.name}" must be a number`);
        continue;
      }
      if (p.type === 'enum' && p.enum && !p.enum.includes(s)) {
        errors.push(`input "${p.name}" must be one of ${p.enum.join(', ')}`);
        continue;
      }
      this.o.redactor.register(s, p.sensitivity, p.name);
      bindings[p.name] = p.type === 'number' ? Number(s) : p.type === 'boolean' ? s === 'true' : s;
    }

    const declared = new Set(cap.inputs.map((p) => p.name));
    for (const k of Object.keys(raw)) {
      if (!declared.has(k)) errors.push(`unknown input "${k}"`);
    }

    return errors.length > 0 ? { error: errors.join('; ') } : { bindings };
  }

  private baseFor(cap: Capability): Omit<ReplayResult, 'status'> & Record<string, unknown> {
    return {
      runId: this.o.runId,
      capability: { id: cap.id, version: cap.version },
      startedAt: this.startedAt,
      durationMs: Date.now() - this.t0,
      stepsExecuted: this.stepsExecuted,
      evidenceDir: this.o.log.dir,
      recoveries: this.recoveries,
      drift: this.drift,
    } as Omit<ReplayResult, 'status'> & Record<string, unknown>;
  }

  private failFor(
    cap: Capability,
    cls: FailureClass,
    expected: string,
    observed: string,
    stepId?: string,
    evidence: string[] = []
  ): ReplayResult {
    this.o.log.event('run.end', { status: 'failure', class: cls, stepId, expected, observed });
    return {
      ...(this.baseFor(cap) as object),
      status: 'failure',
      failure: { class: cls, stepId, expected, observed, evidence },
    } as ReplayResult;
  }
}

/**
 * Sensitivity is declared, but only ever revised *upward* at run time.
 *
 * An overlay may legitimately repoint an output's `source` — a tenant's
 * balance column is called something else — while `sensitivity` is sealed
 * against patching. Those two facts combine badly: repoint a source declared
 * `internal` at a regulated readout and the value flows into the run log and
 * the returned outputs in clear, reaching the same harm the sealed field
 * exists to prevent through the other door. So where the source *names* a
 * regulated field, the value is treated as PII whatever the artifact says.
 * Declaration can raise the classification; it cannot lower it below what the
 * label implies.
 */
function effectiveSensitivity(out: Output): Sensitivity {
  if (out.sensitivity === 'secret' || out.sensitivity === 'pii') return out.sensitivity;
  const src = out.source;
  const label =
    src.from === 'readout' ? src.label.value
    : src.from === 'node' ? src.target.name
    : src.from === 'table' ? `${src.selectColumn} ${src.whereColumn}`
    : '';
  return looksSensitive(`${out.name} ${label}`) ? 'pii' : out.sensitivity;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A one-line "what is actually on screen", for failure messages. */
function summarizeScreen(obs: Observation): string {
  const alerts = obs.nodes.filter((n) => n.role === 'alert').map((n) => n.name);
  if (alerts.length > 0) return `alert on screen: ${alerts.join(' | ').slice(0, 200)}`;
  const heading = obs.nodes.find((n) => n.role === 'heading')?.name;
  const buttons = obs.nodes.filter((n) => n.role === 'button').map((n) => `"${n.name}"`).slice(0, 5);
  return `at ${obs.url}${heading ? ` heading "${heading}"` : ''}` +
    (buttons.length ? `, controls: ${buttons.join(', ')}` : '');
}
