import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { expandRecordedGraph } from '../src/workflow/record.js';
import { writeKeptWorkflow } from '../src/workflow/write.js';

function emptyWorkflowFile(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'flow-code-keep-'));
  const path = join(repoRoot, '.flow-code', 'workflow.yaml');
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

const SPINE = `
nodes:
  - id: plan
    type: plan
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: gate }
  - { from: gate, to: git-ops }
`;

describe('writeKeptWorkflow', () => {
  it('writes a valid workflow file with no plan node, that itself loads without one', () => {
    const path = emptyWorkflowFile();
    const repoRoot = dirname(dirname(path));
    const spine = loadWorkflowFromString(SPINE, { repoRoot });
    const { workflow: expanded } = expandRecordedGraph(
      spine,
      'plan',
      {
        nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }],
        edges: [],
      },
      { repoRoot },
    );

    const written = writeKeptWorkflow(path, expanded);

    expect(written.nodes.map((n) => n.id).sort()).toEqual(['gate', 'git-ops', 'impl']);
    expect(written.nodes.some((n) => n.type.id === 'plan')).toBe(false);

    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('type: plan');
    const reloaded = loadWorkflowFromString(onDisk, { repoRoot });
    expect(reloaded.nodes.map((n) => n.id).sort()).toEqual(['gate', 'git-ops', 'impl']);
  });

  it('a kept graph runs directly on the next load — no plan node, so no planning session', () => {
    const path = emptyWorkflowFile();
    const repoRoot = dirname(dirname(path));
    const spine = loadWorkflowFromString(SPINE, { repoRoot });
    const { workflow: expanded } = expandRecordedGraph(
      spine,
      'plan',
      {
        nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'do it' } }],
        edges: [],
      },
      { repoRoot },
    );
    writeKeptWorkflow(path, expanded);

    const nextRun = loadWorkflowFromString(readFileSync(path, 'utf8'), { repoRoot });

    expect(nextRun.nodes.some((n) => n.type.interactive)).toBe(false);
    expect(nextRun.order).toEqual(['impl', 'gate', 'git-ops']);
  });
});
