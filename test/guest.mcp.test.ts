/**
 * The MCP surface as a host session actually meets it: a tool call in, a
 * result out, over a real transport rather than by reaching into the closure.
 *
 * Only the parts that are reachable *here* are covered. The writer underneath
 * is `guest.report.test.ts`'s subject and the expansion itself is
 * `guest.expand.test.ts`'s; what neither can see is whether this surface
 * hands the agent back what the other surface does. Two reporting surfaces
 * that agree on run-state but disagree on what they say about it is exactly
 * the drift the shared writer exists to prevent.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/guest/mcp.js';
import { latestRunState } from '../src/runstate/watch.js';
import { rehydrateGraph } from '../src/workflow/record.js';
import { makeTempGitRepo } from './helpers.js';

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

const PROPOSAL = {
  nodes: [{ id: 'impl', type: 'implement', config: { instructions: 'build it' } }],
  edges: [],
};

function plannedRepo(): string {
  const repo = makeTempGitRepo();
  mkdirSync(join(repo, '.flow-code'), { recursive: true });
  writeFileSync(join(repo, '.flow-code', 'workflow.yaml'), PLANNED);
  return repo;
}

/** A client wired to a server over an in-memory pair — no process, no stdio. */
async function connect(repo: string): Promise<Client> {
  const server = buildMcpServer(repo);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** The text of a tool result, and whether the server refused it. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; refused: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
  return {
    text: result.content.map((c) => c.text ?? '').join('\n'),
    refused: result.isError === true,
  };
}

describe('completing a Plan node over MCP', () => {
  it('carries the ids the run now holds back to the session', async () => {
    const repo = plannedRepo();
    const client = await connect(repo);
    await call(client, 'open_run');
    await call(client, 'start_node', { node: 'plan' });

    const done = await call(client, 'complete_node', { node: 'plan', output: PROPOSAL });

    expect(done.refused).toBe(false);
    expect(done.text).toContain('plan → done');
    expect(done.text).toContain('plan → impl → gate → ship');
  });

  it('says the ids replace what the instructions listed, since the brief cannot be re-read', async () => {
    const repo = plannedRepo();
    const client = await connect(repo);
    await call(client, 'open_run');
    await call(client, 'start_node', { node: 'plan' });

    const done = await call(client, 'complete_node', { node: 'plan', output: PROPOSAL });

    expect(done.text).toContain('The graph grew');
    expect(done.text).toContain('replace');
  });

  it('adds nothing to a report that did not grow the graph', async () => {
    const repo = plannedRepo();
    const client = await connect(repo);
    await call(client, 'open_run');
    await call(client, 'start_node', { node: 'plan' });
    await call(client, 'complete_node', { node: 'plan', output: PROPOSAL });

    const started = await call(client, 'start_node', { node: 'impl' });

    expect(started.text).toContain('impl → running');
    expect(started.text).not.toContain('The graph grew');
  });

  it('refuses a proposal that routes around the gate, and leaves the step running', async () => {
    const repo = plannedRepo();
    const client = await connect(repo);
    await call(client, 'open_run');
    await call(client, 'start_node', { node: 'plan' });

    const bad = await call(client, 'complete_node', {
      node: 'plan',
      output: { nodes: [{ id: 'sneak', type: 'git-ops', config: {} }], edges: [] },
    });

    // Refused as a tool error the model can read and act on, not thrown — a
    // throw would reach the host as a server fault rather than as a reason to
    // propose a different graph.
    expect(bad.refused).toBe(true);
    expect(bad.text).toContain('Approval-Gate');
    expect(latestRunState(repo)!.nodes.plan!.status).toBe('running');
  });

  it('hands a brief for a node the proposal introduced, which no workflow file declares', async () => {
    const repo = plannedRepo();
    const client = await connect(repo);
    await call(client, 'open_run');
    await call(client, 'start_node', { node: 'plan' });
    await call(client, 'complete_node', { node: 'plan', output: PROPOSAL });

    const brief = await call(client, 'node_brief', { node: 'impl' });

    // Briefs are built from the run's recorded graph, so an expansion makes
    // them available for the new nodes with no further work — the property
    // that would break if the expansion were recorded anywhere else.
    expect(brief.refused).toBe(false);
    expect(brief.text).toContain('build it');
  });
});

describe('both reporting surfaces describe the same expansion', () => {
  it('returns the same node ids the CLI writer returns', async () => {
    const repo = plannedRepo();
    const client = await connect(repo);
    await call(client, 'open_run');
    await call(client, 'start_node', { node: 'plan' });
    const done = await call(client, 'complete_node', { node: 'plan', output: PROPOSAL });

    // Execution order, derived from the run's own recorded graph — not the
    // order the nodes happen to be stored in, and not a list either surface
    // composed for itself. A proposal's nodes are appended to the recording
    // but belong in the middle of the walk.
    const { order } = rehydrateGraph(latestRunState(repo)!.graph!, { repoRoot: repo });
    expect(order).toEqual(['plan', 'impl', 'gate', 'ship']);
    expect(done.text).toContain(order.join(' → '));
  });
});
