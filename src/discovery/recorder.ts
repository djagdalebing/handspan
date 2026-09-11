/**
 * Turning a discovery run into a capability artifact.
 *
 * This is the step that makes the whole approach worth doing, and it is more
 * than serialising the transcript. Three things happen here:
 *
 * 1. **Descriptors are minimised and verified.** For each control the agent
 *    touched we start from the weakest sufficient descriptor (role + name +
 *    frame) and add disambiguators only while the descriptor is still
 *    ambiguous *against the screen it was recorded on*. A descriptor that
 *    cannot uniquely re-resolve on its own recording would certainly not
 *    resolve three months later, so we would rather find out now.
 *
 * 2. **Concrete values are canonicalised into parameters.** The run typed
 *    "12345"; the artifact says `{{memberId}}`. Without this the recording is
 *    a one-off. This also rewrites values embedded in panel headings and row
 *    text, which is where record-specific data hides.
 *
 * 3. **Model proposals are validated, not trusted.** The model suggests
 *    business outcomes and interstitials it thinks the flow can produce. Each
 *    proposal is tested against the successful final screen and discarded if
 *    it fires there — a "member not found" detector that also matches the
 *    success page would silently convert every good run into a bad outcome.
 *    What survives is a proposal for a human reviewer, which is why the
 *    artifact is emitted as `draft`.
 */
import type {
  Capability, Condition, Interstitial, Matcher, Outcome, Output, Param, Risk, Step, Target,
} from '../artifact/schema.js';
import { zCapability } from '../artifact/schema.js';
import type { Observation, UiNode } from '../surface/types.js';
import { evaluate } from '../replay/conditions.js';
import { extractOutputs } from '../replay/extract.js';
import { fingerprintObservation, resolveTarget } from '../replay/locator.js';
import { SENSITIVE_LABEL } from '../safety/redact.js';
import type { Bindings } from '../replay/template.js';
import type { DiscoveryOutcome, RecordedAction } from './agent.js';
import type { SummaryResponse } from './prompt.js';

export interface RecordArgs {
  id: string;
  version: string;
  name: string;
  description: string;
  goal: string;
  app: { vendor: string; product: string; productVersion?: string; tenant?: string };
  inputs: Param[];
  paramValues: Record<string, string>;
  entryUrl: string;
  /**
   * The deployment's allowlist. Used only as an upper bound: what the
   * capability declares is derived from where it actually went.
   */
  allowedOrigins: string[];
  model: string;
  runId: string;
  /** Steps whose credentials must not be baked in, keyed by control name. */
  secretFields?: Array<{ nameMatches: RegExp; secretRef: string }>;
}

export interface RecordReport {
  capability: Capability;
  warnings: string[];
}

