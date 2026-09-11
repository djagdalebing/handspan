/**
 * Gemini provider.
 *
 * Plain REST over `fetch` rather than an SDK: the surface we need is one
 * endpoint, and a direct call keeps the request we send visible in this file
 * — which matters when the thing being sent includes screenshots of a
 * banking screen and we need to be able to say exactly what left the process.
 *
 * Structured output is enforced server-side with `responseSchema`, so the
 * discovery loop never has to parse prose or repair malformed JSON. The
 * schemas we send are deliberately *flat* (an action enum plus optional
 * fields) rather than a discriminated union: Gemini's schema support for
 * unions is uneven, and a flat object validated on our side is more reliable
 * than a clever schema that degrades silently.
 */
import type { CompleteRequest, CompleteResponse, ModelProvider } from './provider.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private apiKey: string,
    private model = process.env.HS_GEMINI_MODEL ?? 'gemini-2.5-pro'
  ) {
    this.name = `gemini:${this.model}`;
  }

  static fromEnv(): GeminiProvider {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error(
        'GEMINI_API_KEY is not set. Export it, or run with --model scripted ' +
        'to exercise the pipeline without a live model.'
      );
    }
    return new GeminiProvider(key);
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const parts = req.parts.map((p) =>
      'text' in p
        ? { text: p.text }
        : { inlineData: { mimeType: p.image.mimeType, data: p.image.data.toString('base64') } }
    );

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: req.temperature ?? 0,
        responseMimeType: 'application/json',
        responseSchema: req.schema,
      },
    };

    const res = await fetch(`${ENDPOINT}/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${detail.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const candidate = json.candidates?.[0];
    const raw = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw) {
      throw new Error(`Gemini returned no content (finishReason=${candidate?.finishReason ?? 'unknown'})`);
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini returned non-JSON despite responseSchema: ${raw.slice(0, 300)}`);
    }

    return {
      value,
      raw,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
