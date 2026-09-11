/**
 * Resolving a recorded `Target` to a live control.
 *
 * The usual approach — an ordered ladder of selectors, take the first that
 * hits — is wrong for this domain. A ladder's failure mode is *silently
 * acting on the wrong control*, because fallback rung four happily matches
 * something that is not what rung one meant. On a screen where the difference
 * between two adjacent buttons is "post" and "cancel", that is the worst
 * possible behaviour.
 *
 * So instead: score every candidate against every recorded signal, and
 * require a *unique* winner. Ambiguity is a hard failure, not a coin flip.
 *
 * The signals are ranked by how well they survive the things that actually
 * change:
 *
 *   role          — disqualifying. A button does not become a textbox.
 *   name          — disqualifying. The accessible name is what a human reads;
 *                   it is the most stable thing on a legacy screen.
 *   inRowContaining — disqualifying when recorded. It is the only way to
 *                   distinguish per-row controls, so a miss means we are
 *                   looking at the wrong row.
 *   framePath     — strong, but frames get renamed between versions, so a
 *                   mismatch penalises rather than disqualifies.
 *   group         — weak. Panel headings often embed record data.
 *   domHint       — weakest, and web-only. Present for diagnosis more than
 *                   for matching.
 *
 * One concession to reality: if the strict name match finds nothing, we retry
 * with punctuation and whitespace normalised, and accept it *only* if it
 * yields exactly one candidate. Legacy apps churn labels between "Member
 * Number:" and "Member No." far more often than they restructure a screen.
 * That retry is reported as drift so it shows up in the run record rather
 * than quietly becoming the new normal.
 */
import type { Target } from '../artifact/schema.js';
import type { Observation, UiNode } from '../surface/types.js';

export type Resolution =
  | { ok: true; node: UiNode; score: number; considered: number; degraded?: DegradeReason }
  | { ok: false; reason: 'not_found' | 'ambiguous'; considered: number; near: UiNode[] };

export type DegradeReason = 'relaxed-name' | 'frame-mismatch';

const normalize = (s: string): string =>
  s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** Strips punctuation and common label noise for the relaxed pass. */
const loosen = (s: string): string =>
  normalize(s).replace(/[.:#*()\[\]/\\-]+/g, ' ').replace(/\b(no|num|number|nbr)\b/g, 'number').replace(/\s+/g, ' ').trim();

function nameMatches(candidate: string, target: string, mode: Target['nameMatch'], loose: boolean): boolean {
  const c = loose ? loosen(candidate) : normalize(candidate);
  const t = loose ? loosen(target) : normalize(target);
  if (mode === 'regex') {
    try {
      return new RegExp(target, 'i').test(candidate);
    } catch {
      return false;
    }
  }
  if (mode === 'contains') return c.includes(t);
  return c === t;
}

function scoreOne(node: UiNode, target: Target): number | null {
  if (node.role !== target.role) return null;

  if (target.inRowContaining) {
    const row = normalize(node.rowText ?? '');
    if (!row.includes(normalize(target.inRowContaining))) return null;
  }

  let score = 10; // cleared role + row scope

  if (target.framePath) {
    score += sameFrame(node.framePath, target.framePath) ? 4 : -3;
  }
  if (target.group) {
    if (node.group && normalize(node.group) === normalize(target.group)) score += 2;
    else if (node.group && loosen(node.group).includes(loosen(target.group))) score += 1;
  }
  if (target.domHint && node.domHint === target.domHint) score += 1;
  return score;
}

function sameFrame(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function resolveTarget(obs: Observation, target: Target): Resolution {
  for (const loose of [false, true]) {
    const scored: Array<{ node: UiNode; score: number }> = [];
    for (const node of obs.nodes) {
      if (!nameMatches(node.name, target.name, target.nameMatch, loose)) continue;
      const s = scoreOne(node, target);
      if (s === null) continue;
      scored.push({ node, score: s });
    }
    if (scored.length === 0) continue;

    scored.sort((a, b) => b.score - a.score || docOrder(a.node, b.node));

    // An explicit ordinal is the recorded answer to a known ambiguity.
    if (target.ordinal !== undefined) {
      const inOrder = [...scored].sort((a, b) => docOrder(a.node, b.node));
      const pick = inOrder[target.ordinal];
      if (!pick) {
        return { ok: false, reason: 'not_found', considered: obs.nodes.length, near: scored.slice(0, 5).map((s) => s.node) };
      }
      return finish(pick.node, pick.score, obs, target, loose);
    }

    const best = scored[0]!;
    const tied = scored.filter((s) => s.score === best.score);
    if (tied.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        considered: obs.nodes.length,
        near: tied.slice(0, 5).map((t) => t.node),
      };
    }
    return finish(best.node, best.score, obs, target, loose);
  }

  return {
    ok: false,
    reason: 'not_found',
    considered: obs.nodes.length,
    near: obs.nodes.filter((n) => n.role === target.role).slice(0, 5),
  };
}

function finish(node: UiNode, score: number, _obs: Observation, target: Target, loose: boolean): Resolution {
  let degraded: DegradeReason | undefined;
  if (loose) degraded = 'relaxed-name';
  else if (target.framePath && !sameFrame(node.framePath, target.framePath)) degraded = 'frame-mismatch';
  return { ok: true, node, score, considered: 1, degraded };
}

/** Reading order: top-to-bottom, then left-to-right. */
function docOrder(a: UiNode, b: UiNode): number {
  const dy = a.bounds.y - b.bounds.y;
  if (Math.abs(dy) > 4) return dy;
  return a.bounds.x - b.bounds.x;
}

/**
 * Hash of the perceived control skeleton. Deliberately excludes values and
 * bounds so it tracks *structure* — which controls exist and what they are
 * called — rather than the record currently on screen. Divergence between
 * record time and replay time is the drift signal.
 */
export function fingerprintObservation(obs: Observation): string {
  const skeleton = obs.nodes
    .filter((n) => n.role !== 'readout' && n.role !== 'table' && n.role !== 'alert')
    .map((n) => `${n.framePath.join('/')}|${n.role}|${normalize(n.name)}`)
    .sort()
    .join('\n');
  let h = 0;
  for (let i = 0; i < skeleton.length; i++) {
    h = (Math.imul(31, h) + skeleton.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
