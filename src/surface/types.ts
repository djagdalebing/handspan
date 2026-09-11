/**
 * The surface abstraction.
 *
 * This is the seam the whole system pivots on. Everything above this file —
 * the discovery agent, the artifact schema, the replay engine — is written
 * against `Surface`, `UiNode` and `Action`, and knows nothing about
 * Playwright, the DOM, CSS selectors, or HTTP.
 *
 * The vocabulary is chosen to be satisfiable by a browser, by a Win32/UIA
 * desktop app, or by a pure screenshot+coordinate driver:
 *
 *   - perception yields a flat list of *controls* with a role, an accessible
 *     name, a containing frame/window path, and screen bounds;
 *   - action is expressed as a small set of human-scale verbs against a
 *     control, never as a selector.
 *
 * A CSS selector cannot cross that seam. An accessible name can.
 */

export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'combobox'
  | 'checkbox'
  | 'radio'
  | 'heading'
  | 'alert'
  | 'readout' // a label:value pair rendered as static text
  | 'table'
  | 'other';

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One perceived control. `ref` is valid only within the observation that
 * produced it — it is deliberately ephemeral so that nothing durable can be
 * built on top of a runtime handle. Durable identity is a `TargetDescriptor`,
 * derived from these fields at record time.
 */
export interface UiNode {
  ref: string;
  role: Role;
  name: string;
  value?: string;
  disabled?: boolean;
  /** Frame/window containment, outermost first. `[]` is the root document. */
  framePath: string[];
  bounds: Bounds;
  /** Structural position within its frame. Tie-breaker only, never primary. */
  path: string;
  /** Heading of the nearest enclosing panel/section, when one exists. */
  group?: string;
  /** Web-only, lowest-confidence hint. Never sufficient on its own. */
  domHint?: string;
  /** For role === 'table': the rendered grid, header row first. */
  grid?: string[][];
  /** For role === 'combobox': the selectable option labels. */
  options?: string[];
  /** Text of the nearest enclosing row, for row-scoped targeting. */
  rowText?: string;
}

export interface Observation {
  url: string;
  title: string;
  nodes: UiNode[];
  /** Condensed visible text. Used for outcome matching and model context. */
  text: string;
  at: string;
}

/**
 * How a control is named in a durable artifact. Multiple independent signals
 * are recorded; resolution scores candidates against all of them and requires
 * a unique winner. See replay/locator.ts for the rationale.
 */
export interface TargetDescriptor {
  role: Role;
  /** Accessible name as seen at record time. */
  name: string;
  /** How strictly `name` must match. */
  nameMatch: 'exact' | 'contains' | 'regex';
  framePath?: string[];
  group?: string;
  /** Disambiguates identical controls, e.g. the 3rd "Edit" button. */
  ordinal?: number;
  domHint?: string;
  /**
   * Resolve relative to a row containing this text. The text may contain
   * `{{param}}` placeholders bound at invocation time. This is how you target
   * "the link in the row for member 12345" on a table-layout app.
   */
  inRowContaining?: string;
}

export type Action =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; target: TargetDescriptor }
  | { kind: 'type'; target: TargetDescriptor; text: string; clearFirst?: boolean }
  | { kind: 'select'; target: TargetDescriptor; option: string }
  | { kind: 'press'; key: string }
  | { kind: 'wait'; ms: number };

export interface ActionResult {
  ok: boolean;
  /** Populated when the action could not be carried out on the surface. */
  error?: string;
}

/**
 * A live, stateful session against one application surface.
 *
 * Implementations are expected to be *thin*: perceive, act, screenshot. All
 * policy, retry, waiting strategy and interpretation lives above this line so
 * that adding a surface never means reimplementing the engine.
 */
export interface Surface {
  readonly id: string;
  observe(): Promise<Observation>;
  /** Resolution of `target` to a concrete control happens inside the surface. */
  act(action: Action, resolved: UiNode | null): Promise<ActionResult>;
  screenshot(opts?: { maskSensitive?: boolean }): Promise<Buffer>;
  /** Current location, in whatever form the surface uses (URL, window title). */
  location(): Promise<string>;
  close(): Promise<void>;
}
