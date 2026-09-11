/**
 * The capability artifact.
 *
 * This is the contract between three audiences, and its shape is driven by
 * having to serve all three at once:
 *
 *   - a *calling agent*, which needs a typed signature: what it must supply,
 *     what it gets back, and which non-exceptional outcomes it must handle;
 *   - a *human reviewer* at a regulated institution, who has to be able to
 *     read the flow and approve it without reading our source;
 *   - the *replay engine*, which must execute it with no model in the loop.
 *
 * Three design decisions are load-bearing:
 *
 * 1. **Targets are semantic, never selectors.** A step says "the textbox
 *    labelled Member Number in the main frame", not `#p_mbr_no`. That is the
 *    only form of identity that survives the jump to a desktop accessibility
 *    tree, and it is the only form a reviewer can actually check.
 *
 * 2. **The error taxonomy lives in the artifact, not the engine.** Which
 *    conditions count as legitimate business outcomes ("no such member") and
 *    which count as recoverable interstitials ("acknowledge this notice") is
 *    knowledge about *the application*, discovered once and reviewed. Baking
 *    it into engine code would mean every new app needs an engine change.
 *
 * 3. **One condition language, three uses.** Checkpoints, outcome detection
 *    and interstitial detection are all `Condition`s. A reviewer learns one
 *    grammar; the engine has one evaluator.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 'capability/v1' as const;

// ------------------------------------------------------------- matching ---

/**
 * String matching with `{{param}}` interpolation applied before comparison.
 * `contains` is the default for anything a human typed, because legacy apps
 * pad labels with whitespace, colons and non-breaking spaces unpredictably.
 */
export const zMatcher = z.object({
  mode: z.enum(['exact', 'contains', 'regex']).default('contains'),
  value: z.string(),
  /** Case-insensitive unless explicitly disabled. */
  caseSensitive: z.boolean().default(false),
});
export type Matcher = z.infer<typeof zMatcher>;

export const zRole = z.enum([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'heading', 'alert', 'readout', 'table', 'other',
]);

/**
 * How a control is identified at replay time. Every field is a *signal*, not
 * a selector: resolution scores candidates across all supplied signals and
 * insists on a unique winner (see replay/locator.ts). Recording several weak
 * signals is safer than recording one strong brittle one.
 */
export const zTarget = z.object({
  role: zRole,
  name: z.string(),
  nameMatch: z.enum(['exact', 'contains', 'regex']).default('exact'),
  /** Frame/window containment, outermost first. */
  framePath: z.array(z.string()).optional(),
  /** Enclosing panel heading. Disambiguator only; a miss is not fatal. */
  group: z.string().optional(),
  /** Which of several identical controls, 0-based. Last-resort disambiguator. */
  ordinal: z.number().int().nonnegative().optional(),
  /** Lowest-confidence, web-only hint. Never sufficient alone. */
  domHint: z.string().optional(),
  /** Scope to the table row containing this text, e.g. "{{memberId}}". */
  inRowContaining: z.string().optional(),
});
export type Target = z.infer<typeof zTarget>;

// ------------------------------------------------------------ conditions ---

export type Condition =
  | { type: 'urlMatches'; value: Matcher }
  | { type: 'textMatches'; value: Matcher }
  | { type: 'nodeExists'; target: Target }
  | { type: 'readoutMatches'; label: Matcher; value: Matcher }
  | { type: 'all'; of: Condition[] }
  | { type: 'any'; of: Condition[] }
  | { type: 'not'; of: Condition };

export const zCondition: z.ZodType<Condition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('urlMatches'), value: zMatcher }),
    z.object({ type: z.literal('textMatches'), value: zMatcher }),
    z.object({ type: z.literal('nodeExists'), target: zTarget }),
    z.object({ type: z.literal('readoutMatches'), label: zMatcher, value: zMatcher }),
    z.object({ type: z.literal('all'), of: z.array(zCondition) }),
    z.object({ type: z.literal('any'), of: z.array(zCondition) }),
    z.object({ type: z.literal('not'), of: zCondition }),
  ])
);

// ---------------------------------------------------------------- types ----

/**
 * Sensitivity drives redaction, and it is declared on the *parameter* rather
 * than inferred from the value. Inference is exactly the wrong tool here: a
 * redactor that guesses will eventually guess wrong on regulated data.
 *
 *  - `secret`  never enters the process as a literal; supplied by reference
 *              from the credential provider and never logged or persisted.
 *  - `pii`     may be used to drive the UI, but is masked in logs, artifacts
 *              and screenshots.
 *  - `internal`/`public` logged as-is.
 */
export const zSensitivity = z.enum(['public', 'internal', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof zSensitivity>;

export const zParam = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  enum: z.array(z.string()).optional(),
  required: z.boolean().default(true),
  description: z.string(),
  sensitivity: zSensitivity.default('internal'),
  /** Validated before the browser is even launched. */
  pattern: z.string().optional(),
  example: z.string().optional(),
});
export type Param = z.infer<typeof zParam>;

