/**
 * Intervention routing and the operator console.
 *
 * The broker owns the queue of "a human is needed here" requests and serves a
 * console that drives the *live* session behind each one. In this
 * single-process build the broker and the session share a process, so the
 * console reaches the surface by reference. In production the seam is the
 * same but the wire is longer: the broker becomes a service, the session
 * lives in a session-host addressed by `runId`, and these route handlers turn
 * into RPCs. Nothing in the control model changes — it is already written as
 * "ask the lease, then act", not "reach into the browser".
 *
 * One deliberate asymmetry: stored evidence screenshots are masked, but the
 * operator's live view is not. A masked screen is useless to the person we
 * just asked to finish a real task on a real member's account. The control is
 * that the operator is an authenticated employee acting inside the
 * institution, whereas evidence files outlive the run and travel.
 */
import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { Observation, Surface } from '../surface/types.js';
import type { LiveControl } from '../surface/web/playwright-surface.js';
import type { RunLog } from '../observability/run-log.js';
import type { Policy } from '../safety/policy.js';
import { SessionControl, type ReleaseSignal } from './control.js';
import { renderConsole } from './console-html.js';

export type EscalationReason =
  | 'STUCK_NO_PROGRESS'
  | 'TARGET_UNRESOLVED'
  | 'AMBIGUOUS_TARGET'
  | 'UNRECOGNISED_SCREEN'
  | 'RISKY_ACTION_CONFIRMATION'
  | 'INTERSTITIAL_UNCLEARED'
  | 'SESSION_LOST'
  | 'STEP_BUDGET_EXHAUSTED'
  | 'MODEL_REQUESTED_HELP';

export interface Intervention {
  id: string;
  runId: string;
  mode: 'discovery' | 'replay';
  capabilityId: string;
  goal: string;
  stepId?: string;
  reason: EscalationReason;
  summary: string;
  raisedAt: string;
  state: 'open' | 'claimed' | 'resolved';
  operator?: string;
  context: {
    url: string;
    screenshot?: string;
    observationDump?: string;
    expected?: string;
    observed?: string;
  };
  humanActions: Array<{ at: string; kind: string; detail: string }>;
  resolution?: ReleaseSignal & { at: string };
}

interface Registration {
  control: SessionControl;
  surface: Surface & Partial<LiveControl>;
  log: RunLog;
  policy: Policy;
  observe: () => Promise<Observation>;
}

/**
 * Optional shared secret for the mutating console endpoints.
 *
 * The console has no user accounts — that is a documented cut — but "no
 * authentication" must not also mean "no authorization". The lease check below
 * is the real control; this is defence in depth for a broker reachable beyond
 * localhost, and is enforced whenever the variable is set.
 */
const OPERATOR_TOKEN = process.env.HS_OPERATOR_TOKEN ?? '';

function tokenOk(req: Request): boolean {
  if (!OPERATOR_TOKEN) return true;
  const supplied = req.get('x-operator-token') ?? String((req.body ?? {}).token ?? '');
  return supplied === OPERATOR_TOKEN;
}

export class EscalationBroker {
  private interventions = new Map<string, Intervention>();
  private sessions = new Map<string, Registration>();
  private server: Server | null = null;
  private seq = 0;

  /** A run registers its live session so the console can drive it. */
  registerSession(runId: string, reg: Registration): void {
    this.sessions.set(runId, reg);
  }

  unregisterSession(runId: string): void {
    this.sessions.delete(runId);
  }

