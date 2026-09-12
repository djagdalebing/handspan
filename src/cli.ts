#!/usr/bin/env node
/**
 * Command surface.
 *
 * Five verbs, matching the lifecycle the system is built around:
 *
 *   discover  a model drives the app once and a draft capability falls out
 *   approve   a human promotes that draft to `approved`
 *   replay    the capability runs with no model, against typed inputs
 *   catalog   what an AI agent would see when choosing a capability
 *   invoke    what an AI agent would call
 *   operator  the intervention console, standalone
 *
 * `invoke` and `replay` are the same execution path; they differ only in
 * how the result is printed. Keeping them separate makes the point that the
 * agent-facing contract is the catalog entry, not the artifact.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Policy, type PolicyConfig } from './safety/policy.js';
import { Redactor } from './safety/redact.js';
import { EnvCredentialProvider } from './safety/credentials.js';
import { RunLog, newRunId } from './observability/run-log.js';
import { SessionControl } from './escalation/control.js';
import { broker } from './escalation/broker.js';
import { WebSurface } from './surface/web/playwright-surface.js';
import { TerminalSurface } from './surface/terminal/terminal-surface.js';
import { runDiscovery } from './discovery/agent.js';
import { recordCapability } from './discovery/recorder.js';
import { probeAndVerify, type ProbeCase } from './discovery/probe.js';
import { GeminiProvider } from './llm/gemini.js';
import { ScriptedProvider } from './llm/scripted.js';
import type { ModelProvider } from './llm/provider.js';
import { ReplayEngine } from './replay/engine.js';
import {
  applyOverlay, capabilityPath, findCapability, listCapabilities,
  loadCapabilityFile, loadOverlay, loadTenantRegistry, saveCapability, toCatalogEntry,
} from './artifact/store.js';
import { zParam, type Param } from './artifact/schema.js';
import { describe } from './replay/conditions.js';

// ------------------------------------------------------------ arg parsing --

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  repeated: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, repeated: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out.flags[key] = true; continue; }
    out.flags[key] = next;
    (out.repeated[key] ??= []).push(next);
    i++;
  }
  return out;
}

const str = (a: Args, k: string, d?: string): string => {
  const v = a.flags[k];
  return typeof v === 'string' ? v : d ?? '';
};
const bool = (a: Args, k: string): boolean => a.flags[k] === true || a.flags[k] === 'true';

function kvPairs(values: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf('=');
    if (i < 0) throw new Error(`expected key=value, got "${v}"`);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}

/**
 * Config paths are the *host's*, not the caller's.
 *
 * `--policy` and `--tenants` were ordinary flags, which made two controls
 * caller-supplied: point `--tenants` at a one-line file and a capability
 * recorded against one institution reaches another's instance. Worse, the
 * override check itself loaded the policy from `--policy`, so it asked the
 * attacker's own file for permission. These now come from the environment,
 * where a deployment sets them, and the flags are treated as overrides.
 */
const hostPolicyPath = (): string => process.env.HS_POLICY_FILE ?? 'config/policy.json';
const hostTenantsPath = (): string => process.env.HS_TENANTS_FILE ?? 'config/tenants.json';
const hostCapabilityDir = (): string => process.env.HS_CAPABILITY_DIR ?? 'capabilities';

function loadPolicy(path = hostPolicyPath()): Policy {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PolicyConfig>;
  return Policy.from(raw);
}

// --------------------------------------------------------------- runtime --

interface Runtime {
  surface: WebSurface | TerminalSurface;
  log: RunLog;
  redactor: Redactor;
  control: SessionControl;
  policy: Policy;
  credentials: EnvCredentialProvider;
  runId: string;
  dispose: () => Promise<void>;
}

/**
 * Picks the driver from the location the flow starts at.
 *
 * The scheme is the only thing that decides this, which is the seam working as
 * intended: nothing else in the system needs to know which surface it is on.
 */
