/**
 * Model access.
 *
 * The interface is narrow on purpose: one call, structured JSON out, against
 * a schema we supply. The discovery loop does not need streaming, tool
 * dispatch or conversation management, and every one of those would be a
 * source of nondeterminism in the only part of the system that is allowed to
 * be nondeterministic at all.
 *
 * Keeping it this small also means the `ScriptedProvider` is a genuine
 * substitute rather than a stub, so the entire pipeline — loop, recorder,
 * artifact, replay — is testable with no network and no key.
 */
export type Part =
  | { text: string }
  | { image: { mimeType: string; data: Buffer } };

export interface CompleteRequest {
  system: string;
  parts: Part[];
  /** JSON schema (OpenAPI subset) the response must satisfy. */
  schema: Record<string, unknown>;
  temperature?: number;
  purpose: string;
}

export interface CompleteResponse {
  value: unknown;
  /** Raw text, retained for evidence. */
  raw: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelProvider {
  readonly name: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}
