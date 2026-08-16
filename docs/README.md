# flow-code documentation

Start with the [project README](../README.md) for what flow-code is and how to install it.

| Guide | Covers |
| --- | --- |
| [Node type reference](node-types.md) | Every built-in node type: capabilities, config fields, recorded output. Generated from the registry. |
| [Workflow reference](workflow-reference.md) | Everything `.flow-code/workflow.yaml` accepts — nodes, edges, loop-backs, conditional routing, budgets, worktrees. |
| [Skills](skills.md) | Attaching custom `SKILL.md` instructions to a node, where skills are discovered, and keeping them portable. |
| [Watching and status](observability.md) | Following a run from another window (`watch`) or a status line (`status`), including driver-liveness detection. |
| [Driving the graph from your own agent](agent-integration.md) | Using `flow-code connect` to walk the graph from your own agent CLI, what each enforcement tier does and doesn't guarantee, and `reconcile`. |

Three commands print reference material directly in your terminal:

```bash
flow-code node-types   # every node type and its configuration
flow-code skills       # skills attachable in this repo
flow-code doctor       # environment, tools, and provider credentials
```
