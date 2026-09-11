/**
 * Redacts a JSON file with the product's own Redactor.
 *
 * Used when archiving a caller-facing result into `/evidence`. The caller gets
 * real values — that is the point of the capability — but evidence files
 * outlive the run and travel, so they must not carry regulated data.
 *
 * Usage: tsx scripts/redact-json.ts <in.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Redactor } from '../src/safety/redact.js';
import { looksSensitive } from '../src/safety/redact.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: redact-json.ts <in.json> <out.json>');

const raw = JSON.parse(readFileSync(input, 'utf8')) as { outputs?: Record<string, unknown> };
const redactor = new Redactor();
for (const [name, value] of Object.entries(raw.outputs ?? {})) {
  if (looksSensitive(name)) redactor.register(String(value), 'pii', name);
}
writeFileSync(output, JSON.stringify(redactor.value(raw), null, 2) + '\n');
