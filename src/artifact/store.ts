/**
 * Capability storage, tenant overlays, and the agent-facing catalog.
 *
 * Artifacts are plain JSON files on disk, one per capability, named
 * `<id>@<version>.json`. Git is a perfectly good store for something that is
 * reviewed, versioned and diffed by humans, and it gives review workflow,
 * history and blame for free. A database buys nothing here until there is a
 * reason to query across thousands of them.
 *
 * Overlays are the answer to "hundreds of tenants, ~20 apps each, many
 * running the same vendor product". A tenant does not get a copy of the
 * capability; it gets a short list of typed patches against a pinned base
 * version. That keeps the common case — a fix to the base — inheritable by
 * every institution at once, and makes each institution's true delta visible
 * and reviewable rather than buried in a 400-line fork.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCapability, parseOverlay, type Capability, type Overlay } from './schema.js';

export const CAPABILITY_DIR = process.env.HS_CAPABILITY_DIR ?? 'capabilities';

export function capabilityPath(cap: Pick<Capability, 'id' | 'version'>, dir = CAPABILITY_DIR): string {
  return join(dir, `${cap.id}@${cap.version}.json`);
}

export function saveCapability(cap: Capability, dir = CAPABILITY_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = capabilityPath(cap, dir);
  writeFileSync(path, JSON.stringify(cap, null, 2) + '\n');
  return path;
}

export function loadCapabilityFile(path: string): Capability {
  return parseCapability(JSON.parse(readFileSync(path, 'utf8')));
}

export function listCapabilities(dir = CAPABILITY_DIR): Capability[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.includes('.overlay.'))
    .map((f) => {
      try {
        return loadCapabilityFile(join(dir, f));
      } catch {
        return null;
      }
    })
    .filter((c): c is Capability => c !== null);
}

/** Newest version of each id, or an exact match when `version` is given. */
export function findCapability(id: string, version?: string, dir = CAPABILITY_DIR): Capability | undefined {
  const all = listCapabilities(dir).filter((c) => c.id === id);
  if (version) return all.find((c) => c.version === version);
  return all.sort((a, b) => cmpSemver(b.version, a.version))[0];
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ------------------------------------------------------------- overlays ---

export function loadOverlay(path: string): Overlay {
  return parseOverlay(JSON.parse(readFileSync(path, 'utf8')));
}

export interface OverlayApplication {
  capability: Capability;
  applied: Array<{ path: string; reason: string }>;
  rejected: Array<{ path: string; reason: string }>;
}

/** Deployment-owned mapping of tenant to the origins that tenant may be driven at. */
export type TenantRegistry = Record<string, { label?: string; origins: string[] }>;

export function loadTenantRegistry(path = 'config/tenants.json'): TenantRegistry {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as TenantRegistry;
}

/**
 * Paths an overlay may never write.
 *
 * An overlay is a *specialisation*, not a privilege escalation. Each of these
 * is a guardrail, and letting a tenant file relax one would mean the weakest
 * overlay in the fleet sets the safety level for the capability it derives
 * from. Patching `steps[N].risk` to "safe" is enough to post an irreversible
 * transaction with no human in the loop; patching `policy.allowedOrigins` is
 * enough to point one institution's capability at another's instance.
 *
 * Origins still have to vary per tenant — that is the whole point — so they
 * come from the deployment's tenant registry rather than from the overlay.
 */
const GUARDED_PATHS: Array<{ re: RegExp; why: string }> = [
  { re: /^approval$/, why: 'approval is granted by review, not by an overlay' },
  { re: /(^|\.)risk$/, why: 'an overlay may not reclassify how risky a step is' },
  { re: /^policy\.confirmAtRisk$/, why: 'an overlay may not move the human-confirmation threshold' },
  { re: /^policy\.allowedOrigins$/, why: 'origins come from the deployment tenant registry, not the overlay' },
  { re: /^policy\.maxSteps$/, why: 'an overlay may not raise the step budget' },
];

/**
 * Applies a tenant overlay to its base capability.
 *
 * Two rules make this safe enough to run unattended:
 *   - the overlay pins a base *version*, so a base change cannot silently
 *     re-target a patch at a step that has moved;
 *   - a patch whose path does not resolve is *rejected and reported*, never
 *     created. A patch that quietly invents `steps[7]` because the base now
 *     has six steps is how a tenant ends up running a flow nobody wrote.
 */
export function applyOverlay(
  base: Capability,
  overlay: Overlay,
  registry: TenantRegistry = {}
): OverlayApplication {
  if (overlay.base.id !== base.id) {
    throw new Error(`overlay targets ${overlay.base.id}, not ${base.id}`);
  }
  if (overlay.base.version !== base.version) {
    throw new Error(
      `overlay for tenant "${overlay.tenant}" pins ${overlay.base.id}@${overlay.base.version} ` +
      `but ${base.version} was supplied; re-review the overlay against the new base`
    );
  }

  const clone = JSON.parse(JSON.stringify(base)) as Capability;
  const applied: OverlayApplication['applied'] = [];
  const rejected: OverlayApplication['rejected'] = [];

  for (const rename of overlay.renames) {
    const sites = renameTargets(clone as unknown as Record<string, unknown>, rename);
    if (sites === 0) {
      rejected.push({
        path: `rename ${rename.role ?? 'control'} "${rename.from}"`,
        reason: 'the base capability does not reference a control by that name',
      });
    } else {
      applied.push({
        path: `rename ${rename.role ?? 'control'} "${rename.from}" → "${rename.to}" (${sites} site${sites === 1 ? '' : 's'})`,
        reason: rename.reason,
      });
    }
  }

  for (const patch of overlay.patches) {
    const guard = GUARDED_PATHS.find((g) => g.re.test(patch.path));
    if (guard) {
      rejected.push({ path: patch.path, reason: `refused — ${guard.why}` });
      continue;
    }
    const ok = setAtPath(clone as unknown as Record<string, unknown>, patch.path, patch.value);
    if (ok) applied.push({ path: patch.path, reason: patch.reason });
    else rejected.push({ path: patch.path, reason: 'path does not exist on the base capability' });
  }

  // Origins are a deployment fact about the tenant, not something the tenant's
  // own file gets to assert. An unknown tenant inherits nothing and is left
  // with the base's origins, which will not match its instance — it fails
  // closed rather than open.
  const tenant = registry[overlay.tenant];
  if (tenant) {
    clone.policy = { ...clone.policy, allowedOrigins: [...tenant.origins] };
    applied.push({
      path: 'policy.allowedOrigins',
      reason: `from the tenant registry (${tenant.label ?? overlay.tenant})`,
    });
  } else {
    rejected.push({
      path: 'policy.allowedOrigins',
      reason: `tenant "${overlay.tenant}" is not in the deployment tenant registry`,
    });
  }

  clone.app = { ...clone.app, tenant: overlay.tenant };
  clone.provenance = {
    ...clone.provenance,
    derivedFrom: { id: base.id, version: base.version },
  };
  clone.approval = overlay.approval === 'approved' && base.approval === 'approved' ? 'approved' : 'draft';

  return { capability: clone, applied, rejected };
}

/**
 * Rewrites the `name` of every target descriptor matching `from`, wherever it
 * appears — step actions, waitFor conditions, checkpoints, interstitials.
 * Returns the number of sites touched.
 */
function renameTargets(
  root: Record<string, unknown>,
  rename: { role?: string; from: string; to: string }
): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    // A target descriptor is recognisable by carrying both a role and a
    // nameMatch; nothing else in the schema has that pair.
    if (typeof o.role === 'string' && typeof o.name === 'string' && 'nameMatch' in o) {
      if (o.name === rename.from && (!rename.role || o.role === rename.role)) {
        o.name = rename.to;
        count++;
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return count;
}

/** Sets `a.b[0].c` if — and only if — every segment already exists. */
export function setAtPath(root: Record<string, unknown>, path: string, value: unknown): boolean {
  const segments = path.split('.').flatMap((part) => {
    const m = part.match(/^([^[\]]+)((\[\d+\])*)$/);
    if (!m) return [part];
    const idx = [...(m[2] ?? '').matchAll(/\[(\d+)\]/g)].map((x) => x[1] as string);
    return [m[1] as string, ...idx];
  });

  let cur: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (cur === null || typeof cur !== 'object') return false;
    const next = (cur as Record<string, unknown>)[seg];
    if (next === undefined) return false;
    cur = next;
  }
  const last = segments[segments.length - 1]!;
  if (cur === null || typeof cur !== 'object') return false;
  if (!(last in (cur as Record<string, unknown>))) return false;
  (cur as Record<string, unknown>)[last] = value;
  return true;
}

// -------------------------------------------------------------- catalog ---

/**
 * The catalog an AI agent sees. Deliberately this is *not* the artifact: the
 * agent has no business knowing about locators, frames or step order. It
 * needs a name, a description, a typed signature, and — critically — the list
 * of business outcomes it must be prepared to handle, because those are part
 * of the contract in the same way the return type is.
 */
export interface CatalogEntry {
  name: string;
  version: string;
  description: string;
  risk: string;
  approval: string;
  app: { vendor: string; product: string; tenant?: string };
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[]; pattern?: string }>;
    required: string[];
  };
  returns: Record<string, { type: string; description: string }>;
  /**
   * Only *business* outcomes. A recognised application failure comes back as
   * `status: "failure"`, so listing it here as something the caller handles
   * would tell an agent that "the core is down" is a fact about the record it
   * asked for. `verified` is exposed because an unproven detector is a
   * different promise from a proven one.
   */
  outcomes: Array<{ code: string; description: string; verified: boolean }>;
}

export function toCatalogEntry(cap: Capability): CatalogEntry {
  const properties: CatalogEntry['inputSchema']['properties'] = {};
  for (const p of cap.inputs) {
    properties[p.name] = {
      type: p.type === 'enum' ? 'string' : p.type,
      description: p.sensitivity === 'pii' ? `${p.description} (PII — redacted in logs)` : p.description,
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.pattern ? { pattern: p.pattern } : {}),
    };
  }
  const returns: CatalogEntry['returns'] = {};
  for (const o of cap.outputs) returns[o.name] = { type: o.type, description: o.description };

  return {
    name: cap.id,
    version: cap.version,
    description: cap.description,
    risk: cap.risk,
    approval: cap.approval,
    app: { vendor: cap.app.vendor, product: cap.app.product, tenant: cap.app.tenant },
    inputSchema: {
      type: 'object',
      properties,
      required: cap.inputs.filter((p) => p.required).map((p) => p.name),
    },
    returns,
    outcomes: cap.outcomes
      .filter((o) => o.classification === 'business')
      .map((o) => ({ code: o.code, description: o.description, verified: o.verified })),
  };
}
