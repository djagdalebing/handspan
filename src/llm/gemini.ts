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

/**
 * Returns how long to wait before retrying, or null if retrying is pointless.
 *
 * The distinction that matters is per-minute versus per-day. A per-minute
 * window clears on its own and is worth waiting out. A *daily* quota does not
 * clear for hours, and retrying it eight times turns a clear error into a
 * seven-minute hang that ends in the same place — so those fail immediately
 * and say so.
 */
function retryDelayMs(message: string, attempt: number): number | null {
  // Transient capacity problems on the provider's side. Nothing about the
  // request is wrong, so back off and try again.
  if (/\b(500|502|503|504)\b/.test(message) || /UNAVAILABLE|INTERNAL/.test(message)) {
    return Math.min(4_000 * 2 ** attempt, 60_000);
  }

  if (!/\b429\b/.test(message) && !/RESOURCE_EXHAUSTED/.test(message)) return null;
  if (/PerDay|per day/i.test(message)) return null;
  const explicit =
    message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ??
    message.match(/retry in (\d+(?:\.\d+)?)s/i);
  const seconds = explicit ? Number(explicit[1]) : 30;
  return Math.ceil(seconds) * 1000 + 2_000;
}

export class GeminiProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private apiKey: string,
    private model = process.env.HS_GEMINI_MODEL ?? 'gemini-2.5-flash'
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

  /**
   * Rate limits are a normal operating condition, not an error: a free-tier
   * key is capped at a handful of requests per minute, and a discovery run
   * needs more than that. The API tells us how long to wait, so we wait that
   * long rather than guessing or giving up — bounded, so a genuinely
   * exhausted quota still surfaces instead of hanging forever.
   */
  private static readonly MAX_RETRIES = 8;

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= GeminiProvider.MAX_RETRIES; attempt++) {
      try {
        return await this.attempt(req);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const base = retryDelayMs(err.message, attempt);
        if (base === null || attempt === GeminiProvider.MAX_RETRIES) throw err;
        // Grow the wait as attempts stack up. The server's suggested delay is
        // for the window it was measuring; retrying into the same window
        // repeatedly just burns the retry budget without making progress.
        const wait = Math.min(base + attempt * 10_000, 120_000);
        lastError = err;
        process.stderr.write(`  [gemini] retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${GeminiProvider.MAX_RETRIES})\n`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError ?? new Error('unreachable');
  }

  private async attempt(req: CompleteRequest): Promise<CompleteResponse> {
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

    const bodyText = await res.text().catch(() => '');

    if (!res.ok) {
      // Two failures are common enough to be worth naming, because the raw
      // message sends you looking in the wrong place: a model that has been
      // retired for new keys, and a model whose free-tier quota is zero.
      const daily = /PerDay|per day/i.test(bodyText);
      const hint =
        res.status === 404 ? ` — set HS_GEMINI_MODEL to a model this key can reach`
        : res.status === 429 && daily
          ? ` — the daily free-tier quota for ${this.model} is spent. The quota is scoped ` +
            `per model, so pointing HS_GEMINI_MODEL at a different model gives a fresh budget`
        : res.status === 429 ? ` — rate limited on ${this.model} beyond the retry budget`
        : '';
      throw new Error(`Gemini ${res.status} for ${this.model}${hint}: ${bodyText.slice(0, 400)}`);
    }

    // Some model names are advertised by ListModels but close the connection
    // without a body. An empty 200 is not something a caller can act on, so
    // say what actually happened rather than failing later on `undefined`.
    if (!bodyText.trim()) {
      throw new Error(
        `Gemini returned an empty 200 for ${this.model}; the model is listed but not ` +
        `serving this key. Set HS_GEMINI_MODEL to a model that responds.`
      );
    }

    const json = JSON.parse(bodyText) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      promptFeedback?: { blockReason?: string };
    };

    const candidate = json.candidates?.[0];
    const raw = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw) {
      const why = json.promptFeedback?.blockReason
        ? `blocked: ${json.promptFeedback.blockReason}`
        : `finishReason=${candidate?.finishReason ?? 'unknown'}`;
      throw new Error(`Gemini returned no content for ${this.model} (${why})`);
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