export function recordCapability(outcome: DiscoveryOutcome, args: RecordArgs): RecordReport {
  const warnings: string[] = [];
  const canon = buildCanonicaliser(args.paramValues);
  const bindings: Bindings = { ...args.paramValues };

  // ------------------------------------------------------------- steps ---
  const steps: Step[] = [];
  const fingerprints: Record<string, string> = {};

  outcome.recorded.forEach((rec, i) => {
    const stepId = `s${String(i + 1).padStart(2, '0')}`;
    const next = outcome.recorded[i + 1];
    const target = rec.node ? minimiseTarget(rec.node, rec.obsBefore, canon, warnings, stepId) : null;

    const action = buildAction(rec, target, canon, args, warnings, stepId);
    if (!action) return;

    const waitFor = deriveWaitFor(rec, next, outcome.finalObs, canon, bindings);

    // The action for a credential field is stored as a `secretRef`, but the
    // model writes its own prose for `intent` and will happily say "enter the
    // password 'demo'". The artifact is committed to a repository, so the
    // literal has to come out of the description too, not just the action.
    let intent = rec.intent;
    if (action.kind === 'type' && action.secretRef) {
      const literal = rec.decision.text ?? '';
      if (literal.length >= 2 && intent.includes(literal)) {
        intent = intent.split(literal).join(`«${action.secretRef}»`);
        warnings.push(`step ${stepId}: removed a credential literal from the step description`);
      }
    }

    steps.push({
      id: stepId,
      intent,
      action,
      risk: rec.risk,
      waitFor,
      optional: false,
      timeoutMs: 15_000,
      retry: { attempts: 2, backoffMs: 600 },
    });
    fingerprints[stepId] = rec.fingerprint;
  });

  // The entry navigation happens before the decision loop starts, so it is
  // not in the trace — but a replay has to start somewhere. Recording it as
  // step zero keeps one mechanism for everything the flow does, and makes the
  // entry point the single most useful thing a tenant overlay can patch:
  // every institution runs the same product at a different hostname.
  const first = steps[0];
  steps.unshift({
    id: 's00',
    intent: `Open ${args.app.product} at its entry point`,
    action: { kind: 'navigate', url: args.entryUrl },
    risk: 'safe',
    waitFor: first && 'target' in first.action
      ? { type: 'nodeExists', target: first.action.target as Target }
      : undefined,
    optional: false,
    timeoutMs: 20_000,
    retry: { attempts: 2, backoffMs: 800 },
  });
  // No fingerprint for s00: there is no meaningful "screen before" a
  // navigation, and recording the destination's fingerprint here would
  // report drift on every single run.

  // -------------------------------------------------------- checkpoint ---
  const summary = outcome.summary;
  let checkpoint: Condition = summary?.successMarker
    ? { type: 'textMatches', value: m(canon(summary.successMarker)) }
    : fallbackCheckpoint(outcome.finalObs, canon);

  if (summary?.successReadoutLabel) {
    checkpoint = {
      type: 'all',
      of: [checkpoint, { type: 'readoutMatches', label: m(summary.successReadoutLabel), value: m('', 'regex', '.') }],
    };
  }
  if (!evaluate(checkpoint, outcome.finalObs, bindings, [])) {
    warnings.push(
      `the proposed success condition did not hold on the screen the run actually ended on; ` +
      `fell back to a mechanically derived marker`
    );
    checkpoint = fallbackCheckpoint(outcome.finalObs, canon);
  }
  // The last step's postcondition is the checkpoint: it makes the final step
  // self-verifying instead of relying on a trailing global check.
  const last = steps[steps.length - 1];
  if (last && !last.waitFor) last.waitFor = checkpoint;

  // ----------------------------------------------------------- outputs ---
  const outputs: Output[] = [];
  for (const o of summary?.outputs ?? []) {
    const spec = buildOutput(o, canon, warnings);
    if (!spec) {
      warnings.push(`output "${o.name}" proposed an unusable source and was dropped`);
      continue;
    }
    const probe = extractOutputs([spec], outcome.finalObs, bindings);
    if (probe.missing.includes(spec.name)) {
      warnings.push(`output "${o.name}" could not be extracted from the final screen and was dropped (${probe.notes.join('; ')})`);
      continue;
    }
    outputs.push(spec);
  }
  if ((summary?.outputs?.length ?? 0) > 0 && outputs.length === 0) {
    warnings.push('no proposed output survived validation; the capability returns nothing');
  }

  // ---------------------------------------------------------- outcomes ---
  const outcomes: Outcome[] = [];
  for (const p of summary?.proposedOutcomes ?? []) {
    const cond: Condition = { type: 'textMatches', value: m(canon(p.textMarker)) };
    if (evaluate(cond, outcome.finalObs, bindings, [])) {
      warnings.push(`proposed outcome ${p.code} also matches the success screen and was dropped as a false positive`);
      continue;
    }
    outcomes.push({
      code: sanitiseCode(p.code),
      description: p.description,
      when: cond,
      classification: 'business',
      afterSteps: [],
      terminal: true,
      outputs: [],
      verified: false,
    });
  }

  const interstitials: Interstitial[] = [];
  for (const p of summary?.proposedInterstitials ?? []) {
    const cond: Condition = { type: 'textMatches', value: m(canon(p.textMarker)) };
    if (evaluate(cond, outcome.finalObs, bindings, [])) {
      warnings.push(`proposed interstitial ${p.code} also matches the success screen and was dropped as a false positive`);
      continue;
    }
    interstitials.push({
      code: sanitiseCode(p.code),
      description: p.description,
      when: cond,
      do: [{ kind: 'click', target: { role: 'button', name: p.dismissButtonLabel, nameMatch: 'exact' } }],
      maxOccurrences: 2,
      restartFlow: false,
      escalateOnFailure: true,
      verified: false,
    });
  }

  const risk: Risk = steps.reduce<Risk>(
    (acc, s) => (rank(s.risk) > rank(acc) ? s.risk : acc),
    'safe'
  );

  const capability = zCapability.parse({
    schema: 'capability/v1',
    id: args.id,
    version: args.version,
    name: args.name,
    description: args.description,
    app: { ...args.app, surface: 'web' },
    approval: 'draft',
    risk,
    inputs: args.inputs,
    outputs,
    preconditions: [],
    steps,
    checkpoint,
    outcomes,
    interstitials,
    policy: {
      // Only the origins this flow actually touched.
      //
      // Stamping the deployment's whole allowlist here made this guard
      // vacuous: a deployment serving many institutions lists all of their
      // hosts, so every capability declared permission to drive every one of
      // them, and the "a tenant-specialised capability cannot reach another
      // institution" property was never true. Derive it from the recording
      // instead, and let the tenant registry widen it deliberately.
      allowedOrigins: originsUsed(args.entryUrl, steps),
      maxSteps: Math.max(steps.length + 6, 20),
      confirmAtRisk: 'irreversible',
    },
    fingerprints,
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: 'llm',
      model: args.model,
      discoveryRunId: args.runId,
      goal: args.goal,
    },
  } satisfies Record<string, unknown>);

  return { capability, warnings };
}

