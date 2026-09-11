import type { Observation, Role, UiNode } from '../src/surface/types.js';

let n = 0;

export function node(role: Role, name: string, extra: Partial<UiNode> = {}): UiNode {
  return {
    ref: extra.ref ?? `n${n++}`,
    role,
    name,
    framePath: extra.framePath ?? [],
    bounds: extra.bounds ?? { x: 0, y: n * 20, w: 80, h: 18 },
    path: extra.path ?? `BODY/DIV[${n}]`,
    ...extra,
  };
}

export function observation(nodes: UiNode[], extra: Partial<Observation> = {}): Observation {
  return {
    url: extra.url ?? 'http://127.0.0.1:4311/desk',
    title: extra.title ?? 'desk',
    nodes,
    text: extra.text ?? nodes.map((x) => `${x.name} ${x.value ?? ''}`).join('\n'),
    at: new Date().toISOString(),
  };
}
