/**
 * Reading declared outputs off the final screen.
 *
 * Extraction is declarative for the same reason targeting is: the caller's
 * contract ("this returns `currentBalance: number`") has to be reviewable and
 * stable, and a screen-scraping expression buried in code is neither.
 *
 * A missing *required* output is a failure even when the checkpoint passed.
 * Returning `{ok: true, outputs: {}}` to an agent that asked for a balance is
 * worse than returning an error, because the agent will act on the absence.
 */
import type { Output } from '../artifact/schema.js';
import type { Observation } from '../surface/types.js';
import { labelMatches, matches } from './conditions.js';
import { resolveTarget } from './locator.js';
import { interpolateDeep, type Bindings } from './template.js';

export interface ExtractionResult {
  values: Record<string, string | number | boolean>;
  missing: string[];
  notes: string[];
  /**
   * Per output, the label the value was *actually* read from — the readout's
   * accessible name, the resolved control's name, the real column headers.
   *
   * This exists because sensitivity classification cannot be allowed to key
   * off the artifact's *matcher*. A `contains` label is a pattern a tenant
   * overlay may legitimately reword, and picking a substring that hits the
   * regulated readout while missing the sensitive-label list turned an
   * approved overlay into an exfiltration channel. What is on the screen is
   * not something the overlay gets a vote on.
   */
  matchedLabels: Record<string, string>;
}

export function extractOutputs(
  outputs: Output[],
  obs: Observation,
  bindings: Bindings
): ExtractionResult {
  const values: Record<string, string | number | boolean> = {};
  const missing: string[] = [];
  const notes: string[] = [];
  const matchedLabels: Record<string, string> = {};

  for (const out of outputs) {
    const read = readOne(out, obs, bindings, notes);
    const raw = read?.value;
    // Recorded even when the value is unusable: the label is what decides how
    // the value is treated, and a coercion failure still logs the raw string.
    if (read?.label) matchedLabels[out.name] = read.label;
    if (raw === undefined || raw === '') {
      if (out.required) missing.push(out.name);
      continue;
    }
    const transformed = applyTransform(raw, out.transform);
    const coerced = coerce(transformed, out.type);
    if (coerced === undefined) {
      notes.push(`output "${out.name}": value ${JSON.stringify(transformed)} is not a valid ${out.type}`);
      if (out.required) missing.push(out.name);
      continue;
    }
    values[out.name] = coerced;
  }

  return { values, missing, notes, matchedLabels };
}

/** A value and the on-screen label it came from. */
interface Read {
  value: string | undefined;
  label?: string;
}

function readOne(out: Output, obs: Observation, bindings: Bindings, notes: string[]): Read | undefined {
  const src = out.source;
  switch (src.from) {
    case 'readout': {
      const hit = obs.nodes.find((n) => n.role === 'readout' && labelMatches(n.name, src.label, bindings));
      if (!hit) notes.push(`output "${out.name}": no readout labelled "${src.label.value}"`);
      return { value: hit?.value, label: hit?.name };
    }

    case 'table': {
      const tables = obs.nodes.filter(
        (n) => n.role === 'table' && n.grid && (!src.table || matches(n.name, src.table, bindings))
      );
      for (const t of tables) {
        const grid = t.grid!;
        const header = grid[0] ?? [];
        const whereIdx = header.findIndex((h) => norm(h) === norm(src.whereColumn));
        const selIdx = header.findIndex((h) => norm(h) === norm(src.selectColumn));
        if (whereIdx < 0 || selIdx < 0) continue;
        for (const row of grid.slice(1)) {
          if (matches(row[whereIdx] ?? '', src.whereEquals, bindings)) {
            // The header as the grid prints it, not as the artifact spells it.
            //
            // The *selected* column only. Including the table's own name swept
            // up "Member Accounts" and classified the share balance — the one
            // number these capabilities exist to return — as regulated. The
            // column a value sits under is what names that value; the table
            // around it names a screen.
            return { value: row[selIdx], label: header[selIdx] ?? '' };
          }
        }
      }
      notes.push(
        `output "${out.name}": no row where ${src.whereColumn} ${src.whereEquals.mode} ` +
        `"${src.whereEquals.value}" in ${tables.length} candidate table(s)`
      );
      return undefined;
    }

    case 'text': {
      const pattern = interpolateDeep(src.pattern, bindings);
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'im');
      } catch {
        notes.push(`output "${out.name}": invalid pattern ${pattern}`);
        return undefined;
      }
      const m = obs.text.match(re);
      if (!m) notes.push(`output "${out.name}": pattern did not match page text`);
      // A raw text match has no label. There is nothing to report, and that
      // absence is why the pattern and the value itself both get classified.
      return { value: m?.[src.group] };
    }

    case 'node': {
      const r = resolveTarget(obs, interpolateDeep(src.target, bindings));
      if (!r.ok) {
        notes.push(`output "${out.name}": target ${r.reason}`);
        return undefined;
      }
      return {
        value: src.attr === 'name' ? r.node.name : r.node.value,
        label: r.node.name,
      };
    }
  }
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function applyTransform(v: string, t: Output['transform']): string {
  switch (t) {
    case 'trim': return v.trim();
    case 'upper': return v.trim().toUpperCase();
    case 'money': return v.replace(/[^0-9.-]/g, '');
    case 'number': return v.replace(/[^0-9.eE+-]/g, '');
    case 'none': default: return v;
  }
}

function coerce(v: string, type: Output['type']): string | number | boolean | undefined {
  if (type === 'string') return v;
  if (type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  const t = v.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(t)) return true;
  if (['false', 'no', 'n', '0'].includes(t)) return false;
  return undefined;
}
