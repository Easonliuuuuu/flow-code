import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProvider } from '../src/cli.js';
import { saveCredentials } from '../src/engine/credentials.js';
import { workflowFromYaml } from './helpers.js';

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-cli-resolve-'));
}

const AGENT_DRIVEN_WORKFLOW = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`;

const NO_AGENT_WORKFLOW = `
nodes:
  - id: t
    type: test
    config: { commands: ["true"] }
`;

beforeEach(() => {
  // Isolate from whatever's actually configured in the host shell/machine —
  // every test below opts specific env vars (or none) back in explicitly.
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
  vi.stubEnv('NVIDIA_API_KEY', undefined);
  vi.stubEnv('NVIDIA_API_KEY_2', undefined);
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.stubEnv('OPENAI_API_KEY_2', undefined);
  vi.stubEnv('OPENROUTER_API_KEY', undefined);
  vi.stubEnv('OPENROUTER_API_KEY_2', undefined);
  // Redirect the Claude Agent SDK's `~/.claude/.credentials.json` login
  // check to an empty temp dir, so a real login on the dev/CI machine
  // doesn't leak into these tests.
  vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'flow-code-cli-resolve-home-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveProvider', () => {
  it('returns saved credentials and fills in a missing env var without clobbering an existing one', async () => {
    const repo = tempRepo();
    saveCredentials(repo, { provider: 'openai', apiKey: 'sk-saved', model: 'gpt-4o-mini' });
    const result = await resolveProvider(repo, workflowFromYaml(AGENT_DRIVEN_WORKFLOW));
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(process.env['OPENAI_API_KEY']).toBe('sk-saved');
  });

  it('does not overwrite an already-set env var with the saved key', async () => {
    const repo = tempRepo();
    saveCredentials(repo, { provider: 'openai', apiKey: 'sk-saved', model: 'gpt-4o-mini' });
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-env');
    await resolveProvider(repo, workflowFromYaml(AGENT_DRIVEN_WORKFLOW));
    expect(process.env['OPENAI_API_KEY']).toBe('sk-from-env');
  });

  it('falls back to an env-var-configured provider when nothing is saved', async () => {
    const repo = tempRepo();
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-test');
    const result = await resolveProvider(repo, workflowFromYaml(AGENT_DRIVEN_WORKFLOW));
    expect(result).toEqual({ provider: 'nvidia' });
  });

  it('falls back to claude when Claude Agent SDK credentials are present', async () => {
    const repo = tempRepo();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const result = await resolveProvider(repo, workflowFromYaml(AGENT_DRIVEN_WORKFLOW));
    expect(result).toEqual({ provider: 'claude' });
  });

  it('exits with a pointer to `flow-code init` when nothing is configured and the workflow needs a provider', async () => {
    const repo = tempRepo();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(resolveProvider(repo, workflowFromYaml(AGENT_DRIVEN_WORKFLOW))).rejects.toThrow(
      'process.exit called',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('flow-code init'));
  });

  it('returns undefined when nothing is configured and the workflow has no agent-driven node', async () => {
    const repo = tempRepo();
    const result = await resolveProvider(repo, workflowFromYaml(NO_AGENT_WORKFLOW));
    expect(result).toBeUndefined();
  });

  it('requires a provider for a Test node with `agent: true` and instructions, even with no other agent-driven node', async () => {
    const repo = tempRepo();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const workflow = workflowFromYaml(`
nodes:
  - id: t
    type: test
    config:
      commands: ["true"]
      agent: true
      instructions: look for flaky output
`);
    await expect(resolveProvider(repo, workflow)).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not require a provider for a Test node with `agent: true` but nothing configured to run it with', async () => {
    const repo = tempRepo();
    const workflow = workflowFromYaml(`
nodes:
  - id: t
    type: test
    config:
      commands: ["true"]
      agent: true
`);
    const result = await resolveProvider(repo, workflow);
    expect(result).toBeUndefined();
  });
});
