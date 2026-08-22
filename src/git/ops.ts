import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunBaseline } from '../runstate/types.js';

const execFileAsync = promisify(execFile);

export async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function headCommit(dir: string): Promise<string> {
  return git(['rev-parse', 'HEAD'], dir);
}

/**
 * Every uncommitted path as a `git status --porcelain` line (`XY path`),
 * tracked and untracked alike. One definition of "dirty", so what preflight
 * refuses and what the prompt lists can never disagree.
 */
export async function dirtyEntries(dir: string): Promise<string[]> {
  const out = await git(['status', '--porcelain'], dir);
  return out.length === 0 ? [] : out.split('\n');
}

export async function isDirty(dir: string): Promise<boolean> {
  return (await dirtyEntries(dir)).length > 0;
}

/** The stash stack's top commit, or null when the repo has never stashed. */
async function stashTop(dir: string): Promise<string | null> {
  try {
    return await git(['rev-parse', '--verify', '--quiet', 'refs/stash'], dir);
  } catch {
    return null;
  }
}

/**
 * Stash everything uncommitted — tracked and untracked alike — leaving the
 * tree at HEAD. Returns the new stash commit, or null when git found nothing
 * to save after all.
 *
 * Deliberately a plain `git stash push -u` with no pathspec: the prompt that
 * offers this lists exactly what it is about to stash, so cleverness about
 * which paths to spare would only make the listing lie. Nothing pops this
 * automatically either — by the time a run ends the agent has edited the same
 * files, so restoring is a decision only the user can make.
 */
export async function stashAll(dir: string, message: string): Promise<string | null> {
  const before = await stashTop(dir);
  await git(['stash', 'push', '--include-untracked', '--message', message], dir);
  const after = await stashTop(dir);
  return after !== null && after !== before ? after : null;
}

/**
 * Snapshot the current working tree (tracked + untracked, respecting
 * excludes) as a tree object, without touching the real index or the tree
 * itself. Uses a temporary index file; blobs land in the object database so
 * later diffs can show content.
 */
export async function captureTree(dir: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'flow-code-index-'));
  const indexFile = join(tmp, 'index');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(['read-tree', 'HEAD'], dir, env);
    await git(['add', '-A'], dir, env);
    // flow-code's own run bookkeeping must never appear as agent output —
    // but only these are transient; a checked-in workflow.yaml must still be
    // diffed like any other tracked file.
    //
    // `reconcile` and `enforcement.json` matter for a subtler reason than
    // tidiness: reconciliation asks whether the tree has changed since the
    // baseline, and both are written *by* flow-code while a run is going. Left
    // in, the first reconciliation would make the tree look changed and every
    // one after it would answer its own question.
    await git(
      [
        'rm', '-r', '--cached', '--ignore-unmatch', '-q',
        '.flow-code/runs',
        '.flow-code/worktrees',
        '.flow-code/reconcile',
        '.flow-code/enforcement.json',
      ],
      dir,
      env,
    );
    return await git(['write-tree'], dir, env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Record the run baseline before any node starts. On a clean tree the
 * baseline tree is HEAD's tree; under the dirty override it snapshots the
 * working tree so pre-existing changes never appear as agent output.
 */
export async function recordBaseline(dir: string, dirtyOverride: boolean): Promise<RunBaseline> {
  const commit = await headCommit(dir);
  const tree = dirtyOverride ? await captureTree(dir) : await git(['rev-parse', 'HEAD^{tree}'], dir);
  return { commit, tree, dirtyOverride };
}

/** Diff the current working tree of `dir` against a baseline tree. */
export async function diffAgainstTree(dir: string, tree: string): Promise<string> {
  const current = await captureTree(dir);
  return git(['diff', tree, current], dir);
}

export async function diffStatAgainstTree(dir: string, tree: string): Promise<string> {
  const current = await captureTree(dir);
  return git(['diff', '--stat', tree, current], dir);
}

export async function changedFilesAgainstTree(dir: string, tree: string): Promise<string[]> {
  const current = await captureTree(dir);
  const out = await git(['diff', '--name-only', tree, current], dir);
  return out.length === 0 ? [] : out.split('\n');
}

export async function diffTrees(dir: string, treeA: string, treeB: string): Promise<string> {
  return git(['diff', treeA, treeB], dir);
}

export async function diffNamesBetweenTrees(
  dir: string,
  treeA: string,
  treeB: string,
): Promise<string[]> {
  const out = await git(['diff', '--name-only', treeA, treeB], dir);
  return out.length === 0 ? [] : out.split('\n');
}

export async function diffStatBetweenTrees(
  dir: string,
  treeA: string,
  treeB: string,
): Promise<string> {
  return git(['diff', '--stat', treeA, treeB], dir);
}

export async function worktreeSupported(dir: string): Promise<boolean> {
  try {
    await git(['worktree', 'list'], dir);
    return true;
  } catch {
    return false;
  }
}

export async function addWorktree(
  repoRoot: string,
  dir: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(['worktree', 'add', '-b', branch, dir, startPoint], repoRoot);
}

export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  await git(['worktree', 'remove', '--force', dir], repoRoot);
}

export async function listWorktreeDirs(repoRoot: string): Promise<string[]> {
  const out = await git(['worktree', 'list', '--porcelain'], repoRoot);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/** Commit everything in a worktree as flow-code itself (not agent-driven). */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(['add', '-A'], dir);
  const staged = await git(['diff', '--cached', '--name-only'], dir);
  if (staged.length === 0) return null;
  await git(
    ['-c', 'user.name=flow-code', '-c', 'user.email=flow-code@localhost', 'commit', '-m', message],
    dir,
  );
  return headCommit(dir);
}