async function openSurface(runId: string, entry: string, args: Args): Promise<WebSurface | TerminalSurface> {
  if (entry.startsWith('tn3270://')) {
    const u = new URL(entry);
    return TerminalSurface.connect(runId, { host: u.hostname, port: Number(u.port || 4331) });
  }
  return WebSurface.launch(runId, { headless: !bool(args, 'headed') });
}

async function bootstrap(kind: 'discover' | 'replay', args: Args, entry = 'http://'): Promise<Runtime> {
  const runId = newRunId(kind);
  const redactor = new Redactor();
  const log = new RunLog(runId, redactor);
  const policy = loadPolicy(str(args, 'policy', hostPolicyPath()));
  const credentials = new EnvCredentialProvider();
  const control = new SessionControl(runId);
  const surface = await openSurface(runId, entry, args);

  await broker.start();
  broker.registerSession(runId, {
    control, surface, log, policy,
    observe: () => surface.observe(),
  });

  return {
    surface, log, redactor, control, policy, credentials, runId,
    dispose: async () => {
      broker.unregisterSession(runId);
      await surface.close();
      await broker.stop();
    },
  };
}

// ----------------------------------------------------------- fault inject --

/**
 * Demo scaffolding only: asks the target app to produce a specific runtime
 * condition on the next request. This is how the error-path evidence is
 * produced deterministically. It is not part of the automation surface, and
 * `/__fault` is on the policy deny-list so the agent itself cannot reach it.
 */
