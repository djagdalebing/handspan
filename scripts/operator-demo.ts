/**
 * A mock operator.
 *
 * This is the one thing in the system that is deliberately stood in for: a
 * real deployment has a person looking at the console in a browser. This
 * script does exactly what that person does, through exactly the same HTTP
 * endpoints — poll the queue, claim the lease, drive the live session,
 * release with a disposition. Nothing about the control-transfer mechanism is
 * mocked; only the human is.
 *
 * Two behaviours, selected by flag:
 *
 *   --approve   the operator reviews the pending irreversible step and hands
 *               control back with "resume", letting the automation post it.
 *   --takeover  the operator performs the step themselves by clicking in the
 *               live session, then releases with "complete", which tells the
 *               engine to verify the checkpoint and extract outputs rather
 *               than replaying steps over a screen that has moved on.
 *
 * The click coordinates come from the observation dump captured when the
 * intervention was raised — the same information a human reads off the
 * screenshot in the console.
 */
const BASE = `http://127.0.0.1:${process.env.HS_OPERATOR_PORT ?? 4312}`;
const OPERATOR = process.env.HS_OPERATOR_NAME ?? 'operator-1';

interface Intervention {
  id: string;
  state: string;
  reason: string;
  summary: string;
  stepId?: string;
  runId: string;
  evidenceDir?: string;
  context: { url: string; observationDump?: string; expected?: string; observed?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} on ${path}`);
  return body;
}

async function waitForIntervention(timeoutMs: number): Promise<Intervention> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await api<Intervention[]>('/api/interventions').catch(() => []);
    const open = list.find((i) => i.state === 'open');
    if (open) return open;
    if (Date.now() >= deadline) throw new Error('no intervention appeared within the timeout');
    await sleep(400);
  }
}

interface OperatorAction {
  kind: 'click' | 'text' | 'key' | 'navigate';
  /** For click: the control to click, by role and accessible name. */
  role?: string;
  name?: string;
  text?: string;
  key?: string;
  url?: string;
}

interface ControlList {
  url: string;
  nodes: Array<{ role: string; name: string; bounds: { x: number; y: number; w: number; h: number } }>;
}

/**
 * Locates a control in the *current* live screen, then returns its centre.
 * A human reads this off the screenshot; the console exposes the same
 * information as a list because on these screens the label next to a field is
 * often the only thing that identifies it.
 */
async function locate(id: string, role: string, name: string): Promise<{ x: number; y: number }> {
  const list = await api<ControlList>(`/i/${id}/controls`);
  const hit = list.nodes.find((n) => n.role === role && n.name === name);
  if (!hit) {
    throw new Error(
      `no ${role} named "${name}" on screen at ${list.url}; ` +
      `visible: ${list.nodes.map((n) => `${n.role} "${n.name}"`).slice(0, 12).join(', ')}`
    );
  }
  return { x: hit.bounds.x + hit.bounds.w / 2, y: hit.bounds.y + hit.bounds.h / 2 };
}

async function perform(id: string, a: OperatorAction): Promise<void> {
  if (a.kind === 'click') {
    const at = await locate(id, a.role ?? 'button', a.name ?? '');
    process.stdout.write(`  [operator] click "${a.name}" at (${Math.round(at.x)}, ${Math.round(at.y)})\n`);
    await api(`/i/${id}/input`, { method: 'POST', body: JSON.stringify({ kind: 'click', ...at }) });
  } else if (a.kind === 'text') {
    process.stdout.write(`  [operator] type ${String(a.text ?? '').length} characters into the focused field\n`);
    await api(`/i/${id}/input`, { method: 'POST', body: JSON.stringify({ kind: 'text', text: a.text ?? '' }) });
  } else if (a.kind === 'key') {
    process.stdout.write(`  [operator] press ${a.key}\n`);
    await api(`/i/${id}/input`, { method: 'POST', body: JSON.stringify({ kind: 'key', key: a.key }) });
  } else {
    process.stdout.write(`  [operator] navigate ${a.url}\n`);
    await api(`/i/${id}/input`, { method: 'POST', body: JSON.stringify({ kind: 'navigate', url: a.url }) });
  }
  await sleep(500);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const disposition =
    (flag('--disposition') as 'resume' | 'complete' | 'abort' | undefined) ??
    (argv.includes('--takeover') ? 'complete' : 'resume');
  const note = flag('--note') ?? 'reviewed by operator';
  const actions: OperatorAction[] = argv.includes('--takeover') && !flag('--actions')
    ? [{ kind: 'click', role: 'button', name: 'Post Account' }]
    : JSON.parse(flag('--actions') ?? '[]');

  process.stdout.write(`  [operator] watching ${BASE} (will release with "${disposition}")\n`);
  const i = await waitForIntervention(120_000);

  process.stdout.write(`  [operator] picked up ${i.id}\n`);
  process.stdout.write(`             reason:   ${i.reason}\n`);
  process.stdout.write(`             summary:  ${i.summary}\n`);
  if (i.context.expected) process.stdout.write(`             expected: ${i.context.expected}\n`);
  if (i.context.observed) process.stdout.write(`             observed: ${i.context.observed}\n`);
  process.stdout.write(`             at:       ${i.context.url}\n`);

  await api(`/i/${i.id}/claim`, { method: 'POST', body: JSON.stringify({ operator: OPERATOR }) });
  process.stdout.write(`  [operator] claimed control of the live session\n`);

  for (const a of actions) await perform(i.id, a);

  await api(`/i/${i.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ disposition, note }),
  });
  process.stdout.write(`  [operator] released control: ${disposition}\n`);
}

main().catch((e) => {
  process.stderr.write(`  [operator] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
