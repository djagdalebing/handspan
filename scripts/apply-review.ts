/**
 * The review step, captured so the evidence is reproducible.
 *
 * Discovery emits a `draft`. A human reads it and fixes what a single
 * successful run plus a handful of probes could not establish. This script is
 * a record of those decisions for `meridian.member.savings-balance` — it is
 * not an automated reviewer, and nothing here is inferred. Each edit is one a
 * person made after reading the draft, written down so that regenerating the
 * evidence produces the same reviewed artifact.
 *
 * Three edits, and each exists because of a specific limit of discovery:
 *
 *  1. Session expiry cannot be recovered by clicking "Sign On" — that form
 *     needs credentials, which must not live in an artifact. Replaced with a
 *     call to the sign-on capability, and marked `restartFlow` because
 *     re-authenticating lands on the desk rather than back mid-flow.
 *  2. An application error page (MCS-0500) is a recognised *failure*, not a
 *     business outcome. Probes only cover paths we gave them an input for, and
 *     there is no input that makes the core throw.
 *  3. The SSN output is dropped — the callers of this capability have no reason
 *     to receive it, and the safest field is the one you do not return. The
 *     member's name is *kept*: an agent confirming it has the right record
 *     legitimately needs it. It stays classified PII, which is what governs
 *     redaction in logs, evidence and screenshots — not whether the caller
 *     gets it. Sensitivity and need-to-know are different questions and this
 *     step is where a human answers the second one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { findCapability, saveCapability } from '../src/artifact/store.js';
import { zCapability } from '../src/artifact/schema.js';

const base = findCapability('meridian.member.savings-balance', '1.0.0');
if (!base) throw new Error('no meridian.member.savings-balance@1.0.0 draft to review');

const cap = JSON.parse(JSON.stringify(base)) as typeof base;
const notes: string[] = [];

cap.version = '1.1.0';
cap.approval = 'approved';
cap.provenance.derivedFrom = { id: base.id, version: base.version };

// 1. Session recovery must not embed credentials, and must restart the flow.
const session = cap.interstitials.find((i) => /SESSION/.test(i.code));
const recovery = {
  code: 'SESSION_EXPIRED',
  description:
    'The operator session timed out. Re-authenticate through the sign-on capability and restart ' +
    'the flow; this capability is read-only, so a restart cannot duplicate anything.',
  when: {
    type: 'textMatches' as const,
    value: { mode: 'contains' as const, value: 'session has timed out', caseSensitive: false },
  },
  do: [{ kind: 'run_capability' as const, capability: 'meridian.session.signon', inputs: {} }],
  maxOccurrences: 2,
  restartFlow: true,
  escalateOnFailure: true,
  verified: false,
};
if (session) {
  Object.assign(session, recovery);
  notes.push(`replaced the proposed ${session.code} recovery with a call to the sign-on capability`);
} else {
  cap.interstitials.push(recovery);
  notes.push('added a SESSION_EXPIRED recovery that re-authenticates via the sign-on capability');
}

// 2. An application error is a recognised failure, not an answer.
if (!cap.outcomes.some((o) => o.code === 'SYSTEM_ERROR')) {
  cap.outcomes.push({
    code: 'SYSTEM_ERROR',
    description: 'MERIDIAN Core returned an unhandled application error (MCS-0500).',
    when: {
      type: 'textMatches',
      value: { mode: 'contains', value: 'MCS-0500', caseSensitive: false },
    },
    classification: 'failure',
    afterSteps: [],
    terminal: true,
    outputs: [],
    verified: false,
  });
  notes.push('added SYSTEM_ERROR as a recognised application failure so a 500 page reports as APP_ERROR');
}

// 3. Do not return regulated data the caller has no need for.
const NOT_NEEDED = /ssn|social|tax|dob|birth|passport|licen[cs]e/i;
const before = cap.outputs.length;
const dropped = cap.outputs.filter((o) => NOT_NEEDED.test(o.name));
cap.outputs = cap.outputs.filter((o) => !NOT_NEEDED.test(o.name));
if (dropped.length > 0) {
  notes.push(`dropped ${dropped.map((o) => o.name).join(', ')} — the caller has no need for it`);
}
const keptPii = cap.outputs.filter((o) => o.sensitivity === 'pii').map((o) => o.name);
if (keptPii.length > 0) {
  notes.push(`kept ${keptPii.join(', ')} as PII — returned to the caller, redacted in logs and evidence`);
}

cap.provenance.reviewNote = notes.join('; ');

const path = saveCapability(zCapability.parse(cap));
process.stdout.write(`  ✓ reviewed ${cap.id}@${cap.version} (approved)\n    ${path}\n`);
for (const n of notes) process.stdout.write(`    · ${n}\n`);
