import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTestCommands } from '../../src/init/testDetect.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-testdetect-'));
}

describe('detectTestCommands', () => {
  it('returns nothing for a directory with no recognizable project files', () => {
    expect(detectTestCommands(tempDir())).toEqual([]);
  });

  it('suggests `npm test` for a bare "test" script', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(detectTestCommands(dir)).toEqual(['npm test']);
  });

  it('ignores the npm-generated placeholder test script', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    expect(detectTestCommands(dir)).toEqual([]);
  });

  it('picks up multiple test levels as separate commands, sorted', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          'test:e2e': 'playwright test',
          'test:integration': 'vitest run --config vitest.integration.ts',
          'test:watch': 'vitest', // excluded — doesn't run to completion
          build: 'tsc',
        },
      }),
    );
    expect(detectTestCommands(dir)).toEqual([
      'npm test',
      'npm run test:e2e',
      'npm run test:integration',
    ]);
  });

  it('uses yarn/pnpm when their lockfile is present', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectTestCommands(dir)).toEqual(['pnpm test']);
  });

  it('finds test targets in a Makefile', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'Makefile'), 'test:\n\tgo test ./...\n\ntest-integration:\n\t./run-integration.sh\n');
    expect(detectTestCommands(dir)).toEqual(['make test', 'make test-integration']);
  });

  it('suggests pytest for a project with a tests/ directory of .py files', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'test_foo.py'), 'def test_ok(): assert True\n');
    expect(detectTestCommands(dir)).toEqual(['pytest']);
  });

  it('suggests go test for a Go module', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\n');
    expect(detectTestCommands(dir)).toEqual(['go test ./...']);
  });

  it('suggests cargo test for a Rust crate', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "foo"\n');
    expect(detectTestCommands(dir)).toEqual(['cargo test']);
  });

  it('combines signals across ecosystems in a polyglot repo', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\n');
    expect(detectTestCommands(dir)).toEqual(['npm test', 'go test ./...']);
  });
});
