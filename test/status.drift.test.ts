import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempGitRepo } from './helpers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `scripts/status.mjs` resolves every path it reads from its own location, so
 * it cannot be pointed at a fixture — it has to be copied into one and run as
 * a subprocess. That is the whole reason this is the first test under
 * `scripts/`: the guard it covers is one that failed silently for a release,
 * and an untested guard fails exactly the same way a missing one does.
 */
function fixtureRepo(options: { attributeArchive: boolean }): string {
  const dir = makeTempGitRepo();

  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'status.mjs'), join(dir, 'scripts', 'status.mjs'));
  // The script imports `yaml`; the fixture has no install of its own.
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');

  mkdirSync(join(dir, 'docs', 'product'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'product', 'roadmap.md'),
    ['## M0 — The core run works', '', '### BR-08 — A run does what the graph says it does', ''].join('\n'),
  );
  writeFileSync(
    join(dir, 'docs', 'product', 'coverage.yaml'),
    [
      'scopes:',
      '  engine: [workflow-graph]',
      'modules:',
      '  engine: [workflow-graph]',
      'capabilities:',
      '  workflow-graph: BR-08',
      'changes: {}',
      'archived:',
      options.attributeArchive ? '  2026-01-01-shipped-thing: BR-08' : '  {}',
      'registered_gaps: []',
    ].join('\n'),
  );

  mkdirSync(join(dir, 'openspec', 'specs', 'workflow-graph'), { recursive: true });
  writeFileSync(
    join(dir, 'openspec', 'specs', 'workflow-graph', 'spec.md'),
    '# workflow-graph Specification\n',
  );

  const archived = join(dir, 'openspec', 'changes', 'archive', '2026-01-01-shipped-thing');
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(archived, 'tasks.md'), '## 1. Work\n\n- [x] 1.1 Did it\n');

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'engine.ts'), 'export const x = 1;\n');

  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
  return dir;
}

function runCheck(dir: string): { code: number; stderr: string } {
  try {
    execFileSync('node', ['scripts/status.mjs', '--check'], { cwd: dir, encoding: 'utf8' });
    return { code: 0, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? '' };
  }
}

/** Generate STATUS.md first, so `--check` fails on drift rather than staleness. */
function generate(dir: string): void {
  execFileSync('node', ['scripts/status.mjs'], { cwd: dir, encoding: 'utf8' });
}

describe('status drift: unattributed archives', () => {
  it('fails when an archived change is claimed by no business requirement', () => {
    const dir = fixtureRepo({ attributeArchive: false });
    generate(dir);

    const { code, stderr } = runCheck(dir);

    expect(code).not.toBe(0);
    expect(stderr).toContain('2026-01-01-shipped-thing');
    expect(stderr).toContain('serves no business requirement');
  });

  it('points at the pre-archive name, because that is where the entry usually still is', () => {
    const dir = fixtureRepo({ attributeArchive: false });
    generate(dir);

    expect(runCheck(dir).stderr).toContain('before archiving');
  });

  it('passes once the archive is attributed', () => {
    const dir = fixtureRepo({ attributeArchive: true });
    generate(dir);

    expect(runCheck(dir).code).toBe(0);
  });

  it('renders the attributed archive under its requirement rather than dropping it', () => {
    const dir = fixtureRepo({ attributeArchive: true });
    generate(dir);

    const rendered = execFileSync('cat', ['STATUS.md'], { cwd: dir, encoding: 'utf8' });
    expect(rendered).toContain('2026-01-01-shipped-thing');
    expect(rendered).toContain('BR-08');
  });
});
