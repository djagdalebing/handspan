import { describe, expect, it } from 'vitest';
import { applyOverlay, setAtPath, toCatalogEntry } from '../src/artifact/store.js';
import { zCapability, zOverlay, type Capability } from '../src/artifact/schema.js';

const base = (): Capability => zCapability.parse({
  schema: 'capability/v1',
  id: 'demo.cap',
  version: '1.0.0',
  name: 'Demo',
  description: 'Look something up.',
  app: { vendor: 'Meridian', product: 'Core' },
  inputs: [{ name: 'memberId', type: 'string', description: 'Member number.', sensitivity: 'pii' }],
  outputs: [{
    name: 'balance', type: 'number', description: 'Balance.',
    source: { from: 'table', whereColumn: 'ACCOUNT TYPE', whereEquals: { value: 'SHARE SAVINGS' }, selectColumn: 'CURRENT BALANCE' },
  }],
  steps: [
    { id: 's00', intent: 'open', action: { kind: 'navigate', url: 'http://a.example/' } },
    {
      id: 's01', intent: 'search',
      action: { kind: 'click', target: { role: 'button', name: 'Search', nameMatch: 'exact' } },
      waitFor: { type: 'nodeExists', target: { role: 'button', name: 'Search', nameMatch: 'exact' } },
    },
  ],
  checkpoint: { type: 'textMatches', value: { value: 'DETAIL' } },
  policy: { allowedOrigins: ['http://a.example'], maxSteps: 20, confirmAtRisk: 'irreversible' },
  provenance: { recordedAt: new Date().toISOString(), recordedBy: 'llm' },
});

const overlay = (patches: unknown[] = [], renames: unknown[] = [], version = '1.0.0') =>
  zOverlay.parse({
    schema: 'overlay/v1',
    base: { id: 'demo.cap', version },
    tenant: 'northgate',
    patches,
    renames,
    approval: 'approved',
  });

describe('tenant overlays', () => {
  it('applies a path patch and records why', () => {
    const r = applyOverlay(base(), overlay([{ path: 'steps[0].action.url', value: 'http://b.example/', reason: 'different host' }]));
    expect(r.capability.steps[0]!.action).toMatchObject({ url: 'http://b.example/' });
    expect(r.applied[0]?.reason).toBe('different host');
  });

  // Inventing a path would silently produce a flow nobody wrote.
  it('rejects a patch whose path does not exist rather than creating it', () => {
    const r = applyOverlay(base(), overlay([{ path: 'steps[9].action.url', value: 'x' }]));
    expect(r.rejected.some((x) => x.path === 'steps[9].action.url' && /does not exist/.test(x.reason))).toBe(true);
    expect(r.capability.steps).toHaveLength(2);
  });

  it('refuses to apply against a base version it was not reviewed against', () => {
    expect(() => applyOverlay(base(), overlay([], [], '2.0.0'))).toThrow(/pins demo.cap@2.0.0/);
  });

  // The reason renames exist: one label change touches more than one site.
  it('renames a control everywhere it is referenced', () => {
    const r = applyOverlay(base(), overlay([], [{ role: 'button', from: 'Search', to: 'Find' }]));
    const step = r.capability.steps[1]!;
    expect((step.action as { target: { name: string } }).target.name).toBe('Find');
    expect((step.waitFor as { target: { name: string } }).target.name).toBe('Find');
    expect(r.applied[0]?.path).toContain('2 sites');
  });

  it('reports a rename that matched nothing instead of passing silently', () => {
    const r = applyOverlay(base(), overlay([], [{ role: 'button', from: 'Absent', to: 'X' }]));
    expect(r.rejected[0]?.reason).toMatch(/does not reference a control/);
  });

  it('stamps the tenant and its lineage onto the result', () => {
    const r = applyOverlay(base(), overlay());
    expect(r.capability.app.tenant).toBe('northgate');
    expect(r.capability.provenance.derivedFrom).toEqual({ id: 'demo.cap', version: '1.0.0' });
  });

  // A specialisation of an unapproved base is not itself approved.
  it('does not let an approved overlay promote an unapproved base', () => {
    const b = base();
    b.approval = 'draft';
    expect(applyOverlay(b, overlay()).capability.approval).toBe('draft');
  });
});

