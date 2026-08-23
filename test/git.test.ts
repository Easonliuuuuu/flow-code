import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { preflight, PreflightError } from '../src/engine/preflight.js';
import {
  addWorktree,
  captureTree,
  diffAgainstTree,
  headCommit,
  listWorktreeDirs,
  recordBaseline,
  removeWorktree,
} from '../src/git/ops.js';
import { makeTempGitRepo, repoGit, workflowFromYaml } from './helpers.js';

const MINIMAL = `
nodes:
  - id: chat
    type: discuss
  - id: impl
    type: implement
    config: { instructions: x }
`;

describe('preflight', () => {
  it('fails on missing credentials before anything else', async () => {
    const repo = makeTempGitRepo();
    await expect(
      preflight(workflowFromYaml(MINIMAL), repo, {
        allowDirty: false,
        credentialsResolver: () => false,
      }),
    ).rejects.toThrowError(PreflightError);
    await expect(
      preflight(workflowFromYaml(MINIMAL), repo, {
        allowDirty: false,
        credentialsResolver: () => false,
      }),
    ).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('refuses a dirty working tree without the explicit override', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    await expect(
      preflight(workflowFromYaml(MINIMAL), repo, {
        allowDirty: false,
        credentialsResolver: () => true,
      }),
    ).rejects.toMatchObject({ kind: 'dirty-tree' });
  });

  it('accepts a dirty tree with the override, and a clean tree without it', async () => {
    const repo = makeTempGitRepo();
    await preflight(workflowFromYaml(MINIMAL), repo, {
      allowDirty: false,
      credentialsResolver: () => true,
    });
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    await preflight(workflowFromYaml(MINIMAL), repo, {
      allowDirty: true,
      credentialsResolver: () => true,
    });
  });

  it('does not require credentials for a workflow with no agent-driven node at all', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: t
    type: test
    config: { commands: ["true"] }
`;
    // Would fail if the check ran at all — proves it's skipped, not just satisfied.
    await preflight(workflowFromYaml(yaml), repo, {
      allowDirty: false,
      credentialsResolver: () => false,
    });
  });

  it('requires credentials for a workflow with only a Test node that has `agent: true` and instructions', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: t
    type: test
    config:
      commands: ["true"]
      agent: true
      instructions: look for flaky output
`;
    await expect(
      preflight(workflowFromYaml(yaml), repo, {
        allowDirty: false,
        credentialsResolver: () => false,
      }),
    ).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('requires credentials for a workflow with only a non-discuss agent-driven node', async () => {
    const repo = makeTempGitRepo();
    const yaml = `
nodes:
  - id: impl
    type: implement
    config: { instructions: x }
`;
    await expect(
      preflight(workflowFromYaml(yaml), repo, {
        allowDirty: false,
        credentialsResolver: () => false,
      }),
    ).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('checks the configured provider, not always claude', async () => {
    const repo = makeTempGitRepo();
    await expect(
      preflight(workflowFromYaml(MINIMAL), repo, {
        allowDirty: false,
        provider: 'openai',
      }),
    ).rejects.toMatchObject({ kind: 'credentials' });

    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    try {
      await preflight(workflowFromYaml(MINIMAL), repo, {
        allowDirty: false,
        provider: 'openai',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('run baseline', () => {
  it('on a clean tree, the baseline tree is HEAD^{tree}', async () => {
    const repo = makeTempGitRepo();
    const baseline = await recordBaseline(repo, false);
    expect(baseline.commit).toBe(repoGit(repo, 'rev-parse', 'HEAD'));
    expect(baseline.tree).toBe(repoGit(repo, 'rev-parse', 'HEAD^{tree}'));
    expect(baseline.dirtyOverride).toBe(false);
  });

  it('under the dirty override, pre-existing changes are inside the baseline — not in later diffs', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'README.md'), 'user was editing this\n');
    writeFileSync(join(repo, 'untracked-user-file.txt'), 'pre-existing\n');
    const baseline = await recordBaseline(repo, true);
    expect(baseline.tree).not.toBe(repoGit(repo, 'rev-parse', 'HEAD^{tree}'));

    // Nothing changed since the snapshot: the diff must be empty.
    expect(await diffAgainstTree(repo, baseline.tree)).toBe('');

    // An agent-made change after the baseline is the only thing that appears.
    writeFileSync(join(repo, 'agent-file.txt'), 'agent output\n');
    const diff = await diffAgainstTree(repo, baseline.tree);
    expect(diff).toContain('agent-file.txt');
    expect(diff).not.toContain('untracked-user-file');
    expect(diff).not.toContain('user was editing');
  });

  it('captureTree sees untracked files and leaves the real index untouched', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const tree = await captureTree(repo);
    const files = repoGit(repo, 'ls-tree', '--name-only', tree);
    expect(files).toContain('new.txt');
    // Real index untouched: new.txt still untracked.
    expect(repoGit(repo, 'status', '--porcelain')).toContain('?? new.txt');
  });

  it('a committed .flow-code/workflow.yaml is not reported as deleted, but run bookkeeping is excluded', async () => {
    const repo = makeTempGitRepo();
    mkdirSync(join(repo, '.flow-code', 'runs'), { recursive: true });
    writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), 'nodes: []\n');
    repoGit(repo, 'add', '-A');
    repoGit(repo, 'commit', '-q', '-m', 'add workflow.yaml');

    const baseline = await recordBaseline(repo, false);

    // Run bookkeeping written after the baseline (as if a run just happened).
    writeFileSync(join(repo, '.flow-code', 'runs', 'run-1.json'), '{}\n');

    const diff = await diffAgainstTree(repo, baseline.tree);
    expect(diff).toBe('');
  });
});

describe('concurrent worktree mutation', () => {
  /**
   * A Worktree-Agent node fans out with `Promise.all` and creates each
   * instance's worktree before taking a session slot, so `concurrency` does
   * not bound how many `git worktree add` calls are in flight at once.
   *
   * git cannot take that: an add reads every sibling worktree's `commondir`
   * while rewriting shared `.git/worktrees/` metadata, so a racing pair can
   * have one read a file the other has not finished writing — reported as
   * `failed to read .git/worktrees/<sibling>/commondir: Undefined error: 0`.
   * The window is narrow enough that this passed on ext4 for months and
   * failed the first time it ran on APFS.
   */
  it('creates every worktree when a fan-out adds them all at once', async () => {
    const repo = makeTempGitRepo();
    const start = await headCommit(repo);
    mkdirSync(join(repo, '.flow-code', 'worktrees'), { recursive: true });

    const instances = Array.from({ length: 8 }, (_, i) => `fan-${i}`);
    await Promise.all(
      instances.map((id) =>
        addWorktree(repo, join(repo, '.flow-code', 'worktrees', id), `flow-code/test/${id}`, start),
      ),
    );

    const dirs = await listWorktreeDirs(repo);
    for (const id of instances) {
      expect(dirs.some((d) => d.endsWith(id))).toBe(true);
    }
  });

  it('removes them all when the fan-out tears down at once', async () => {
    const repo = makeTempGitRepo();
    const start = await headCommit(repo);
    mkdirSync(join(repo, '.flow-code', 'worktrees'), { recursive: true });

    const instances = Array.from({ length: 6 }, (_, i) => `tear-${i}`);
    const dirOf = (id: string) => join(repo, '.flow-code', 'worktrees', id);
    await Promise.all(
      instances.map((id) => addWorktree(repo, dirOf(id), `flow-code/test/${id}`, start)),
    );

    await Promise.all(instances.map((id) => removeWorktree(repo, dirOf(id))));

    const dirs = await listWorktreeDirs(repo);
    for (const id of instances) {
      expect(dirs.some((d) => d.endsWith(id))).toBe(false);
    }
  });

  it('lets the rest through when one add fails', async () => {
    const repo = makeTempGitRepo();
    const start = await headCommit(repo);
    mkdirSync(join(repo, '.flow-code', 'worktrees'), { recursive: true });

    // Two adds claiming the same branch: the second must fail without
    // stranding everything queued behind it on the serialization chain.
    const results = await Promise.allSettled([
      addWorktree(repo, join(repo, '.flow-code', 'worktrees', 'a'), 'flow-code/test/dup', start),
      addWorktree(repo, join(repo, '.flow-code', 'worktrees', 'b'), 'flow-code/test/dup', start),
      addWorktree(repo, join(repo, '.flow-code', 'worktrees', 'c'), 'flow-code/test/c', start),
    ]);

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const dirs = await listWorktreeDirs(repo);
    expect(dirs.some((d) => d.endsWith('c'))).toBe(true);
  });
});
