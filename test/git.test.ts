import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflight, PreflightError } from '../src/engine/preflight.js';
import { captureTree, diffAgainstTree, recordBaseline } from '../src/git/ops.js';
import { makeTempGitRepo, repoGit, workflowFromYaml } from './helpers.js';

const MINIMAL = `
nodes:
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
});
