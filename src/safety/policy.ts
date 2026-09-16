/**
 * Guardrails.
 *
 * Two layers, and it matters which is which:
 *
 *  - **The allowlist is the hard boundary.** Origin and path prefixes are
 *    checked on every navigation and every action, during discovery and
 *    during replay. Nothing the model says can widen it.
 *
 *  - **Risk classification is a heuristic floor, not a guarantee.** During
 *    discovery we have to guess whether "Post Account" is irreversible from
 *    its label, and label heuristics are defeatable. So the guess is only
 *    used to decide *when to stop and ask a human*, never to authorise. The
 *    durable control is that every step in a recorded artifact carries an
 *    explicit reviewed risk label, and unattended replay requires the
 *    artifact to be `approved`.
 *
 * The choice to *escalate* rather than *block* irreversible actions is
 * deliberate. In back-office banking the irreversible step is usually the
 * entire point of the task; a system that refuses to post anything is not
 * safe, it is useless, and it gets routed around. Escalation keeps a human
 * accountable for the consequential decision while leaving the other
 * nineteen steps automated.
 */
import type { Risk } from '../artifact/schema.js';

export interface PolicyConfig {
  /** Origins the agent may touch, e.g. "http://127.0.0.1:4311". */
  allowedOrigins: string[];
  /** Optional path prefixes; empty means any path on an allowed origin. */
  allowedPathPrefixes: string[];
  /** Paths that are never permitted even on an allowed origin. */
  deniedPathPrefixes: string[];
  allowedActions: Array<
    'navigate' | 'click' | 'type' | 'type_secret' | 'select' | 'press' | 'wait' | 'run_capability'
  >;
  /**
   * Location schemes the deployment permits, e.g. `http`, `https`, `tn3270`.
   *
   * The allowlist is about *where you are*, not about the web. A green-screen
   * session's location is `tn3270://host:port/SCREEN` and a desktop app's
   * would be something like `app://process/window`; the same origin check
   * applies to all of them, which is what stops the policy from being a
   * web-only concept the seam cannot carry.
   */
  allowedSchemes: string[];
  /** Steps at or above this risk need a human decision. */
  confirmAtRisk: Risk;
  maxSteps: number;
  /** Wall-clock ceiling for a single run. Enforced between steps. */
  runTimeoutMs: number;
  /**
   * How long a raised intervention waits for an operator before the run gives
   * up and returns `needs_human`. Without a bound, "escalate" means "block
   * forever", which is not a safety property — it is a hang.
   */
  escalationTimeoutMs: number;
  /**
   * Whether a caller may weaken the controls at invocation time
   * (`--risky proceed`, `--allow-draft`).
   *
   * Off by default, because the premise of this system is that an *agent*
   * invokes capabilities by name — so the caller is the untrusted side of the
   * boundary. An "audited override" supplied by the party the gate exists to
   * constrain is not an override, it is an off switch.
   */
  allowCallerOverrides: boolean;
}

export const DEFAULT_POLICY: PolicyConfig = {
  allowedOrigins: [],
  allowedPathPrefixes: [],
  deniedPathPrefixes: [],
  // `type_secret` fills a credential field without the value passing through
  // the model. It is a *narrower* capability than `type`, not a wider one.
  allowedActions: ['navigate', 'click', 'type', 'type_secret', 'select', 'press', 'wait', 'run_capability'],
  allowedSchemes: ['http', 'https'],
  confirmAtRisk: 'irreversible',
  maxSteps: 40,
  runTimeoutMs: 5 * 60_000,
  escalationTimeoutMs: 10 * 60_000,
  allowCallerOverrides: false,
};

export type Decision =
  | { decision: 'allow' }
  | { decision: 'confirm'; reason: string }
  | { decision: 'deny'; reason: string };

const RANK: Record<Risk, number> = { safe: 0, mutating: 1, irreversible: 2 };

/**
 * Origin of a location, for any scheme.
 *
 * `URL.origin` returns the string "null" for schemes the spec does not treat
 * as special, which quietly matches nothing — so a non-web surface would have
 * been denied for the wrong reason, or worse, compared "null" to "null".
 */
