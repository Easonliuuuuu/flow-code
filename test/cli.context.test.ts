import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, loadWorkflowOrFail, repoRootFromCwd } from '../src/cli/context.js';

function tempDir(prefix: string): string {
  // realpath so the comparison against git's own answer holds on platforms
  // where the temp dir is itself a symlink (/tmp -> /private/tmp on macOS).
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function trapExit() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
}

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe('fail', () => {
  it('prefixes the message and exits non-zero', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    expect(() => fail('something broke')).toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith('flow-code: something broke');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('repoRootFromCwd', () => {
  it('returns the top level of the repo the cwd sits in', async () => {
    const repo = tempDir('flow-code-cli-ctx-repo-');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    process.chdir(nested);
    expect(await repoRootFromCwd()).toBe(repo);
  });

  it('exits with a per-repo explanation outside a git repository', async () => {
    process.chdir(tempDir('flow-code-cli-ctx-bare-'));
    const exitSpy = trapExit();
    await expect(repoRootFromCwd()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('loadWorkflowOrFail', () => {
  function repoWithWorkflow(yaml: string): string {
    const repo = tempDir('flow-code-cli-ctx-wf-');
    mkdirSync(join(repo, '.flow-code'), { recursive: true });
    writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), yaml);
    return repo;
  }

  it('returns the loaded workflow when the file is valid', () => {
    const repo = repoWithWorkflow(`
nodes:
  - id: t
    type: test
    config: { commands: ["true"] }
`);
    expect(loadWorkflowOrFail(repo).nodes.map((n) => n.id)).toEqual(['t']);
  });

  it('reports validation problems as a listing instead of a stack trace', () => {
    const repo = repoWithWorkflow(`
nodes:
  - id: t
    type: no-such-node-type
`);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => loadWorkflowOrFail(repo)).toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith('flow-code: the workflow file is invalid:');
    // Each problem lands on its own bulleted line.
    expect(errorSpy.mock.calls.some(([line]) => String(line).startsWith('  - '))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports a missing workflow file the same way, with a pointer to `init`', () => {
    const repo = tempDir('flow-code-cli-ctx-missing-');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => loadWorkflowOrFail(repo)).toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('flow-code init'));
  });

  it('rethrows anything that is not a validation error', async () => {
    // Only a mocked loader can produce this: every real failure below
    // `loadWorkflow` is already wrapped as a WorkflowValidationError.
    vi.resetModules();
    vi.doMock('../src/workflow/load.js', async () => ({
      ...(await vi.importActual<typeof import('../src/workflow/load.js')>('../src/workflow/load.js')),
      loadWorkflow: () => {
        throw new Error('disk caught fire');
      },
    }));
    const { loadWorkflowOrFail: withBrokenLoader } = await import('../src/cli/context.js');

    expect(() => withBrokenLoader('/anywhere')).toThrow('disk caught fire');
    vi.doUnmock('../src/workflow/load.js');
    vi.resetModules();
  });
});
