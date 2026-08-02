import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDiscussProviderId, type DiscussProviderId } from './providers.js';

export const DISCUSS_CREDENTIALS_RELATIVE_PATH = join('.flow-code', 'credentials.json');

export interface StoredDiscussCredentials {
  provider: DiscussProviderId;
  /** Absent for 'claude' — it relies on the Claude Agent SDK's own credential resolution. */
  apiKey?: string;
  /**
   * Every agent-driven node besides Discuss is hardcoded to the NVIDIA
   * runner, so this is cached here too even when `provider` is something
   * else — one file, one first-run prompt, instead of a second credentials
   * store just for NVIDIA.
   */
  nvidiaApiKey?: string;
  /** Optional second key (a separate account) to rotate onto under sustained rate-limiting. */
  nvidiaApiKey2?: string;
}

export function discussCredentialsPath(repoRoot: string): string {
  return join(repoRoot, DISCUSS_CREDENTIALS_RELATIVE_PATH);
}

/** Returns undefined on anything unreadable/malformed — the caller re-prompts rather than crashing. */
export function loadDiscussCredentials(repoRoot: string): StoredDiscussCredentials | undefined {
  const path = discussCredentialsPath(repoRoot);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      provider?: unknown;
      apiKey?: unknown;
      nvidiaApiKey?: unknown;
      nvidiaApiKey2?: unknown;
    };
    if (typeof parsed.provider !== 'string' || !isDiscussProviderId(parsed.provider)) return undefined;
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
    const nvidiaApiKey = typeof parsed.nvidiaApiKey === 'string' ? parsed.nvidiaApiKey : undefined;
    const nvidiaApiKey2 = typeof parsed.nvidiaApiKey2 === 'string' ? parsed.nvidiaApiKey2 : undefined;
    return {
      provider: parsed.provider,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(nvidiaApiKey !== undefined ? { nvidiaApiKey } : {}),
      ...(nvidiaApiKey2 !== undefined ? { nvidiaApiKey2 } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Written mode 0600: it's a plaintext API key. */
export function saveDiscussCredentials(repoRoot: string, creds: StoredDiscussCredentials): void {
  const path = discussCredentialsPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on platforms without POSIX permission bits
  }
}
