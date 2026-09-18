/**
 * The discovery loop: observe → decide → act, with a model in the loop.
 *
 * This is the only place a model influences behaviour, and it is bounded on
 * every side — the allowlist, a step budget, a risk gate, and stuck
 * detection that escalates to a human rather than flailing. What it produces
 * is not an answer but a *recording*: an ordered list of (intent, action,
 * the control that was acted on, the screen it was acted on). The recorder
 * turns that into a capability.
 *
 * Screenshots sent to the model are masked with the same redaction used for
 * stored evidence. The discovery run is the one moment in this system when
 * regulated data would leave the institution's boundary, and the honest
 * answer for production is to run the model inside that boundary; masking is
 * the mitigation that holds in the meantime, and it costs nothing here
 * because no task needs to read an SSN off the screen.
 */
import type { Param, Risk } from '../artifact/schema.js';
import type { Observation, Surface, UiNode } from '../surface/types.js';
import type { LiveControl } from '../surface/web/playwright-surface.js';
import type { ModelProvider, Part } from '../llm/provider.js';
import type { RunLog } from '../observability/run-log.js';
import type { Redactor } from '../safety/redact.js';
import type { CredentialProvider } from '../safety/credentials.js';
import { Policy } from '../safety/policy.js';
import { SessionControl } from '../escalation/control.js';
import { broker } from '../escalation/broker.js';
import { fingerprintObservation } from '../replay/locator.js';
import {
  DECISION_SCHEMA, SUMMARY_SCHEMA, SUMMARY_SYSTEM, SYSTEM_PROMPT,
  describeChange, renderHistory, renderObservation,
  type Decision, type SummaryResponse,
} from './prompt.js';

export interface DiscoveryOptions {
  runId: string;
  goal: string;
  entryUrl: string;
  /** Values supplied for this run, and their declared types. */
  params: Record<string, string>;
  paramDecls: Param[];
  provider: ModelProvider;
  surface: Surface & Partial<LiveControl>;
  policy: Policy;
  log: RunLog;
  redactor: Redactor;
  control: SessionControl;
  maxSteps: number;
  includeScreenshots: boolean;
  allowEscalation: boolean;
  riskyActions: 'escalate' | 'block' | 'proceed';
  capabilityId: string;
  /** Resolves credentials the model may use without ever seeing them. */
  credentials: CredentialProvider;
  /** Credential names the model may reference. Names only, never values. */
  secretRefs: string[];
  /** How long an unanswered intervention waits before the run gives up. */
  escalationTimeoutMs: number;
}

export interface RecordedAction {
  intent: string;
  decision: Decision;
  /** The control acted on, as perceived. Null for navigate/press/wait. */
  node: UiNode | null;
  obsBefore: Observation;
  fingerprint: string;
  risk: Risk;
}

export interface DiscoveryOutcome {
  ok: boolean;
  reason: string;
  recorded: RecordedAction[];
  finalObs: Observation;
  summary?: SummaryResponse;
}

const STUCK_WINDOW = 3;

/** What "the screen has not changed" means for stuck detection. */
function stateSignature(obs: Observation): string {
  const values = obs.nodes
    .filter((n) => n.value !== undefined)
    .map((n) => `${n.ref}=${n.value}`)
    .join(';');
  return `${obs.url}#${fingerprintObservation(obs)}#${values}`;
}