describe('overlay guardrails', () => {
  const registry = { northgate: { label: 'Northgate', origins: ['http://b.example'] } };

  // An overlay is a specialisation, not a privilege escalation.
  it('reverts a step risk a tenant tried to downgrade', () => {
    const b = base();
    b.steps[1]!.risk = 'irreversible';
    const r = applyOverlay(b, overlay([{ path: 'steps[1].risk', value: 'safe' }]), registry);
    expect(r.capability.steps[1]!.risk).toBe('irreversible');
    expect(r.rejected.some((x) => /step risk labels/.test(x.path))).toBe(true);
  });

  /**
   * The regression that matters. Guarding path *spellings* loses to anyone who
   * spells it differently: rewriting the whole of `steps[1]` writes the same
   * value through a path no denylist saw, and that posted a real irreversible
   * transaction. The check has to be on the resolved value.
   */
  it('reverts a risk downgrade smuggled through an ancestor path', () => {
    const b = base();
    b.steps[1]!.risk = 'irreversible';
    const smuggled = { ...JSON.parse(JSON.stringify(b.steps[1])), risk: 'safe' };
    const r = applyOverlay(b, overlay([{ path: 'steps[1]', value: smuggled }]), registry);
    expect(r.capability.steps[1]!.risk).toBe('irreversible');
    expect(r.rejected.some((x) => /step risk labels/.test(x.path))).toBe(true);
  });

  it('reverts a wholesale rewrite of the policy object', () => {
    const r = applyOverlay(
      base(),
      overlay([{ path: 'policy', value: { allowedOrigins: ['http://evil.example'], maxSteps: 999, confirmAtRisk: 'safe' } }]),
      registry
    );
    expect(r.capability.policy.confirmAtRisk).toBe('irreversible');
    expect(r.capability.policy.maxSteps).toBe(20);
    expect(r.capability.policy.allowedOrigins).toEqual(['http://b.example']);
  });

  it('refuses to let a tenant add or remove steps', () => {
    const b = base();
    const extra = JSON.parse(JSON.stringify(b.steps[1]));
    const r = applyOverlay(b, overlay([{ path: 'steps', value: [...b.steps, extra] }]), registry);
    expect(r.capability.steps).toHaveLength(2);
    expect(r.rejected.some((x) => /step sequence/.test(x.path))).toBe(true);
  });

  // Origins are a deployment fact about the tenant, not an overlay assertion.
  it('takes origins from the deployment registry, ignoring what the overlay asked for', () => {
    const r = applyOverlay(
      base(),
      overlay([{ path: 'policy.allowedOrigins', value: ['http://evil.example'] }]),
      registry
    );
    expect(r.capability.policy.allowedOrigins).toEqual(['http://b.example']);
  });

  // Fails closed: an unknown tenant is left able to navigate nowhere, rather
  // than silently inheriting the base's origins.
  it('leaves an unknown tenant with no permitted origins at all', () => {
    const r = applyOverlay(base(), overlay(), {});
    expect(r.capability.policy.allowedOrigins).toEqual([]);
    expect(r.rejected.some((x) => /not in the deployment tenant registry/.test(x.reason))).toBe(true);
  });

  // The one code path that mutates a typed artifact is the last place to skip
  // the schema: an out-of-enum threshold ranks as undefined and opens the gate.
  it('rejects an overlay that would produce an invalid capability', () => {
    expect(() =>
      applyOverlay(base(), overlay([{ path: 'steps[1].timeoutMs', value: 'not-a-number' }]), registry)
    ).toThrow();
  });

  it('still allows the entry point to be repointed', () => {
    const r = applyOverlay(
      base(),
      overlay([{ path: 'steps[0].action.url', value: 'http://b.example/' }]),
      registry
    );
    expect(r.capability.steps[0]!.action).toMatchObject({ url: 'http://b.example/' });
  });
});

describe('setAtPath', () => {
  it('refuses to create missing segments', () => {
    const o = { a: { b: [1] } };
    expect(setAtPath(o as never, 'a.c', 2)).toBe(false);
    expect(setAtPath(o as never, 'a.b[0]', 9)).toBe(true);
    expect(o.a.b[0]).toBe(9);
  });
});

describe('agent-facing catalog', () => {
  it('exposes a typed signature and the outcomes a caller must handle', () => {
    const cap = base();
    cap.outcomes = [{
      code: 'MEMBER_NOT_FOUND', description: 'No such member.', classification: 'business',
      when: { type: 'textMatches', value: { mode: 'contains', value: 'not found', caseSensitive: false } },
      afterSteps: [], terminal: true, outputs: [], verified: true,
    }];
    const e = toCatalogEntry(cap);
    expect(e.inputSchema.required).toEqual(['memberId']);
    expect(e.inputSchema.properties.memberId?.description).toContain('PII');
    expect(e.returns.balance?.type).toBe('number');
    expect(e.outcomes.map((o) => o.code)).toEqual(['MEMBER_NOT_FOUND']);
  });

  // The agent has no business knowing about frames, locators or step order.
  it('does not leak the mechanics of the flow to the caller', () => {
    const json = JSON.stringify(toCatalogEntry(base()));
    expect(json).not.toContain('steps');
    expect(json).not.toContain('nameMatch');
  });
});
