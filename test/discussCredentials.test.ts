import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discussCredentialsPath,
  loadDiscussCredentials,
  saveDiscussCredentials,
} from '../src/engine/discussCredentials.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-discuss-creds-'));
}

describe('discuss credentials persistence', () => {
  it('returns undefined when no file exists', () => {
    expect(loadDiscussCredentials(tempRepo())).toBeUndefined();
  });

  it('round-trips provider and key through save/load', () => {
    const repo = tempRepo();
    saveDiscussCredentials(repo, { provider: 'openai', apiKey: 'sk-abc' });
    expect(loadDiscussCredentials(repo)).toEqual({ provider: 'openai', apiKey: 'sk-abc' });
  });

  it('writes the file with owner-only permissions', () => {
    const repo = tempRepo();
    saveDiscussCredentials(repo, { provider: 'openrouter', apiKey: 'or-abc' });
    const mode = statSync(discussCredentialsPath(repo)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns undefined for a malformed file instead of throwing', () => {
    const repo = tempRepo();
    const path = discussCredentialsPath(repo);
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(path, 'not json', 'utf8');
    expect(loadDiscussCredentials(repo)).toBeUndefined();
  });

  it('returns undefined for an unknown provider id', () => {
    const repo = tempRepo();
    const path = discussCredentialsPath(repo);
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: 'bogus' }), 'utf8');
    expect(loadDiscussCredentials(repo)).toBeUndefined();
  });

  it('omits apiKey for claude, which needs none', () => {
    const repo = tempRepo();
    saveDiscussCredentials(repo, { provider: 'claude' });
    expect(loadDiscussCredentials(repo)).toEqual({ provider: 'claude' });
    expect(readFileSync(discussCredentialsPath(repo), 'utf8')).not.toContain('apiKey');
  });

  it('round-trips the cached NVIDIA key(s) alongside a different discuss provider', () => {
    const repo = tempRepo();
    saveDiscussCredentials(repo, {
      provider: 'claude',
      nvidiaApiKey: 'nvapi-primary',
      nvidiaApiKey2: 'nvapi-secondary',
    });
    expect(loadDiscussCredentials(repo)).toEqual({
      provider: 'claude',
      nvidiaApiKey: 'nvapi-primary',
      nvidiaApiKey2: 'nvapi-secondary',
    });
  });
});
