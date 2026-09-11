/**
 * A provider that replays a fixed list of responses.
 *
 * This exists so that everything downstream of the model — the decision loop,
 * the recorder, the artifact it emits, and the replay of that artifact — is
 * exercised in CI without a key and without network flake. It is not a mock
 * of the *model*; it is a mock of the *randomness*. The loop, prompts,
 * validation and recording code paths are identical.
 *
 * Scripted decisions may address a control symbolically as `@role:Name`
 * instead of by a live `ref`. The provider resolves those against the same
 * rendered control list the real model would read, which keeps scripts stable
 * when node ordering shifts. It reads the prompt and nothing else — it has no
 * privileged access to the page — so a script cannot target something the
 * model could not have seen.
 */
import type { CompleteRequest, CompleteResponse, ModelProvider } from './provider.js';

const SYMBOLIC = /^@([a-z]+):(.+)$/;

export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  private i = 0;

  constructor(private responses: unknown[]) {}

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    if (this.i >= this.responses.length) {
      throw new Error(
        `scripted provider exhausted after ${this.responses.length} responses ` +
        `(requested: ${req.purpose})`
      );
    }
    const value = this.responses[this.i++] as Record<string, unknown>;
    const resolved = this.resolveRef(value, req);
    return { value: resolved, raw: JSON.stringify(resolved) };
  }

  private resolveRef(value: Record<string, unknown>, req: CompleteRequest): unknown {
    const ref = value?.ref;
    if (typeof ref !== 'string') return value;
    const m = ref.match(SYMBOLIC);
    if (!m) return value;

    const [, role, name] = m;
    const prompt = req.parts.map((p) => ('text' in p ? p.text : '')).join('\n');
    // Lines look like:  [n1_3] textbox "Member Number" value="" frame=main
    const line = prompt
      .split('\n')
      .find((l) => l.includes(`] ${role} "${name}"`));
    if (!line) {
      return { ...value, ref: `@unresolved:${role}:${name}` };
    }
    const found = line.match(/\[([^\]]+)\]/);
    return { ...value, ref: found?.[1] ?? ref };
  }
}
