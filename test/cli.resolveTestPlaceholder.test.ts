import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACEHOLDER_TEST_COMMAND, TEST_COMMANDS_AUTO } from '../src/registry/index.js';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { workflowFromYaml } from './helpers.js';

/** Queued answers for the wizard's prompts, consumed in order — same technique as testDiscovery.test.ts. */
const confirmAnswers: boolean[] = [];

vi.mock('../src/init/prompts.js', () => ({
  confirm: vi.fn(async () => confirmAnswers.shift() ?? false),
  promptText: vi.fn(async () => ''),
}));

const { resolveTestPlaceholder } = await import('../src/cli.js');

function tempRepo(files: Record<string, string> = {}): { repoRoot: string; workflowPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-cli-testplaceholder-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repoRoot, name), content);
  }
  const workflowPath = join(repoRoot, 'workflow.yaml');
  return { repoRoot, workflowPath };
}

const PLACEHOLDER_WORKFLOW = `
nodes:
  - id: test
    type: test
    config:
      commands:
        - ${PLACEHOLDER_TEST_COMMAND}
`;

const RESOLVED_WORKFLOW = `
nodes:
  - id: test
    type: test
    config:
      commands: [npm test]
`;

const AUTO_WORKFLOW = `
nodes:
  - id: test
    type: test
    config:
      commands: ${TEST_COMMANDS_AUTO}
`;

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  confirmAnswers.length = 0;
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  vi.restoreAllMocks();
});

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

describe('resolveTestPlaceholder', () => {
  it('returns false and touches nothing when the Test node already has a real command', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    writeFileSync(workflowPath, RESOLVED_WORKFLOW);
    const resolved = await resolveTestPlaceholder(
      repoRoot,
      workflowPath,
      workflowFromYaml(RESOLVED_WORKFLOW),
      undefined,
    );
    expect(resolved).toBe(false);
    expect(readFileSync(workflowPath, 'utf8')).toBe(RESOLVED_WORKFLOW);
  });

  it('returns false for `commands: auto` — that is a deliberate opt-in, not an unfilled placeholder', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    writeFileSync(workflowPath, AUTO_WORKFLOW);
    const resolved = await resolveTestPlaceholder(
      repoRoot,
      workflowPath,
      workflowFromYaml(AUTO_WORKFLOW),
      undefined,
    );
    expect(resolved).toBe(false);
  });

  it('fails fast with a pointer to an interactive terminal when there is no TTY to ask', async () => {
    const { repoRoot, workflowPath } = tempRepo();
    writeFileSync(workflowPath, PLACEHOLDER_WORKFLOW);
    setTTY(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      resolveTestPlaceholder(repoRoot, workflowPath, workflowFromYaml(PLACEHOLDER_WORKFLOW), undefined),
    ).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('interactive terminal'));
    // Never even reached the wizard, so the placeholder is exactly as it was.
    expect(readFileSync(workflowPath, 'utf8')).toBe(PLACEHOLDER_WORKFLOW);
  });

  it('runs the wizard and writes a detected command back when there is a TTY', async () => {
    const { repoRoot, workflowPath } = tempRepo({
      'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    });
    writeFileSync(workflowPath, PLACEHOLDER_WORKFLOW);
    setTTY(true);
    confirmAnswers.push(true); // "Include `npm test`?"

    const resolved = await resolveTestPlaceholder(
      repoRoot,
      workflowPath,
      workflowFromYaml(PLACEHOLDER_WORKFLOW),
      undefined,
    );

    expect(resolved).toBe(true);
    const written = loadWorkflowFromString(readFileSync(workflowPath, 'utf8'));
    expect(written.nodes.find((n) => n.id === 'test')?.config).toMatchObject({ commands: ['npm test'] });
  });

  it('leaves the placeholder in place when every detected command is declined', async () => {
    const { repoRoot, workflowPath } = tempRepo({
      'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    });
    writeFileSync(workflowPath, PLACEHOLDER_WORKFLOW);
    setTTY(true);
    confirmAnswers.push(false); // decline the detected command
    // No provider passed, so the agent fallback is skipped and the wizard's
    // final "add a command?" loop declines by default (mocked confirm falls
    // back to false once the queue is empty).

    const resolved = await resolveTestPlaceholder(
      repoRoot,
      workflowPath,
      workflowFromYaml(PLACEHOLDER_WORKFLOW),
      undefined,
    );

    // The wizard still ran (returns true — the caller reloads either way);
    // it just didn't have anything to write.
    expect(resolved).toBe(true);
    expect(readFileSync(workflowPath, 'utf8')).toBe(PLACEHOLDER_WORKFLOW);
  });
});
