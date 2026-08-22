import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/cli.js';

/**
 * What `npx @easonliuuuuu/flow-code` depends on, asserted against the manifest
 * rather than by publishing and finding out. Every rule here corresponds to a
 * way a zero-install run has actually broken or would have.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  version: string;
};

describe('the published package', () => {
  it('has no `prepare` script — it would run on install, in a package that ships no source to build', () => {
    // `files` ships dist/ and plugin/ only: no src/, no tsconfig, and
    // typescript is a devDependency, so a build hook that runs during someone
    // else's install can only fail. `prepack` runs when packing instead.
    expect(manifest.scripts['prepare']).toBeUndefined();
    expect(manifest.scripts['prepack']).toBe('npm run build');
  });

  it('ships the directory its bin lives in', () => {
    const bin = manifest.bin['flow-code']!;
    expect(bin).toBe('dist/cli.js');
    expect(manifest.files).toContain(bin.split('/')[0]);
  });

  it('names its bin after the unscoped package name, so bare `npx @easonliuuuuu/flow-code` resolves it', () => {
    expect(Object.keys(manifest.bin)).toEqual(['flow-code']);
  });

  it('keeps every runtime dependency out of devDependencies', () => {
    for (const name of Object.keys(manifest.dependencies)) {
      expect(manifest.devDependencies[name]).toBeUndefined();
    }
  });

  it('declares the node floor npx checks before it will run anything', () => {
    expect(manifest.engines.node).toBe('>=20');
  });
});

describe('packageVersion', () => {
  it('reads the manifest rather than a baked-in constant, so a release bump cannot drift', () => {
    expect(packageVersion()).toBe(manifest.version);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
