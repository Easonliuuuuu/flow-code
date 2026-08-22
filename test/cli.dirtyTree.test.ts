import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDirtyListing, resolveDirtyTree } from '../src/cli/dirtyTree.js';
import { isDirty } from '../src/git/ops.js';
import { makeTempGitRepo, repoGit } from './helpers.js';

const REFUSAL = 'the working tree has uncommitted changes. …pass --allow-dirty…';

/** Makes `fail`'s process.exit observable rather than killing the test runner. */
function trapExit() {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { exit, error, log };
}

/** Runs `body` with stdin reporting as a TTY, so the interactive path is taken. */
async function asTTY<T>(body: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  process.stdin.isTTY = true;
  try {
    return await body();
  } finally {
    process.stdin.isTTY = original;
  }
}

function stashCount(repo: string): number {
  const out = execFileSync('git', ['stash', 'list'], { cwd: repo }).toString().trim();
  return out.length === 0 ? 0 : out.split('\n').length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatDirtyListing', () => {
  it('counts and lists every path, singular when there is one', () => {
    expect(formatDirtyListing([' M src/a.ts'])).toBe(
      'The working tree has 1 uncommitted change:\n   M src/a.ts',
    );
  });

  it('lists several, pluralised', () => {
    expect(formatDirtyListing([' M a.ts', '?? b.md'])).toBe(
      'The working tree has 2 uncommitted changes:\n   M a.ts\n  ?? b.md',
    );
  });

  it('stops listing past ten and counts the rest, so the prompt stays readable', () => {
    const entries = Array.from({ length: 14 }, (_, i) => ` M file${i}.ts`);
    const listing = formatDirtyListing(entries);
    expect(listing).toContain('has 14 uncommitted changes');
    expect(listing).toContain(' M file9.ts');
    expect(listing).not.toContain(' M file10.ts');
    expect(listing).toContain('…and 4 more');
  });
});

describe('resolveDirtyTree', () => {
  it('refuses with preflight\'s own wording, listing the paths, when there is no TTY to ask in', async () => {
    // The test runner's own stdin is not a TTY — exactly the condition that
    // must keep behaving the way CI has always seen it behave.
    expect(process.stdin.isTTY).toBeFalsy();
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const pick = vi.fn();
    const { error } = trapExit();

    await expect(() => resolveDirtyTree(repo, REFUSAL, { pick })).rejects.toThrow('process.exit called');
    expect(pick).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('?? dirty.txt'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(REFUSAL));
  });

  it('offers the paths in the prompt, so "stash them" is an informed answer', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    writeFileSync(join(repo, 'notes.md'), 'new\n');
    const pick = vi.fn().mockResolvedValue('continue');
    trapExit();

    await asTTY(() => resolveDirtyTree(repo, REFUSAL, { pick }));

    const [items, opts] = pick.mock.calls[0]!;
    expect(items.map((i: { value: string }) => i.value)).toEqual(['stash', 'continue', 'cancel']);
    expect(opts.prompt).toContain(' M README.md');
    expect(opts.prompt).toContain('?? notes.md');
  });

  it('leaves the tree alone and asks for a snapshot baseline when told to continue', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    trapExit();

    const resolution = await asTTY(() =>
      resolveDirtyTree(repo, REFUSAL, { pick: async () => 'continue' }),
    );

    expect(resolution).toEqual({ allowDirty: true });
    expect(stashCount(repo)).toBe(0);
    await expect(isDirty(repo)).resolves.toBe(true);
  });

  it('stashes tracked and untracked changes alike, leaving a clean tree to diff against HEAD', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    writeFileSync(join(repo, 'untracked.md'), 'new\n');
    trapExit();

    const resolution = await asTTY(() =>
      resolveDirtyTree(repo, REFUSAL, {
        pick: async () => 'stash',
        now: () => new Date('2026-08-23T00:00:00.000Z'),
      }),
    );

    // allowDirty stays false on purpose: the tree is at HEAD now, so HEAD's
    // tree is the right baseline and the approval diff shows agent work only.
    expect(resolution.allowDirty).toBe(false);
    await expect(isDirty(repo)).resolves.toBe(false);
    expect(repoGit(repo, 'show', 'HEAD:README.md')).toBe('hello');
    expect(stashCount(repo)).toBe(1);
    expect(repoGit(repo, 'stash', 'list')).toContain('flow-code: pre-run stash 2026-08-23T00:00:00.000Z');
  });

  it('reports the stash so the user can get their work back, before the run and after it', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    const { log } = trapExit();

    const resolution = await asTTY(() =>
      resolveDirtyTree(repo, REFUSAL, { pick: async () => 'stash' }),
    );

    expect(resolution.restoreNotice).toContain('stash@{0}');
    expect(resolution.restoreNotice).toContain('git stash pop');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('git stash pop'));

    // The stash the notice names is genuinely poppable.
    execFileSync('git', ['stash', 'pop'], { cwd: repo });
    await expect(isDirty(repo)).resolves.toBe(true);
  });

  it('stashes onto an existing stack rather than mistaking the old top for its own', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'README.md'), 'earlier work\n');
    execFileSync('git', ['stash', 'push', '-m', 'earlier'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    trapExit();

    const resolution = await asTTY(() =>
      resolveDirtyTree(repo, REFUSAL, { pick: async () => 'stash' }),
    );

    expect(stashCount(repo)).toBe(2);
    expect(resolution.restoreNotice).toBeDefined();
    await expect(isDirty(repo)).resolves.toBe(false);
  });

  it('cancels without touching the tree', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const { error } = trapExit();

    await expect(() =>
      asTTY(() => resolveDirtyTree(repo, REFUSAL, { pick: async () => 'cancel' })),
    ).rejects.toThrow('process.exit called');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    expect(stashCount(repo)).toBe(0);
    await expect(isDirty(repo)).resolves.toBe(true);
  });

  it('treats escape/ctrl+c as cancel, never as a silent fallback into running anyway', async () => {
    const repo = makeTempGitRepo();
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const { error } = trapExit();

    await expect(() =>
      asTTY(() => resolveDirtyTree(repo, REFUSAL, { pick: async () => undefined })),
    ).rejects.toThrow('process.exit called');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    expect(stashCount(repo)).toBe(0);
  });
});
