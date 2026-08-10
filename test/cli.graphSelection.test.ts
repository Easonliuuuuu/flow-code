import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGraphSelection } from '../src/cli/run.js';

function repoWithWorkflow(yaml: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'flow-code-cli-graphsel-'));
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), yaml);
  return repo;
}

const FLAT = `
nodes:
  - id: t
    type: test
    config: { commands: ["true"] }
`;

const ONE_GRAPH = `
graphs:
  quick:
    description: fast path
    nodes:
      - id: t
        type: test
        config: { commands: ["true"] }
`;

const TWO_GRAPHS = `
graphs:
  quick:
    description: fast path
    nodes:
      - id: t
        type: test
        config: { commands: ["true"] }
  hardened:
    description: extra scrutiny
    nodes:
      - id: t
        type: test
        config: { commands: ["true"] }
`;

/** Makes `fail`'s process.exit observable rather than killing the test runner. */
function trapExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { exit, error };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveGraphSelection', () => {
  it('is undefined for a single-graph (flat-form) file — nothing to select, no prompt', async () => {
    const pick = vi.fn();
    const repo = repoWithWorkflow(FLAT);
    await expect(resolveGraphSelection(repo, undefined, { pick })).resolves.toBeUndefined();
    expect(pick).not.toHaveBeenCalled();
  });

  it('returns an explicit --graph name without prompting, when it is declared', async () => {
    const pick = vi.fn();
    const repo = repoWithWorkflow(TWO_GRAPHS);
    await expect(resolveGraphSelection(repo, 'hardened', { pick })).resolves.toBe('hardened');
    expect(pick).not.toHaveBeenCalled();
  });

  it('fails, listing the declared names, when the explicit name is not one of them', async () => {
    const repo = repoWithWorkflow(TWO_GRAPHS);
    const { error } = trapExit();
    await expect(() => resolveGraphSelection(repo, 'nope', {})).rejects.toThrow('process.exit called');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('quick, hardened'));
  });

  it('auto-selects the sole declared graph without prompting', async () => {
    const pick = vi.fn();
    const repo = repoWithWorkflow(ONE_GRAPH);
    await expect(resolveGraphSelection(repo, undefined, { pick })).resolves.toBe('quick');
    expect(pick).not.toHaveBeenCalled();
  });

  it('prompts interactively, offering each name with its description, when more than one is declared and none is given', async () => {
    const repo = repoWithWorkflow(TWO_GRAPHS);
    const pick = vi.fn().mockResolvedValue('hardened');
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      const result = await resolveGraphSelection(repo, undefined, { pick });
      expect(result).toBe('hardened');
      expect(pick).toHaveBeenCalledWith(
        [
          { label: 'quick — fast path', value: 'quick' },
          { label: 'hardened — extra scrutiny', value: 'hardened' },
        ],
        expect.objectContaining({ prompt: expect.any(String) }),
      );
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('fails when the interactive pick is cancelled', async () => {
    const repo = repoWithWorkflow(TWO_GRAPHS);
    const pick = vi.fn().mockResolvedValue(undefined);
    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    const { error } = trapExit();
    try {
      await expect(() => resolveGraphSelection(repo, undefined, { pick })).rejects.toThrow(
        'process.exit called',
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('no graph selected'));
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it('fails before execution, listing the declared names, when there is no TTY to ask in and no name was given', async () => {
    // The test runner's own stdin is not a TTY — exactly the condition this
    // path exists to fail on rather than silently guessing.
    expect(process.stdin.isTTY).toBeFalsy();
    const repo = repoWithWorkflow(TWO_GRAPHS);
    const pick = vi.fn();
    const { error } = trapExit();
    await expect(() => resolveGraphSelection(repo, undefined, { pick })).rejects.toThrow(
      'process.exit called',
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('quick, hardened'));
    expect(pick).not.toHaveBeenCalled();
  });
});