export async function runDiscovery(o: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const recorded: RecordedAction[] = [];
  const history: Array<{ intent: string; action: string; result: string }> = [];
  const seen: string[] = [];

  o.log.event('run.start', {
    mode: 'discovery',
    goal: o.goal,
    entryUrl: o.entryUrl,
    model: o.provider.name,
    params: Object.keys(o.params),
  });

  // Entry navigation is a step of the flow, and it goes through the same gate.
  const entryCheck = o.policy.checkUrl(o.entryUrl);
  o.log.event('policy.decision', { url: o.entryUrl, ...entryCheck });
  if (entryCheck.decision !== 'allow') {
    return {
      ok: false,
      reason: `entry point rejected by policy: ${(entryCheck as { reason: string }).reason}`,
      recorded,
      finalObs: await o.surface.observe(),
    };
  }
  await o.surface.act({ kind: 'navigate', url: o.entryUrl }, null);

  let obs = await o.surface.observe();
  let finishMessage = '';

  // The previous turn's result is filled in from the *next* observation, so
  // the model is told what its action actually did to the screen rather than
  // where it nominally is. Deferring it to the top of the loop costs no extra
  // perception: this observation was going to happen anyway.
  let pending: { turn: { result: string }; before: Observation } | null = null;

  for (let step = 0; step < o.maxSteps; step++) {
    if (!o.control.canAutomate()) await o.control.requestHandoff();

    obs = await o.surface.observe();
    o.log.event('observe', { step, url: obs.url, nodes: obs.nodes.length });

    if (pending) {
      pending.turn.result = describeChange(pending.before, obs);
      o.log.event('step.effect', { step: step - 1, change: pending.turn.result });
      pending = null;
    }

    // --- stuck detection ---------------------------------------------------
    // The signature has to include field *values*, not just the control
    // skeleton: filling in a form is progress even though the set of controls
    // on screen is identical before and after.
    const signature = stateSignature(obs);
    seen.push(signature);
    if (seen.length >= STUCK_WINDOW && seen.slice(-STUCK_WINDOW).every((s) => s === signature)) {
      const signal = await escalate(o, 'STUCK_NO_PROGRESS',
        `the screen has not changed across ${STUCK_WINDOW} actions`,
        { expected: 'progress toward the goal', observed: `still at ${obs.url}` });
      if (!signal || signal.disposition === 'abort') {
        return { ok: false, reason: 'stuck: no progress and no operator resolution', recorded, finalObs: obs };
      }
      if (signal.disposition === 'complete') { finishMessage = 'operator completed the task manually'; break; }
      seen.length = 0;
      continue;
    }

    // --- decide ------------------------------------------------------------
    // Everything describing the *screen* is redacted before it leaves the
    // process. Masking the screenshot while shipping the same data as text in
    // the same request is not a control, it is a costume — and that is exactly
    // how this shipped: `textbox "Password" value="…"` went to the model
    // beside a carefully masked image of the same field.
    //
    // The parameters block is deliberately *not* redacted. The model has to
    // type the member number to do the task, so that value is the irreducible
    // disclosure of this design; the honest production answer is a model
    // inside the institution's boundary, which is why §6 says so rather than
    // claiming this is solved.
    const parts: Part[] = [{
      text: [
        `GOAL: ${o.redactor.string(o.goal)}`,
        '',
        'PARAMETERS AVAILABLE:',
        ...(o.paramDecls.length
          ? o.paramDecls.map((p) => `  ${p.name} = ${JSON.stringify(o.params[p.name] ?? '')}  (${p.description})`)
          : ['  (none)']),
        '',
        // Names only. The model can ask for a credential to be typed without
        // ever being shown it, which is what lets the screen stay redacted.
        'CREDENTIALS AVAILABLE (use action "type_secret"; values are never shown):',
        ...(o.secretRefs.length ? o.secretRefs.map((r) => `  ${r}`) : ['  (none)']),
        '',
        'STEPS SO FAR:',
        o.redactor.string(renderHistory(history)),
        '',
        'CURRENT SCREEN:',
        o.redactor.string(renderObservation(obs)),
      ].join('\n'),
    }];

    if (o.includeScreenshots) {
      const png = await o.surface
        .screenshot({ maskSensitive: true, maskValues: o.redactor.piiLiterals() })
        .catch(() => null);
      if (png) parts.push({ image: { mimeType: 'image/png', data: png } });
    }

    o.log.event('model.request', {
      step, purpose: 'decide', model: o.provider.name,
      controls: obs.nodes.length, withScreenshot: o.includeScreenshots,
    });

    let decision: Decision;
    try {
      const res = await o.provider.complete({
        system: SYSTEM_PROMPT, parts, schema: DECISION_SCHEMA, purpose: 'decide', temperature: 0,
      });
      decision = res.value as Decision;
      // The whole decision, not a subset. A run log that drops `text` and
      // `parameterName` cannot answer "why did it type that", and cannot be
      // replayed to reproduce a recording. The redactor handles anything
      // sensitive on the way out — which is why the credential values are
      // registered with it before the loop starts.
      o.log.event('model.response', { step, ...decision, usage: res.usage });
    } catch (e) {
      return { ok: false, reason: `model call failed: ${String(e)}`, recorded, finalObs: obs };
    }

    // --- terminal decisions -------------------------------------------------
    if (decision.action === 'finish') {
      finishMessage = decision.message ?? 'goal reached';
      break;
    }
    if (decision.action === 'escalate') {
      const signal = await escalate(o, 'MODEL_REQUESTED_HELP',
        decision.message ?? decision.reasoning,
        { expected: 'a screen the agent could act on', observed: decision.screen });
      if (!signal || signal.disposition === 'abort') {
        return { ok: false, reason: `agent escalated: ${decision.message ?? decision.reasoning}`, recorded, finalObs: obs };
      }
      if (signal.disposition === 'complete') { finishMessage = 'operator completed the task manually'; break; }
      continue;
    }

    // --- validate against the live screen ----------------------------------
    const kindCheck = o.policy.checkActionKind(decision.action);
    if (kindCheck.decision === 'deny') {
      history.push({ intent: decision.intent, action: decision.action, result: `REFUSED: ${kindCheck.reason}` });
      o.log.event('policy.decision', { step, ...kindCheck });
      continue;
    }

    let node: UiNode | null = null;
    if (['click', 'type', 'type_secret', 'select'].includes(decision.action)) {
      if (!decision.ref) {
        history.push({ intent: decision.intent, action: decision.action, result: 'REJECTED: no ref supplied' });
        continue;
      }
      node = obs.nodes.find((n) => n.ref === decision.ref) ?? null;
      if (!node) {
        // A hallucinated ref. Tell the model rather than failing the run: the
        // next turn sees the rejection in its history and re-picks.
        history.push({
          intent: decision.intent, action: decision.action,
          result: `REJECTED: ref "${decision.ref}" is not on this screen`,
        });
        o.log.event('note', { step, rejected: 'unknown ref', ref: decision.ref });
        continue;
      }
    }

    if (decision.action === 'navigate') {
      const check = o.policy.checkUrl(decision.url ?? '');
      o.log.event('policy.decision', { step, url: decision.url, ...check });
      if (check.decision !== 'allow') {
        history.push({
          intent: decision.intent, action: 'navigate',
          result: `REFUSED: ${(check as { reason: string }).reason}`,
        });
        continue;
      }
    }

    // --- risk gate ----------------------------------------------------------
    const risk = Policy.classify(decision.action, node?.name);
    const riskCheck = o.policy.checkRisk(risk, `"${node?.name ?? decision.action}"`);
    if (riskCheck.decision === 'confirm') {
      o.log.event('policy.decision', {
        step, risk, decision: 'confirm', control: node?.name, mode: o.riskyActions,
      });
      if (o.riskyActions === 'block') {
        history.push({ intent: decision.intent, action: decision.action, result: 'REFUSED: irreversible actions are blocked' });
        continue;
      }
      if (o.riskyActions === 'escalate') {
        const signal = await escalate(o, 'RISKY_ACTION_CONFIRMATION',
          `the agent wants to ${decision.action} "${node?.name}" — ${decision.intent}`,
          { expected: 'operator approval', observed: `classified ${risk}` });
        if (!signal || signal.disposition === 'abort') {
          return { ok: false, reason: 'operator declined the irreversible action', recorded, finalObs: obs };
        }
        if (signal.disposition === 'complete') { finishMessage = 'operator completed the task manually'; break; }
      } else {
        o.log.event('note', { step, message: 'risky action auto-approved by run configuration', control: node?.name });
      }
    }

    // --- act ----------------------------------------------------------------
    const fingerprint = fingerprintObservation(obs);
    const result = await performDecision(o, decision, node);
    if (!result.ok) {
      history.push({ intent: decision.intent, action: decision.action, result: `FAILED: ${result.error}` });
      o.log.event('note', { step, actionFailed: result.error });
      continue;
    }

    recorded.push({ intent: decision.intent, decision, node, obsBefore: obs, fingerprint, risk });
    const after = await o.surface.location();
    // Provisional. The next observation replaces this with what changed; if
    // the loop ends here, "now at" is still an honest last line.
    const turn = { intent: decision.intent, action: decision.action, result: `now at ${after}` };
    history.push(turn);
    pending = { turn, before: obs };
    o.log.event('step.end', { step, intent: decision.intent, action: decision.action, ok: true, url: after });
  }

  const finalObs = await o.surface.observe();
  await o.log.screenshot(o.surface, 'discovery-final');

  if (!finishMessage) {
    return { ok: false, reason: `step budget of ${o.maxSteps} exhausted without reaching the goal`, recorded, finalObs };
  }
  if (recorded.length === 0) {
    return { ok: false, reason: 'no actions were recorded', recorded, finalObs };
  }

  const summary = await summarize(o, finalObs, recorded).catch((e) => {
    o.log.event('note', { summarizeFailed: String(e) });
    return undefined;
  });

  o.log.event('run.end', { status: 'success', steps: recorded.length, message: finishMessage });
  return { ok: true, reason: finishMessage, recorded, finalObs, summary };
}

