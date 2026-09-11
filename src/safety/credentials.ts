/**
 * Credential resolution.
 *
 * Secrets are referenced by name in artifacts and resolved here at run time.
 * The value is handed straight to the surface driver and is registered with
 * the redactor so that if it ever does reach a log line — via an error
 * message, a page echo, anything — it is scrubbed on the way out.
 *
 * In a real deployment this is backed by the institution's secret manager and
 * scoped per tenant; the env-var implementation is the seam, not the design.
 */
export interface CredentialProvider {
  resolve(ref: string): string;
  has(ref: string): boolean;
}

export class EnvCredentialProvider implements CredentialProvider {
  constructor(private prefix = 'HS_SECRET_') {}

  has(ref: string): boolean {
    return typeof process.env[this.key(ref)] === 'string';
  }

  resolve(ref: string): string {
    const v = process.env[this.key(ref)];
    if (v === undefined) {
      throw new Error(
        `credential "${ref}" is not available (expected env ${this.key(ref)}); ` +
        `refusing to continue rather than guessing`
      );
    }
    return v;
  }

  private key(ref: string): string {
    return this.prefix + ref.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  }
}