async function injectFault(baseUrl: string, fault: string): Promise<void> {
  const res = await fetch(`${baseUrl}/__fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault }),
  });
  if (!res.ok) throw new Error(`fault injection failed: ${res.status}`);
  process.stderr.write(`  [harness] armed fault "${fault}" on ${baseUrl}\n`);
}

// -------------------------------------------------------------- discover --

interface Job {
  id: string;
  version: string;
  name: string;
  description: string;
  goal: string;
  entry: string;
  app: { vendor: string; product: string; productVersion?: string; tenant?: string };
  inputs: unknown[];
  values: Record<string, string>;
  secretFields?: Array<{ nameMatches: string; secretRef: string }>;
  /** Inputs known to produce an unhappy path, used to verify detectors. */
  probes?: ProbeCase[];
}

async function cmdDiscover(args: Args): Promise<number> {
  const job = JSON.parse(readFileSync(str(args, 'job'), 'utf8')) as Job;
  const inputs: Param[] = job.inputs.map((i) => zParam.parse(i));
  const values = { ...job.values, ...kvPairs(args.repeated.param) };

  const provider = makeProvider(args);
  // The surface follows the job's entry point, so discovery works on any
  // surface without the loop, the recorder or the prompts knowing which.
  const rt = await bootstrap('discover', args, job.entry);

  // The goal itself may reference parameters; bind them for readability.
  const goal = job.goal.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => values[k] ?? `{{${k}}}`);
  for (const p of inputs) rt.redactor.register(values[p.name], p.sensitivity, p.name);

  // Discovery is the one phase where a credential can reach the log without
  // passing through the credential provider: the model reads the sign-on hint
  // off the screen and types it as a literal. Registering the configured
  // values up front means that literal is scrubbed wherever it surfaces — the
  // model's decision, the page text, an error message.
  for (const f of job.secretFields ?? []) {
    if (rt.credentials.has(f.secretRef)) {
      rt.redactor.registerSecret(rt.credentials.resolve(f.secretRef), f.secretRef);
    }
  }

  process.stderr.write(`\n  discovery run ${rt.runId}\n  goal: ${goal}\n  model: ${provider.name}\n`);
  process.stderr.write(`  operator console: ${broker.consoleUrl()}\n\n`);

  try {
    const outcome = await runDiscovery({
      runId: rt.runId,
      goal,
      entryUrl: job.entry,
      params: values,
      paramDecls: inputs,
      provider,
      surface: rt.surface,
      policy: rt.policy,
      log: rt.log,
      redactor: rt.redactor,
      control: rt.control,
      maxSteps: Number(str(args, 'max-steps', '18')),
      includeScreenshots: !bool(args, 'no-screenshots'),
      allowEscalation: !bool(args, 'no-escalation'),
      riskyActions: (str(args, 'risky', 'escalate') as 'escalate' | 'block' | 'proceed'),
      capabilityId: `${job.id}@${job.version}`,
    });

    if (!outcome.ok) {
      process.stderr.write(`\n  ✗ discovery did not complete: ${outcome.reason}\n`);
      rt.log.dumpObservation(outcome.finalObs, 'discovery-failed');
      process.stderr.write(`    evidence: ${rt.log.dir}\n`);
      return 1;
    }

    const { capability: draft, warnings } = recordCapability(outcome, {
      id: job.id,
      version: job.version,
      name: job.name,
      description: job.description,
      goal,
      app: job.app,
      inputs,
      paramValues: values,
      entryUrl: job.entry,
      allowedOrigins: rt.policy.config.allowedOrigins,
      model: provider.name,
      runId: rt.runId,
      secretFields: (job.secretFields ?? []).map((s) => ({
        nameMatches: new RegExp(s.nameMatches, 'i'),
        secretRef: s.secretRef,
      })),
    });

    // The model proposed outcome detectors from a single successful run, which
    // means it guessed at wording it has never seen. Replay the flow we just
    // recorded against inputs known to fail, and rebuild those detectors from
    // what the application actually says.
    let capability = draft;
    const probes = bool(args, 'no-probe') ? [] : (job.probes ?? []);
    if (probes.length > 0) {
      process.stderr.write(`\n  probing ${probes.length} unhappy path(s) to verify the proposed detectors...\n`);
      const verified = await probeAndVerify(draft, probes, outcome.finalObs, values, {
        surface: rt.surface, policy: rt.policy, credentials: rt.credentials,
        log: rt.log, redactor: rt.redactor, runId: rt.runId,
      });
      for (const r of verified.results) {
        process.stderr.write(`    ${r.case.code}: ${r.status}${r.alert ? ` — "${r.alert.slice(0, 70)}"` : ''}\n`);
      }
      capability = verified.capability;
      warnings.push(...verified.warnings);
      for (const n of verified.notes) process.stdout.write(`    · ${n}\n`);
      rt.log.event('note', { message: 'probe verification complete', notes: verified.notes, warnings: verified.warnings });
    }

    const path = saveCapability(capability, str(args, 'out', hostCapabilityDir()));
    rt.log.writeJson('capability.json', capability);
    rt.log.event('artifact.written', { path, id: capability.id, version: capability.version, warnings });

    process.stdout.write(`\n  ✓ recorded ${capability.id}@${capability.version} (${capability.steps.length} steps, approval=${capability.approval})\n`);
    process.stdout.write(`    artifact: ${path}\n    evidence: ${rt.log.dir}\n`);
    process.stdout.write(`    success condition: ${describe(capability.checkpoint)}\n`);
    if (capability.outputs.length) {
      process.stdout.write(`    returns: ${capability.outputs.map((o) => `${o.name}: ${o.type}`).join(', ')}\n`);
    }
    if (capability.outcomes.length) {
      process.stdout.write(`    proposed outcomes (for review): ${capability.outcomes.map((o) => o.code).join(', ')}\n`);
    }
    for (const w of warnings) process.stdout.write(`    ! ${w}\n`);
    process.stdout.write(`\n  review it, then: npm run capability -- approve ${capability.id}@${capability.version}\n\n`);
    return 0;
  } finally {
    await rt.dispose();
  }
}

function makeProvider(args: Args): ModelProvider {
  const which = str(args, 'model', 'gemini');
  if (which === 'scripted') {
    const path = str(args, 'script');
    if (!path) throw new Error('--model scripted requires --script <responses.json>');
    return new ScriptedProvider(JSON.parse(readFileSync(path, 'utf8')) as unknown[]);
  }
  return GeminiProvider.fromEnv();
}

// ---------------------------------------------------------------- replay --

/**
 * Refuses caller-supplied flags that would weaken a guardrail, unless the
 * *deployment* has opted in. `invoke` is the agent-facing entry point and
 * never accepts them at all.
 */
function checkOverrides(args: Args, policy: Policy, mode: 'replay' | 'invoke'): void {
  // Two different questions, and conflating them broke the legitimate case.
  //
  // An overlay is how a tenant *runs* — an operator supplying one is normal
  // operation, not a weakening. But a calling agent supplying one is a
  // different matter entirely: an overlay can rewrite the checkpoint, so an
  // agent that may pass `--overlay` can declare its own definition of success.
  // So `--overlay` is refused for `invoke` and unremarkable for `replay`.
  const weakening = [
    bool(args, 'risky') || str(args, 'risky') === 'proceed' ? '--risky proceed' : null,
    bool(args, 'allow-draft') ? '--allow-draft' : null,
    // Redirecting where policy, tenants or capabilities are read from replaces
    // the rules rather than bending them.
    str(args, 'policy') ? '--policy' : null,
    str(args, 'tenants') ? '--tenants' : null,
    str(args, 'dir') ? '--dir' : null,
  ].filter(Boolean) as string[];

  const agentForbidden = [...weakening, str(args, 'overlay') ? '--overlay' : null]
    .filter(Boolean) as string[];

  if (mode === 'invoke' && agentForbidden.length > 0) {
    throw new Error(
      `${agentForbidden.join(' and ')} cannot be used with "invoke": a calling agent does not get ` +
      `to supply the rules it is judged by. Use "replay" from an operator shell.`
    );
  }
  if (weakening.length > 0 && !policy.config.allowCallerOverrides) {
    throw new Error(
      `${weakening.join(' and ')} is refused: this deployment sets allowCallerOverrides=false in ` +
      `config/policy.json. Change the deployment policy deliberately if an operator really needs it.`
    );
  }
}

async function cmdReplay(args: Args, mode: 'replay' | 'invoke'): Promise<number> {
  const ref = args._[1] ?? str(args, 'capability');
  if (!ref) throw new Error(`usage: ${mode} <capabilityId[@version]> --input k=v ...`);
  const [id, version] = ref.split('@');

  // Before anything else. An earlier version applied the overlay first and
  // then asked whether overlays were allowed, which is not a gate, it is a
  // post-mortem.
  checkOverrides(args, loadPolicy(hostPolicyPath()), mode);

  let capability = findCapability(id!, version, str(args, 'dir', hostCapabilityDir()));
  if (!capability) throw new Error(`no capability "${ref}" found`);

  const overlayPath = str(args, 'overlay');
  if (overlayPath) {
    const overlay = loadOverlay(overlayPath);
    const applied = applyOverlay(capability, overlay, loadTenantRegistry(str(args, 'tenants', hostTenantsPath())));
    capability = applied.capability;
    process.stderr.write(
      `  [overlay] tenant ${overlay.tenant}: ${applied.applied.length} patch(es) applied` +
      `${applied.rejected.length ? `, ${applied.rejected.length} REJECTED` : ''}\n`
    );
    for (const a of applied.applied) process.stderr.write(`    ~ ${a.path}${a.reason ? ` — ${a.reason}` : ''}\n`);
    for (const r of applied.rejected) process.stderr.write(`    ✗ ${r.path} — ${r.reason}\n`);
  }

  const inputs = kvPairs(args.repeated.input);

  const entryStep = capability.steps.find((x) => x.action.kind === 'navigate');
  const entry = entryStep && entryStep.action.kind === 'navigate' ? entryStep.action.url : 'http://';
  const rt = await bootstrap('replay', args, entry);

  const fault = str(args, 'fault');
  if (fault) await injectFault(str(args, 'app-url', 'http://127.0.0.1:4311'), fault);

  process.stderr.write(`\n  replay run ${rt.runId}\n  capability: ${capability.id}@${capability.version}\n`);
  process.stderr.write(`  operator console: ${broker.consoleUrl()}\n\n`);

  try {
    const engine = new ReplayEngine({
      runId: rt.runId,
      surface: rt.surface,
      policy: rt.policy,
      credentials: rt.credentials,
      log: rt.log,
      redactor: rt.redactor,
      control: rt.control,
      allowEscalation: !bool(args, 'no-escalation'),
      riskyActions: (str(args, 'risky', 'escalate') as 'escalate' | 'block' | 'proceed'),
      requireApproval: !bool(args, 'allow-draft'),
      resolveCapability: (cid, ver) => findCapability(cid, ver, str(args, 'dir', hostCapabilityDir())),
    });

    const result = await engine.run(capability, inputs);
    rt.log.writeJson('result.json', result);

    // An operator's terminal should show the real values — that is the point of
    // running the capability. But stdout gets piped into log aggregators and
    // evidence files, which outlive the run and travel, so a deployment can ask
    // for it to be redacted on the way out.
    const shown = process.env.HS_REDACT_STDOUT ? rt.redactor.value(result) : result;

    if (mode === 'invoke') {
      // What an agent gets back: the contract, nothing else.
      process.stdout.write(JSON.stringify(agentView(shown), null, 2) + '\n');
    } else {
      printResult(shown);
    }
    return result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
  } finally {
    await rt.dispose();
  }
}

function agentView(r: Awaited<ReturnType<ReplayEngine['run']>>): Record<string, unknown> {
  switch (r.status) {
    case 'success': return { status: r.status, outputs: r.outputs };
    case 'business_outcome': return { status: r.status, code: r.code, message: r.message, outputs: r.outputs };
    case 'needs_human': return { status: r.status, escalationId: r.escalationId, reason: r.reason };
    case 'failure': return { status: r.status, failure: r.failure };
  }
}

function printResult(r: Awaited<ReturnType<ReplayEngine['run']>>): void {
  const mark = { success: '✓', business_outcome: '•', needs_human: '⚠', failure: '✗' }[r.status];
  process.stdout.write(`\n  ${mark} ${r.status.toUpperCase()}  (${r.stepsExecuted} steps, ${r.durationMs}ms)\n`);

  if (r.status === 'success') {
    for (const [k, v] of Object.entries(r.outputs)) process.stdout.write(`    ${k} = ${JSON.stringify(v)}\n`);
  }
  if (r.status === 'business_outcome') {
    process.stdout.write(`    code: ${r.code}\n    ${r.message}\n`);
  }
  if (r.status === 'failure') {
    process.stdout.write(`    class:    ${r.failure.class}\n`);
    if (r.failure.stepId) process.stdout.write(`    step:     ${r.failure.stepId}\n`);
    process.stdout.write(`    expected: ${r.failure.expected}\n`);
    process.stdout.write(`    observed: ${r.failure.observed}\n`);
    if (r.failure.detail) process.stdout.write(`    detail:   ${r.failure.detail}\n`);
    if (r.failure.evidence.length) process.stdout.write(`    evidence: ${r.failure.evidence.join(', ')}\n`);
  }
  if (r.status === 'needs_human') {
    process.stdout.write(`    escalation: ${r.escalationId}\n    ${r.reason}\n`);
  }
  if (r.recoveries.length) {
    process.stdout.write(`    recovered: ${r.recoveries.map((x) => `${x.code}×${x.occurrences}`).join(', ')}\n`);
  }
  const d = r.drift;
  if (d.changedSteps.length || d.relaxedTargets.length || d.frameMismatches.length) {
    process.stdout.write(`    drift:    screen changed at [${d.changedSteps.join(', ') || '-'}]`);
    process.stdout.write(`, relaxed match at [${d.relaxedTargets.join(', ') || '-'}]`);
    process.stdout.write(`, frame moved at [${d.frameMismatches.join(', ') || '-'}]\n`);
  }
  process.stdout.write(`    evidence: ${r.evidenceDir}\n\n`);
}

// --------------------------------------------------------------- catalog --

function cmdCatalog(args: Args): number {
  const caps = listCapabilities(str(args, 'dir', hostCapabilityDir()));
  if (bool(args, 'json')) {
    process.stdout.write(JSON.stringify(caps.map(toCatalogEntry), null, 2) + '\n');
    return 0;
  }
  if (caps.length === 0) {
    process.stdout.write('  no capabilities recorded yet\n');
    return 0;
  }
  for (const c of caps) {
    const e = toCatalogEntry(c);
    process.stdout.write(`\n  ${e.name}@${e.version}  [${e.approval}, risk=${e.risk}]\n`);
    process.stdout.write(`    ${e.description}\n`);
    process.stdout.write(`    app:     ${e.app.vendor} / ${e.app.product}${e.app.tenant ? ` / ${e.app.tenant}` : ''}\n`);
    const args_ = Object.entries(e.inputSchema.properties)
      .map(([k, v]) => `${k}: ${v.type}${e.inputSchema.required.includes(k) ? '' : '?'}`);
    process.stdout.write(`    args:    (${args_.join(', ')})\n`);
    const rets = Object.entries(e.returns).map(([k, v]) => `${k}: ${v.type}`);
    process.stdout.write(`    returns: {${rets.join(', ')}}\n`);
    if (e.outcomes.length) {
      process.stdout.write(`    outcomes the caller must handle: ${e.outcomes.map((o) => o.code).join(', ')}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}

// ------------------------------------------------------------- approval ---

function cmdCapability(args: Args): number {
  const sub = args._[1];
  const dir = str(args, 'dir', hostCapabilityDir());
  if (sub !== 'approve') throw new Error('usage: capability approve <id@version>');
  const ref = args._[2];
  if (!ref) throw new Error('usage: capability approve <id@version>');
  const [id, version] = ref.split('@');
  const cap = findCapability(id!, version, dir);
  if (!cap) throw new Error(`no capability "${ref}"`);

  cap.approval = 'approved';
  const path = capabilityPath(cap, dir);
  writeFileSync(path, JSON.stringify(cap, null, 2) + '\n');
  process.stdout.write(`  ✓ ${cap.id}@${cap.version} approved for unattended replay\n    ${path}\n`);
  return 0;
}

// ------------------------------------------------------------- operator ---

async function cmdOperator(): Promise<number> {
  await broker.start();
  const port = process.env.HS_OPERATOR_PORT ?? 4312;
  process.stdout.write(`  operator console on http://127.0.0.1:${port}/\n  (interventions appear here while a run is in progress)\n`);
  await new Promise(() => {});
  return 0;
}

// ------------------------------------------------------------------ main --

const USAGE = `
handspan — record-once / replay-many automation for legacy back-office apps

  discover   --job <job.json> [--model gemini|scripted] [--script f.json]
             [--param k=v] [--max-steps N] [--headed] [--risky escalate|proceed|block]
  capability approve <id@version>
  replay     <id[@version]> [--input k=v] [--overlay f.json] [--fault F]
             [--allow-draft] [--risky ...] [--headed] [--no-escalation]
  invoke     <id[@version]> [--input k=v]        (agent-facing JSON result)
  catalog    [--json]
  operator
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'discover': return cmdDiscover(args);
    case 'replay': return cmdReplay(args, 'replay');
    case 'invoke': return cmdReplay(args, 'invoke');
    case 'catalog': return cmdCatalog(args);
    case 'capability': return cmdCapability(args);
    case 'operator': return cmdOperator();
    default:
      process.stdout.write(USAGE);
      return cmd ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`\n  error: ${e instanceof Error ? e.message : String(e)}\n\n`);
    process.exit(1);
  });
