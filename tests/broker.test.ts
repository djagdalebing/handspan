/**
 * Authorization on the operator console.
 *
 * `resolve` is the endpoint that authorises an irreversible step. It had no
 * lease check and no identity check, so a bare POST from anything that could
 * reach the port approved a posting, attributed to a default string. These
 * tests exist so that cannot come back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { RunLog } from '../src/observability/run-log.js';
import { SessionControl } from '../src/escalation/control.js';
import type { Observation, Surface } from '../src/surface/types.js';

process.env.HS_OPERATOR_PORT = '4388';
const BASE = 'http://127.0.0.1:4388';
const RUN = 'replay-test-broker';

const observation: Observation = {
  url: 'http://127.0.0.1:4311/desk', title: 'desk', nodes: [], text: '', at: new Date().toISOString(),
};

const surface: Surface = {
  id: 'fake',
  observe: async () => observation,
  act: async () => ({ ok: true }),
  screenshot: async () => Buffer.from('png'),
  location: async () => observation.url,
  close: async () => {},
};

let broker: typeof import('../src/escalation/broker.js')['broker'];
let control: SessionControl;

const post = (path: string, body: unknown) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  ({ broker } = await import('../src/escalation/broker.js'));
  control = new SessionControl(RUN);
  const redactor = new Redactor();
  broker.registerSession(RUN, {
    control,
    surface,
    log: new RunLog(RUN, redactor, 'evidence/.test'),
    policy: Policy.from({ allowedOrigins: ['http://127.0.0.1:4311'] }),
    observe: async () => observation,
  });
  await broker.start();
});

afterAll(async () => {
  broker.unregisterSession(RUN);
  await broker.stop();
});

async function raise() {
  const pending = broker.raise({
    runId: RUN, mode: 'replay', capabilityId: 'demo.cap@1.0.0', goal: 'g',
    reason: 'RISKY_ACTION_CONFIRMATION', summary: 'post an irreversible transaction',
    timeoutMs: 4_000,
  });
  await new Promise((r) => setTimeout(r, 80));
  const open = broker.list().find((i) => i.state === 'open')!;
  return { pending, id: open.id };
}

describe('operator console authorization', () => {
  it('refuses to approve an intervention nobody has claimed', async () => {
    const { pending, id } = await raise();
    const res = await post(`/i/${id}/resolve`, { disposition: 'resume', note: 'approved by nobody' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/claim it as yourself/);
    // The automation is still waiting; nothing was authorised.
    expect(control.canAutomate()).toBe(false);
    const { signal } = await pending;             // times out rather than proceeding
    expect(signal).toBeNull();
  });

  it('refuses a claim that does not name an operator', async () => {
    const { pending, id } = await raise();
    expect((await post(`/i/${id}/claim`, {})).status).toBe(400);
    await pending;
  });

  // Authorizing against the stored holder rather than the caller let anyone
  // drive the session as whoever had claimed it.
  it('refuses input from someone who is not the operator holding the lease', async () => {
    const { pending, id } = await raise();
    expect((await post(`/i/${id}/claim`, { operator: 'alice' })).status).toBe(200);

    const asMallory = await post(`/i/${id}/input`, { operator: 'mallory', kind: 'key', key: 'Enter' });
    expect(asMallory.status).toBe(409);

    const anonymous = await post(`/i/${id}/input`, { kind: 'key', key: 'Enter' });
    expect(anonymous.status).toBe(409);

    expect((await post(`/i/${id}/input`, { operator: 'alice', kind: 'key', key: 'Enter' })).status).toBe(200);
    await post(`/i/${id}/resolve`, { operator: 'alice', disposition: 'abort', note: 'done' });
    await pending;
  });

  it('refuses a resolve from someone other than the holder', async () => {
    const { pending, id } = await raise();
    await post(`/i/${id}/claim`, { operator: 'alice' });
    expect((await post(`/i/${id}/resolve`, { operator: 'mallory', disposition: 'resume' })).status).toBe(409);
    expect((await post(`/i/${id}/resolve`, { operator: 'alice', disposition: 'resume' })).status).toBe(200);
    const { signal } = await pending;
    expect(signal?.operator).toBe('alice');
  });

  it('records the human actions against the operator who performed them', async () => {
    const { pending, id } = await raise();
    await post(`/i/${id}/claim`, { operator: 'alice' });
    await post(`/i/${id}/input`, { operator: 'alice', kind: 'text', text: 'hunter2' });
    await post(`/i/${id}/resolve`, { operator: 'alice', disposition: 'resume', note: 'typed it' });
    await pending;
    const i = broker.get(id)!;
    expect(i.operator).toBe('alice');
    // Typed content is never recorded, only its length.
    expect(i.humanActions.map((a) => a.detail)).toEqual(['7 chars']);
  });
});
