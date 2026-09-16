import { describe, expect, it } from 'vitest';
import { verifyWithProbes, type ProbeResult } from '../src/discovery/probe.js';
import { zCapability, type Capability } from '../src/artifact/schema.js';
import { node, observation } from './helpers.js';

const cap = (outcomes: unknown[] = [], interstitials: unknown[] = []): Capability =>
  zCapability.parse({
    schema: 'capability/v1',
    id: 'demo.cap', version: '1.0.0', name: 'Demo', description: 'd',
    app: { vendor: 'V', product: 'P' },
    steps: [{ id: 's00', intent: 'open', action: { kind: 'navigate', url: 'http://a/' } }],
    checkpoint: { type: 'textMatches', value: { value: 'MEMBER DETAIL' } },
    outcomes, interstitials,
    provenance: { recordedAt: new Date().toISOString(), recordedBy: 'llm' },
  });

const outcome = (code: string, marker: string) => ({
  code, description: `${code} desc`,
  when: { type: 'textMatches', value: { mode: 'contains', value: marker, caseSensitive: false } },
});

const successObs = observation([node('readout', 'Member Name', { value: 'RIVERA' })], {
  text: 'MEMBER DETAIL — 12345\nMember Name: RIVERA',
});

const probe = (code: string, alertText: string, status = 'failure'): ProbeResult => ({
  case: { code, description: `${code} desc`, inputs: {}, expect: 'business_outcome' },
  status,
  observation: observation([node('alert', alertText)], { text: alertText }),
  alert: alertText,
});

