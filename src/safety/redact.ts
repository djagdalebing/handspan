/**
 * Redaction for logs, artifacts and evidence.
 *
 * Two mechanisms, because they solve different problems:
 *
 *  1. **Registered values.** We know, from the capability's declared input
 *     sensitivities and from the credential provider, the exact strings that
 *     are sensitive in this run. Those are replaced wherever they appear —
 *     including inside page text we scraped, error messages, and URLs. This
 *     is exact and has no false negatives for the data we were handed.
 *
 *  2. **Pattern sweep.** A backstop for sensitive data we were never told
 *     about but which the *application* put on screen: SSNs, card numbers,
 *     long account numbers, bearer tokens. Patterns have false positives and
 *     negatives, so they are a second line, never the first.
 *
 * PII becomes a stable pseudonym rather than a fixed blob. `«member#7f3a»`
 * keeps a run debuggable — you can still see that the same member flowed
 * through six steps — without the log holding the identifier. Secrets get no
 * such courtesy: they are replaced by their reference name and the value
 * never appears in any form.
 */
import { createHash } from 'node:crypto';
import type { Sensitivity } from '../artifact/schema.js';

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g },
  { name: 'token', re: /\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gi },
  { name: 'secretish', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*\S+/gi },
];

export class Redactor {
  /** value -> replacement */
  private exact = new Map<string, string>();

  /** Register a value whose sensitivity we were told about. */
  register(value: string | undefined | null, sensitivity: Sensitivity, label: string): void {
    if (!value) return;
    const v = String(value);
    // Very short values (a status flag, "25") would shred unrelated text.
    if (v.length < 3 && sensitivity !== 'secret') return;
    if (sensitivity === 'secret') {
      this.exact.set(v, `«secret:${label}»`);
    } else if (sensitivity === 'pii') {
      this.exact.set(v, `«${label}#${fingerprint(v)}»`);
    }
  }

  registerSecret(value: string, label: string): void {
    this.register(value, 'secret', label);
  }

  string(input: string): string {
    let out = input;
    // Longest first, so a substring of a registered value cannot partially
    // redact and leave the tail exposed.
    const entries = [...this.exact.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [value, replacement] of entries) {
      out = out.split(value).join(replacement);
    }

    // Sweep only *outside* spans that are already redacted. Without this the
    // `secretish` pattern matches our own `«secret:NAME»` marker — the word
    // "secret" followed by a colon — and rewrites it into an opaque hash,
    // destroying the one piece of information that made the log useful while
    // adding no safety at all.
    return out
      .split(/(«[^»]*»)/)
      .map((part) => (part.startsWith('«') && part.endsWith('»') ? part : sweep(part)))
      .join('');
  }

  /** Deep-redacts any JSON-serialisable structure, keys included. */
  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.string(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = /pass(word)?|secret|token|api[_-]?key/i.test(k) ? '«redacted»' : this.walk(val);
      }
      return out;
    }
    return v;
  }
}

function sweep(part: string): string {
  let out = part;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (m) => (looksLikeMoney(m) ? m : `«${name}#${fingerprint(m)}»`));
  }
  return out;
}

function fingerprint(v: string): string {
  return createHash('sha256').update(v).digest('hex').slice(0, 4);
}

/**
 * The card pattern is greedy enough to swallow currency amounts, which are
 * the single most common thing we legitimately need to read off these
 * screens. Excluding them explicitly beats loosening the pattern.
 */
function looksLikeMoney(s: string): boolean {
  return /^[\d ,.-]+$/.test(s) && /[.,]\d{2}$/.test(s.trim());
}
