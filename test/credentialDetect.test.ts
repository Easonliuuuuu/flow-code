import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectCredential,
  detectCredentials,
  hasCredential,
} from '../src/engine/credentialDetect.js';

/** A home directory with no `claude`/`codex` login in it. */
function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-detect-home-'));
}

beforeEach(() => {
  // Every credential this module reads is opted back in explicitly per test,
  // so a real login on the dev/CI machine cannot decide the result.
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.stubEnv('CODEX_API_KEY', undefined);
  vi.stubEnv('OPENROUTER_API_KEY', undefined);
  vi.stubEnv('CODEX_HOME', undefined);
  vi.stubEnv('HOME', emptyHome());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('detectCredential', () => {
  it('reports nothing found when the environment and home are empty', () => {
    for (const provider of ['claude', 'codex', 'openai', 'openrouter'] as const) {
      expect(detectCredential(provider)).toEqual({ provider });
      expect(hasCredential(provider)).toBe(false);
    }
  });

  it('names the env var as the source and carries the key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    expect(detectCredential('openai')).toEqual({
      provider: 'openai',
      source: 'OPENAI_API_KEY',
      apiKey: 'sk-openai',
    });
  });

  it('never puts the secret itself in the printable source field', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-supersecret');
    expect(detectCredential('openrouter').source).toBe('OPENROUTER_API_KEY');
    expect(detectCredential('openrouter').source).not.toContain('supersecret');
  });

  it('prefers ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN for claude', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth');
    expect(detectCredential('claude')).toEqual({
      provider: 'claude',
      source: 'ANTHROPIC_API_KEY',
      apiKey: 'sk-ant',
    });
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN when no API key is set', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth');
    expect(detectCredential('claude').source).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('finds a `claude` CLI login and reports no key to copy', () => {
    const home = emptyHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    vi.stubEnv('HOME', home);
    expect(detectCredential('claude')).toEqual({
      provider: 'claude',
      source: '`claude` CLI login',
    });
    expect(detectCredential('claude').apiKey).toBeUndefined();
  });

  it('mirrors the Codex SDK order: OPENAI_API_KEY, then CODEX_API_KEY, then the CLI login', () => {
    vi.stubEnv('CODEX_API_KEY', 'codex-key');
    expect(detectCredential('codex').source).toBe('CODEX_API_KEY');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    expect(detectCredential('codex').source).toBe('OPENAI_API_KEY');
  });

  it('honours CODEX_HOME when looking for a codex login', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'flow-code-detect-codex-'));
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    vi.stubEnv('CODEX_HOME', codexHome);
    expect(detectCredential('codex')).toEqual({
      provider: 'codex',
      source: '`codex` CLI login',
    });
  });

  it("does not treat an unrelated provider's key as its own", () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or');
    expect(hasCredential('openrouter')).toBe(true);
    expect(hasCredential('openai')).toBe(false);
    expect(hasCredential('claude')).toBe(false);
  });
});

describe('detectCredentials', () => {
  it('returns every provider in menu order, annotated', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    const all = detectCredentials();
    expect(all.map((d) => d.provider)).toEqual(['claude', 'codex', 'openai', 'openrouter']);
    expect(all.filter((d) => d.source !== undefined).map((d) => d.provider))
      // codex too: OPENAI_API_KEY is second in the Codex SDK's own order.
      .toEqual(['codex', 'openai']);
  });
});
