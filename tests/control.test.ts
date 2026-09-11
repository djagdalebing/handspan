import { describe, expect, it } from 'vitest';
import { SessionControl } from '../src/escalation/control.js';

const sig = (operator: string, disposition: 'resume' | 'complete' | 'abort' = 'resume') =>
  ({ disposition, note: `${operator} note`, operator });

describe('session control lease', () => {
  it('hands a release to the handoff that is waiting', async () => {
    const c = new SessionControl('r');
    const pending = c.requestHandoff();
    expect(c.current).toBe('PENDING');
    expect(c.claim('alice')).toBe(true);
    expect(c.canOperate('alice')).toBe(true);
    expect(c.canOperate('mallory')).toBe(false);
    c.release(sig('alice'));
    expect((await pending).operator).toBe('alice');
    expect(c.canAutomate()).toBe(true);
  });

  /**
   * The regression that matters. A cached "last signal" meant one approval
   * silently satisfied every later handoff in the run — including the
   * confirmation gate on an irreversible step.
   */
  it('does not let an earlier approval resolve a later, unrelated handoff', async () => {
    const c = new SessionControl('r');
    const first = c.requestHandoff();
    c.claim('alice');
    c.release(sig('alice'));
    await first;

    let settled = false;
    const second = c.requestHandoff().then((s) => {
      settled = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(settled).toBe(false);
    expect(c.current).toBe('PENDING');
    expect(c.canAutomate()).toBe(false);

    c.claim('bob');
    c.release(sig('bob', 'abort'));
    const s = await second;
    expect(s.operator).toBe('bob');
    expect(s.disposition).toBe('abort');
  });

  it('still resolves a handoff whose release arrived first', async () => {
    const c = new SessionControl('r');
    c.requestHandoff();            // opens the handoff, nothing awaiting yet
    c.claim('alice');
    c.release(sig('alice'));
    // A later awaiter of the *same* handoff generation still gets the signal.
    expect(c.canAutomate()).toBe(true);
  });

  it('refuses a claim when no handoff is pending', () => {
    const c = new SessionControl('r');
    expect(c.claim('alice')).toBe(false);
    expect(c.canOperate('alice')).toBe(false);
  });

  it('refuses a release from an operator who never took control', () => {
    const c = new SessionControl('r');
    expect(c.release(sig('mallory'))).toBe(false);
  });

  it('leaves control relinquished after an abort', async () => {
    const c = new SessionControl('r');
    const p = c.requestHandoff();
    c.claim('alice');
    c.release(sig('alice', 'abort'));
    await p;
    expect(c.current).toBe('RELINQUISHED');
    expect(c.canAutomate()).toBe(false);
  });
});