/**
 * The one place a location is authorised: the deployment's allowlist AND the
 * origins the capability itself declares, intersected.
 *
 * It lived only in the replay engine, so operator navigation from the console
 * was checked against the deployment policy alone — and in the target
 * environment, one deployment lists every tenant's origin, so anything holding
 * the console token could walk a live session into another institution.
 * Returns a reason when the navigation must not happen.
 */
export function denyLocation(policy: Policy, declaredOrigins: string[], url: string): string | null {
  const check = policy.checkUrl(url);
  if (check.decision === 'deny') return check.reason;
  if (!declaredOrigins.some((o) => url.startsWith(o))) {
    return declaredOrigins.length === 0
      ? `${url} is refused: this capability declares no permitted origins`
      : `${url} is outside the origins this capability declares (${declaredOrigins.join(', ')})`;
  }
  return null;
}

export function originOf(u: URL): string {
  const scheme = u.protocol.replace(/:$/, '');
  if (u.origin && u.origin !== 'null') return u.origin;
  return `${scheme}://${u.host}`;
}

/** Label patterns that suggest an action commits something. */
const IRREVERSIBLE_LABEL =
  /\b(post|commit|transfer|wire|disburse|delete|remove|void|purge|charge|release|approve|deny|send|close\s+account|write.?off|reverse)\b/i;
const MUTATING_LABEL =
  /\b(save|update|create|add|apply|submit|change|set|open\b)\b/i;

export class Policy {
  constructor(readonly config: PolicyConfig) {}

  static from(partial: Partial<PolicyConfig>): Policy {
    return new Policy({ ...DEFAULT_POLICY, ...partial });
  }

  /** Hard boundary. Applies to discovery and replay, on any surface. */
  checkUrl(rawUrl: string): Decision {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return { decision: 'deny', reason: `not a valid location: ${rawUrl}` };
    }
    const scheme = u.protocol.replace(/:$/, '');
    if (!this.config.allowedSchemes.includes(scheme)) {
      return { decision: 'deny', reason: `scheme ${scheme} is not permitted` };
    }
    if (!this.config.allowedOrigins.includes(originOf(u))) {
      return { decision: 'deny', reason: `origin ${originOf(u)} is not on the allowlist` };
    }
    for (const denied of this.config.deniedPathPrefixes) {
      if (u.pathname.startsWith(denied)) {
        return { decision: 'deny', reason: `path ${u.pathname} is explicitly denied` };
      }
    }
    const prefixes = this.config.allowedPathPrefixes;
    if (prefixes.length > 0 && !prefixes.some((p) => u.pathname.startsWith(p))) {
      return { decision: 'deny', reason: `path ${u.pathname} is outside the allowed prefixes` };
    }
    return { decision: 'allow' };
  }

  checkActionKind(kind: string): Decision {
    return (this.config.allowedActions as string[]).includes(kind)
      ? { decision: 'allow' }
      : { decision: 'deny', reason: `action kind "${kind}" is not permitted by policy` };
  }

  /**
   * Gate on declared step risk.
   *
   * `capabilityThreshold` is the capability's own `policy.confirmAtRisk`. The
   * effective threshold is whichever of the two is *stricter*, so neither the
   * deployment nor a capability can loosen what the other requires — a
   * capability that asks for confirmation on mutating steps gets it even
   * where the deployment only insists on irreversible ones.
   */
  checkRisk(risk: Risk, what: string, capabilityThreshold?: Risk): Decision {
    const threshold = capabilityThreshold !== undefined &&
      RANK[capabilityThreshold] < RANK[this.config.confirmAtRisk]
      ? capabilityThreshold
      : this.config.confirmAtRisk;
    if (RANK[risk] >= RANK[threshold]) {
      return { decision: 'confirm', reason: `${what} is classified ${risk} (threshold ${threshold})` };
    }
    return { decision: 'allow' };
  }

  /**
   * Best-effort risk guess for an action the model proposed during discovery,
   * where no reviewed label exists yet. Intentionally errs toward caution.
   */
  static classify(kind: string, controlLabel: string | undefined): Risk {
    if (kind !== 'click' && kind !== 'press') return 'safe';
    const label = controlLabel ?? '';
    if (IRREVERSIBLE_LABEL.test(label)) return 'irreversible';
    if (MUTATING_LABEL.test(label)) return 'mutating';
    return 'safe';
  }
}
