/**
 * End-to-end: the real recorded artifact, the real browser, the real app.
 *
 * The unit tests cover the decision logic in isolation; this one exists to
 * catch the things that only appear when a real frameset is loading — the
 * class of bug where an observation lands mid-navigation and the flow acts on
 * a half-rendered screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { app as targetApp } from '../target-app/server.js';
import { WebSurface } from '../src/surface/web/playwright-surface.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { EnvCredentialProvider } from '../src/safety/credentials.js';
import { RunLog, newRunId } from '../src/observability/run-log.js';
import { SessionControl } from '../src/escalation/control.js';
import { applyOverlay, findCapability } from '../src/artifact/store.js';
import { zOverlay } from '../src/artifact/schema.js';

const PORT = 4399;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let server: Server;
let surface: WebSurface;

beforeAll(async () => {
  process.env.HS_SECRET_MERIDIAN_OPERATOR_ID = 'demo';
  process.env.HS_SECRET_MERIDIAN_OPERATOR_PASSWORD = 'demo';
  server = await new Promise<Server>((resolve) => {
    const s = targetApp.listen(PORT, () => resolve(s));
  });
  surface = await WebSurface.launch('e2e', { headless: true });
}, 60_000);

afterAll(async () => {
  await surface?.close();
  await new Promise<void>((r) => server?.close(() => r()));
});

/**
 * The recorded artifact, repointed at this test's instance — through the same
 * mechanism a real tenant uses. The overlay may move the entry point; the
 * origins it is allowed to reach come from the deployment's tenant registry,
 * not from the overlay itself.
 */
function capability() {
  const base = findCapability('meridian.member.savings-balance', '1.1.0');
  if (!base) throw new Error('capability meridian.member.savings-balance@1.1.0 is not recorded');
  const overlay = zOverlay.parse({
    schema: 'overlay/v1',
    base: { id: base.id, version: base.version },
    tenant: 'e2e',
    approval: 'approved',
    patches: [{ path: 'steps[0].action.url', value: `${ORIGIN}/` }],
  });
  return applyOverlay(base, overlay, { e2e: { label: 'e2e harness', origins: [ORIGIN] } }).capability;
}

function engine() {
  const redactor = new Redactor();
  const runId = newRunId('replay');
  return new ReplayEngine({
    runId,
    surface,
    policy: Policy.from({ allowedOrigins: [ORIGIN], deniedPathPrefixes: ['/__fault'] }),
    credentials: new EnvCredentialProvider(),
    log: new RunLog(runId, redactor, 'evidence/.test'),
    redactor,
    control: new SessionControl(runId),
    allowEscalation: false,
    riskyActions: 'escalate',
    requireApproval: true,
    resolveCapability: (id) => findCapability(id),
  });
}

describe('replay against the live legacy app', () => {
  it('completes the flow and returns the declared outputs', async () => {
    const r = await engine().run(capability(), { memberId: '12345' });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.outputs.memberName).toBe('RIVERA, DANA Q');
      expect(r.outputs.savingsBalance).toBe(4812.55);
      expect(typeof r.outputs.savingsBalance).toBe('number');
    }
  }, 90_000);

  // "No such member" is an answer, not a crash. A caller that sees a failure
  // here will retry; a caller that sees the outcome will report it.
  it('reports a missing record as a business outcome, not a failure', async () => {
    const r = await engine().run(capability(), { memberId: '99999' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.code).toBe('MEMBER_NOT_FOUND');
  }, 90_000);

  it('rejects malformed input before it ever opens the app', async () => {
    const r = await engine().run(capability(), { memberId: 'not-a-number' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') {
      expect(r.failure.class).toBe('INVALID_INPUT');
      expect(r.stepsExecuted).toBe(0);
    }
  }, 30_000);

  it('refuses to replay a capability that has not been approved', async () => {
    const cap = capability();
    cap.approval = 'draft';
    const r = await engine().run(cap, { memberId: '12345' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.failure.class).toBe('APPROVAL_REQUIRED');
  }, 30_000);

  /**
   * A recovery handler's action list calls straight into the engine's
   * `perform()`. URL checking used to live only in the step loop, so an
   * interstitial declared as "navigate to another institution" reached the
   * surface with no policy decision recorded at all.
   */
  it('refuses a recovery action that navigates outside the declared origins', async () => {
    const cap = capability();
    cap.interstitials = [{
      code: 'EXFIL',
      description: 'a recovery that leaves the permitted origins',
      when: { type: 'textMatches', value: { mode: 'contains', value: 'MERIDIAN', caseSensitive: false } },
      do: [{ kind: 'navigate', url: 'http://127.0.0.1:4311/app/search?p_mbr_no=12345' }],
      maxOccurrences: 1,
      restartFlow: false,
      escalateOnFailure: false,
      verified: false,
    }];
    const e = engine();
    const r = await e.run(cap, { memberId: '12345' });
    // However the run ends, it must not have reached the other origin.
    expect(e.lastObservation?.url ?? '').not.toContain('4311');
    expect(r.status).not.toBe('success');
  }, 60_000);

  /**
   * `invoke` runs unattended, so this is the mode production uses. The richer
   * failure signal used to be skipped there: a reason string and nothing to
   * debug it with.
   */
  it('captures evidence when an unattended run needs a human', async () => {
    const cap = capability();
    const step = cap.steps.find((x) => x.id === 's05')!;
    if ('target' in step.action) step.action.target.name = 'Nonexistent Button';
    const r = await engine().run(cap, { memberId: '12345' });

    expect(r.status).toBe('needs_human');
    if (r.status === 'needs_human') {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence.some((f) => f.endsWith('.observation.json'))).toBe(true);
      // The near-miss control names the locator already computed.
      expect(r.observed).toMatch(/nearest/);
    }
  }, 60_000);

  it('refuses to navigate outside the capability\'s declared origins', async () => {
    const cap = capability();
    cap.policy.allowedOrigins = ['http://127.0.0.1:4311'];
    const r = await engine().run(cap, { memberId: '12345' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.failure.class).toBe('POLICY_DENIED');
  }, 30_000);
});
