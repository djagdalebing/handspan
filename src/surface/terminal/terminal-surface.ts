/**
 * Green-screen surface driver.
 *
 * The second implementation of `Surface`, and the reason it exists is to find
 * out whether the seam is real or merely asserted. Nothing structured crosses
 * the wire here: no DOM, no element ids, no accessibility tree, no URL — only
 * an 80x24 grid of characters, which is what a terminal emulator gets from a
 * 3270 or 5250 host. Credit unions run a great deal of exactly this.
 *
 * Everything above `Surface` is unchanged. The artifact schema, the scoring
 * locator, the condition language, the probe mechanism, the replay engine and
 * the escalation model all work against `UiNode`s produced from characters:
 *
 *   - a *control* is recovered the same way a human recovers one, from the
 *     label printed next to it. On the web that was the table cell to the
 *     left; here it is the text before the colon on the same row. Same idea,
 *     completely different mechanism — which is the point.
 *   - `framePath` is unused (a terminal has one screen); on a desktop driver
 *     it would carry the window path.
 *   - `bounds` are row and column rather than pixels, which is what makes
 *     "click the field" expressible without a DOM.
 *   - `location()` is a `tn3270://` URI, so the allowlist applies here exactly
 *     as it does to `http://` — the policy is about *where you are*, not about
 *     the web.
 */
import { Socket } from 'node:net';
import type { Action, ActionResult, Observation, Surface, UiNode } from '../types.js';

const END = '--END--';

export interface TerminalSurfaceOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export class TerminalSurface implements Surface {
  readonly id: string;
  private socket: Socket | null = null;
  private screen: string[] = [];
  private pending: Array<(lines: string[]) => void> = [];
  private buffer = '';
  private frame: string[] = [];
  private opts: Required<TerminalSurfaceOptions>;
  /** Cursor position for each perceived control, keyed by ref. */
  private positions = new Map<string, { row: number; col: number }>();
  private keys = new Map<string, string>();

  private constructor(id: string, opts: TerminalSurfaceOptions) {
    this.id = id;
    this.opts = { host: opts.host ?? '127.0.0.1', port: opts.port ?? 4331, timeoutMs: opts.timeoutMs ?? 8_000 };
  }

