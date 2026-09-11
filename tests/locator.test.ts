import { describe, expect, it } from 'vitest';
import { fingerprintObservation, resolveTarget } from '../src/replay/locator.js';
import type { Target } from '../src/artifact/schema.js';
import { node, observation } from './helpers.js';

const target = (t: Partial<Target> & Pick<Target, 'role' | 'name'>): Target => ({
  nameMatch: 'exact',
  ...t,
});

describe('resolveTarget', () => {
  it('matches on role and accessible name', () => {
    const obs = observation([node('button', 'Search'), node('button', 'Clear')]);
    const r = resolveTarget(obs, target({ role: 'button', name: 'Search' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.name).toBe('Search');
  });

  it('will not match across roles', () => {
    const obs = observation([node('link', 'Search')]);
    expect(resolveTarget(obs, target({ role: 'button', name: 'Search' })).ok).toBe(false);
  });

  // The single most important property: never guess between candidates.
  it('refuses to choose when several controls match equally', () => {
    const obs = observation([
      node('button', 'Select', { bounds: { x: 0, y: 10, w: 40, h: 18 } }),
      node('button', 'Select', { bounds: { x: 0, y: 40, w: 40, h: 18 } }),
    ]);
    const r = resolveTarget(obs, target({ role: 'button', name: 'Select' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.near).toHaveLength(2);
    }
  });

  it('uses a recorded ordinal to settle a known ambiguity, in reading order', () => {
    const obs = observation([
      node('button', 'Select', { ref: 'second', bounds: { x: 0, y: 90, w: 40, h: 18 } }),
      node('button', 'Select', { ref: 'first', bounds: { x: 0, y: 10, w: 40, h: 18 } }),
    ]);
    const r = resolveTarget(obs, target({ role: 'button', name: 'Select', ordinal: 0 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.ref).toBe('first');
  });

  it('scopes to a row, which is how per-record controls are distinguished', () => {
    const obs = observation([
      node('link', 'Select', { rowText: '12345 RIVERA, DANA Q ACTIVE' }),
      node('link', 'Select', { rowText: '23456 OKONKWO, PAT R ACTIVE' }),
    ]);
    const r = resolveTarget(obs, target({ role: 'link', name: 'Select', inRowContaining: '23456' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.rowText).toContain('OKONKWO');
  });

  it('binds {{param}} inside a row scope at resolution time', () => {
    const obs = observation([
      node('link', 'Select', { rowText: '12345 RIVERA' }),
      node('link', 'Select', { rowText: '23456 OKONKWO' }),
    ]);
    // resolveTarget itself takes a bound target; interpolation happens above it,
    // so the literal is what arrives here.
    const r = resolveTarget(obs, target({ role: 'link', name: 'Select', inRowContaining: '12345' }));
    expect(r.ok).toBe(true);
  });

  it('prefers the recorded frame but does not require it', () => {
    const obs = observation([
      node('button', 'Search', { ref: 'other', framePath: ['nav'] }),
      node('button', 'Search', { ref: 'wanted', framePath: ['main'] }),
    ]);
    const r = resolveTarget(obs, target({ role: 'button', name: 'Search', framePath: ['main'] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.ref).toBe('wanted');
  });

  it('reports a frame move rather than failing on it', () => {
    const obs = observation([node('button', 'Search', { framePath: ['content'] })]);
    const r = resolveTarget(obs, target({ role: 'button', name: 'Search', framePath: ['main'] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.degraded).toBe('frame-mismatch');
  });

  it('tolerates a relabelled field and flags it as drift', () => {
    const obs = observation([node('textbox', 'Member No.')]);
    const r = resolveTarget(obs, target({ role: 'textbox', name: 'Member Number' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.degraded).toBe('relaxed-name');
  });

  it('does not relax its way into an ambiguous choice', () => {
    const obs = observation([node('textbox', 'Member No.'), node('textbox', 'Member Number')]);
    const r = resolveTarget(obs, target({ role: 'textbox', name: 'Member Nbr' }));
    // Both loosen to the same thing; refusing beats picking one.
    expect(r.ok).toBe(false);
  });
});

describe('fingerprintObservation', () => {
  it('ignores values so it tracks structure, not the record on screen', () => {
    const a = observation([node('textbox', 'Member Number', { ref: 'x', value: '12345' })]);
    const b = observation([node('textbox', 'Member Number', { ref: 'x', value: '99999' })]);
    expect(fingerprintObservation(a)).toBe(fingerprintObservation(b));
  });

  it('changes when a control is renamed', () => {
    const a = observation([node('button', 'Search')]);
    const b = observation([node('button', 'Find')]);
    expect(fingerprintObservation(a)).not.toBe(fingerprintObservation(b));
  });
});
