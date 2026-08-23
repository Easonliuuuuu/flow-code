# flow-code documentation

Start with the [project README](../README.md) for what flow-code is and how to
install it. New to the vocabulary? The [glossary](glossary.md) defines every
term once — *driver*, *guest*, *harness*, *spine*, *enforcement tier* and the
rest — so no other page has to stop and explain them.

## Start here

| Guide | Covers |
| --- | --- |
| [Why a graph, not a chat log](why-a-graph.md) | The thesis, the default graph node by node, the presets, and where it doesn't fit. |
| [What a run costs](cost.md) | The measured token figures from a real run, what they price out to, and five ways to spend less. |
| [Glossary](glossary.md) | Every term flow-code uses that isn't self-explanatory, defined once. |
| [FAQ](faq.md) | Windows, monorepos, non-git repos, CI, cost, stuck runs. |

## Reference

| Guide | Covers |
| --- | --- |
| [Workflow reference](workflow-reference.md) | Everything `.flow-code/workflow.yaml` accepts — nodes, edges, loop-backs, conditional routing, settings, notifications, budgets, worktrees, named graphs. The settings table is generated from the schema. |
| [Node type reference](node-types.md) | Every built-in node type: capabilities, config fields, recorded output. Generated from the registry. |
| [Providers and credentials](providers.md) | Picking a provider, credential reuse, where the key lives, and how a node's effective model is resolved. |
| [Keyboard and mouse](keys.md) | The key map, editing a node mid-run, and what `watch` disables. |

## Operating it

| Guide | Covers |
| --- | --- |
| [Security and privacy](security.md) | What lands in `.flow-code/`, what the engine actually enforces, and — stated plainly — what it does not. |
| [Watching and status](observability.md) | Following a run from another window (`watch`) or a status line (`status`), including driver-liveness detection. |
| [Driving the graph from your own agent](agent-integration.md) | Using `flow-code connect` to walk the graph from your own agent CLI, what each enforcement tier does and doesn't guarantee, and `reconcile`. |
| [Skills](skills.md) | Attaching custom `SKILL.md` instructions to a node, where skills are discovered, and keeping them portable. |

## In your terminal

Three commands print reference material directly, without a browser:

```bash
flow-code node-types   # every node type and its configuration
flow-code skills       # skills attachable in this repo
flow-code doctor       # environment, tools, and provider credentials
```

## Which pages can drift

The node type reference, the README's command table, and the workflow
reference's settings table are **generated from source** — `npm run docs:check`
fails CI when any of them falls behind the code they describe. Everything else
on this page is written by hand and can be wrong; if you find something that is,
[open an issue](https://github.com/Easonliuuuuu/flow-code/issues).
