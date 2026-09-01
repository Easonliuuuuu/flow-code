import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialsPath, loadCredentials, saveCredentials } from '../src/engine/credentials.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-creds-'));
}

describe('credentials persistence', () => {
  it('returns undefined when no file exists', () => {
    expect(loadCredentials(tempRepo())).toBeUndefined();
  });

  it('round-trips provider, key, and model through save/load', () => {
    const repo = tempRepo();
    saveCredentials(repo, { provider: 'openai', apiKey: 'sk-abc', model: 'gpt-4o-mini' });
    expect(loadCredentials(repo)).toEqual({ provider: 'openai', apiKey: 'sk-abc', model: 'gpt-4o-mini' });
  });

  it('round-trips an optional second (rotation) key', () => {
    const repo = tempRepo();
    saveCredentials(repo, {
      provider: 'openrouter',
      apiKey: 'nvapi-primary',
      apiKey2: 'nvapi-secondary',
      model: 'meta/llama-3.1-70b-instruct',
    });
    expect(loadCredentials(repo)).toEqual({
      provider: 'openrouter',
      apiKey: 'nvapi-primary',
      apiKey2: 'nvapi-secondary',
      model: 'meta/llama-3.1-70b-instruct',
    });
  });

  it('round-trips provider, key, and model for orcarouter', () => {
    const repo = tempRepo();
    saveCredentials(repo, { provider: 'orcarouter', apiKey: 'or-orca-abc', model: 'openai/gpt-4o-mini' });
    expect(loadCredentials(repo)).toEqual({
      provider: 'orcarouter',
      apiKey: 'or-orca-abc',
      model: 'openai/gpt-4o-mini',
    });
  });

  it('writes the file with owner-only permissions', () => {
    const repo = tempRepo();
    saveCredentials(repo, { provider: 'openrouter', apiKey: 'or-abc', model: 'openai/gpt-4o-mini' });
    const mode = statSync(credentialsPath(repo)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns undefined for a malformed file instead of throwing', () => {
    const repo = tempRepo();
    const path = credentialsPath(repo);
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(path, 'not json', 'utf8');
    expect(loadCredentials(repo)).toBeUndefined();
  });

  it('returns undefined for an unknown provider id', () => {
    const repo = tempRepo();
    const path = credentialsPath(repo);
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: 'bogus', model: 'x' }), 'utf8');
    expect(loadCredentials(repo)).toBeUndefined();
  });

  it('returns undefined when model is missing (legacy pre-project-wide-provider file)', () => {
    const repo = tempRepo();
    const path = credentialsPath(repo);
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ provider: 'claude', legacyApiKey: 'key-old', legacyApiKey2: 'key-old-2' }),
      'utf8',
    );
    expect(loadCredentials(repo)).toBeUndefined();
  });

  it('omits apiKey for claude, which needs none', () => {
    const repo = tempRepo();
    saveCredentials(repo, { provider: 'claude', model: 'claude-sonnet-5' });
    expect(loadCredentials(repo)).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
    expect(readFileSync(credentialsPath(repo), 'utf8')).not.toContain('apiKey');
  });
});
