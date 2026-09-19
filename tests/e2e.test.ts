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
import { readFileSync } from 'node:fs';
import { zOverlay } from '../src/artifact/schema.js';

const PORT = 4399;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let server: Server;
let surface: WebSurface;

beforeAll(async () => {
  process.env.HS_SECRET_MERIDIAN_OPERATOR_ID = 'demo';
  process.env.HS_SECRET_MERIDIAN_OPERATOR_PASSWORD = 'demo';
  server = await new Promise<Server>((resolve, reject) => {
    // Without the error handler an occupied port produces six tests failing on
    // an unrelated error page 40s apart, which is a bad half-hour. Say it once.
    const s = targetApp.listen(PORT, () => resolve(s));
    s.on('error', (e) => reject(new Error(`cannot start the test app on ${PORT}: ${e.message}`)));
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

/**
 * The frameset race, from the perceiving side.
 *
 * A click submits the form inside the `main` frame, but the new document has
 * not begun loading when the action returns, so every frame still reads
 * `readyState: complete` and settling finished on the *old* screen. Replay
 * survived it by retrying; discovery got one look and reported "nothing
 * changed" on the one action that mattered.
 *
 * Honest about what this test is: the race is intermittent (about one run in
 * five, and not on this in-process server), so this does not reproduce the
 * timing. It pins the path — observe immediately after a click, no retry —
 * so the guard in `settle` cannot be removed without something failing here
 * when the timing does go wrong.
 */
describe('observing immediately after a click', () => {
  it('sees the screen the click produced, not the one it left', async () => {
    await surface.act({ kind: 'navigate', url: `${ORIGIN}/` }, null);

    const find = async (role: string, name: string) => {
      const obs = await surface.observe();
      const n = obs.nodes.find((x) => x.role === role && x.name === name);
      if (!n) throw new Error(`no ${role} "${name}" on ${obs.url}`);
      return n;
    };

    await surface.act({ kind: 'type', target: { role: 'textbox', name: 'Operator ID', nameMatch: 'exact' }, text: 'demo' }, await find('textbox', 'Operator ID'));
    await surface.act({ kind: 'type', target: { role: 'textbox', name: 'Password', nameMatch: 'exact' }, text: 'demo' }, await find('textbox', 'Password'));
    await surface.act({ kind: 'click', target: { role: 'button', name: 'Sign On', nameMatch: 'exact' } }, await find('button', 'Sign On'));

    await surface.act({ kind: 'type', target: { role: 'textbox', name: 'Member Number', nameMatch: 'exact' }, text: '12345' }, await find('textbox', 'Member Number'));
    await surface.act({ kind: 'click', target: { role: 'button', name: 'Search', nameMatch: 'exact' } }, await find('button', 'Search'));

    // No retry, no wait, no second observation: exactly what discovery does.
    const after = await surface.observe();
    expect(after.text).toContain('MEMBER DETAIL');
    expect(after.nodes.some((n) => n.role === 'button' && n.name === 'Search')).toBe(false);
  }, 60_000);
});

/**
 * Two ways an *approved* artifact reached data or an instance it should not,
 * both found by review rather than by these tests, and both closed here.
 */
describe('what an approved capability may reach', () => {
  /**
   * Sensitivity was classified from the artifact's *matcher*. A `contains`
   * label is something a tenant may legitimately reword, and
   * `outputs[].source.label` is on the overlay allow-list with no re-review,
   * so `"N (last 4)"` matched the `SSN (last 4)` readout while missing the
   * sensitive-label list. The output was declared `internal`, so the value
   * went to the calling agent and into result.json in clear.
   */
  it('classifies an output by the label on screen, not the one in the patch', async () => {
    const cap = capability();
    const status = cap.outputs.find((o) => o.name === 'accountStatus');
    expect(status?.source.from).toBe('readout');
    expect(status?.sensitivity).toBe('internal');
    if (status?.source.from === 'readout') status.source.label.value = 'N (last 4)';

    const r = await engine().run(cap, { memberId: '12345' });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;

    // It read the SSN readout — the relabel matches — but the value the caller
    // receives is a pseudonym, and the result says which output under-declared.
    expect(String(r.outputs.accountStatus)).toMatch(/^«accountStatus#[0-9a-f]+»$/);
    expect(r.underDeclared).toContain('accountStatus');
  }, 90_000);

  // The same output, unpatched, must not be swept up by the above.
  it('leaves an ordinary business field in clear', async () => {
    const r = await engine().run(capability(), { memberId: '12345' });
    if (r.status === 'success') expect(r.outputs.accountStatus).toBe('ACTIVE');
  }, 90_000);

  /**
   * A nested capability ran under its *own* declared origins, discarding the
   * caller's. A capability overlaid onto one tenant hit SESSION_EXPIRED, ran
   * the shared sign-on capability, and signed on to the instance that
   * capability happened to be recorded against — reporting success.
   */
  it('confines a nested capability to the origins its caller was confined to', async () => {
    const cap = capability();
    const signon = findCapability('meridian.session.signon', '1.0.0');
    if (!signon) throw new Error('meridian.session.signon@1.0.0 is not recorded');

    // The caller may reach only this test's instance; the sub-capability
    // declares the reference instance on 4311.
    expect(cap.policy.allowedOrigins).toEqual([ORIGIN]);
    expect(signon.policy.allowedOrigins).not.toContain(ORIGIN);

    cap.interstitials = [{
      code: 'COMPOSE',
      description: 'runs a capability recorded against another instance',
      when: { type: 'textMatches', value: { mode: 'contains', value: 'MERIDIAN', caseSensitive: false } },
      do: [{ kind: 'run_capability', capability: 'meridian.session.signon', version: '1.0.0', inputs: {} }],
      maxOccurrences: 1,
      restartFlow: false,
      escalateOnFailure: false,
      verified: false,
    }];

    const redactor = new Redactor();
    const runId = newRunId('replay');
    const log = new RunLog(runId, redactor, 'evidence/.test');
    const r = await new ReplayEngine({
      runId, surface, log, redactor,
      // The deployment permits both instances and the sub-capability declares
      // 4311, so the only thing that can refuse is the caller's confinement.
      policy: Policy.from({ allowedOrigins: [ORIGIN, 'http://127.0.0.1:4311'] }),
      credentials: new EnvCredentialProvider(),
      control: new SessionControl(runId),
      allowEscalation: false,
      riskyActions: 'escalate',
      requireApproval: true,
      resolveCapability: (id, v) => findCapability(id, v),
    }).run(cap, { memberId: '12345' });

    // The deployment permits 4311 and the sub-capability declares it; the only
    // thing refusing is the caller's own confinement.
    const events = readFileSync(`${log.dir}/events.jsonl`, 'utf8');
    expect(events).toMatch(/none of which its caller is permitted/);
    expect(r.status).not.toBe('success');
  }, 120_000);
});
