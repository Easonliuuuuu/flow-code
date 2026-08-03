import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../../src/defaultWorkflow.js';
import type { AgentSessionRequest, SessionRunner } from '../../src/engine/types.js';
import { loadWorkflowFromString } from '../../src/workflow/load.js';

/** Queued answers for the wizard's prompts, consumed in order. */
const confirmAnswers: boolean[] = [];
const textAnswers: string[] = [];
const confirmPrompts: string[] = [];

vi.mock('../../src/init/prompts.js', () => ({
  confirm: vi.fn(async (prompt: string) => {
    confirmPrompts.push(prompt);
    return confirmAnswers.shift() ?? false;
  }),
  promptText: vi.fn(async () => textAnswers.shift() ?? ''),
}));

const { runTestSetupWizard } = await import('../../src/init/testWizard.js');
const { discoverTestCommandsWithAgent } = await import('../../src/init/testDiscoverAgent.js');

function tempRepo(files: Record<string, string> = {}): { repoRoot: string; workflowPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-testdisc-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repoRoot, name), content);
  }
  const workflowPath = join(repoRoot, 'workflow.yaml');
  writeFileSync(workflowPath, DEFAULT_WORKFLOW_YAML);
  return { repoRoot, workflowPath };
}

function fakeSessions(reply: string): SessionRunner & { requests: AgentSessionRequest[] } {
  const requests: AgentSessionRequest[] = [];
  return {
    requests,
    async run(req) {
      requests.push(req);
      return { finalText: reply };
    },
    async openInteractive() {
      throw new Error('the fallback must not open an interactive session');
    },
  };
}

function commandsIn(workflowPath: string): unknown {
  const wf = loadWorkflowFromString(readFileSync(workflowPath, 'utf8'));
  return (wf.nodes.find((n) => n.id === 'test')!.config as { commands: unknown }).commands;
}

const PROPOSAL = JSON.stringify({
  commands: [
    { command: 'tox -e py311', rationale: 'tox.ini declares a py311 env' },
    { command: 'pytest tests/e2e', rationale: '.github/workflows/ci.yml runs it separately' },
  ],
});

beforeEach(() => {
  confirmAnswers.length = 0;
  textAnswers.length = 0;
  confirmPrompts.length = 0;
});

describe('discoverTestCommandsWithAgent', () => {
  it('asks for a read-only session and never an interactive one', async () => {
    const { repoRoot } = tempRepo();
    const sessions = fakeSessions(PROPOSAL);

    await discoverTestCommandsWithAgent({ repoRoot, sessions });

    const req = sessions.requests[0]!;
    expect([...req.capabilities]).toEqual(['read']);
    expect(req.workingDir).toBe(repoRoot);
  });

  it('parses proposals with their rationales', async () => {
    const { repoRoot } = tempRepo();

    const proposals = await discoverTestCommandsWithAgent({
      repoRoot,
      sessions: fakeSessions(PROPOSAL),
    });

    expect(proposals).toEqual([
      { command: 'tox -e py311', rationale: 'tox.ini declares a py311 env' },
      { command: 'pytest tests/e2e', rationale: '.github/workflows/ci.yml runs it separately' },
    ]);
  });

  it('treats an empty list as a valid answer', async () => {
    const { repoRoot } = tempRepo();

    const proposals = await discoverTestCommandsWithAgent({
      repoRoot,
      sessions: fakeSessions('{"commands": []}'),
    });

    expect(proposals).toEqual([]);
  });

  it('drops entries with no usable command string', async () => {
    const { repoRoot } = tempRepo();

    const proposals = await discoverTestCommandsWithAgent({
      repoRoot,
      sessions: fakeSessions('{"commands":[{"command":"  "},{"command":"go test ./..."}]}'),
    });

    expect(proposals.map((p) => p.command)).toEqual(['go test ./...']);
  });
});

describe('the wizard runs heuristics before spending a model', () => {
  it('accepts a heuristic hit and never opens a session', async () => {
    const { repoRoot, workflowPath } = tempRepo({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    });
    const sessions = fakeSessions(PROPOSAL);
    confirmAnswers.push(true, false); // include `npm test`; add another? no

    await runTestSetupWizard(repoRoot, workflowPath, { sessions });

    expect(sessions.requests).toHaveLength(0);
    expect(commandsIn(workflowPath)).toEqual(['npm test']);
  });

  it('falls back to the agent when the heuristics find nothing', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    const sessions = fakeSessions(PROPOSAL);
    // run the fallback? yes; include each proposal? yes, yes; add another? no
    confirmAnswers.push(true, true, true, false);

    await runTestSetupWizard(repoRoot, workflowPath, { sessions });

    expect(sessions.requests).toHaveLength(1);
    expect(commandsIn(workflowPath)).toEqual(['tox -e py311', 'pytest tests/e2e']);
  });

  it('falls back when the user declines every heuristic candidate', async () => {
    const { repoRoot, workflowPath } = tempRepo({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    });
    const sessions = fakeSessions(PROPOSAL);
    // decline `npm test`; run the fallback? yes; take the first only; no more
    confirmAnswers.push(false, true, true, false, false);

    await runTestSetupWizard(repoRoot, workflowPath, { sessions });

    expect(sessions.requests).toHaveLength(1);
    expect(commandsIn(workflowPath)).toEqual(['tox -e py311']);
  });

  it('shows each proposal with its rationale before asking', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    confirmAnswers.push(true, true, false, false);

    await runTestSetupWizard(repoRoot, workflowPath, { sessions: fakeSessions(PROPOSAL) });

    expect(confirmPrompts.some((p) => p.includes('tox -e py311'))).toBe(true);
  });

  it('skips the fallback with the placeholder intact when no provider is configured', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    confirmAnswers.push(false); // add a test command by hand? no

    await runTestSetupWizard(repoRoot, workflowPath, {});

    expect(confirmPrompts.some((p) => p.includes('read the repo'))).toBe(false);
    expect(commandsIn(workflowPath)).toEqual([
      'echo "replace me with your project\'s test command"',
    ]);
  });

  it('leaves the placeholder alone when the user declines the fallback itself', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    const sessions = fakeSessions(PROPOSAL);
    confirmAnswers.push(false, false); // no to the fallback, no to adding by hand

    await runTestSetupWizard(repoRoot, workflowPath, { sessions });

    expect(sessions.requests).toHaveLength(0);
    expect(commandsIn(workflowPath)).toEqual([
      'echo "replace me with your project\'s test command"',
    ]);
  });

  it('writes nothing when every proposal is declined', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    confirmAnswers.push(true, false, false, false);

    await runTestSetupWizard(repoRoot, workflowPath, { sessions: fakeSessions(PROPOSAL) });

    expect(commandsIn(workflowPath)).toEqual([
      'echo "replace me with your project\'s test command"',
    ]);
  });

  it('survives a fallback session that fails, without failing init', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    const failing: SessionRunner = {
      async run() {
        throw new Error('provider unreachable');
      },
      async openInteractive() {
        throw new Error('unused');
      },
    };
    confirmAnswers.push(true, false);

    await expect(
      runTestSetupWizard(repoRoot, workflowPath, { sessions: failing }),
    ).resolves.toBeUndefined();
  });
});
