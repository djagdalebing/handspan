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
import type { Capability, Interstitial, Outcome, Step, StepAction, Target } from '../artifact/schema.js';
import type { Action, Observation, Surface, UiNode } from '../surface/types.js';
import type { LiveControl } from '../surface/web/playwright-surface.js';
import type { CredentialProvider } from '../safety/credentials.js';
import type { Redactor } from '../safety/redact.js';
import type { RunLog } from '../observability/run-log.js';
import { Policy } from '../safety/policy.js';
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
  /** Resolves `run_capability` references. */
  resolveCapability?: (id: string) => Capability | undefined;
}

const POLL_MS = 350;

export class ReplayEngine {
  private drift: DriftReport = emptyDrift();
  private recoveries: RecoveryRecord[] = [];
  private stepsExecuted = 0;
  private interstitialCounts = new Map<string, number>();
  private startedAt = new Date().toISOString();
  private t0 = Date.now();

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
            i = 0; this.interstitialCounts.clear(); continue;
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
        this.o.redactor.register(String(extraction.values[out.name] ?? ''), out.sensitivity, out.name);
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
        const url = interpolateDeep(step.action.url, bindings);
        // Two allowlists, intersected. The runtime policy is the deployment's
        // hard boundary; the capability's own declared origins are what a
        // reviewer approved it to touch. A capability specialised for one
        // tenant should not be able to drive another tenant's instance just
        // because the deployment can reach both.
        const urlCheck = this.o.policy.checkUrl(url);
        this.o.log.event('policy.decision', { stepId: step.id, url, ...urlCheck });
        if (urlCheck.decision === 'deny') {
          return { kind: 'result', result: this.failFor(cap, 'POLICY_DENIED', 'navigation within the deployment allowlist', urlCheck.reason, step.id) };
        }
        const declared = cap.policy.allowedOrigins;
        if (declared.length > 0 && !declared.some((o) => url.startsWith(o))) {
          const reason = `${url} is outside the origins this capability declares (${declared.join(', ')})`;
          this.o.log.event('policy.decision', { stepId: step.id, url, decision: 'deny', reason });
          return { kind: 'result', result: this.failFor(cap, 'POLICY_DENIED', 'navigation within the capability\'s declared origins', reason, step.id) };
        }
      }

      const riskCheck = this.o.policy.checkRisk(step.risk, `step "${step.id}" (${step.intent})`);
      if (riskCheck.decision === 'confirm') {
        const gate = await this.gateRiskyStep(cap, step, riskCheck.reason);
        if (gate.kind === 'result') return gate;
        if (gate.kind === 'human_completed') return { kind: 'human_completed' };
      }

      // 5. Resolve the target.
      let resolvedNode: UiNode | null = null;
      const target = this.targetOf(step.action);
      if (target) {
        const t = interpolateDeep(target, bindings) as Target;
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

      const performed = await this.perform(step.action, bindings, resolvedNode, depth);
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
        const done = await this.perform(action, bindings, node, 1);
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
      this.o.log.event('note', { message: 'escalation suppressed (unattended run)', reason, summary });
      return null;
    }
    const { signal } = await broker.raise({
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
    return signal;
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

  private targetOf(action: StepAction): Target | null {
    return 'target' in action ? (action.target as Target) : null;
  }

  private async perform(
    action: StepAction,
    bindings: Bindings,
    node: UiNode | null,
    depth: number
  ): Promise<{ ok: boolean; error?: string }> {
    switch (action.kind) {
      case 'navigate':
        return this.o.surface.act({ kind: 'navigate', url: interpolateDeep(action.url, bindings) }, null);
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
        const sub = this.o.resolveCapability?.(action.capability);
        if (!sub) return { ok: false, error: `capability "${action.capability}" is not in the catalog` };
        this.o.log.event('note', { message: 'running nested capability', capability: action.capability });
        const r = await new ReplayEngine({ ...this.o, requireApproval: false })
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