// ---------------------------------------------------------------- helpers --

async function performDecision(
  o: DiscoveryOptions,
  d: Decision,
  node: UiNode | null
): Promise<{ ok: boolean; error?: string }> {
  switch (d.action) {
    case 'navigate': return o.surface.act({ kind: 'navigate', url: d.url! }, null);
    case 'press': return o.surface.act({ kind: 'press', key: d.key ?? 'Enter' }, null);
    case 'wait': return o.surface.act({ kind: 'wait', ms: Math.min(d.ms ?? 1000, 10_000) }, null);
    case 'click':
      return o.surface.act({ kind: 'click', target: { role: node!.role, name: node!.name, nameMatch: 'exact' } }, node);
    case 'select':
      return o.surface.act(
        { kind: 'select', target: { role: node!.role, name: node!.name, nameMatch: 'exact' }, option: d.option ?? '' },
        node
      );
    case 'type':
      return o.surface.act(
        { kind: 'type', target: { role: node!.role, name: node!.name, nameMatch: 'exact' }, text: d.text ?? '' },
        node
      );
    case 'type_secret': {
      // The value is fetched here and handed straight to the surface. It is
      // registered with the redactor so that if the application echoes it back
      // onto a later screen, it is scrubbed before the next prompt is built.
      const ref = d.secretRef ?? '';
      if (!o.secretRefs.includes(ref)) {
        return { ok: false, error: `"${ref}" is not a credential this job makes available` };
      }
      if (!o.credentials.has(ref)) {
        return { ok: false, error: `credential "${ref}" is not configured in this environment` };
      }
      const value = o.credentials.resolve(ref);
      o.redactor.registerSecret(value, ref);
      return o.surface.act(
        { kind: 'type', target: { role: node!.role, name: node!.name, nameMatch: 'exact' }, text: value },
        node
      );
    }
    default: return { ok: false, error: `unsupported action ${d.action}` };
  }
}

