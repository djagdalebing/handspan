import { describe, expect, it } from 'vitest';
import { describeChange } from '../src/discovery/prompt.js';
import { node, observation } from './helpers.js';

/**
 * The loop used to report the top-level URL after every action. On a frameset
 * that is a constant, so the model's only feedback signal was a fixed string:
 * it clicked Search, was told it was still at /desk, and re-clicked the nav
 * link that wiped the form it had just filled.
 */
describe('per-step feedback on a surface whose URL never changes', () => {
  const searchForm = () => [
    node('link', 'Member Inquiry'),
    node('textbox', 'Member Number', { value: '' }),
    node('button', 'Search'),
  ];

  it('reports the controls that replaced the ones that were there', () => {
    const before = observation(searchForm());
    const after = observation([
      node('link', 'New Inquiry'),
      node('readout', 'Member Name', { value: 'RIVERA, DANA Q' }),
    ]);
    const change = describeChange(before, after);
    expect(change).toMatch(/appeared: .*readout "Member Name"/);
    expect(change).toMatch(/no longer present: .*button "Search"/);
    // Same URL throughout — the whole point.
    expect(change).not.toMatch(/navigated/);
  });

  it('reports a typed value, which no control-set diff would show', () => {
    const before = observation(searchForm());
    const after = observation([
      node('link', 'Member Inquiry'),
      node('textbox', 'Member Number', { value: '12345' }),
      node('button', 'Search'),
    ]);
    expect(describeChange(before, after)).toBe('textbox "Member Number" now "12345"');
  });

  it('calls out a new message ahead of everything else', () => {
    const before = observation(searchForm());
    const after = observation([...searchForm(), node('alert', 'MCS-0012 — Member number must be numeric')]);
    const change = describeChange(before, after);
    expect(change.indexOf('message on screen')).toBe(0);
    expect(change).toMatch(/MCS-0012/);
    // Reported once, not also as an appeared control.
    expect(change).not.toMatch(/appeared/);
  });

  it('says plainly when an action did nothing, rather than returning nothing', () => {
    const same = searchForm();
    const change = describeChange(observation(same), observation(same));
    expect(change).toMatch(/NOTHING CHANGED/);
    expect(change).toMatch(/repeating it will not help/);
  });

  it('caps a long list rather than pasting a whole screen into the history', () => {
    const many = Array.from({ length: 20 }, (_, i) => node('readout', `Field ${i}`));
    const change = describeChange(observation([]), observation(many));
    expect(change).toMatch(/and 14 more/);
  });
});