describe('probe verification', () => {
  // The whole point: a model guessing at wording produces a detector that
  // never fires, and the run reports a timeout instead of the outcome.
  it('repairs a detector whose wording never matches the real screen', () => {
    const r = verifyWithProbes(
      cap([outcome('MEMBER_NOT_FOUND', 'Member not found')]),
      [probe('MEMBER_NOT_FOUND', 'MCS-0404 — No member record found for the number entered.')],
      successObs,
      {}
    );
    const fixed = r.capability.outcomes[0]!;
    expect((fixed.when as { value: { value: string } }).value.value).toBe('MCS-0404');
    expect(r.warnings.join(' ')).toMatch(/never matches this application/);
  });

  it('prefers the application error code over its prose', () => {
    const r = verifyWithProbes(
      cap(), [probe('X', 'MCS-0403 — You are not authorized to view this member record.')], successObs, {}
    );
    expect((r.capability.outcomes[0]!.when as { value: { value: string } }).value.value).toBe('MCS-0403');
  });

  it('falls back to the message when there is no error code', () => {
    const r = verifyWithProbes(
      cap(), [probe('X', 'You are not permitted to view this record.')], successObs, {}
    );
    expect((r.capability.outcomes[0]!.when as { value: { value: string } }).value.value)
      .toContain('You are not permitted');
  });

  it('marks a detector verified when the run actually reported the outcome', () => {
    const r = verifyWithProbes(
      cap([outcome('MEMBER_NOT_FOUND', 'MCS-0404')]),
      [probe('MEMBER_NOT_FOUND', 'MCS-0404 — No member record found.', 'business_outcome:MEMBER_NOT_FOUND')],
      successObs, {}
    );
    expect(r.capability.outcomes[0]!.verified).toBe(true);
    expect(r.warnings.filter((w) => w.includes('MEMBER_NOT_FOUND'))).toHaveLength(0);
  });

  /**
   * `verified` is exported to calling agents as a trust signal, so it has to
   * mean "this detector produced this outcome on a real run" — not "some text
   * was scraped off a screen". It used to be stamped from the scrape alone, and
   * the shipped live-Gemini artifact proved the gap: three probes ended
   * TARGET_NOT_FOUND and the detector was still marked verified.
   */
  it('refuses to verify a detector when the run did not report the outcome', () => {
    const r = verifyWithProbes(
      cap([outcome('MEMBER_NOT_FOUND', 'MCS-0404')]),
      [probe('MEMBER_NOT_FOUND', 'MCS-0404 — No member record found.', 'failure')],
      successObs, {}
    );
    expect(r.capability.outcomes[0]!.verified).toBe(false);
    expect(r.pending).toContain('MEMBER_NOT_FOUND');
  });

  it('leaves a repaired detector unproven until a re-probe fires it', () => {
    const r = verifyWithProbes(
      cap([outcome('MEMBER_NOT_FOUND', 'No matching member found')]),
      [probe('MEMBER_NOT_FOUND', 'MCS-0404 — No member record found.')],
      successObs, {}
    );
    const fixed = r.capability.outcomes[0]!;
    expect((fixed.when as { value: { value: string } }).value.value).toBe('MCS-0404');
    expect(fixed.verified).toBe(false);
    expect(r.pending).toContain('MEMBER_NOT_FOUND');
  });

  // A marker that fires on two different conditions is worse than none.
  it('refuses a marker that also fires on another probe screen', () => {
    const shared = 'MCS-0404 — No member record found.';
    const r = verifyWithProbes(
      cap(), [probe('A', shared), probe('B', shared)], successObs, {}
    );
    expect(r.capability.outcomes).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/ambiguous/);
  });

  it('refuses a marker that also appears on the success screen', () => {
    // The success screen already carries this text, so detecting an outcome
    // by it would turn every good run into a reported outcome.
    const r = verifyWithProbes(cap(), [probe('A', 'MEMBER DETAIL')], successObs, {});
    expect(r.capability.outcomes).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/success screen/);
  });

  it('flags every detector no probe confirmed', () => {
    const r = verifyWithProbes(cap([outcome('GUESSED', 'something')]), [], successObs, {});
    expect(r.capability.outcomes[0]!.verified).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/unverified: outcome GUESSED/);
  });

  // An interstitial is verified by the flow surviving it, not by text.
  it('verifies an interstitial when the probed run still completed', () => {
    const c = cap([], [{
      code: 'COMPLIANCE_ACK', description: 'ack',
      when: { type: 'textMatches', value: { value: 'ACKNOWLEDGEMENT' } },
      do: [{ kind: 'click', target: { role: 'button', name: 'Acknowledge', nameMatch: 'exact' } }],
    }]);
    const r = verifyWithProbes(c, [{
      case: { code: 'COMPLIANCE_ACK', description: 'ack', inputs: {}, expect: 'success' },
      status: 'success', observation: successObs,
    }], successObs, {});
    expect(r.capability.interstitials[0]!.verified).toBe(true);
  });

  it('reports an interstitial it cannot propose a way to clear', () => {
    const c = cap([], [{
      code: 'COMPLIANCE_ACK', description: 'ack',
      when: { type: 'textMatches', value: { value: 'ACKNOWLEDGEMENT' } },
      do: [{ kind: 'click', target: { role: 'button', name: 'OK', nameMatch: 'exact' } }],
    }]);
    // The stalled screen carries no button, so there is nothing to propose.
    const r = verifyWithProbes(c, [{
      case: { code: 'COMPLIANCE_ACK', description: 'ack', inputs: {}, expect: 'success' },
      status: 'failure', observation: observation([node('alert', 'Something is in the way here')]),
    }], successObs, {});
    expect(r.capability.interstitials[0]!.verified).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/no obvious way to clear it/);
  });

  // The interesting half: read the recovery off the screen the flow stalled on.
  it('proposes a recovery from the stalled screen when one button is offered', () => {
    const stalled = observation(
      [node('alert', 'This record carries a compliance review flag.'), node('button', 'Acknowledge')],
      { text: 'This record carries a compliance review flag.' }
    );
    const r = verifyWithProbes(cap(), [{
      case: { code: 'COMPLIANCE_ACK', description: 'ack', inputs: {}, expect: 'success' },
      status: 'failure', observation: stalled,
    }], successObs, {});

    const i = r.capability.interstitials[0]!;
    expect(i.code).toBe('COMPLIANCE_ACK');
    expect((i.do[0] as { target: { name: string } }).target.name).toBe('Acknowledge');
    // Proposed, not trusted: the caller re-probes to find out if it works.
    expect(i.verified).toBe(false);
    expect(r.synthesised).toEqual(['COMPLIANCE_ACK']);
  });

  // Several buttons means guessing, and one of them might commit something.
  it('declines to guess between several buttons', () => {
    const stalled = observation(
      [node('alert', 'Confirm this irreversible posting before continuing.'),
       node('button', 'Post Account'), node('button', 'Cancel')],
      { text: 'Confirm this irreversible posting before continuing.' }
    );
    const r = verifyWithProbes(cap(), [{
      case: { code: 'SOMETHING', description: 'x', inputs: {}, expect: 'success' },
      status: 'failure', observation: stalled,
    }], successObs, {});
    expect(r.capability.interstitials).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/no obvious way to clear it/);
  });
});