async function escalate(
  o: DiscoveryOptions,
  reason: Parameters<typeof broker.raise>[0]['reason'],
  summary: string,
  ctx: { expected?: string; observed?: string }
) {
  if (!o.allowEscalation) {
    o.log.event('note', { message: 'escalation suppressed (unattended discovery)', reason, summary });
    return null;
  }
  const { signal } = await broker.raise({
    // Bounded, like the replay path. Without this an unanswered intervention
    // during discovery blocks the run forever, which is the unsafe default and
    // made a stuck live run hang past every configured ceiling.
    timeoutMs: o.escalationTimeoutMs,
    runId: o.runId,
    mode: 'discovery',
    capabilityId: o.capabilityId,
    goal: o.goal,
    reason,
    summary,
    expected: ctx.expected,
    observed: ctx.observed,
  });
  return signal;
}

async function summarize(
  o: DiscoveryOptions,
  finalObs: Observation,
  recorded: RecordedAction[]
): Promise<SummaryResponse> {
  const parts: Part[] = [{
    text: [
      `GOAL: ${o.redactor.string(o.goal)}`,
      '',
      'STEPS TAKEN:',
      ...recorded.map((r, i) => `${i + 1}. ${o.redactor.string(r.intent)}`),
      '',
      'PARAMETERS THIS RUN USED:',
      ...o.paramDecls.map((p) => `  ${p.name} = ${JSON.stringify(o.params[p.name] ?? '')}`),
      '',
      'FINAL SCREEN:',
      o.redactor.string(renderObservation(finalObs)),
    ].join('\n'),
  }];

  o.log.event('model.request', { purpose: 'summarize', model: o.provider.name });
  const res = await o.provider.complete({
    system: SUMMARY_SYSTEM, parts, schema: SUMMARY_SCHEMA, purpose: 'summarize', temperature: 0,
  });
  o.log.event('model.response', { purpose: 'summarize', value: res.value, usage: res.usage });
  return res.value as SummaryResponse;
}
