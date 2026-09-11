/**
 * Run evidence.
 *
 * Everything a run produces lands under `evidence/<runId>/`: a JSONL event
 * stream, screenshots, and observation dumps. Two rules shape it.
 *
 * *Everything goes through the redactor on the way out.* Not at read time,
 * not "when we remember to" — the only write path is `event()`, and it
 * redacts. Regulated data that never reaches disk cannot leak from disk.
 *
 * *Failures get a richer signal than successes.* A successful replay writes
 * the event stream and a final screenshot. A failure additionally dumps the
 * full perceived control list at the point of failure, which is what you
 * actually need to answer "why didn't it find the button" three weeks later
 * without reproducing the run.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation, Surface } from '../surface/types.js';
import { Redactor } from '../safety/redact.js';

export type EventType =
  | 'run.start' | 'run.end'
  | 'policy.decision'
  | 'step.start' | 'step.end'
  | 'observe'
  | 'model.request' | 'model.response'
  | 'outcome.detected' | 'interstitial.recovered'
  | 'drift.detected'
  | 'escalation.raised' | 'escalation.claimed' | 'escalation.action' | 'escalation.resumed'
  | 'artifact.written'
  | 'note';

export interface RunEvent {
  seq: number;
  at: string;
  runId: string;
  type: EventType;
  data: Record<string, unknown>;
}

export class RunLog {
  readonly dir: string;
  private seq = 0;
  private file: string;

  constructor(
    readonly runId: string,
    readonly redactor: Redactor,
    rootDir = 'evidence'
  ) {
    this.dir = join(rootDir, runId);
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, 'events.jsonl');
  }

  event(type: EventType, data: Record<string, unknown> = {}): void {
    const ev: RunEvent = {
      seq: this.seq++,
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      data: this.redactor.value(data),
    };
    appendFileSync(this.file, JSON.stringify(ev) + '\n');
  }

  /** Screenshot with sensitive values masked in-page before capture. */
  async screenshot(surface: Surface, label: string): Promise<string | null> {
    try {
      const buf = await surface.screenshot({
        maskSensitive: true,
        maskValues: this.redactor.piiLiterals(),
      });
      const name = `${String(this.seq).padStart(3, '0')}-${slug(label)}.png`;
      writeFileSync(join(this.dir, name), buf);
      this.event('note', { evidence: name, label });
      return name;
    } catch (e) {
      this.event('note', { label, screenshotFailed: String(e) });
      return null;
    }
  }

  /** Full perceived control list. Written on failure and on escalation. */
  dumpObservation(obs: Observation, label: string): string {
    const name = `${String(this.seq).padStart(3, '0')}-${slug(label)}.observation.json`;
    const payload = this.redactor.value({
      url: obs.url,
      title: obs.title,
      at: obs.at,
      text: obs.text,
      nodes: obs.nodes.map((n) => ({
        ref: n.ref, role: n.role, name: n.name, value: n.value,
        framePath: n.framePath, group: n.group, domHint: n.domHint,
        bounds: n.bounds, grid: n.grid, options: n.options,
      })),
    });
    writeFileSync(join(this.dir, name), JSON.stringify(payload, null, 2));
    this.event('note', { evidence: name, label });
    return name;
  }

  writeJson(name: string, value: unknown): string {
    writeFileSync(join(this.dir, name), JSON.stringify(this.redactor.value(value), null, 2));
    return join(this.dir, name);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';
}

export function newRunId(kind: 'discover' | 'replay'): string {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${kind}-${t}-${Math.random().toString(36).slice(2, 6)}`;
}
