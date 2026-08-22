import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, providerInfo, type ProviderId } from './providers.js';

/**
 * Where a provider's credential was found. Always the *name* of an env var or
 * a description of a login file — never the secret itself, so this is safe to
 * print. The secret, when there is one to read, travels in `apiKey`.
 */
export interface CredentialDetection {
  provider: ProviderId;
  /** Undefined when nothing was found for this provider. */
  source?: string;
  /**
   * The key, when it came from an env var we can read. Absent for a CLI login,
   * where the credential lives in a file owned by that CLI and is its business
   * to refresh — copying it would be both fragile and none of ours.
   */
  apiKey?: string;
}

/**
 * One definition of "this provider already has credentials", used by both
 * preflight (which refuses a run without them) and the init wizard (which
 * offers to reuse them instead of asking for a paste). Two definitions would
 * eventually disagree, and the failure mode is the worst kind: a wizard that
 * says it found nothing followed by a run that starts fine, or vice versa.
 *
 * The per-provider order mirrors each SDK's own resolution order, so what is
 * reported here is what will actually be used.
 */
export function detectCredential(provider: ProviderId): CredentialDetection {
  const fromEnv = (name: string): CredentialDetection | undefined => {
    const value = process.env[name];
    return value ? { provider, source: name, apiKey: value } : undefined;
  };

  switch (provider) {
    case 'claude': {
      const env = fromEnv('ANTHROPIC_API_KEY') ?? fromEnv('CLAUDE_CODE_OAUTH_TOKEN');
      if (env) return env;
      return existsSync(join(homedir(), '.claude', '.credentials.json'))
        ? { provider, source: '`claude` CLI login' }
        : { provider };
    }
    case 'codex': {
      const env = fromEnv('OPENAI_API_KEY') ?? fromEnv('CODEX_API_KEY');
      if (env) return env;
      // CODEX_HOME defaults to ~/.codex, same as the Codex SDK assumes.
      const codexHome = process.env['CODEX_HOME'] || join(homedir(), '.codex');
      return existsSync(join(codexHome, 'auth.json'))
        ? { provider, source: '`codex` CLI login' }
        : { provider };
    }
    default: {
      // Every remaining provider is a plain API key in a single env var.
      const envVar = providerInfo(provider).apiKeyEnvVar;
      return (envVar ? fromEnv(envVar) : undefined) ?? { provider };
    }
  }
}

/** Every provider, in menu order, annotated with what was found for it. */
export function detectCredentials(): CredentialDetection[] {
  return PROVIDERS.map((p) => detectCredential(p.id));
}

export function hasCredential(provider: ProviderId): boolean {
  return detectCredential(provider).source !== undefined;
}
