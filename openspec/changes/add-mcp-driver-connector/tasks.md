## 0. Prerequisites

- [ ] 0.1 Confirm M2 (driver-mode trustworthiness under real conditions) is far enough along that a second entry point into the engine is acceptable risk
- [ ] 0.2 Settle the open questions in `design.md`: single `respond` tool vs. `respond_to_gate`/`respond_to_discuss`, and whether `get_run_state`'s payload needs a summarized form for large graphs
- [ ] 0.3 Re-confirm `InteractionPorts` (`src/engine/types.ts`) hasn't changed shape since this proposal was written, since the whole design leans on it staying a clean substitution point

## 1. Ports implementation

- [ ] 1.1 Add `McpInteractionPorts` implementing `InteractionPorts` in `src/mcp/`: `approval.request` resolves on a matching `respond` tool call, `discuss.nextUserMessage`/`begin`/`postAssistant`/`end` map to the Discuss tool-call exchange, `testCommands.request` and `convergence.select` get equivalent tool-backed implementations
- [ ] 1.2 Test each port method resolves correctly when the matching tool call arrives, and stays pending otherwise
- [ ] 1.3 Test a `respond` call naming a node that isn't currently awaiting input is rejected with a clear error and no state change

## 2. Run lifecycle tools

- [ ] 2.1 Add `start_run`: load `.flow-code/workflow.yaml` the same way `src/cli/run.ts` does, construct `Engine` with `McpInteractionPorts`, keep the tool call open for the run's duration
- [ ] 2.2 Add `stop_run`: signal the same abort path `flow-code run`'s ctrl+c handler uses
- [ ] 2.3 Test `start_run` against a missing or invalid `workflow.yaml` returns a tool error and starts nothing
- [ ] 2.4 Test a full workflow run to completion via `start_run` alone, including a Gate and a Discuss node answered via `respond`

## 3. State reading

- [ ] 3.1 Add `get_run_state`: read from the live `RunStateStore` when this process holds it, else fall back to `latestRunState`/`RunStateWatcher` (`src/runstate/watch.ts`)
- [ ] 3.2 Include graph shape (nodes, edges, loop-backs) and the most recent transition's reason in the response, not just per-node status
- [ ] 3.3 Test `get_run_state` against a run this process started (live path) and a run started separately by the CLI (file-fallback path) return equivalent shapes
- [ ] 3.4 Wire `RunStateStore`'s listener to emit an MCP progress notification on every transition during an open `start_run` call

## 4. CLI entry point

- [ ] 4.1 Add the `flow-code mcp` subcommand (stdio transport) alongside `run`/`init`/`watch` in `src/cli/`
- [ ] 4.2 Test the server starts, advertises its tools, and exits cleanly on the host disconnecting

## 5. Interoperability

- [ ] 5.1 Test a run started via `start_run` is attachable and renders correctly in `flow-code watch`
- [ ] 5.2 Test a run started via `flow-code run` is fully queryable via `get_run_state` from a separate MCP server invocation
- [ ] 5.3 Test `flow-code run --resume` resumes a run that was started via MCP

## 6. Harness parity verification

- [ ] 6.1 Run the same workflow once via `flow-code run` and once via `start_run`; assert the compiled tool policy is identical per node in both
- [ ] 6.2 Test a Git-ops node downstream of an unapproved Gate does not execute in an MCP-driven run, matching CLI behavior
- [ ] 6.3 Test approving/rejecting the same gate a second time (via either surface) is refused

## 7. Documentation

- [ ] 7.1 Document `flow-code mcp` setup for Claude Code (`claude mcp add`) and Codex CLI (`mcp_servers` config) in the README
- [ ] 7.2 Register this change in `docs/product/roadmap.md`'s Parked section and note the relationship to `add-guest-mode-reporter`
