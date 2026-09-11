import { describe, expect, it } from 'vitest';
import { describe as describeCond, evaluate, matches } from '../src/replay/conditions.js';
import { extractOutputs } from '../src/replay/extract.js';
import { interpolate, interpolateDeep } from '../src/replay/template.js';
import type { Condition, Output } from '../src/artifact/schema.js';
import { node, observation } from './helpers.js';

describe('matchers', () => {
  const m = (mode: 'exact' | 'contains' | 'regex', value: string, caseSensitive = false) =>
    ({ mode, value, caseSensitive });

  it('normalises whitespace, which legacy markup produces unpredictably', () => {
    expect(matches('  MEMBER   DETAIL ', m('exact', 'MEMBER DETAIL'), {})).toBe(true);
  });
  it('treats non-breaking spaces as spaces', () => {
    expect(matches('MEMBER DETAIL', m('exact', 'MEMBER DETAIL'), {})).toBe(true);
  });
  it('interpolates parameters before comparing', () => {
    expect(matches('MEMBER DETAIL — 12345', m('contains', 'DETAIL — {{memberId}}'), { memberId: '12345' })).toBe(true);
  });
  it('returns false rather than throwing on an invalid regex', () => {
    expect(matches('anything', m('regex', '([unclosed'), {})).toBe(false);
  });
});

describe('evaluate', () => {
  const obs = observation(
    [
      node('readout', 'Member Name', { value: 'RIVERA, DANA Q' }),
      node('readout', 'Status', { value: 'ACTIVE' }),
      node('button', 'Search'),
    ],
    { url: 'http://127.0.0.1:4311/desk', text: 'MEMBER DETAIL — 12345\nMember Name: RIVERA, DANA Q' }
  );

  it('handles all / any / not', () => {
    const yes: Condition = { type: 'textMatches', value: { mode: 'contains', value: 'MEMBER DETAIL', caseSensitive: false } };
    const no: Condition = { type: 'textMatches', value: { mode: 'contains', value: 'NOPE', caseSensitive: false } };
    expect(evaluate({ type: 'all', of: [yes, no] }, obs, {})).toBe(false);
    expect(evaluate({ type: 'any', of: [yes, no] }, obs, {})).toBe(true);
    expect(evaluate({ type: 'not', of: no }, obs, {})).toBe(true);
  });

  it('matches a readout by label and value', () => {
    const c: Condition = {
      type: 'readoutMatches',
      label: { mode: 'contains', value: 'Status', caseSensitive: false },
      value: { mode: 'exact', value: 'ACTIVE', caseSensitive: false },
    };
    expect(evaluate(c, obs, {})).toBe(true);
  });

  it('explains a failure in terms a reviewer can act on', () => {
    const trace: Array<{ type: string; result: boolean; detail?: string }> = [];
    evaluate({ type: 'nodeExists', target: { role: 'button', name: 'Post', nameMatch: 'exact' } }, obs, {}, trace);
    expect(trace[0]?.result).toBe(false);
    expect(trace[0]?.detail).toContain('not_found');
  });

  it('renders itself as English for review', () => {
    expect(describeCond({ type: 'nodeExists', target: { role: 'button', name: 'Search', nameMatch: 'exact' } }))
      .toBe('a button named "Search" is present');
  });
});

describe('extractOutputs', () => {
  const out = (o: Partial<Output> & Pick<Output, 'name' | 'source'>): Output => ({
    type: 'string', description: '', transform: 'none', required: true, sensitivity: 'internal', ...o,
  }) as Output;

  const obs = observation([
    node('readout', 'Member Name', { value: 'RIVERA, DANA Q' }),
    node('table', 'MEMBER DETAIL', {
      grid: [
        ['ACCOUNT TYPE', 'ACCOUNT NO', 'CURRENT BALANCE'],
        ['SHARE SAVINGS', 'S-0001', '$4,812.55'],
        ['SHARE DRAFT', 'D-0001', '$1,290.03'],
      ],
    }),
  ]);

  it('reads a labelled value', () => {
    const r = extractOutputs([out({ name: 'memberName', source: { from: 'readout', label: { mode: 'contains', value: 'Member Name', caseSensitive: false } } })], obs, {});
    expect(r.values.memberName).toBe('RIVERA, DANA Q');
  });

  it('reads a cell by row lookup and strips currency formatting', () => {
    const r = extractOutputs([out({
      name: 'savingsBalance', type: 'number', transform: 'money',
      source: { from: 'table', whereColumn: 'ACCOUNT TYPE', whereEquals: { mode: 'contains', value: 'SHARE SAVINGS', caseSensitive: false }, selectColumn: 'CURRENT BALANCE' },
    })], obs, {});
    expect(r.values.savingsBalance).toBe(4812.55);
  });

  it('picks the right row, not merely the first', () => {
    const r = extractOutputs([out({
      name: 'draft', type: 'number', transform: 'money',
      source: { from: 'table', whereColumn: 'ACCOUNT TYPE', whereEquals: { mode: 'exact', value: 'SHARE DRAFT', caseSensitive: false }, selectColumn: 'CURRENT BALANCE' },
    })], obs, {});
    expect(r.values.draft).toBe(1290.03);
  });

  // Silently omitting a declared output is worse than failing: the caller acts
  // on the absence.
  it('reports a missing required output rather than returning nothing', () => {
    const r = extractOutputs([out({ name: 'ssn', source: { from: 'readout', label: { mode: 'contains', value: 'Tax ID', caseSensitive: false } } })], obs, {});
    expect(r.missing).toEqual(['ssn']);
    expect(r.notes[0]).toContain('no readout labelled');
  });

  it('rejects a value that does not fit its declared type', () => {
    const r = extractOutputs([out({ name: 'n', type: 'number', source: { from: 'readout', label: { mode: 'contains', value: 'Member Name', caseSensitive: false } } })], obs, {});
    expect(r.missing).toEqual(['n']);
  });
});

describe('templating', () => {
  it('substitutes bound parameters', () => {
    expect(interpolate('member {{id}}', { id: '12345' })).toBe('member 12345');
  });

  // A blank member number is a data-integrity bug, not a smaller crash.
  it('throws on an unbound parameter instead of substituting empty', () => {
    expect(() => interpolate('member {{id}}', {})).toThrow(/unbound parameter "id"/);
  });

  it('walks nested structures', () => {
    expect(interpolateDeep({ a: ['x {{id}}'] }, { id: '7' })).toEqual({ a: ['x 7'] });
  });
});