/** Distinct origins the recorded flow navigates to. */
function originsUsed(entryUrl: string, steps: Step[]): string[] {
  const origins = new Set<string>();
  const add = (u: string) => {
    try {
      origins.add(new URL(u).origin);
    } catch {
      /* a templated URL with no resolvable origin; the runtime policy still applies */
    }
  };
  add(entryUrl);
  for (const step of steps) {
    if (step.action.kind === 'navigate') add(step.action.url);
  }
  return [...origins];
}

// ------------------------------------------------------------- helpers ----

type Canon = (s: string) => string;

/**
 * Replaces concrete parameter values with `{{name}}`. Longest values first so
 * that a parameter which is a substring of another cannot half-replace it.
 */
function buildCanonicaliser(values: Record<string, string>): Canon {
  const pairs = Object.entries(values)
    .filter(([, v]) => typeof v === 'string' && v.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  return (s: string): string => {
    let out = s;
    for (const [name, value] of pairs) out = out.split(value).join(`{{${name}}}`);
    return out;
  };
}

const m = (value: string, mode: Matcher['mode'] = 'contains', override?: string): Matcher => ({
  mode,
  value: override ?? value,
  caseSensitive: false,
});

function rank(r: Risk): number {
  return { safe: 0, mutating: 1, irreversible: 2 }[r];
}

function sanitiseCode(code: string): string {
  const c = code.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+/, '');
  return /^[A-Z]/.test(c) ? c : `X_${c}`;
}

/**
 * The weakest descriptor that still resolves uniquely on the screen it was
 * recorded from. Disambiguators are added one at a time, strongest-meaning
 * first, and each addition is re-tested.
 */
function minimiseTarget(
  node: UiNode,
  obs: Observation,
  canon: Canon,
  warnings: string[],
  stepId: string
): Target {
  const candidate: Target = {
    role: node.role,
    name: canon(node.name),
    nameMatch: 'exact',
    framePath: node.framePath,
  };
  const unique = (t: Target) => {
    const r = resolveTarget(obs, t);
    return r.ok && r.node.ref === node.ref;
  };
  if (unique(candidate)) return candidate;

  // Row scoping is the most meaningful disambiguator on table-based screens:
  // it says *which record* this control belongs to.
  if (node.rowText) {
    const rowCanon = canon(node.rowText);
    if (rowCanon !== node.rowText) {
      const withRow = { ...candidate, inRowContaining: rowCanon };
      if (unique(withRow)) return withRow;
    }
  }
  if (node.group) {
    const withGroup = { ...candidate, group: canon(node.group) };
    if (unique(withGroup)) return withGroup;
  }

  // Last resort: positional. Recorded explicitly so replay does not have to
  // guess, and flagged so a reviewer knows this one is the fragile step.
  const sameName = obs.nodes
    .filter((n) => n.role === node.role && n.name === node.name)
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const ordinal = sameName.findIndex((n) => n.ref === node.ref);
  if (ordinal >= 0) {
    const withOrdinal = { ...candidate, ordinal };
    if (unique(withOrdinal)) {
      warnings.push(
        `step ${stepId} targets "${node.name}" by position (#${ordinal}) because ${sameName.length} ` +
        `controls share that name; review whether a more specific label exists`
      );
      return withOrdinal;
    }
  }

  warnings.push(`step ${stepId}: could not derive a uniquely resolving descriptor for "${node.name}"`);
  return candidate;
}

