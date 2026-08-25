import { describe, expect, it } from 'vitest';
import { loadWorkflowFromString } from '../src/workflow/load.js';
import { describePlanProposal, spliceProposal, stripPlanNode } from '../src/workflow/splice.js';

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

describe('spliceProposal', () => {
  it('bridges a single-node proposal between plan and its original successors', () => {
    const workflow = loadWorkflowFromString(SPINE);
    const file = spliceProposal(workflow, 'plan', {
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
      edges: [],
    });
    expect(file.nodes.map((n) => n.id)).toEqual(['plan', 'gate', 'git-ops', 'impl']);
    expect(file.edges).toContainEqual({ from: 'plan', to: 'impl' });
    expect(file.edges).toContainEqual({ from: 'impl', to: 'gate' });
    // The plan node's own original edge to gate is gone — impl carries that now.
    expect(file.edges).not.toContainEqual({ from: 'plan', to: 'gate' });
  });

  it('bridges every proposal root and every proposal sink', () => {
    const workflow = loadWorkflowFromString(SPINE);
    const file = spliceProposal(workflow, 'plan', {
      nodes: [
        { id: 'a', type: 'implement', config: { instructions: 'x' } },
        { id: 'b', type: 'implement', config: { instructions: 'y' } },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    // `a` has no incoming proposal edge (a root); `b` has no outgoing one (a sink).
    expect(file.edges).toContainEqual({ from: 'plan', to: 'a' });
    expect(file.edges).not.toContainEqual({ from: 'plan', to: 'b' });
    expect(file.edges).toContainEqual({ from: 'b', to: 'gate' });
    expect(file.edges).not.toContainEqual({ from: 'a', to: 'gate' });
  });

  it('leaves the rest of the graph untouched', () => {
    const workflow = loadWorkflowFromString(SPINE);
    const file = spliceProposal(workflow, 'plan', {
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
      edges: [],
    });
    // gate -> git-ops survives verbatim, including its synthesized approval condition.
    expect(file.edges).toContainEqual({
      from: 'gate',
      to: 'git-ops',
      when: "gate.decision == 'approved'",
    });
  });

  it('preserves a proposal edge naming an existing node outside the proposal', () => {
    // The mechanism a bypass proposal actually uses: a proposed node wired
    // straight to a pre-existing node by id, skipping the mechanical bridge.
    const workflow = loadWorkflowFromString(SPINE);
    const file = spliceProposal(workflow, 'plan', {
      nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'x' } }],
      edges: [{ from: 'impl', to: 'git-ops' }],
    });
    expect(file.edges).toContainEqual({ from: 'impl', to: 'git-ops' });
  });
});

describe('describePlanProposal', () => {
  it('shows node types, configuration, and routing instead of reducing a graph to node order', () => {
    const text = describePlanProposal({
      nodes: [
        { id: 'impl', type: 'implement', config: { instructions: 'build it' } },
        { id: 'unit', type: 'test', config: { commands: ['npm test'] } },
      ],
      edges: [
        { from: 'impl', to: 'unit' },
        { from: 'unit', to: 'impl', loopback: { on: 'failure', maxAttempts: 2 } },
      ],
    });

    expect(text).toContain('- impl [implement] — {"instructions":"build it"}');
    expect(text).toContain('- unit [test] — {"commands":["npm test"]}');
    expect(text).toContain('- impl → unit');
    expect(text).toContain('- unit → impl (loopback on failure, max 2 attempts)');
  });
});

describe('stripPlanNode', () => {
  it('removes the plan node and every edge touching it, leaving its successors as roots', () => {
    const workflow = loadWorkflowFromString(`
nodes:
  - id: plan
    type: plan
  - id: a
    type: implement
    config: { instructions: x }
  - id: gate
    type: approval-gate
  - id: git-ops
    type: git-ops
edges:
  - { from: plan, to: a }
  - { from: a, to: gate }
  - { from: gate, to: git-ops }
`);
    const stripped = stripPlanNode(workflow);

    expect(stripped.nodes.map((n) => n.id)).toEqual(['a', 'gate', 'git-ops']);
    expect(stripped.edges).toEqual([
      { from: 'a', to: 'gate' },
      { from: 'gate', to: 'git-ops', when: "gate.decision == 'approved'" },
    ]);
  });

  it('leaves a graph with no plan node untouched', () => {
    const workflow = loadWorkflowFromString(`
nodes:
  - id: a
    type: implement
    config: { instructions: x }
`);
    const stripped = stripPlanNode(workflow);

    expect(stripped.nodes).toEqual([{ id: 'a', type: 'implement', config: { instructions: 'x' } }]);
    expect(stripped.edges).toEqual([]);
  });

});
