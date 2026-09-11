/**
 * Evaluating the condition language.
 *
 * The same evaluator backs success checkpoints, business-outcome detection
 * and interstitial detection. That is not merely code reuse: it means a
 * reviewer who understands how success is asserted automatically understands
 * how "member not found" is recognised, and the engine has exactly one place
 * where a screen is interpreted.
 */
import type { Condition, Matcher } from '../artifact/schema.js';
import type { Observation } from '../surface/types.js';
import { resolveTarget } from './locator.js';
import { interpolateDeep, type Bindings } from './template.js';

export function matches(subject: string, m: Matcher, bindings: Bindings): boolean {
  const want = interpolateDeep(m.value, bindings);
  if (m.mode === 'regex') {
    try {
      return new RegExp(want, m.caseSensitive ? '' : 'i').test(subject);
    } catch {
      return false;
    }
  }
  const a = m.caseSensitive ? subject : subject.toLowerCase();
  const b = m.caseSensitive ? want : want.toLowerCase();
  const na = a.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const nb = b.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  return m.mode === 'contains' ? na.includes(nb) : na === nb;
}

export interface ConditionTrace {
  type: string;
  result: boolean;
  detail?: string;
}

/** Evaluates `cond`, appending a human-readable trace for failure reporting. */
export function evaluate(
  cond: Condition,
  obs: Observation,
  bindings: Bindings,
  trace: ConditionTrace[] = []
): boolean {
  const push = (result: boolean, detail?: string): boolean => {
    trace.push({ type: cond.type, result, detail });
    return result;
  };

  switch (cond.type) {
    case 'urlMatches':
      return push(matches(obs.url, cond.value, bindings), `url=${obs.url}`);

    case 'textMatches':
      return push(matches(obs.text, cond.value, bindings), `wanted ${cond.value.mode} "${cond.value.value}"`);

    case 'nodeExists': {
      const r = resolveTarget(obs, interpolateDeep(cond.target, bindings));
      return push(r.ok, r.ok ? `matched "${r.node.name}"` : `${r.reason} for ${cond.target.role} "${cond.target.name}"`);
    }

    case 'readoutMatches': {
      const candidates = obs.nodes.filter(
        (n) => n.role === 'readout' && matches(n.name, cond.label, bindings)
      );
      if (candidates.length === 0) {
        return push(false, `no readout labelled "${cond.label.value}"`);
      }
      const hit = candidates.find((n) => matches(n.value ?? '', cond.value, bindings));
      return push(
        Boolean(hit),
        hit ? `"${hit.name}" matched` : `readout "${candidates[0]!.name}" did not match`
      );
    }

    case 'all': {
      const sub: ConditionTrace[] = [];
      const ok = cond.of.every((c) => evaluate(c, obs, bindings, sub));
      trace.push(...sub);
      return push(ok);
    }

    case 'any': {
      const sub: ConditionTrace[] = [];
      const ok = cond.of.some((c) => evaluate(c, obs, bindings, sub));
      trace.push(...sub);
      return push(ok);
    }

    case 'not': {
      const sub: ConditionTrace[] = [];
      const ok = !evaluate(cond.of, obs, bindings, sub);
      trace.push(...sub);
      return push(ok);
    }
  }
}

/** Renders a condition as a one-line English description, for reviewers. */
export function describe(cond: Condition): string {
  switch (cond.type) {
    case 'urlMatches': return `URL ${cond.value.mode} "${cond.value.value}"`;
    case 'textMatches': return `page text ${cond.value.mode} "${cond.value.value}"`;
    case 'nodeExists': return `a ${cond.target.role} named "${cond.target.name}" is present`;
    case 'readoutMatches': return `field "${cond.label.value}" ${cond.value.mode} "${cond.value.value}"`;
    case 'all': return cond.of.map(describe).join(' AND ');
    case 'any': return `(${cond.of.map(describe).join(' OR ')})`;
    case 'not': return `NOT (${describe(cond.of)})`;
  }
}