  static async connect(id: string, opts: TerminalSurfaceOptions = {}): Promise<TerminalSurface> {
    const s = new TerminalSurface(id, opts);
    await s.open();
    return s;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const fail = (e: Error) => reject(e);
      socket.once('error', fail);
      socket.connect(this.opts.port, this.opts.host, () => {
        socket.off('error', fail);
        socket.on('error', () => {});
        this.socket = socket;
        // The host paints the first screen unprompted.
        this.awaitScreen().then(() => resolve(), reject);
      });
      socket.on('data', (chunk) => this.consume(chunk.toString('utf8')));
    });
  }

  private consume(text: string): void {
    this.buffer += text;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      if (line === END) {
        this.screen = this.frame;
        this.frame = [];
        const waiter = this.pending.shift();
        waiter?.(this.screen);
      } else {
        this.frame.push(line);
      }
    }
  }

  private awaitScreen(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('terminal did not repaint in time')), this.opts.timeoutMs);
      this.pending.push((lines) => {
        clearTimeout(timer);
        resolve(lines);
      });
    });
  }

  private async send(command: string): Promise<void> {
    if (!this.socket) throw new Error('terminal session is not open');
    const screen = this.awaitScreen();
    this.socket.write(command + '\n');
    await screen;
  }

  // ------------------------------------------------------------- perceive --

  async observe(): Promise<Observation> {
    const nodes: UiNode[] = [];
    this.positions.clear();
    this.keys.clear();
    let seq = 0;
    const add = (n: Omit<UiNode, 'ref'>, pos?: { row: number; col: number }, key?: string): void => {
      const ref = `t${seq++}`;
      nodes.push({ ...n, ref });
      if (pos) this.positions.set(ref, pos);
      if (key) this.keys.set(ref, key);
    };

    const lines = this.screen;
    const title = (lines[0] ?? '').slice(40).trim();
    if (title) {
      add({ role: 'heading', name: title, framePath: [], bounds: { x: 40, y: 0, w: title.length, h: 1 }, path: 'row0' });
    }

    for (let row = 0; row < lines.length; row++) {
      const line = lines[row] ?? '';

      // A host message. These carry the same `MCS-nnnn` codes as the web app,
      // which is why an artifact's outcome detectors port across unchanged.
      const alert = line.match(/(MCS-\d{3,5}\s*-\s*.+?)\s*$/);
      if (alert) {
        add({ role: 'alert', name: alert[1]!.trim(), framePath: [], bounds: { x: 0, y: row, w: line.length, h: 1 }, path: `row${row}` });
        continue;
      }

      // `Label: ____` is an input field; `Label: value` is a readout. This is
      // the green-screen equivalent of deriving a name from the adjacent cell.
      const labelled = line.match(/^(\s+)([A-Za-z][A-Za-z0-9 ()]*?):\s+(.*?)\s*$/);
      if (labelled) {
        const name = labelled[2]!.trim();
        const rest = labelled[3] ?? '';
        const col = (labelled[1]?.length ?? 0) + name.length + 2 + (rest.length - rest.trimStart().length);
        if (rest.includes('_')) {
          add(
            { role: 'textbox', name, value: rest.replace(/_+$/, ''), framePath: [], bounds: { x: col, y: row, w: rest.length, h: 1 }, path: `row${row}` },
            { row, col }
          );
        } else if (rest) {
          add({ role: 'readout', name, value: rest, framePath: [], bounds: { x: col, y: row, w: rest.length, h: 1 }, path: `row${row}` });
        }
        continue;
      }

      // The action bar: `PF3=Return  ENTER=Search`. Each becomes a button
      // named by what it does, so an artifact says "click Search" here just
      // as it does on the web.
      if (/\b(PF\d+|ENTER)=/.test(line)) {
        for (const m of line.matchAll(/\b(PF\d+|ENTER)=([A-Za-z][A-Za-z0-9 -]*?)(?=\s{2,}|$)/g)) {
          add(
            { role: 'button', name: m[2]!.trim(), framePath: [], bounds: { x: m.index ?? 0, y: row, w: m[0].length, h: 1 }, path: `row${row}` },
            undefined,
            m[1]!
          );
        }
      }
    }

    const grid = this.readGrid(lines);
    if (grid) {
      add({ role: 'table', name: grid.name, grid: grid.rows, framePath: [], bounds: { x: 0, y: grid.row, w: 80, h: grid.rows.length }, path: `row${grid.row}` });
    }

    return {
      url: await this.location(),
      title,
      nodes,
      text: lines.join('\n').replace(/[ \t]+$/gm, ''),
      at: new Date().toISOString(),
    };
  }

  /** A columnar table, recovered from the header row's column offsets. */
  private readGrid(lines: string[]): { name: string; row: number; rows: string[][] } | null {
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row] ?? '';
      const cells = [...line.matchAll(/\S(?:[^ ]| (?! ))*/g)];
      const isHeader = cells.length >= 3 && line.trim() === line.trim().toUpperCase() && !line.includes(':') && /[A-Z]{3,}/.test(line);
      if (!isHeader) continue;
      const starts = cells.map((c) => c.index ?? 0);
      const cut = (l: string) => starts.map((s, i) => l.slice(s, starts[i + 1] ?? l.length).trim());
      const rows: string[][] = [cells.map((c) => c[0].trim())];
      for (let r = row + 1; r < lines.length; r++) {
        const body = lines[r] ?? '';
        if (!body.trim()) break;
        rows.push(cut(body));
      }
      if (rows.length >= 2) return { name: rows[0]!.join(' '), row, rows };
    }
    return null;
  }

  // ----------------------------------------------------------------- act --

  async act(action: Action, resolved: UiNode | null): Promise<ActionResult> {
    try {
      switch (action.kind) {
        case 'navigate':
          // A terminal has no address bar; "go to the entry point" means
          // returning the session to its first screen.
          await this.send('RESET');
          return { ok: true };
        case 'wait':
          await new Promise((r) => setTimeout(r, action.ms));
          return { ok: true };
        case 'press':
          await this.send(`KEY ${action.key.toUpperCase()}`);
          return { ok: true };
        case 'click': {
          if (!resolved) return { ok: false, error: 'no resolved control' };
          const key = this.keys.get(resolved.ref);
          if (key) {
            await this.send(`KEY ${key}`);
            return { ok: true };
          }
          const pos = this.positions.get(resolved.ref);
          if (!pos) return { ok: false, error: `"${resolved.name}" is not something this terminal can activate` };
          await this.send(`FIELD ${pos.row} ${pos.col}`);
          return { ok: true };
        }
        case 'type': {
          if (!resolved) return { ok: false, error: 'no resolved control' };
          const pos = this.positions.get(resolved.ref);
          if (!pos) return { ok: false, error: `"${resolved.name}" is not an input field` };
          await this.send(`FIELD ${pos.row} ${pos.col}`);
          await this.send(`TYPE ${action.text}`);
          return { ok: true };
        }
        case 'select':
          return { ok: false, error: 'a green screen has no combo boxes' };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Text screens carry nothing sensitive we can mask, so evidence is the grid. */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(this.screen.join('\n'), 'utf8');
  }

  async location(): Promise<string> {
    const title = (this.screen[0] ?? '').slice(40).trim().split(/\s+-\s+/)[0] ?? 'UNKNOWN';
    return `tn3270://${this.opts.host}:${this.opts.port}/${title.replace(/\s+/g, '_')}`;
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}
