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

/**
 * Writes a capability, refusing to silently replace an approved one.
 *
 * A version is an identity, not a filename: re-running discovery used to
 * overwrite `<id>@<version>.json` without a word, so a model-authored draft
 * could quietly take the place of a reviewed, approved artifact that tenants
 * inherit from. Overwriting a draft is ordinary iteration; overwriting an
 * approval is not something to do by accident.
 */
export function saveCapability(cap: Capability, dir = CAPABILITY_DIR, allowOverwrite = false): string {
  mkdirSync(dir, { recursive: true });
  const path = capabilityPath(cap, dir);

  if (!allowOverwrite && existsSync(path)) {
    const existing = loadCapabilityFile(path);
    if (existing.approval === 'approved') {
      throw new Error(
        `${cap.id}@${cap.version} already exists and is approved. Recording over a reviewed ` +
        `capability would replace what tenants inherit; bump the version instead.`
      );
    }
  }

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
 * What an overlay is allowed to change, as an allow-list.
 *
 * Two earlier versions of this got the shape wrong. The first denylisted
 * guarded *path spellings* and lost to patching one level up. The second
 * compared a hand-enumerated set of fields by value afterwards and reverted
 * what moved — better, but still an enumeration, so it missed `sensitivity`
 * (a tenant could downgrade it and put a customer's name on disk), missed
 * `interstitials` and `checkpoint` entirely, and "restored" injected outcome
 * codes by looking them up in the base, where by definition they were absent.
 * That last one reported a revert that had not happened, which is worse than
 * no guardrail: it lied in its own audit trail.
 *
 * The lesson I kept failing to take is that enumerating what an attacker may
 * not do loses to anyone who thinks of a thing not on the list. So this is
 * inverted: a patch is refused unless its path matches something here, and it
 * is refused *before* being applied, so nothing has to be put back and the
 * audit line cannot describe a revert that did not occur.
 *
 * The list is what tenant specialisation actually needs: relabelled controls,
 * a different host, a renamed column, differently-worded messages.
 */
const PATCHABLE: RegExp[] = [
  /^name$/,
  /^description$/,
  /^app\.(productVersion|tenant)$/,
  /^steps\[\d+\]\.action\.(url|option)$/,
  /^steps\[\d+\]\.action\.target\.(name|nameMatch|group|ordinal|framePath|domHint|inRowContaining)$/,
  /^steps\[\d+\]\.(timeoutMs|optional)$/,
  /^steps\[\d+\]\.retry\.(attempts|backoffMs)$/,
  /^steps\[\d+\]\.waitFor(\..*)?$/,
  /^outputs\[\d+\]\.source(\..*)?$/,
  /^outputs\[\d+\]\.transform$/,
  /^outcomes\[\d+\]\.when(\..*)?$/,
  /^interstitials\[\d+\]\.when(\..*)?$/,
  /^interstitials\[\d+\]\.do\[\d+\]\.target\.(name|nameMatch|framePath)$/,
  /^checkpoint(\..*)?$/,
];

/**
 * Patchable, but only with a fresh pair of eyes.
 *
 * These paths decide what *counts* as success or as a recognised screen.
 * Tenants genuinely word them differently, so forbidding the change would
 * force a re-recording per institution — but a checkpoint rewritten to
 * something trivially true turns a failed run into a reported success, so an
 * overlay that touches one lands as `draft` and cannot be replayed unattended
 * until a human has looked at it.
 */
const REQUIRES_REREVIEW: RegExp[] = [
  /^checkpoint(\..*)?$/,
  /^steps\[\d+\]\.waitFor(\..*)?$/,
  /^outcomes\[\d+\]\.when(\..*)?$/,
  /^interstitials\[\d+\]\.when(\..*)?$/,
];

/**
 * A last-line self-audit over things no patch should be able to reach.
 *
 * With the allow-list above this should be unreachable, so if it ever fires
 * the allow-list is wrong and the right response is to fail the run loudly
 * rather than quietly repair the artifact and carry on.
 */
const SEALED: Array<{ name: string; read: (c: Capability) => unknown }> = [
  // `approval` is deliberately not here: the allow-list already keeps patches
  // away from it, and this function lowers it on purpose when an overlay
  // changes what counts as success.
  { name: 'risk', read: (c) => c.risk },
  { name: 'policy', read: (c) => ({ ...c.policy, allowedOrigins: null }) },
  { name: 'step sequence', read: (c) => c.steps.map((x) => `${x.id}:${x.risk}:${x.action.kind}`).join(',') },
  { name: 'input sensitivity', read: (c) => c.inputs.map((i) => `${i.name}:${i.sensitivity}`).join(',') },
  { name: 'output sensitivity', read: (c) => c.outputs.map((o) => `${o.name}:${o.sensitivity}:${o.type}`).join(',') },
  { name: 'outcome codes', read: (c) => c.outcomes.map((o) => `${o.code}:${o.classification}`).join(',') },
  { name: 'interstitial codes', read: (c) => c.interstitials.map((i) => `${i.code}:${i.restartFlow}`).join(',') },
];

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
  let needsReReview = false;

  for (const rename of overlay.renames) {
    const { count, sites } = renameTargets(clone as unknown as Record<string, unknown>, rename);
    if (count === 0) {
      rejected.push({
        path: `rename ${rename.role ?? 'control'} "${rename.from}"`,
        reason: 'the base capability does not reference a control by that name',
      });
      continue;
    }
    // A rename is a patch by another name, and it reaches further: it rewrites
    // every target descriptor in the document, including the ones inside
    // `waitFor`, `checkpoint` and outcome detectors. Expressing a
    // success-condition change this way used to slip past the attestation that
    // the equivalent patch required — the same enumeration mistake, one layer
    // out.
    if (sites.some((site) => REQUIRES_REREVIEW.some((re) => re.test(site)))) needsReReview = true;
    applied.push({
      path: `rename ${rename.role ?? 'control'} "${rename.from}" → "${rename.to}" (${count} site${count === 1 ? '' : 's'})`,
      reason: rename.reason,
    });
  }

  for (const patch of overlay.patches) {
    if (!PATCHABLE.some((re) => re.test(patch.path))) {
      rejected.push({
        path: patch.path,
        reason: 'refused — not a path a tenant overlay may change',
      });
      continue;
    }
    const ok = setAtPath(clone as unknown as Record<string, unknown>, patch.path, patch.value);
    if (!ok) {
      rejected.push({ path: patch.path, reason: 'path does not exist on the base capability' });
      continue;
    }
    if (REQUIRES_REREVIEW.some((re) => re.test(patch.path))) needsReReview = true;
    applied.push({ path: patch.path, reason: patch.reason });
  }

  // Origins are a deployment fact about the tenant, not something the tenant's
  // own file asserts. An unknown tenant gets an empty list, which the engine
  // treats as "navigate nowhere" — the failure has to be closed, not silent.
  const tenant = registry[overlay.tenant];
  if (tenant) {
    clone.policy = { ...clone.policy, allowedOrigins: [...tenant.origins] };
    applied.push({
      path: 'policy.allowedOrigins',
      reason: `from the tenant registry (${tenant.label ?? overlay.tenant})`,
    });
  } else {
    clone.policy = { ...clone.policy, allowedOrigins: [] };
    rejected.push({
      path: 'policy.allowedOrigins',
      reason: `tenant "${overlay.tenant}" is not in the deployment tenant registry; ` +
        `this capability may now navigate nowhere`,
    });
  }

  clone.app = { ...clone.app, tenant: overlay.tenant };
  clone.provenance = {
    ...clone.provenance,
    derivedFrom: { id: base.id, version: base.version },
  };
  clone.approval = overlay.approval === 'approved' && base.approval === 'approved' ? 'approved' : 'draft';
  if (needsReReview && clone.approval === 'approved' && !overlay.conditionsReviewedBy) {
    clone.approval = 'draft';
    rejected.push({
      path: 'approval',
      reason:
        'held at draft — this overlay changes what counts as success, so it needs ' +
        '`conditionsReviewedBy` naming the reviewer who read that change',
    });
  } else if (needsReReview && overlay.conditionsReviewedBy) {
    applied.push({
      path: 'checkpoint/conditions',
      reason: `success-condition changes attested by ${overlay.conditionsReviewedBy}`,
    });
  }

  for (const sealed of SEALED) {
    if (JSON.stringify(sealed.read(base)) === JSON.stringify(sealed.read(clone))) continue;
    throw new Error(
      `overlay for tenant "${overlay.tenant}" changed ${sealed.name}, which no patch should be able to reach. ` +
      `This means the patchable allow-list is wrong; refusing the overlay rather than repairing it.`
    );
  }

  // Re-validate. An overlay writes arbitrary values into a typed document, so
  // the one code path that mutates an artifact is the last place to skip the
  // schema — an out-of-enum `confirmAtRisk` would rank as `undefined` and
  // open the gate rather than close it.
  const capability = parseCapability(clone);
  return { capability, applied, rejected };
}

/**
 * Rewrites the `name` of every target descriptor matching `from`, wherever it
 * appears — step actions, waitFor conditions, checkpoints, interstitials.
 * Returns the number of sites touched.
 */
function renameTargets(
  root: Record<string, unknown>,
  rename: { role?: string; from: string; to: string }
): { count: number; sites: string[] } {
  let count = 0;
  const sites: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    // A target descriptor is recognisable by carrying both a role and a
    // nameMatch; nothing else in the schema has that pair.
    if (typeof o.role === 'string' && typeof o.name === 'string' && 'nameMatch' in o) {
      if (o.name === rename.from && (!rename.role || o.role === rename.role)) {
        o.name = rename.to;
        sites.push(path);
        count++;
      }
    }
    for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(root, '');
  return { count, sites };
}

/**
 * Segments that must never be traversed.
 *
 * `checkpoint.__proto__.toString` matches the checkpoint allow-list entry, and
 * `last in cur` is true for anything on `Object.prototype` — so an overlay, the
 * constrained and reviewable customisation mechanism, could corrupt the process
 * global prototype and the audit line would report it as *applied*.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Sets `a.b[0].c` if — and only if — every segment already exists. */
export function setAtPath(root: Record<string, unknown>, path: string, value: unknown): boolean {
  const segments = path.split('.').flatMap((part) => {
    const m = part.match(/^([^[\]]+)((\[\d+\])*)$/);
    if (!m) return [part];
    const idx = [...(m[2] ?? '').matchAll(/\[(\d+)\]/g)].map((x) => x[1] as string);
    return [m[1] as string, ...idx];
  });

  if (segments.some((seg) => FORBIDDEN_SEGMENTS.has(seg))) return false;

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