function buildAction(
  rec: RecordedAction,
  target: Target | null,
  canon: Canon,
  args: RecordArgs,
  warnings: string[],
  stepId: string
): Step['action'] | null {
  const d = rec.decision;
  switch (d.action) {
    case 'navigate':
      return { kind: 'navigate', url: canon(d.url ?? '') };
    case 'press':
      return { kind: 'press', key: d.key ?? 'Enter' };
    case 'wait':
      return { kind: 'wait', ms: Math.min(d.ms ?? 1000, 30_000) };
    case 'click':
      if (!target) return null;
      return { kind: 'click', target };
    case 'select':
      if (!target) return null;
      return { kind: 'select', target, option: canon(d.option ?? '') };
    case 'type': {
      if (!target) return null;
      const secret = args.secretFields?.find((s) => s.nameMatches.test(rec.node?.name ?? ''));
      if (secret) {
        return { kind: 'type', target, secretRef: secret.secretRef, clearFirst: true };
      }
      const text = canon(d.text ?? '');
      if (text === (d.text ?? '') && d.parameterName && args.paramValues[d.parameterName] !== undefined) {
        // The model said this came from a parameter but the literal did not
        // match the value it was given. Trusting the label over the evidence
        // would bake the wrong thing in, so keep the literal and flag it.
        warnings.push(
          `step ${stepId} typed a literal the model attributed to parameter ` +
          `"${d.parameterName}", but it does not match that parameter's value; left as a literal`
        );
      }
      return { kind: 'type', target, text, clearFirst: true };
    }
    default:
      return null;
  }
}

/**
 * A step's postcondition is "the screen the next step expects is here".
 * Deriving it from the recording rather than asking the model keeps it
 * grounded in what actually happened.
 */
function deriveWaitFor(
  rec: RecordedAction,
  next: RecordedAction | undefined,
  finalObs: Observation,
  canon: Canon,
  bindings: Bindings
): Condition | undefined {
  const after = next?.obsBefore ?? finalObs;

  if (next?.node) {
    const cond: Condition = {
      type: 'nodeExists',
      target: {
        role: next.node.role,
        name: canon(next.node.name),
        nameMatch: 'exact',
        framePath: next.node.framePath,
      },
    };
    if (evaluate(cond, after, bindings, [])) return cond;
  }

  if (after.url !== rec.obsBefore.url) {
    try {
      const path = new URL(after.url).pathname;
      return { type: 'urlMatches', value: m(canon(path)) };
    } catch { /* fall through */ }
  }

  const heading = after.nodes.find((n) => n.role === 'heading')?.name
    ?? after.nodes.find((n) => n.role === 'table')?.name;
  if (heading) return { type: 'textMatches', value: m(canon(heading)) };
  return undefined;
}

function fallbackCheckpoint(obs: Observation, canon: Canon): Condition {
  const heading = obs.nodes.find((n) => n.role === 'heading')?.name
    ?? obs.nodes.find((n) => n.role === 'table')?.name;
  if (heading) return { type: 'textMatches', value: m(canon(heading)) };
  try {
    return { type: 'urlMatches', value: m(canon(new URL(obs.url).pathname)) };
  } catch {
    return { type: 'textMatches', value: m(canon(obs.text.slice(0, 40))) };
  }
}

function buildOutput(
  o: SummaryResponse['outputs'][number],
  canon: Canon,
  warnings: string[]
): Output | null {
  // The model proposes outputs by usefulness, not by sensitivity, and it will
  // cheerfully offer to return an SSN field because it is on the screen.
  // Defaulting every output to `internal` would mean that value flows into
  // results and logs unredacted. Classify by label instead and err high: a
  // reviewer can downgrade a false positive, but nobody reviews a leak that
  // already happened.
  const labelish = `${o.name} ${o.readoutLabel ?? ''} ${o.description}`;
  const sensitive = SENSITIVE_LABEL.test(labelish);
  const common = {
    name: o.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[^a-zA-Z]+/, ''),
    type: o.type,
    description: o.description,
    transform: o.transform ?? 'none',
    required: true,
    sensitivity: (sensitive ? 'pii' : 'internal') as 'pii' | 'internal',
  };
  if (!common.name) return null;
  if (sensitive) {
    warnings.push(
      `output "${common.name}" reads a regulated field and was classified PII (redacted in logs); ` +
      `confirm the caller actually needs it before approving`
    );
  }

  if (o.sourceKind === 'readout' && o.readoutLabel) {
    return { ...common, source: { from: 'readout', label: m(o.readoutLabel) } };
  }
  if (o.sourceKind === 'table' && o.tableWhereColumn && o.tableSelectColumn) {
    return {
      ...common,
      source: {
        from: 'table',
        whereColumn: o.tableWhereColumn,
        whereEquals: m(canon(o.tableWhereEquals ?? '')),
        selectColumn: o.tableSelectColumn,
      },
    };
  }
  if (o.sourceKind === 'text' && o.textPattern) {
    return { ...common, source: { from: 'text', pattern: canon(o.textPattern), group: 1 } };
  }
  return null;
}
