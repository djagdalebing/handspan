/**
 * Prompts and response schemas for discovery.
 *
 * Two things shape these more than anything else:
 *
 * 1. **The model gets the same view the replay engine gets.** It chooses from
 *    the normalized control list, by `ref`. It never writes a selector, never
 *    sees HTML, and never picks raw coordinates. That is what makes the run
 *    recordable: every decision it makes is already expressed in the
 *    vocabulary the artifact stores. A model that emitted CSS would produce a
 *    transcript we would then have to reverse-engineer into a flow.
 *
 * 2. **Response schemas are flat.** An action enum plus optional fields,
 *    validated on our side. Nested unions are where structured output gets
 *    unreliable, and a malformed decision here costs a whole run.
 *
 * The screenshot is supplied alongside the control list rather than instead
 * of it. The list is what the model acts on; the image is what disambiguates
 * layout, adjacency and "which of these three identical buttons is the one
 * next to the balance" — the things a flat list genuinely loses.
 */
import type { Observation, UiNode } from '../surface/types.js';

export const SYSTEM_PROMPT = `You are operating a legacy back-office banking application on behalf of an
operator, through a normalized control interface.

Each turn you receive:
  - the goal,
  - the parameter values you have been given,
  - a list of the controls currently on screen, each with a [ref],
  - the visible text of the screen,
  - usually a screenshot.

You reply with exactly ONE action. Rules:

  - Act only on controls in the list, addressed by their [ref]. Never invent a
    ref, a selector, or screen coordinates.
  - Prefer the control whose label a human operator would read as the right
    one. These screens are table-based and visually dense; the label matters
    more than the position.
  - When you type a value that came from the supplied parameters, set
    "parameterName" to that parameter's name. This is how the recorded flow
    becomes reusable for other values instead of being hard-coded to this one.
  - You are never shown credentials. To fill a sign-on field, use the action
    "type_secret" and set "secretRef" to one of the CREDENTIALS AVAILABLE
    names; the value is fetched and typed without passing through you, and the
    recorded step stores the reference rather than the secret. Do not look for
    a password on the screen and do not invent one.
  - Take the shortest safe path to the goal. Do not explore, do not verify by
    navigating away and back, do not click things to see what they do.
  - Actions that post, submit, transfer, delete or otherwise commit something
    are gated: a human will be asked to approve them. Choose them only when
    the goal actually requires them, and say so in "intent".
  - When the goal is achieved and the screen shows the result, reply with
    action "finish".
  - If you are stuck, looping, or the screen is not one you can make sense of,
    reply with action "escalate" and explain what a human needs to do. This is
    a legitimate outcome, not a failure — a wrong click on a banking screen is
    far more expensive than asking.

"intent" must describe the step the way it would read in a reviewed
procedure, e.g. "Enter the member number into the inquiry form", not
"click ref n1_4".`;

/** Gemini's schema dialect uses the proto enum names, hence upper case. */
export const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    screen: { type: 'STRING', description: 'One sentence naming the screen you are on.' },
    reasoning: { type: 'STRING', description: 'Why this action, briefly.' },
    action: {
      type: 'STRING',
      enum: ['click', 'type', 'type_secret', 'select', 'navigate', 'press', 'wait', 'finish', 'escalate'],
    },
    intent: { type: 'STRING', description: 'Reviewable description of this step.' },
    ref: { type: 'STRING', description: 'Control ref, for click/type/select.' },
    text: { type: 'STRING', description: 'Text to type.' },
    secretRef: { type: 'STRING', description: 'Credential name, for type_secret.' },
    parameterName: { type: 'STRING', description: 'Parameter this text came from, if any.' },
    option: { type: 'STRING', description: 'Option label, for select.' },
    url: { type: 'STRING', description: 'Absolute URL, for navigate.' },
    key: { type: 'STRING', description: 'Key name, for press.' },
    ms: { type: 'INTEGER', description: 'Milliseconds, for wait.' },
    message: { type: 'STRING', description: 'For finish or escalate: what happened / what is needed.' },
  },
  required: ['screen', 'reasoning', 'action', 'intent'],
};