  list(): Intervention[] {
    return [...this.interventions.values()].sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  get(id: string): Intervention | undefined {
    return this.interventions.get(id);
  }

  /**
   * Raise an intervention and block the automation until a human resolves it.
   * Context is captured *before* we stop, because the screen is the single
   * most useful thing the operator gets and it will not survive the wait.
   */
  async raise(args: {
    runId: string;
    mode: 'discovery' | 'replay';
    capabilityId: string;
    goal: string;
    reason: EscalationReason;
    summary: string;
    stepId?: string;
    expected?: string;
    observed?: string;
    /** Give up waiting after this long and let the caller report needs_human. */
    timeoutMs?: number;
  }): Promise<{ intervention: Intervention; signal: ReleaseSignal | null }> {
    const reg = this.sessions.get(args.runId);
    if (!reg) throw new Error(`no live session registered for run ${args.runId}`);

    const id = `int-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    const obs = await reg.observe().catch(() => null);
    const screenshot = await reg.log.screenshot(reg.surface, `escalation-${args.reason}`);
    const dump = obs ? reg.log.dumpObservation(obs, `escalation-${args.reason}`) : undefined;

    const intervention: Intervention = {
      id,
      runId: args.runId,
      mode: args.mode,
      capabilityId: args.capabilityId,
      goal: args.goal,
      stepId: args.stepId,
      reason: args.reason,
      summary: args.summary,
      raisedAt: new Date().toISOString(),
      state: 'open',
      context: {
        url: obs?.url ?? (await reg.surface.location().catch(() => 'unknown')),
        screenshot: screenshot ?? undefined,
        observationDump: dump,
        expected: args.expected,
        observed: args.observed,
      },
      humanActions: [],
    };
    this.interventions.set(id, intervention);

    reg.log.event('escalation.raised', {
      escalationId: id,
      reason: args.reason,
      summary: args.summary,
      stepId: args.stepId,
      expected: args.expected,
      observed: args.observed,
      consoleUrl: this.urlFor(id),
    });
    process.stderr.write(
      `\n  ⚠ intervention required — ${args.reason}\n` +
      `    ${args.summary}\n` +
      `    operator console: ${this.urlFor(id)}\n\n`
    );

    const signal = await withTimeout(reg.control.requestHandoff(), args.timeoutMs);
    if (!signal) {
      reg.log.event('note', {
        message: 'no operator resolved the intervention within the timeout',
        escalationId: id, timeoutMs: args.timeoutMs,
      });
      return { intervention, signal: null };
    }
    intervention.state = 'resolved';
    intervention.resolution = { ...signal, at: new Date().toISOString() };
    reg.log.event('escalation.resumed', {
      escalationId: id,
      disposition: signal.disposition,
      operator: signal.operator,
      note: signal.note,
      humanActionCount: intervention.humanActions.length,
      humanActionKinds: intervention.humanActions.map((a) => a.kind),
    });
    return { intervention, signal };
  }

  // ------------------------------------------------------------ console --

  private port = Number(process.env.HS_OPERATOR_PORT ?? 4312);

  urlFor(id: string): string {
    return `http://127.0.0.1:${this.port}/i/${id}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const app: Express = express();
    app.use(express.json());

    app.get('/', (_req, res) => {
      const rows = this.list().map((i) =>
        `<tr><td><a href="/i/${i.id}">${i.id}</a></td><td>${i.state}</td>` +
        `<td>${i.reason}</td><td>${esc(i.summary)}</td><td>${i.raisedAt}</td></tr>`
      ).join('');
      res.send(`<html><body style="font:13px system-ui;padding:20px">
        <h2>Interventions</h2>
        <table border=1 cellpadding=6 cellspacing=0>
        <tr><th>id</th><th>state</th><th>reason</th><th>summary</th><th>raised</th></tr>
        ${rows || '<tr><td colspan=5><i>none</i></td></tr>'}</table>
        <p><a href="/">refresh</a></p></body></html>`);
    });

    // Machine-readable view of the queue. The HTML console is one client of
    // this; a real deployment would have others (a work queue, a pager).
    app.get('/api/interventions', (_req, res) => {
      res.json(this.list().map((i) => ({ ...i, evidenceDir: this.sessions.get(i.runId)?.log.dir })));
    });

    app.get('/api/i/:id', (req, res) => {
      const i = this.interventions.get(req.params.id!);
      if (!i) return res.status(404).json({ error: 'unknown intervention' });
      res.json({ ...i, evidenceDir: this.sessions.get(i.runId)?.log.dir });
    });

    app.get('/i/:id', (req, res) => {
      const i = this.interventions.get(req.params.id!);
      if (!i) return res.status(404).send('unknown intervention');
      res.send(renderConsole(i, this.sessions.get(i.runId)?.control.current ?? 'RELINQUISHED'));
    });

    app.get('/i/:id/state', (req, res) => {
      const i = this.interventions.get(req.params.id!);
      if (!i) return res.status(404).json({ error: 'unknown intervention' });
      const reg = this.sessions.get(i.runId);
      res.json({
        state: i.state,
        control: reg?.control.current ?? 'RELINQUISHED',
        controller: reg?.control.controller,
        actions: i.humanActions.length,
      });
    });

    // Live view of the session. Unmasked by design; see the header comment.
    app.get('/i/:id/screenshot', async (req, res) => {
      const reg = this.regFor(req, res);
      if (!reg) return;
      try {
        const buf = await reg.surface.screenshot({ maskSensitive: false });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /**
     * The current control list for the live session — the same normalized view
     * the automation sees. The screenshot shows the operator what is there;
     * this tells them what it is *called*, which on a table-laid-out legacy
     * screen with no labels is genuinely hard to tell by eye.
     */
    app.get('/i/:id/controls', async (req, res) => {
      const reg = this.regFor(req, res);
      if (!reg) return;
      try {
        const obs = await reg.observe();
        res.json(reg.log.redactor.value({
          url: obs.url,
          nodes: obs.nodes.map((n) => ({
            role: n.role, name: n.name, value: n.value,
            framePath: n.framePath, bounds: n.bounds,
          })),
        }));
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    app.post('/i/:id/claim', (req, res) => {
      const i = this.interventions.get(req.params.id!);
      const reg = i ? this.sessions.get(i.runId) : undefined;
      if (!i || !reg) return res.status(404).json({ error: 'unknown intervention' });
      if (!tokenOk(req)) return res.status(403).json({ error: 'operator token required' });
      const operator = String(req.body?.operator ?? '').trim();
      if (!operator) return res.status(400).json({ error: 'an operator name is required to take control' });
      if (!reg.control.claim(operator)) {
        return res.status(409).json({ error: `control is ${reg.control.current}, cannot claim` });
      }
      i.state = 'claimed';
      i.operator = operator;
      reg.log.event('escalation.claimed', { escalationId: i.id, operator });
      res.json({ ok: true, control: reg.control.current });
    });

    /**
     * Raw input against the live session. Every call re-checks the lease, so
     * a stale console tab cannot drive a session it no longer holds.
     */
    app.post('/i/:id/input', async (req, res) => {
      const i = this.interventions.get(req.params.id!);
      const reg = i ? this.sessions.get(i.runId) : undefined;
      if (!i || !reg) return res.status(404).json({ error: 'unknown intervention' });
      if (!tokenOk(req)) return res.status(403).json({ error: 'operator token required' });
      // Authorize the *caller*, not whoever happens to be recorded as holder —
      // otherwise anyone who can reach the broker drives as the person who
      // claimed.
      const operator = String(req.body?.operator ?? '').trim();
      if (!operator || !reg.control.canOperate(operator)) {
        return res.status(409).json({
          error: `control is ${reg.control.current} and held by "${reg.control.controller}"; claim it as yourself first`,
        });
      }
      const surface = reg.surface;
      const body = req.body ?? {};
      try {
        let detail = '';
        switch (body.kind) {
          case 'click':
            await surface.rawClick?.(Number(body.x), Number(body.y));
            detail = `(${Math.round(Number(body.x))},${Math.round(Number(body.y))})`;
            break;
          case 'text':
            await surface.rawType?.(String(body.text ?? ''));
            // Content is not logged: the operator is typing into a live
            // banking screen and we have no declaration of what it is.
            detail = `${String(body.text ?? '').length} chars`;
            break;
          case 'key':
            await surface.rawKey?.(String(body.key ?? 'Enter'));
            detail = String(body.key ?? 'Enter');
            break;
          case 'navigate': {
            const url = String(body.url ?? '');
            const decision = reg.policy.checkUrl(url);
            if (decision.decision !== 'allow') {
              // The allowlist binds the operator console too. It is reachable
              // over HTTP, which makes it a confused-deputy risk if it can
              // send the session anywhere.
              reg.log.event('policy.decision', { actor: 'operator', url, ...decision });
              return res.status(403).json({ error: (decision as { reason: string }).reason });
            }
            await surface.rawNavigate?.(url);
            detail = url;
            break;
          }
          default:
            return res.status(400).json({ error: `unknown input kind ${body.kind}` });
        }
        const record = { at: new Date().toISOString(), kind: String(body.kind), detail };
        i.humanActions.push(record);
        reg.log.event('escalation.action', { escalationId: i.id, operator, ...record });
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    });

    /**
     * Handing control back. This is the endpoint that authorises an
     * irreversible step, so it is the one that must not be satisfiable by a
     * bare POST: the caller has to name themselves and already hold the lease.
     */
    app.post('/i/:id/resolve', (req, res) => {
      const i = this.interventions.get(req.params.id!);
      const reg = i ? this.sessions.get(i.runId) : undefined;
      if (!i || !reg) return res.status(404).json({ error: 'unknown intervention' });
      if (!tokenOk(req)) return res.status(403).json({ error: 'operator token required' });

      const operator = String(req.body?.operator ?? '').trim();
      if (!operator || !reg.control.canOperate(operator)) {
        reg.log.event('policy.decision', {
          escalationId: i.id, decision: 'deny', actor: operator || '(anonymous)',
          reason: 'attempted to resolve an intervention without holding the lease',
        });
        return res.status(409).json({
          error: `control is ${reg.control.current} and held by "${reg.control.controller}"; ` +
            `claim it as yourself before resolving`,
        });
      }

      const signal: ReleaseSignal = {
        disposition: (req.body?.disposition ?? 'resume') as ReleaseSignal['disposition'],
        note: String(req.body?.note ?? ''),
        operator,
      };
      if (!reg.control.release(signal)) {
        return res.status(409).json({ error: `control is ${reg.control.current}, cannot release` });
      }
      res.json({ ok: true, disposition: signal.disposition });
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(this.port, () => resolve());
    });
  }

  private regFor(req: Request, res: Response): Registration | null {
    const i = this.interventions.get(req.params.id!);
    const reg = i ? this.sessions.get(i.runId) : undefined;
    if (!i || !reg) {
      res.status(404).json({ error: 'unknown intervention' });
      return null;
    }
    return reg;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

/** Resolves to null if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms?: number): Promise<T | null> {
  if (!ms || ms <= 0) return promise;
  let timer: NodeJS.Timeout;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer!);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

export const broker = new EscalationBroker();
