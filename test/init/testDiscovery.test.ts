import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_YAML } from '../../src/defaultWorkflow.js';
import type { AgentSessionRequest, SessionRunner } from '../../src/engine/types.js';

import { discoverTestCommandsWithAgent } from '../../src/init/testDiscoverAgent.js';

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

const PROPOSAL = JSON.stringify({
  commands: [
    { command: 'tox -e py311', rationale: 'tox.ini declares a py311 env' },
    { command: 'pytest tests/e2e', rationale: '.github/workflows/ci.yml runs it separately' },
  ],
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
