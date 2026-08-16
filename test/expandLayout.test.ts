import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandRecordedGraph } from '../src/workflow/record.js';
import { computeLayout } from '../src/ui/layout.js';
import { workflowFromYaml } from './helpers.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'flow-code-expand-layout-'));
}

describe('an expanded graph lays out identically to the same shape hand-written', () => {
  it('produces the same boxes as the equivalent flat workflow file', () => {
    const repoRoot = tempDir();
    const spine = workflowFromYaml(`
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
`);
    const { workflow: expanded } = expandRecordedGraph(
      spine,
      'plan',
      {
        nodes: [
          { id: 'a', type: 'implement', config: { instructions: 'x' } },
          { id: 'b', type: 'implement', config: { instructions: 'y' } },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
      { repoRoot },
    );

    // What a person would have written by hand for the same shape: `plan`
    // feeding `a`, `b` feeding `gate` — exactly what splicing produces.
    const handWritten = workflowFromYaml(`
nodes:
  - id: plan
    type: plan
  - id: a
    type: implement
    config: { instructions: x }
  - id: b
    type: implement
    config: { instructions: y }
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: a }
  - { from: a, to: b }
  - { from: b, to: gate }
  - { from: gate, to: git-ops }
`);

    const expandedLayout = computeLayout(expanded);
    const handLayout = computeLayout(handWritten);

    expect(expandedLayout.width).toBe(handLayout.width);
    expect(expandedLayout.height).toBe(handLayout.height);
    for (const id of ['plan', 'a', 'b', 'gate', 'git-ops']) {
      expect(expandedLayout.boxes.get(id)).toEqual(handLayout.boxes.get(id));
    }
  });
});
