import { describe, expect, it } from 'vitest';
import { denyLocation, Policy } from '../src/safety/policy.js';
import { Redactor, looksSensitive } from '../src/safety/redact.js';
import { EnvCredentialProvider } from '../src/safety/credentials.js';

const policy = Policy.from({
  allowedOrigins: ['http://127.0.0.1:4311'],
  deniedPathPrefixes: ['/__fault'],
  allowedActions: ['navigate', 'click', 'type'],
  confirmAtRisk: 'irreversible',
});

describe('allowlist', () => {
  it('permits an allowed origin', () => {
    expect(policy.checkUrl('http://127.0.0.1:4311/app/home').decision).toBe('allow');
  });
  it('denies any other origin, including a different port on the same host', () => {
    expect(policy.checkUrl('http://127.0.0.1:9999/app/home').decision).toBe('deny');
    expect(policy.checkUrl('https://evil.example/x').decision).toBe('deny');
  });
  it('denies non-http schemes', () => {
    expect(policy.checkUrl('file:///etc/passwd').decision).toBe('deny');
    expect(policy.checkUrl('javascript:alert(1)').decision).toBe('deny');
  });
  it('denies an explicitly denied path even on an allowed origin', () => {
    expect(policy.checkUrl('http://127.0.0.1:4311/__fault').decision).toBe('deny');
  });
  it('denies action kinds outside the permitted set', () => {
    expect(policy.checkActionKind('select').decision).toBe('deny');
    expect(policy.checkActionKind('click').decision).toBe('allow');
  });
});

describe('risk', () => {
  it('gates irreversible steps for human confirmation', () => {
    expect(policy.checkRisk('irreversible', 'step').decision).toBe('confirm');
    expect(policy.checkRisk('mutating', 'step').decision).toBe('allow');
  });
  it('classifies commit-shaped labels conservatively', () => {
    expect(Policy.classify('click', 'Post Account')).toBe('irreversible');
    expect(Policy.classify('click', 'Transfer Funds')).toBe('irreversible');
    expect(Policy.classify('click', 'Save Draft')).toBe('mutating');
    expect(Policy.classify('click', 'Search')).toBe('safe');
  });
  it('never treats typing as risky — nothing commits until submission', () => {
    expect(Policy.classify('type', 'Post Account')).toBe('safe');
  });
});