/** Where an output value is read from on the final screen. */
export const zExtractor = z.discriminatedUnion('from', [
  z.object({ from: z.literal('readout'), label: zMatcher }),
  z.object({
    from: z.literal('table'),
    table: zMatcher.optional(),
    whereColumn: z.string(),
    whereEquals: zMatcher,
    selectColumn: z.string(),
  }),
  z.object({ from: z.literal('text'), pattern: z.string(), group: z.number().int().default(1) }),
  z.object({ from: z.literal('node'), target: zTarget, attr: z.enum(['name', 'value']).default('value') }),
]);
export type Extractor = z.infer<typeof zExtractor>;

export const zOutput = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  source: zExtractor,
  /** `money` strips currency formatting; `number` coerces. */
  transform: z.enum(['none', 'trim', 'money', 'number', 'upper']).default('none'),
  required: z.boolean().default(true),
  sensitivity: zSensitivity.default('internal'),
});
export type Output = z.infer<typeof zOutput>;

// ----------------------------------------------------------------- steps ---

/**
 * Risk is declared per step, not per capability, because a single flow
 * routinely mixes both: nine navigational steps and one that posts a journal
 * entry. Guardrails act on the step.
 */
export const zRisk = z.enum(['safe', 'mutating', 'irreversible']);
export type Risk = z.infer<typeof zRisk>;

// A plain union rather than a discriminated one: the `type` variant carries a
// cross-field refinement (text XOR secretRef), which Zod cannot express inside
// a discriminated union option.
export const zStepAction = z.union([
  z.object({ kind: z.literal('navigate'), url: z.string() }),
  z.object({ kind: z.literal('click'), target: zTarget }),
  z.object({
    kind: z.literal('type'),
    target: zTarget,
    /** Templated literal. Mutually exclusive with `secretRef`. */
    text: z.string().optional(),
    /**
     * Name of a credential resolved at run time from the credential provider.
     * The value never appears in the artifact, the logs, or the transcript.
     */
    secretRef: z.string().optional(),
    clearFirst: z.boolean().default(true),
  }).refine((v) => (v.text === undefined) !== (v.secretRef === undefined), {
    message: 'a type step needs exactly one of `text` or `secretRef`',
  }),
  z.object({ kind: z.literal('select'), target: zTarget, option: z.string() }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive().max(30_000) }),
  /** Composition: run another capability (used for sign-on / re-auth). */
  z.object({
    kind: z.literal('run_capability'),
    capability: z.string(),
    inputs: z.record(z.string()).default({}),
  }),
]);
export type StepAction = z.infer<typeof zStepAction>;

export const zStep = z.object({
  id: z.string(),
  /** Plain-language description. This is what a reviewer actually reads. */
  intent: z.string(),
  action: zStepAction,
  risk: zRisk.default('safe'),
  /** Must hold before the step is considered complete. */
  waitFor: zCondition.optional(),
  /** Skip silently if its target cannot be resolved. */
  optional: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  retry: z.object({
    attempts: z.number().int().min(1).max(5).default(1),
    backoffMs: z.number().int().nonnegative().default(500),
  }).default({ attempts: 1, backoffMs: 500 }),
});
export type Step = z.infer<typeof zStep>;

// -------------------------------------------------------------- outcomes ---

/**
 * A *declared business outcome*: the application worked correctly and is
 * telling us something the caller needs to know. "No member record found" is
 * a result, not a failure, and conflating the two is the single most common
 * way these systems become untrustworthy to their callers.
 */
export const zOutcome = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  when: zCondition,
  /**
   * `business` — the application worked and this is a legitimate result the
   * caller must handle. `failure` — the application itself is broken (a 500
   * page, a core outage banner). Both are *recognised* screens, which is why
   * they share a declaration, but only the first is an answer. Conflating
   * them would tell a calling agent that "the core is down" is a fact about
   * the member it asked for.
   */
  classification: z.enum(['business', 'failure']).default('business'),
  /** Which steps this may legitimately appear after. Empty = any. */
  afterSteps: z.array(z.string()).default([]),
  /** Whether the run stops here (almost always true). */
  terminal: z.boolean().default(true),
  /** Outputs still extractable in this outcome, e.g. an error code. */
  outputs: z.array(zOutput).default([]),
  /**
   * Whether this detector has been confirmed to fire against a real screen.
   *
   * A model proposing outcomes from a single happy-path run is guessing at
   * wording it has never seen, and a guess that never matches is worse than
   * no detector at all: the run fails with a timeout instead of reporting the
   * outcome. Unverified detectors ship, but they ship labelled.
   */
  verified: z.boolean().default(false),
});
export type Outcome = z.infer<typeof zOutcome>;

/**
 * A *recoverable condition*: something got in the way that we know how to
 * clear. Recovery is a bounded, declared action list — never open-ended — so
 * that a compromised or drifted screen cannot induce arbitrary behaviour.
 */
