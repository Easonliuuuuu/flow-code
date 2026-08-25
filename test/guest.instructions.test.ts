/**
 * Instructions are the only thing standing between "this project has a graph"
 * and an agent that knows what the graph is. They are generated rather than
 * written, which is what makes them checkable — regenerate, compare, and a
 * workflow that has moved on since the install becomes visible instead of
 * quietly producing runs against a shape that no longer exists.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdConnect, inspect, mergeMcpConfig } from '../src/cli/connect.js';
import {
  describeDrift,
  generateInstructions,
  installedSection,
  instructionsSection,
  instructionState,
  nodeBrief,
  spliceSection,
} from '../src/guest/instructions.js';
import { makeTempGitRepo, workflowFromYaml } from './helpers.js';

const YAML = `
nodes:
  - id: discuss
    type: discuss
    config: { topic: what to build }
  - id: implement
    type: implement
    config: { instructions: build it }
  - id: check
    type: test
    config: { commands: ["echo ok"] }
edges:
  - { from: discuss, to: implement }
  - { from: implement, to: check }
  - { from: check, to: implement, loopback: { maxAttempts: 3 } }
`;

const workflow = workflowFromYaml(YAML);

describe('generated instructions describe this project and no other', () => {
  const text = generateInstructions(workflow);

  it('names the project\'s own nodes in order', () => {
    expect(text).toContain('`discuss`');
    expect(text).toContain('`implement`');
    expect(text).toContain('`check`');
    expect(text.indexOf('`discuss`')).toBeLessThan(text.indexOf('`implement`'));
    // A node the workflow does not have must not appear just because the
    // default scaffold has one.
    expect(text).not.toContain('`review`');
  });

  it('states what each node has to produce, in enough detail to pass its validation', () => {
    // The output summaries come from the node type itself, which is what
    // `flow-code node-types` prints and what the validator checks against.
    expect(text).toContain('changedFiles');
    expect(text).toContain('passed (boolean)');
  });

  it('explains the loop-back as work the agent does, since nothing routes it', () => {
    expect(text).toContain('When `check` fails, go back to `implement`');
    expect(text).toContain('3 attempts');
    expect(text).toMatch(/Nothing routes you back/);
  });

  it('says plainly that nothing is enforced, when nothing is', () => {
    expect(text).toContain('`reported` tier');
    expect(text).toMatch(/does not restrict which tools you use/);
  });

  it('says what is enforced instead, when the enforcement layer is in force', () => {
    // Telling an agent nothing is checked while calls are in fact being denied
    // is what makes it read a denial as a bug and route around it.
    const enforced = generateInstructions(workflow, { enforced: true });
    expect(enforced).toMatch(/denied if they fall outside it/);
    expect(enforced).toContain('A denial is the boundary');
    expect(enforced).not.toContain('`reported` tier');
    // The half that is still not in force is named just as plainly.
    expect(enforced).toMatch(/What is \*not\* enforced/);
  });
});

describe('a graph that can grow says so', () => {
  const PLANNED = `
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: ship
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: ship }
`;

  it('tells the agent that completing the Plan node splices its proposal into the run', () => {
    const text = generateInstructions(workflowFromYaml(PLANNED));

    expect(text).toContain('This step changes the graph');
    // The three things the brief cannot leave out: what the output is, where
    // it goes, and who is the authority afterwards.
    expect(text).toContain('proposed set of nodes and edges');
    expect(text).toContain('between this step and `gate`');
    expect(text).toContain('the run — not these instructions');
  });

  it('tells it a refused proposal leaves the step running, so it can propose again', () => {
    expect(generateInstructions(workflowFromYaml(PLANNED))).toContain('propose again');
  });

  it('asks for a graph rather than a conclusion, which is what the schema takes', () => {
    const text = generateInstructions(workflowFromYaml(PLANNED));

    // The generic interactive phrasing would send an agent off reporting prose
    // against an output shape that takes nodes and edges.
    expect(text).not.toContain('report the conclusion you both reached');
    expect(text).toContain('propose the graph that carries it out');
  });

  it('says nothing about expansion for a graph with no Plan node', () => {
    const text = generateInstructions(workflow);

    expect(text).not.toContain('changes the graph');
    expect(text).not.toContain('propose again');
  });

  it('still reports a freshly generated section as current, so `connect --check` is not tripped', () => {
    const planned = workflowFromYaml(PLANNED);

    expect(instructionState(instructionsSection(planned), planned)).toBe('current');
    // And drift detection still reads the node headings out of it — the extra
    // bullet must not disturb the `### n. \`id\`` shape it parses.
    expect(describeDrift(instructionsSection(planned), planned)).toEqual([
      "a step's configuration or output shape changed",
    ]);
  });
});

describe('installing into a file the user owns', () => {
  const section = instructionsSection(workflow);

  it('leaves unrelated content byte-identical', () => {
    const existing = '# My project\n\nSome house rules.\n';
    const after = spliceSection(existing, section);
    expect(after).toContain('# My project');
    expect(after).toContain('Some house rules.');
    expect(after.indexOf('# My project')).toBe(0);
  });

  it('is idempotent — a second install with no change rewrites nothing', () => {
    const once = spliceSection('# My project\n', section);
    expect(spliceSection(once, section)).toBe(once);
  });

  it('replaces only its own section when the workflow changes', () => {
    const existing = spliceSection('# My project\n\nHouse rules.\n', section);
    const changed = workflowFromYaml(YAML.replace('  - { from: check, to: implement, loopback: { maxAttempts: 3 } }\n', ''));
    const after = spliceSection(existing, instructionsSection(changed));

    expect(after).toContain('House rules.');
    expect(after).not.toContain('When `check` fails');
    expect(installedSection(after)).toBeDefined();
  });
});

describe('staleness', () => {
  it('tells never-installed apart from out-of-date', () => {
    expect(instructionState(undefined, workflow)).toBe('absent');
    expect(instructionState(instructionsSection(workflow), workflow)).toBe('current');

    const grown = workflowFromYaml(
      YAML.replace(
        'edges:',
        `  - id: review\n    type: review\n    config: { instructions: review it }\nedges:\n  - { from: check, to: review }`,
      ),
    );
    expect(instructionState(instructionsSection(workflow), grown)).toBe('stale');
  });

  it('names the difference rather than only reporting one', () => {
    const grown = workflowFromYaml(
      YAML.replace(
        'edges:',
        `  - id: review\n    type: review\n    config: { instructions: review it }\nedges:\n  - { from: check, to: review }`,
      ),
    );
    expect(describeDrift(instructionsSection(workflow), grown).join(' ')).toContain('added: review');
  });
});

describe('registering the MCP server', () => {
  const entry = { command: 'flow-code', args: ['mcp'] };

  it('keeps servers somebody else registered', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'other-thing' } } });
    const merged = JSON.parse(mergeMcpConfig(existing, entry)!) as {
      mcpServers: Record<string, unknown>;
    };
    expect(merged.mcpServers.other).toEqual({ command: 'other-thing' });
    expect(merged.mcpServers['flow-code']).toEqual(entry);
  });

  it('reports nothing to do when the entry is already exactly right', () => {
    const existing = JSON.stringify({ mcpServers: { 'flow-code': entry } });
    expect(mergeMcpConfig(existing, entry)).toBeUndefined();
  });

  it('refuses to overwrite a config it cannot parse', () => {
    expect(() => mergeMcpConfig('{ not json', entry)).toThrow(/not valid JSON/);
  });
});

describe('flow-code connect', () => {
  function repo(): string {
    const dir = makeTempGitRepo();
    mkdirSync(join(dir, '.flow-code'), { recursive: true });
    writeFileSync(join(dir, '.flow-code', 'workflow.yaml'), YAML);
    return dir;
  }

  async function connect(dir: string, args: string[] = []): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await cmdConnect(args);
      return log.mock.calls.map(([line]) => String(line)).join('\n');
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  }

  it('names every file it changed, and says what it did not install', async () => {
    const dir = repo();
    const out = await connect(dir);

    expect(out).toContain('.claude/skills/flow-code-workflow/SKILL.md');
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('.mcp.json');
    expect(out).toContain('.claude/settings.json');
    // What is enforced and what is not are both stated on every install: the
    // failure this guards against is reading a green graph as a stronger
    // claim than it is.
    expect(out).toContain('Installed: the reporting tools');
    expect(out).toContain('Still not in force');
  });

  it('changes nothing on a second run', async () => {
    const dir = repo();
    await connect(dir);
    const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8');

    const out = await connect(dir);
    expect(out).toContain('already connected');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(before);
  });

  it('installs beside an existing CLAUDE.md rather than creating a second file', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n\nAlways run the linter.\n');
    await connect(dir);

    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('Always run the linter.');
    expect(claude).toContain('`discuss`');
    expect(() => readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toThrow();
  });

  it('--check reports what is installed without installing anything', async () => {
    const dir = repo();
    const before = await connect(dir, ['--check']);
    expect(before).toContain('missing');
    expect(() => readFileSync(join(dir, '.mcp.json'), 'utf8')).toThrow();

    await connect(dir);
    expect(await connect(dir, ['--check'])).not.toContain('missing');
  });

  it('--check reports installed instructions as stale once the workflow moves on', async () => {
    const dir = repo();
    await connect(dir);
    writeFileSync(
      join(dir, '.flow-code', 'workflow.yaml'),
      YAML.replace(
        'edges:',
        `  - id: review\n    type: review\n    config: { instructions: review it }\nedges:\n  - { from: check, to: review }`,
      ),
    );

    const out = await connect(dir, ['--check']);
    expect(out).toContain('stale');
    expect(out).toContain('added: review');
  });

  it('hands a step the outputs of the steps above it', () => {
    // The failure this prevents: a Review subagent gets a brief, has `read`
    // only, and so can neither be given the diff nor go and fetch it. The
    // engine avoids this by serializing upstream outputs into node context;
    // a brief is where a guest run does the same.
    const brief = nodeBrief(workflow, 'check', {
      discuss: { conclusion: 'build the thing', constraints: [] },
      implement: { changedFiles: ['src/a.ts'], diff: '@@ -1 +1 @@' },
    })!;

    expect(brief).toContain('## Upstream context');
    expect(brief).toContain('`implement`');
    expect(brief).toContain('@@ -1 +1 @@');
    // Only what it directly depends on: `discuss` is upstream of `implement`,
    // not of `check`, and carrying the whole ancestry would bury the diff.
    expect(brief).not.toContain('build the thing');
  });

  it('truncates a large upstream output rather than dropping it', () => {
    const brief = nodeBrief(workflow, 'check', {
      implement: { changedFiles: [], diff: 'x'.repeat(20_000) },
    })!;

    expect(brief).toContain('[truncated');
    expect(brief.length).toBeLessThan(10_000);
  });

  it('says nothing about upstream context when there is none to give', () => {
    expect(nodeBrief(workflow, 'implement', {})).not.toContain('Upstream context');
  });

  it('reports the same surfaces `inspect` reports, from the workflow alone', () => {
    const dir = repo();
    const reports = inspect(dir, workflow);
    expect(reports.map((r) => r.path)).toContain('.mcp.json');
    expect(reports.every((r) => r.state === 'absent')).toBe(true);
  });
});
