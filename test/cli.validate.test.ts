import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkflowOrFail } from '../src/cli/context.js';
import { cmdValidate } from '../src/cli/validate.js';

function tempRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'flow-code-validate-')));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function repoWithWorkflow(yaml: string): string {
  const repo = tempRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), yaml);
  return repo;
}

function captureOutput() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const lines = (spy: typeof log): string =>
    spy.mock.calls.map(([line]) => String(line)).join('\n');
  return { exit, out: () => lines(log), err: () => lines(error) };
}

const VALID = `
nodes:
  - id: impl
    type: implement
    config: { instructions: do the thing }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
edges:
  - { from: impl, to: check }
`;

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe('flow-code validate', () => {
  it('accepts a valid file without writing a run document or starting anything', async () => {
    const repo = repoWithWorkflow(VALID);
    process.chdir(repo);
    const { exit, out } = captureOutput();

    await cmdValidate();

    expect(exit).not.toHaveBeenCalled();
    expect(out()).toContain('is valid');
    expect(out()).toContain('2 nodes, 1 edge');
    // The reason this command is safe to run on a file you are mid-edit on.
    expect(existsSync(join(repo, '.flow-code', 'runs'))).toBe(false);
  });

  it('rejects an invalid file, listing every failure it found', async () => {
    const repo = repoWithWorkflow(`
nodes:
  - id: mystery
    type: no-such-type
  - id: impl
    type: implement
    config: { instructions: 12 }
edges:
  - { from: impl, to: ghost }
`);
    process.chdir(repo);
    const { exit, err } = captureOutput();

    await expect(cmdValidate()).rejects.toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    expect(err()).toContain('no-such-type');
    expect(err()).toContain('impl');
    expect(err()).toContain('ghost');
  });

  it('says which checks a failure stopped it from reaching', async () => {
    const repo = repoWithWorkflow('nodes: [oh: [dear');
    process.chdir(repo);
    const { exit, err } = captureOutput();

    await expect(cmdValidate()).rejects.toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    expect(err()).toContain('Not evaluated');
    expect(err()).toContain('graph structure');
  });

  it('rejects an ungated git-writing node, without starting a run', async () => {
    const repo = repoWithWorkflow(`
nodes:
  - id: impl
    type: implement
    config: { instructions: do the thing }
  - id: ship
    type: git-ops
edges:
  - { from: impl, to: ship }
`);
    process.chdir(repo);
    const { exit, err } = captureOutput();

    await expect(cmdValidate()).rejects.toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    expect(err()).toContain('ship');
    expect(err()).toContain('Approval-Gate');
    expect(existsSync(join(repo, '.flow-code', 'runs'))).toBe(false);
  });

  it('reports a missing file as missing, pointing at `init`', async () => {
    const repo = tempRepo();
    process.chdir(repo);
    const { exit, err } = captureOutput();

    await expect(cmdValidate()).rejects.toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    expect(err()).toContain('no workflow file at');
    expect(err()).toContain('flow-code init');
  });
});

describe('flow-code validate — named graphs', () => {
  it('reports every declared graph, all passing', async () => {
    const repo = repoWithWorkflow(`
graphs:
  quick:
    description: fast path
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
  hardened:
    description: extra scrutiny
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
      - id: check
        type: test
        config: { commands: ["echo ok"] }
    edges: []
`);
    process.chdir(repo);
    const { exit, out } = captureOutput();

    await cmdValidate();

    expect(exit).not.toHaveBeenCalled();
    expect(out()).toContain('declares 2 named graphs');
    expect(out()).toContain('graph `quick` is valid');
    expect(out()).toContain('graph `hardened` is valid');
  });

  it('attributes a failure to the graph it came from, and still reports the other as valid', async () => {
    const repo = repoWithWorkflow(`
graphs:
  quick:
    nodes:
      - id: impl
        type: implement
        config: { instructions: x }
  hardened:
    nodes:
      - id: impl
        type: no-such-type
`);
    process.chdir(repo);
    const { exit, out, err } = captureOutput();

    await expect(cmdValidate()).rejects.toThrow('process.exit called');

    expect(exit).toHaveBeenCalledWith(1);
    expect(out()).toContain('graph `quick` is valid');
    expect(err()).toContain('graph `hardened` is invalid');
    expect(err()).toContain('no-such-type');
  });
});

describe('validate and run agree', () => {
  // The guarantee: a file `validate` accepts cannot then fail a pre-execution
  // check. Both go through `loadWorkflow`, and this is what would catch a
  // check being added to one path and not the other.
  const fixtures: Array<{ name: string; yaml: string }> = [
    { name: 'the valid graph', yaml: VALID },
    { name: 'an unknown node type', yaml: 'nodes:\n  - { id: x, type: nope }\n' },
    {
      name: 'a dangling edge',
      yaml: 'nodes:\n  - { id: x, type: implement, config: { instructions: a } }\nedges:\n  - { from: x, to: nowhere }\n',
    },
    {
      name: 'a loop-back pointing the wrong way',
      yaml: `
nodes:
  - { id: a, type: implement, config: { instructions: a } }
  - { id: b, type: implement, config: { instructions: b } }
edges:
  - { from: a, to: b }
  - { from: a, to: b, loopback: { maxAttempts: 2 } }
`,
    },
    { name: 'unparseable YAML', yaml: 'nodes: [oh: [dear' },
    {
      name: 'an ungated git-writing node',
      yaml: 'nodes:\n  - { id: x, type: implement, config: { instructions: a } }\n  - { id: y, type: git-ops }\nedges:\n  - { from: x, to: y }\n',
    },
  ];

  for (const { name, yaml } of fixtures) {
    it(`agrees on ${name}`, async () => {
      const repo = repoWithWorkflow(yaml);
      process.chdir(repo);
      captureOutput();

      const validateAccepted = await cmdValidate().then(
        () => true,
        () => false,
      );
      let runAccepted: boolean;
      try {
        loadWorkflowOrFail(repo);
        runAccepted = true;
      } catch {
        runAccepted = false;
      }

      expect(validateAccepted).toBe(runAccepted);
    });
  }
});
