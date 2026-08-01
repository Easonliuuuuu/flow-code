## Why

Coding agent sessions today are a scrolling chat log: status, review findings, and risky actions (like pushing to git) are all mixed into text you have to read carefully to not miss. There's no existing tool that renders a coding task's lifecycle (spec discussion, implementation, validation, review, git operations) as a live, interactive graph in the terminal — and none let you fan work out across multiple agents in isolated git worktrees and watch them converge. flow-code fills that gap: a terminal-native, node-graph interface for running and observing agentic coding workflows, replacing the chatbox with a flowchart.

## What Changes

- New standalone terminal application (own CLI, `flow-code`) that runs a coding task as a configurable graph of nodes rendered live with mouse-interactive boxes and connecting edges.
- A built-in node type palette: Discuss, Implement, Test, Validate, Review, Git-ops, Worktree-Agent (parallel), and Approval-Gate. Each type is defined by a capability set, a default role prompt, and an output schema — so the types differ in what they are *allowed to do* and what they *produce*, not just in their wording.
- A workflow definition file (per-project, checked into the repo) describing which nodes are used and how they're connected — no custom code required to compose a graph. Edges carry no behavior; blocking and approval are expressed by placing nodes.
- Each node's execution is driven directly via the Claude Agent SDK (not by shelling out to an interactive `claude` session) and streams live status (idle/running/waiting/done/error/skipped) back to the graph.
- A capability harness wraps every agent session: the node type's declared capabilities are compiled into tool restrictions and a per-call interception check, so an Implement node physically cannot `git push` and a Review node cannot edit the code it is reviewing. Enforcement is structural, not a prompt instruction.
- A per-node tool-call activity log records every command the agent attempted — timestamp, command, allowed/denied, duration, exit status — rendered in the node's detail view and persisted to run-state.
- Worktree-Agent node: fans out N agents, each running in its own isolated `git worktree`/branch, supporting both "compare approaches" (same task, different instructions/models) and "parallelize independent work" (different sub-tasks). Worktree instances are the only executions that run concurrently; everything else serializes on the shared working tree.
- Approval-Gate node: a first-class node placed on any path, which blocks its downstream nodes until the user reviews the pending diff and approves inline. The scaffolded default workflow includes one before Git-ops.

## Capabilities

### New Capabilities
- `workflow-graph`: Defining, loading, and validating a project's workflow as a graph (nodes + edges) from a config file, including the built-in node type registry and each type's capability set, role prompt, and output schema.
- `terminal-canvas-ui`: The interactive terminal rendering of the graph — node boxes, edges, live status indicators, layout and panning, mouse click/drag, and the node detail/activity-log view.
- `agent-execution`: Driving the Claude Agent SDK per node, the capability harness that enforces what each node may do, the tool-call activity log, node output contracts, and streaming status back to the graph.
- `worktree-agent-node`: The parallel fan-out node type that creates isolated git worktrees per agent instance and converges results back into a single working directory.
- `approval-gate`: An explicit, graph-level approval node that blocks its downstream nodes until the user reviews a diff and approves inline.

### Modified Capabilities
(none — this is the first change in the project)

## Impact

- New repo, new codebase: no existing systems affected.
- Introduces a runtime dependency on the Claude Agent SDK and a terminal UI stack (Ink plus a lower-level mouse/canvas layer, TBD in design.md).
- Introduces a new per-project config file format (the workflow definition) that users will check into their own repos.
- Requires `git worktree` support in the user's environment for the Worktree-Agent node.
- The capability harness depends on the Agent SDK exposing per-tool-call interception; the exact API surface must be confirmed during the implementation spike.
