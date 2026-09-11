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
import { createHash, randomBytes } from 'node:crypto';
import type { Sensitivity } from '../artifact/schema.js';

/**
 * Field labels whose values are regulated. Used in three places that must
 * agree: masking screenshots before they are stored, and classifying the
 * sensitivity of a recorded output or parameter when nobody declared one.
 */
export const SENSITIVE_LABEL =
  /\bssn\b|social security|tax\s*id\b|\bein\b|date of birth|\bdob\b|password|passcode|\bpin\b|card number|routing|account number|driver.?s licen[cs]e|passport/i;

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g },
  { name: 'token', re: /\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gi },
  { name: 'secretish', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*\S+/gi },
];

/**
 * Keys whose values are system-generated identifiers, never user data.
 *
 * These are exempt from the pattern sweep because the sweep otherwise
 * destroys them: a run id like `replay-20260911-190755-dsw9` contains a
 * 14-digit run once the hyphens are treated as separators, so the card-number
 * pattern ate it and every `result.json` handed its caller an `evidenceDir`
 * that did not exist. Exact registered values are still replaced inside them.
 */
const PRESERVED_KEYS = /^(runId|evidenceDir|escalationId|stepId|atStep|capability|version|schema|code|class)$/;

export class Redactor {
  /** value -> replacement */
  private exact = new Map<string, string>();
  /** Values declared PII, for masking them out of screenshots. */
  private pii = new Set<string>();

  /**
   * Per-process salt.
   *
   * An unsalted hash of low-entropy data is not a pseudonym, it is an
   * encoding: four hex characters over a five-digit member number is 100,000
   * candidates, and over an SSN's last four it is 10,000 — both enumerable in
   * milliseconds. Salting per process keeps the property that actually
   * matters (the same value reads the same way throughout one run, so a run
   * stays traceable) while making the token useless to anyone holding the
   * log.
   */
  private salt = randomBytes(16).toString('hex');

  /** Register a value whose sensitivity we were told about. */
  register(value: string | undefined | null, sensitivity: Sensitivity, label: string): void {
    if (!value) return;
    const v = String(value);
    // Very short values (a status flag, "25") would shred unrelated text.
    if (v.length < 3 && sensitivity !== 'secret') return;
    if (sensitivity === 'secret') {
      this.exact.set(v, `«secret:${label}»`);
    } else if (sensitivity === 'pii') {
      this.exact.set(v, `«${label}#${this.fingerprint(v)}»`);
      this.pii.add(v);
    }
  }

  /** Registered PII values, for masking them out of stored screenshots. */
  piiLiterals(): string[] {
    return [...this.pii];
  }

  private fingerprint(v: string): string {
    return createHash('sha256').update(this.salt).update(v).digest('hex').slice(0, 6);
  }

  registerSecret(value: string, label: string): void {
    this.register(value, 'secret', label);
  }

  string(input: string): string {
    let out = input;
    // Longest first, so a substring of a registered value cannot partially
    // redact and leave the tail exposed.
    for (const [value, replacement] of this.sortedExact()) {
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

  /** Exact registered replacements only, without the heuristic sweep. */
  private exactOnly(input: string): string {
    let out = input;
    for (const [value, replacement] of this.sortedExact()) out = out.split(value).join(replacement);
    return out;
  }

  private sortedExact(): Array<[string, string]> {
    return [...this.exact.entries()].sort((a, b) => b[0].length - a[0].length);
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.string(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/pass(word)?|secret|token|api[_-]?key/i.test(k)) {
          out[k] = '«redacted»';
        } else if (PRESERVED_KEYS.test(k) && typeof val === 'string') {
          // Registered secrets and PII still get replaced; the pattern sweep
          // (which is what mangles identifiers) is skipped.
          out[k] = this.exactOnly(val);
        } else {
          out[k] = this.walk(val);
        }
      }
      return out;
    }
    return v;
  }
}

/** Unsalted, for pattern hits only: these are values we were never told about. */
function hash(v: string): string {
  return createHash('sha256').update(v).digest('hex').slice(0, 6);
}

function sweep(part: string): string {
  let out = part;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (m) => (looksLikeMoney(m) ? m : `«${name}#${hash(m)}»`));
  }
  return out;
}

/**
 * The card pattern is greedy enough to swallow currency amounts, which are
 * the single most common thing we legitimately need to read off these
 * screens. Excluding them explicitly beats loosening the pattern.
 */
function looksLikeMoney(s: string): boolean {
  return /^[\d ,.-]+$/.test(s) && /[.,]\d{2}$/.test(s.trim());
}
