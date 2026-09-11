/**
 * Control transfer over a live session.
 *
 * The requirement that a human take over *the same session* — not a fresh one
 * — is what forces this to be a real mechanism rather than a notification.
 * A bank session carries authentication, a navigation position, a
 * half-completed form and often a server-side lock on the record being
 * edited. Handing the operator a new browser loses all of it.
 *
 * So the session object is shared, and what transfers is the *right to act on
 * it*. The invariant is single-writer: at any instant exactly one of the
 * automation or the operator may drive, and both go through this lease.
 * Without that you get the genuinely bad failure mode where the engine's
 * pending click lands two seconds after the human has navigated somewhere
 * else.
 *
 * States:
 *
 *   AUTOMATION ──raise()──▶ PENDING ──claim()──▶ HUMAN ──release()──▶ AUTOMATION
 *        ▲                     │                   │
 *        └──────release()──────┘                   └──abandon()──▶ RELINQUISHED
 *
 * PENDING exists because raising an intervention and a human actually picking
 * it up are seconds-to-minutes apart, and the automation must already be
 * stopped during that window — not still clicking while a request sits in a
 * queue.
 */
export type ControlState = 'AUTOMATION' | 'PENDING' | 'HUMAN' | 'RELINQUISHED';

export type ReleaseDisposition = 'resume' | 'complete' | 'abort';

export interface ReleaseSignal {
  disposition: ReleaseDisposition;
  note: string;
  operator: string;
}

export class SessionControl {
  private state: ControlState = 'AUTOMATION';
  private holder = 'automation';
  private waiters: Array<(s: ReleaseSignal) => void> = [];
  private lastSignal: ReleaseSignal | null = null;

  constructor(readonly runId: string, private onChange?: (s: ControlState) => void) {}

  get current(): ControlState {
    return this.state;
  }

  get controller(): string {
    return this.holder;
  }

  /** True only when the automation is permitted to drive the surface. */
  canAutomate(): boolean {
    return this.state === 'AUTOMATION';
  }

  /** Automation stops here and waits for a human decision. */
  requestHandoff(): Promise<ReleaseSignal> {
    if (this.state === 'AUTOMATION') this.transition('PENDING', 'awaiting-operator');
    return new Promise<ReleaseSignal>((resolve) => {
      if (this.lastSignal) {
        resolve(this.lastSignal);
        return;
      }
      this.waiters.push(resolve);
    });
  }

  /** An operator picks up a pending intervention and takes the wheel. */
  claim(operator: string): boolean {
    if (this.state !== 'PENDING') return false;
    this.transition('HUMAN', operator);
    return true;
  }

  /** True only when this operator may drive the surface. */
  canOperate(operator: string): boolean {
    return this.state === 'HUMAN' && this.holder === operator;
  }

  /** The operator hands control back and says what should happen next. */
  release(signal: ReleaseSignal): boolean {
    if (this.state !== 'HUMAN' && this.state !== 'PENDING') return false;
    this.lastSignal = signal;
    this.transition(signal.disposition === 'abort' ? 'RELINQUISHED' : 'AUTOMATION', 'automation');
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(signal);
    return true;
  }

  private transition(next: ControlState, holder: string): void {
    this.state = next;
    this.holder = holder;
    this.onChange?.(next);
  }
}