describe('redaction', () => {
  it('removes a secret entirely, leaving only its reference name', () => {
    const r = new Redactor();
    r.registerSecret('hunter2', 'MERIDIAN_OPERATOR_PASSWORD');
    expect(r.string('signing on with hunter2')).toBe('signing on with «secret:MERIDIAN_OPERATOR_PASSWORD»');
  });

  // A stable pseudonym keeps a run traceable without holding the identifier.
  it('pseudonymises PII stably so a run stays debuggable', () => {
    const r = new Redactor();
    r.register('12345', 'pii', 'memberId');
    const a = r.string('looked up 12345');
    const b = r.string('detail for 12345');
    expect(a).not.toContain('12345');
    expect(a.match(/«memberId#\w+»/)?.[0]).toBe(b.match(/«memberId#\w+»/)?.[0]);
  });

  it('redacts sensitive-looking keys anywhere in a structure', () => {
    const r = new Redactor();
    expect(r.value({ nested: { password: 'p', ok: 'fine' } })).toEqual({ nested: { password: '«redacted»', ok: 'fine' } });
  });

  it('catches an SSN the application put on screen that we were never told about', () => {
    const r = new Redactor();
    expect(r.string('SSN 123-45-6789 on file')).toMatch(/«ssn#\w+»/);
  });

  // The balance is the thing we are usually trying to read; shredding it
  // would make the backstop worse than useless.
  it('does not mistake a currency amount for a card number', () => {
    const r = new Redactor();
    expect(r.string('balance is 4,812.55 today')).toContain('4,812.55');
  });

  it('replaces the longest registered value first', () => {
    const r = new Redactor();
    r.register('1234567', 'pii', 'account');
    r.register('12345', 'pii', 'member');
    expect(r.string('acct 1234567')).toMatch(/«account#\w+»$/);
  });
});

describe('caller-supplied overrides', () => {
  // The premise is that an *agent* invokes capabilities, so the caller is the
  // untrusted side. An override supplied by the party the gate constrains is
  // not an override, it is an off switch.
  it('defaults to refusing caller overrides', () => {
    expect(Policy.from({}).config.allowCallerOverrides).toBe(false);
  });

  it('only enables them when the deployment says so', () => {
    expect(Policy.from({ allowCallerOverrides: true }).config.allowCallerOverrides).toBe(true);
  });
});

describe('sensitive field labels', () => {
  // A member's name is customer NPI. The list missed it, so `memberName`
  // shipped classified `internal` and was written to disk in clear.
  it.each(['Member Name', 'memberName', 'Home Address', 'Date of Birth', 'Phone', 'Email', 'SSN (last 4)'])(
    'treats %s as regulated',
    (label) => {
      expect(looksSensitive(label)).toBe(true);
    }
  );

  it('does not sweep up ordinary business fields', () => {
    for (const label of ['Status', 'Home Branch', 'Account Type', 'Current Balance']) {
      expect(looksSensitive(label)).toBe(false);
    }
  });
});

describe('credentials', () => {
  it('refuses to continue when a credential is missing rather than guessing', () => {
    const p = new EnvCredentialProvider('HS_TEST_SECRET_');
    expect(() => p.resolve('NOPE')).toThrow(/not available/);
  });
  it('resolves from the configured namespace', () => {
    process.env.HS_TEST_SECRET_MY_KEY = 'v';
    expect(new EnvCredentialProvider('HS_TEST_SECRET_').resolve('my-key')).toBe('v');
  });
});

describe('redaction of system identifiers', () => {
  // Every shipped result.json once pointed at a directory that did not exist:
  // a run id like `replay-20260911-190755-dsw9` contains a 14-digit run, so
  // the card-number pattern devoured it.
  it('leaves run ids and evidence paths intact', () => {
    const r = new Redactor();
    const out = r.value({
      runId: 'replay-20260911-190755-dsw9',
      evidenceDir: 'evidence/replay-20260911-190755-dsw9',
      stepId: 's05',
    });
    expect(out).toEqual({
      runId: 'replay-20260911-190755-dsw9',
      evidenceDir: 'evidence/replay-20260911-190755-dsw9',
      stepId: 's05',
    });
  });

  it('still scrubs a registered secret out of a preserved field', () => {
    const r = new Redactor();
    r.registerSecret('hunter2', 'PWD');
    expect((r.value({ runId: 'run-hunter2-1' }) as { runId: string }).runId)
      .toBe('run-«secret:PWD»-1');
  });

  // An unsalted hash of a five-digit member id is 100,000 candidates: an
  // encoding, not a pseudonym.
  it('salts pseudonyms so they cannot be enumerated back', () => {
    const a = new Redactor();
    const b = new Redactor();
    a.register('12345', 'pii', 'memberId');
    b.register('12345', 'pii', 'memberId');
    const ta = a.string('member 12345');
    const tb = b.string('member 12345');
    expect(ta).not.toContain('12345');
    expect(ta).not.toBe(tb);                       // different salt per process
    expect(ta).toBe(a.string('member 12345'));     // stable within one run
  });

  it('exposes declared PII literals so screenshots can mask them', () => {
    const r = new Redactor();
    r.register('12345', 'pii', 'memberId');
    r.registerSecret('hunter2', 'PWD');
    expect(r.piiLiterals()).toEqual(['12345']);    // secrets are never handed to the page
  });
});

describe('action kinds', () => {
  /**
   * `type_secret` fills a credential field without the value passing through
   * the model. Omitting it from the allowlist silently broke live discovery:
   * every attempt was denied and the run looped until stuck detection fired.
   */
  it('permits type_secret, which is narrower than type rather than wider', () => {
    expect(Policy.from({}).checkActionKind('type_secret').decision).toBe('allow');
    expect(Policy.from({}).checkActionKind('type').decision).toBe('allow');
  });

  it('still refuses an action kind nobody declared', () => {
    expect(Policy.from({}).checkActionKind('execute_script').decision).toBe('deny');
  });
});

describe('location authorisation', () => {
  const policy = Policy.from({
    allowedOrigins: ['http://a.example', 'http://b.example'],
    allowedSchemes: ['http'],
  });

  /**
   * One deployment serving many institutions lists every tenant's origin, so
   * the deployment allowlist alone does not isolate them. The capability's own
   * declared origins are the second half — and the operator console used to
   * check only the first, so anything holding the console token could steer a
   * live session into another institution.
   */
  it('requires both the deployment allowlist and the capability origins', () => {
    expect(denyLocation(policy, ['http://a.example'], 'http://a.example/x')).toBeNull();
    expect(denyLocation(policy, ['http://a.example'], 'http://b.example/x'))
      .toMatch(/outside the origins this capability declares/);
    expect(denyLocation(policy, ['http://c.example'], 'http://c.example/x'))
      .toMatch(/not on the allowlist/);
  });

  it('fails closed when a capability declares no origins', () => {
    expect(denyLocation(policy, [], 'http://a.example/x')).toMatch(/declares no permitted origins/);
  });
});

describe('value-level regulated-data backstop', () => {
  /**
   * Classification keys off a field's label, which has a blind spot: a text
   * extractor has no label. An overlay repointing an output at a raw pattern
   * pulled an account number onto disk in clear past a label-only check.
   */
  it('recognises regulated-looking values with no label to go on', () => {
    const r = new Redactor();
    expect(r.looksRegulatedValue('123-45-6789')).toBe(true);
    expect(r.looksRegulatedValue('4111 1111 1111 1111')).toBe(true);
  });

  // The balance is the thing these capabilities exist to read.
  it('does not flag ordinary business values', () => {
    const r = new Redactor();
    for (const v of ['4,812.55', 'ACTIVE', 'SHARE SAVINGS', 'EASTGATE 004']) {
      expect(r.looksRegulatedValue(v)).toBe(false);
    }
  });
});
