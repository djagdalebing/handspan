/**
 * The surface seam, tested rather than asserted.
 *
 * A capability recorded by a model against the frameset web app is replayed
 * here against a 3270-style green screen over a socket. Nothing above
 * `Surface` differs: same artifact, same semantic targets, same condition
 * language, same outcome detectors, same replay engine. If the seam were
 * merely a nice diagram, these tests would not pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:net';
import { server as greenScreen } from '../target-app/green-screen.js';
import { TerminalSurface } from '../src/surface/terminal/terminal-surface.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { EnvCredentialProvider } from '../src/safety/credentials.js';
import { RunLog, newRunId } from '../src/observability/run-log.js';
import { SessionControl } from '../src/escalation/control.js';
import { applyOverlay, findCapability } from '../src/artifact/store.js';
import { zOverlay } from '../src/artifact/schema.js';

const PORT = 4398;
const ORIGIN = `tn3270://127.0.0.1:${PORT}`;
let listening: Server;

beforeAll(async () => {
  process.env.HS_SECRET_MERIDIAN_OPERATOR_ID = 'demo';
  process.env.HS_SECRET_MERIDIAN_OPERATOR_PASSWORD = 'demo';
  await new Promise<void>((r) => { listening = greenScreen.listen(PORT, '127.0.0.1', () => r()); });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => listening?.close(() => r()));
});

/** The web-recorded capability, repointed at the terminal. */
function capability() {
  const base = findCapability('meridian.member.savings-balance', '1.1.0');
  if (!base) throw new Error('meridian.member.savings-balance@1.1.0 is not recorded');
  const overlay = zOverlay.parse({
    schema: 'overlay/v1',
    base: { id: base.id, version: base.version },
    tenant: 'terminal-test',
    approval: 'approved',
    conditionsReviewedBy: 'test',
    patches: [
      { path: 'steps[0].action.url', value: `${ORIGIN}/` },
      { path: 'steps[5].waitFor.value.value', value: 'MEMBER DETAIL - {{memberId}}' },
    ],
  });
  return applyOverlay(base, overlay, { 'terminal-test': { origins: [ORIGIN] } }).capability;
}

async function replay(inputs: Record<string, string>) {
  const surface = await TerminalSurface.connect('test', { port: PORT });
  const redactor = new Redactor();
  const runId = newRunId('replay');
  const engine = new ReplayEngine({
    runId,
    surface,
    policy: Policy.from({ allowedOrigins: [ORIGIN], allowedSchemes: ['tn3270'] }),
    credentials: new EnvCredentialProvider(),
    log: new RunLog(runId, redactor, 'evidence/.test'),
    redactor,
    control: new SessionControl(runId),
    allowEscalation: false,
    riskyActions: 'escalate',
    requireApproval: true,
  });
  try {
    return await engine.run(capability(), inputs);
  } finally {
    await surface.close();
  }
}

describe('a web-recorded capability replayed on a green screen', () => {
  it('completes and returns the same typed outputs', async () => {
    const r = await replay({ memberId: '12345' });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.outputs.memberName).toBe('RIVERA, DANA Q');
      expect(r.outputs.accountStatus).toBe('ACTIVE');
      expect(r.outputs.savingsBalance).toBe(4812.55);
      expect(typeof r.outputs.savingsBalance).toBe('number');
    }
  }, 30_000);

  // The detectors were built by probing the *web* app and repaired to its
  // error codes. The terminal prints the same codes, so they port unchanged.
  it('reports a missing record as the same business outcome', async () => {
    const r = await replay({ memberId: '99999' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_NOT_FOUND');
  }, 30_000);

  it('reports a permission denial as the same business outcome', async () => {
    const r = await replay({ memberId: '77777' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_RESTRICTED');
  }, 30_000);

  it('enforces the allowlist on a non-http scheme', async () => {
    const cap = capability();
    cap.policy.allowedOrigins = ['tn3270://127.0.0.1:9999'];
    const surface = await TerminalSurface.connect('test', { port: PORT });
    const redactor = new Redactor();
    const runId = newRunId('replay');
    const engine = new ReplayEngine({
      runId, surface,
      policy: Policy.from({ allowedOrigins: [ORIGIN], allowedSchemes: ['tn3270'] }),
      credentials: new EnvCredentialProvider(),
      log: new RunLog(runId, redactor, 'evidence/.test'),
      redactor, control: new SessionControl(runId),
      allowEscalation: false, riskyActions: 'escalate', requireApproval: false,
    });
    try {
      const r = await engine.run(cap, { memberId: '12345' });
      expect(r.status).toBe('failure');
      if (r.status === 'failure') expect(r.failure.class).toBe('POLICY_DENIED');
    } finally {
      await surface.close();
    }
  }, 30_000);
});

describe('terminal perception', () => {
  it('recovers controls from characters alone', async () => {
    const s = await TerminalSurface.connect('test', { port: PORT });
    try {
      const obs = await s.observe();
      // The label before the colon is the only identity a green screen offers.
      expect(obs.nodes.find((n) => n.role === 'textbox' && n.name === 'Operator ID')).toBeDefined();
      expect(obs.nodes.find((n) => n.role === 'textbox' && n.name === 'Password')).toBeDefined();
      expect(obs.nodes.find((n) => n.role === 'button' && n.name === 'Sign On')).toBeDefined();
      // Location is a URI so the allowlist applies as it does on the web.
      expect(obs.url).toMatch(/^tn3270:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      await s.close();
    }
  }, 30_000);
});
