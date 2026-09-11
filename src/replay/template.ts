/**
 * `{{param}}` interpolation.
 *
 * Missing bindings throw rather than substituting empty string. On a
 * back-office banking screen a silently-blank member number is not a smaller
 * problem than a crash — it is a much larger one, because the run continues
 * and does something to the wrong record.
 */
export type Bindings = Record<string, string | number | boolean>;

const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function interpolate(input: string, bindings: Bindings): string {
  return input.replace(TOKEN, (_m, name: string) => {
    if (!(name in bindings)) {
      throw new Error(`template references unbound parameter "${name}"`);
    }
    return String(bindings[name]);
  });
}

export function referencedParams(input: string): string[] {
  return [...input.matchAll(TOKEN)].map((m) => m[1] as string);
}

/** Deep-interpolates every string in a structure. */
export function interpolateDeep<T>(value: T, bindings: Bindings): T {
  if (typeof value === 'string') return interpolate(value, bindings) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, bindings)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, bindings);
    }
    return out as T;
  }
  return value;
}
