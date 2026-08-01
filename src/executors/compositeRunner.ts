import type { RunStateStore } from '../runstate/store.js';
import type { AgentSessionRequest, InteractiveAgentSession, SessionRunner } from '../engine/types.js';
import type { Workflow } from '../workflow/load.js';

/**
 * Routes each node's session to a runner by node type: `discuss` goes to the
 * Claude Agent SDK runner (interactive, and free for anyone already logged
 * into Claude Code); every other agent-driven node type goes to the
 * NVIDIA-backed runner. See design.md in the add-nvidia-session-runner
 * change for why Discuss isn't ported yet.
 */
export class CompositeSessionRunner implements SessionRunner {
  private readonly typeByNodeId: Map<string, string>;

  constructor(
    workflow: Workflow,
    private readonly claudeRunner: SessionRunner,
    private readonly nvidiaRunner: SessionRunner,
  ) {
    this.typeByNodeId = new Map(workflow.nodes.map((n) => [n.id, n.type.id]));
  }

  private runnerFor(nodeId: string): SessionRunner {
    const typeId = this.typeByNodeId.get(nodeId);
    if (typeId === undefined) {
      throw new Error(`CompositeSessionRunner: unknown node id "${nodeId}"`);
    }
    return typeId === 'discuss' ? this.claudeRunner : this.nvidiaRunner;
  }

  async run(req: AgentSessionRequest, store: RunStateStore): Promise<{ finalText: string }> {
    return this.runnerFor(req.nodeId).run(req, store);
  }

  async openInteractive(req: AgentSessionRequest, store: RunStateStore): Promise<InteractiveAgentSession> {
    return this.runnerFor(req.nodeId).openInteractive(req, store);
  }
}