export interface Decision {
  screen: string;
  reasoning: string;
  action: 'click' | 'type' | 'type_secret' | 'select' | 'navigate' | 'press' | 'wait' | 'finish' | 'escalate';
  intent: string;
  ref?: string;
  text?: string;
  secretRef?: string;
  parameterName?: string;
  option?: string;
  url?: string;
  key?: string;
  ms?: number;
  message?: string;
}

export const SUMMARY_SYSTEM = `You have just completed a task in a legacy banking application. You will be
shown the goal, the steps that were taken, and the final screen.

Produce the *contract* for turning this into a reusable capability:

  - successMarker: a distinctive phrase on the final screen that will be
    present on every successful run but absent otherwise. Do not choose text
    that contains values specific to this particular record.
  - outputs: the data a caller of this capability would want back. Name them
    as an API would. Say exactly where each is read from on the final screen.
  - proposedOutcomes: *other* results this same flow could legitimately
    produce that a caller must handle — a record not being found, a permission
    denial, a validation rejection. These are proposals for human review, so
    err toward listing them.
  - proposedInterstitials: screens that can legitimately appear mid-flow and
    that an operator would simply acknowledge or dismiss to continue.

You are describing what the application can do, not only what it just did.`;

export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    successMarker: { type: 'STRING' },
    successReadoutLabel: { type: 'STRING', description: 'Optional label present on success.' },
    outputs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          type: { type: 'STRING', enum: ['string', 'number', 'boolean'] },
          description: { type: 'STRING' },
          sourceKind: { type: 'STRING', enum: ['readout', 'table', 'text'] },
          readoutLabel: { type: 'STRING' },
          tableWhereColumn: { type: 'STRING' },
          tableWhereEquals: { type: 'STRING' },
          tableSelectColumn: { type: 'STRING' },
          textPattern: { type: 'STRING' },
          transform: { type: 'STRING', enum: ['none', 'trim', 'money', 'number', 'upper'] },
        },
        required: ['name', 'type', 'description', 'sourceKind'],
      },
    },
    proposedOutcomes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: { type: 'STRING', description: 'SCREAMING_SNAKE_CASE.' },
          description: { type: 'STRING' },
          textMarker: { type: 'STRING', description: 'Text that identifies this outcome on screen.' },
        },
        required: ['code', 'description', 'textMarker'],
      },
    },
    proposedInterstitials: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          code: { type: 'STRING' },
          description: { type: 'STRING' },
          textMarker: { type: 'STRING' },
          dismissButtonLabel: { type: 'STRING' },
        },
        required: ['code', 'description', 'textMarker', 'dismissButtonLabel'],
      },
    },
  },
  required: ['successMarker', 'outputs'],
};

export interface SummaryResponse {
  successMarker: string;
  successReadoutLabel?: string;
  outputs: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    sourceKind: 'readout' | 'table' | 'text';
    readoutLabel?: string;
    tableWhereColumn?: string;
    tableWhereEquals?: string;
    tableSelectColumn?: string;
    textPattern?: string;
    transform?: 'none' | 'trim' | 'money' | 'number' | 'upper';
  }>;
  proposedOutcomes?: Array<{ code: string; description: string; textMarker: string }>;
  proposedInterstitials?: Array<{ code: string; description: string; textMarker: string; dismissButtonLabel: string }>;
}

// ------------------------------------------------------------ rendering ---

const frame = (n: UiNode): string => (n.framePath.length ? ` frame=${n.framePath.join('/')}` : '');

