/**
 * The ownership check must not turn every write into a read.
 *
 * This lives in its own file because proving it means instrumenting `node:fs`,
 * and a module-level mock applies to everything in the file. It is a real
 * property rather than a micro-optimisation: the persister writes on every
 * node transition and every intercepted tool call, and a run's document grows
 * to include its whole activity log — re-parsing that on each write would make
 * the cost of recording a run scale with how much the run has already done.
 */

import { describe, expect, it, vi } from 'vitest';

const reads: string[] = [];
const writes: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (path: never, ...rest: never[]) => {
      reads.push(String(path));
      return (actual.readFileSync as (...args: never[]) => string)(path, ...rest);
    },
    writeFileSync: (path: never, ...rest: never[]) => {
      writes.push(String(path));
      return (actual.writeFileSync as (...args: never[]) => void)(path, ...rest);
    },
  };
});

const { FileRunStatePersister } = await import('../src/runstate/persist.js');
const { RunStateStore } = await import('../src/runstate/store.js');
const { makeTempGitRepo } = await import('./helpers.js');

function runFileReads(): string[] {
  return reads.filter((p) => p.includes('.flow-code') && p.includes('runs'));
}

describe('the ownership check costs a stat on the common path', () => {
  it('never re-reads a document this writer left untouched', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['a', 'b'] });
    store.attachPersister(new FileRunStatePersister(repo));
    reads.length = 0;

    store.setStatus('a', 'running');
    store.setStatus('a', 'done');
    store.setStatus('b', 'running');

    expect(runFileReads()).toEqual([]);
  });

  it('reads exactly once when something else has written since', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    const persister = new FileRunStatePersister(repo);
    store.attachPersister(persister);

    // A second writer touches the file, moving its stat signature. Only now is
    // a read worth doing — and only one, to compare owner tokens.
    new FileRunStatePersister(repo).persist({ ...store.snapshot(), owner: store.snapshot().owner! });
    reads.length = 0;

    persister.persist(store.snapshot());
    expect(runFileReads()).toHaveLength(1);
  });
});

describe('the published document is only ever replaced whole', () => {
  it('never writes to the published path — every write lands on a temporary and is renamed over', () => {
    const repo = makeTempGitRepo();
    const store = new RunStateStore({ repoRoot: repo, nodeIds: ['a'] });
    store.attachPersister(new FileRunStatePersister(repo));
    writes.length = 0;

    store.setStatus('a', 'running');
    store.setStatus('a', 'done');

    const runWrites = writes.filter((p) => p.includes('runs'));
    expect(runWrites.length).toBeGreaterThan(0);
    // A reader can therefore only ever open the previous complete document or
    // the next one: there is no window in which the published path holds half
    // of either.
    expect(runWrites.every((p) => p.endsWith('.tmp'))).toBe(true);
  });
});