export const zInterstitial = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  description: z.string(),
  when: zCondition,
  do: z.array(zStepAction).max(6),
  /** Guards against an interstitial that never clears becoming a loop. */
  maxOccurrences: z.number().int().min(1).max(5).default(2),
  /**
   * Restart the flow from step one after recovering, rather than resuming.
   *
   * This is what session expiry actually requires: re-authenticating leaves
   * you at the app's home screen, not back where you were, so resuming
   * mid-flow just times out against a screen that is no longer there.
   *
   * The engine honours this only for capabilities whose overall risk is
   * `safe`. Restarting a flow that posts a transaction risks posting it
   * twice, and there is no way to tell from the UI whether the first attempt
   * committed before the session dropped. Mutating flows escalate instead.
   */
  restartFlow: z.boolean().default(false),
  /** If recovery fails, hand to a human rather than failing outright. */
  escalateOnFailure: z.boolean().default(true),
  /** Confirmed by a probe run that actually hit this screen and recovered. */
  verified: z.boolean().default(false),
});
export type Interstitial = z.infer<typeof zInterstitial>;

// ------------------------------------------------------------ capability ---

export const zAppRef = z.object({
  /** The vendor product, shared across tenants running the same software. */
  vendor: z.string(),
  product: z.string(),
  productVersion: z.string().optional(),
  /** Absent on a base capability; set on a tenant-specialised one. */
  tenant: z.string().optional(),
  surface: z.enum(['web', 'desktop', 'terminal']).default('web'),
});

export const zCapability = z.object({
  schema: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  /** Agent-facing summary. This is what shows up in a tool catalog. */
  description: z.string(),
  app: zAppRef,

  /**
   * Unattended replay is gated on `approved`. Discovery always emits `draft`:
   * a model-authored flow against a regulated system does not get to promote
   * itself.
   */
  approval: z.enum(['draft', 'in_review', 'approved']).default('draft'),
  /** Worst-case risk over all steps; derived, but stored for cheap filtering. */
  risk: zRisk.default('safe'),

  inputs: z.array(zParam).default([]),
  outputs: z.array(zOutput).default([]),

  /** Conditions that must hold before step 1, e.g. "operator is signed on". */
  preconditions: z.array(zCondition).default([]),
  steps: z.array(zStep).min(1),
  /** The success condition. A run that does not satisfy it did not succeed. */
  checkpoint: zCondition,

  outcomes: z.array(zOutcome).default([]),
  interstitials: z.array(zInterstitial).default([]),

  policy: z.object({
    allowedOrigins: z.array(z.string()).default([]),
    maxSteps: z.number().int().positive().default(40),
    /** Steps at or above this risk require human confirmation to execute. */
    confirmAtRisk: zRisk.default('irreversible'),
  }).default({ allowedOrigins: [], maxSteps: 40, confirmAtRisk: 'irreversible' }),

  /**
   * Per-step hash of the perceived control skeleton (roles + names, sorted).
   * Replay recomputes these and reports divergence. This is how per-tenant
   * and per-version drift surfaces as a signal rather than as a mystery
   * failure three months later.
   */
  fingerprints: z.record(z.string()).default({}),

  provenance: z.object({
    recordedAt: z.string(),
    recordedBy: z.enum(['llm', 'human', 'import']),
    model: z.string().optional(),
    discoveryRunId: z.string().optional(),
    goal: z.string().optional(),
    /** Set when this capability was derived from another. */
    derivedFrom: z.object({ id: z.string(), version: z.string() }).optional(),
    /** What a human changed when promoting a draft. */
    reviewNote: z.string().optional(),
  }),
});
export type Capability = z.infer<typeof zCapability>;

/**
 * A tenant-specific specialisation of a base capability.
 *
 * Hundreds of institutions run the same vendor product with different
 * branding, field labels and menu paths. Re-recording per tenant does not
 * scale and destroys any chance of a shared fix. Instead a tenant carries a
 * thin overlay of typed patches against a versioned base, so the base can be
 * improved once and inherited everywhere, and the delta for each institution
 * stays small enough to review.
 */
export const zOverlay = z.object({
  schema: z.literal('overlay/v1'),
  base: z.object({ id: z.string(), version: z.string() }),
  tenant: z.string(),
  description: z.string().default(''),
  /** Dotted paths into the capability, e.g. `steps[2].action.target.name`. */
  patches: z.array(z.object({
    path: z.string(),
    value: z.unknown(),
    reason: z.string().default(''),
  })).default([]),
  /**
   * Relabel a control everywhere it is referenced.
   *
   * A tenant renaming one button touches the capability in more than one
   * place — the step that clicks it, and every condition that waits for it.
   * Expressing that as N path patches means a reviewer has to find all N, and
   * missing one produces a flow that clicks the right button and then times
   * out waiting for the old one. A rename states the intent once and the
   * engine reports how many sites it touched, so a count of zero is visible
   * rather than silent.
   */
  renames: z.array(z.object({
    role: zRole.optional(),
    from: z.string(),
    to: z.string(),
    reason: z.string().default(''),
  })).default([]),
  approval: z.enum(['draft', 'in_review', 'approved']).default('draft'),
});
export type Overlay = z.infer<typeof zOverlay>;

export function parseCapability(input: unknown): Capability {
  return zCapability.parse(input);
}
export function parseOverlay(input: unknown): Overlay {
  return zOverlay.parse(input);
}