/** Compact, stable rendering of the control list. */
export function renderObservation(obs: Observation): string {
  const interactive = obs.nodes.filter((n) =>
    ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio'].includes(n.role)
  );
  const readouts = obs.nodes.filter((n) => n.role === 'readout');
  const tables = obs.nodes.filter((n) => n.role === 'table');
  const alerts = obs.nodes.filter((n) => n.role === 'alert');

  const lines: string[] = [`URL: ${obs.url}`, `TITLE: ${obs.title}`, '', 'CONTROLS:'];

  for (const n of interactive) {
    const bits = [`[${n.ref}]`, n.role, `"${n.name}"`];
    if (n.value !== undefined && n.value !== '') bits.push(`value="${n.value}"`);
    if (n.options) bits.push(`options=[${n.options.join(' | ')}]`);
    if (n.disabled) bits.push('(disabled)');
    lines.push('  ' + bits.join(' ') + frame(n));
  }
  if (interactive.length === 0) lines.push('  (none)');

  if (alerts.length) {
    lines.push('', 'MESSAGES ON SCREEN:');
    for (const a of alerts) lines.push(`  ! ${a.name}`);
  }
  if (readouts.length) {
    lines.push('', 'FIELDS DISPLAYED:');
    for (const r of readouts) lines.push(`  ${r.name}: ${r.value ?? ''}`);
  }
  if (tables.length) {
    lines.push('', 'TABLES:');
    for (const t of tables) {
      lines.push(`  "${t.name}"`);
      for (const row of (t.grid ?? []).slice(0, 12)) lines.push('    ' + row.join(' | '));
    }
  }

  lines.push('', 'SCREEN TEXT:', obs.text.slice(0, 1500));
  return lines.join('\n');
}

export function renderHistory(history: Array<{ intent: string; action: string; result: string }>): string {
  if (history.length === 0) return '(nothing yet — this is the first step)';
  return history
    .map((h, i) => `${i + 1}. ${h.intent} [${h.action}] → ${h.result}`)
    .join('\n');
}

/**
 * What changed on screen between the observation an action was chosen from
 * and the next one.
 *
 * The loop used to report `now at <url>` after every action, which on a
 * frameset — the surface this project exists for — is a constant. The model
 * clicked Search, was told it was still at `/desk`, concluded nothing had
 * happened, re-clicked the navigation link, wiped the form it had just
 * filled, and stalled. The URL is the one signal these applications do not
 * give you; the control list is the one they do.
 *
 * Alerts come first and are called out separately, because on these screens
 * an error is an alert and it is the most consequential thing that can have
 * changed. "No visible change" is stated explicitly rather than left as an
 * empty result: an action that did nothing is information, and a model that
 * is told so stops repeating it.
 */
export function describeChange(before: Observation, after: Observation): string {
  const key = (n: UiNode): string => `${n.role} "${n.name}"`;
  const beforeByKey = new Map(before.nodes.map((n) => [key(n), n]));
  const afterByKey = new Map(after.nodes.map((n) => [key(n), n]));

  const parts: string[] = [];

  if (after.url !== before.url) parts.push(`navigated to ${after.url}`);
  else if (after.title !== before.title) parts.push(`screen is now "${after.title}"`);

  const newAlerts = after.nodes
    .filter((n) => n.role === 'alert')
    .filter((n) => !before.nodes.some((b) => b.role === 'alert' && b.name === n.name));
  if (newAlerts.length) {
    parts.push(`message on screen: ${newAlerts.map((a) => `"${a.name}"`).join('; ')}`);
  }

  const structural = (k: string): boolean => !k.startsWith('alert ');
  const appeared = [...afterByKey.keys()].filter((k) => !beforeByKey.has(k) && structural(k));
  const gone = [...beforeByKey.keys()].filter((k) => !afterByKey.has(k) && structural(k));

  const changedValues: string[] = [];
  for (const [k, n] of afterByKey) {
    const b = beforeByKey.get(k);
    if (!b) continue;
    const bv = b.value ?? '';
    const av = n.value ?? '';
    if (bv !== av) changedValues.push(`${k} now ${av === '' ? 'empty' : `"${av}"`}`);
  }

  if (appeared.length) parts.push(`appeared: ${cap(appeared)}`);
  if (gone.length) parts.push(`no longer present: ${cap(gone)}`);
  if (changedValues.length) parts.push(cap(changedValues));

  if (parts.length === 0) {
    return `NOTHING CHANGED on screen (still at ${after.url}) — that action had no visible effect, so repeating it will not help`;
  }
  return parts.join('; ');
}

/** Long lists of controls are noise past the first few. */
function cap(items: string[], limit = 6): string {
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} and ${items.length - limit} more`;
}
