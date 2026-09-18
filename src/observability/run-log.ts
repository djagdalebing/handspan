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
import { looksSensitive, Redactor } from '../safety/redact.js';

export type EventType =
  | 'run.start' | 'run.end'
  | 'policy.decision'
  | 'step.start' | 'step.end' | 'step.effect'
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
      // A text surface returns its screen, not an image. Naming that `.png`
      // makes the evidence unopenable and hid a leak: the file looked binary,
      // so nobody grepped it.
      const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
      const name = `${String(this.seq).padStart(3, '0')}-${slug(label)}.${isPng ? 'png' : 'txt'}`;
      writeFileSync(join(this.dir, name), buf);
      this.event('note', { evidence: name, label });
      return name;
    } catch (e) {
      this.event('note', { label, screenshotFailed: String(e) });
      return null;
    }
  }

  /**
   * Full perceived control list. Written on failure and on escalation.
   *
   * The redactor only knows values it was told about — the capability's own
   * declared parameters and outputs. A dump is a picture of the whole screen,
   * which routinely carries regulated fields this capability never declared: a
   * sub-account flow does not declare the member's name, but the name is right
   * there on the screen it stalled on. So the dump protects itself using the
   * one thing it does know, the field's own label, registering those values
   * before writing so they are scrubbed from the node list *and* the page text.
   */
  dumpObservation(obs: Observation, label: string): string {
    for (const node of obs.nodes) {
      if (node.role !== 'readout' || !node.value) continue;
      if (looksSensitive(node.name)) {
        this.redactor.register(node.value, 'pii', slug(node.name).replace(/-/g, '_'));
      }
    }
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
