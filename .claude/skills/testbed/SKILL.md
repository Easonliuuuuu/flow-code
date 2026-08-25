---
name: testbed
description: Generate a clean throwaway repo for hands-on flow-code testing in engine, local companion, or official-release companion mode, and print exactly how to run it.
license: MIT
metadata:
  author: local
  version: "3.0"
---

Generate a disposable Git repository for one of flow-code's three product
execution paths. Keep the distinction strict: a mode is either entirely local
or entirely released, never a mixture.

**Input**: optionally one mode (`engine`, `companion-local`, or
`companion-release`) and/or a destination path. Ask which mode if none was
provided. Do not ask follow-up questions.

## Modes

- **`engine`** — an otherwise-empty repository with no `.flow-code/`
  directory. It exposes the current checkout's CLI through a shim beside the
  testbed. The user runs `flow-code init`, then `flow-code run`, exercising the
  local engine and the complete first-run flow.
- **`companion-local`** — an ordinary sample repository with a five-node
  workflow. Both components under test are local: the CLI/MCP server comes from
  this checkout's `dist/`, and Claude loads this checkout's plugin with
  `--plugin-dir`. Nothing is installed into the project.
- **`companion-release`** — the same ordinary sample repository, driven only
  by the published `flow-code` executable and the public Claude marketplace
  plugin. Its launch commands and runtime never reference the current checkout.
  If a published `flow-code` executable is not already on `PATH`, generation
  stops and prints the global install prerequisite; it must never substitute a
  local shim.

The two companion repos contain `.flow-code/workflow.yaml`, because that is
project configuration rather than plugin installation. They contain no
`.mcp.json`, `.claude/`, `AGENTS.md`, in-repo executable shim, or visible
testbed marker. The regeneration marker lives under `.git`.

All three modes can call a real provider and cost actual API usage. Never run
`flow-code run` or start the companion Claude session for the user.

## Generate

Run:

```bash
.claude/skills/testbed/make-testbed.sh --mode MODE [--dest PATH] [--no-build]
```

`--no-build` is valid only for `engine` and `companion-local`. The default
destinations are separate so the three modes can coexist:

- `~/flow-code-testbed-engine`
- `~/flow-code-testbed-companion-local`
- `~/flow-code-testbed-companion-release`

The script deletes and recreates its destination only when it finds its own
marker. If it refuses a destination or shim, report that and stop. Never delete
or work around the guard manually.

Relay the script's launch commands verbatim. Do not launch the TUI from a tool
call: it needs a real TTY. Do not start the Claude companion session from this
conversation: testing a separate host session is the point.

## Checklists

### `engine`

- `flow-code init` begins with the preset/provider first-run experience and
  writes a plausible `.flow-code/workflow.yaml`.
- `flow-code run` drives live node transitions rather than rendering a static
  graph.
- The final gate and git operation behave like an engine-owned run.

Mention that `run` calls a real provider and costs actual API usage.

### `companion-local`

- `claude --plugin-dir …/plugin` exposes the `/flow-code` command and the MCP
  tools without marketplace installation.
- The graph fills while the agent works, and the tier reads `hooks`, not
  `reported`.
- An edit attempted during `review` is denied, and git writes stay blocked
  until the user decides the gate.

Mention that both the plugin and CLI come from the current checkout. The
external shim must be exported on `PATH` in the Claude shell because the plugin
launches a bare `flow-code` command.

### `companion-release`

- `flow-code --version` is the published CLI version the user intended to
  test, and neither launch command contains a checkout path.
- The public marketplace plugin loads without warnings and its MCP server is
  healthy (`claude plugin list`, `claude mcp list`).
- The graph fills live at the `hooks` tier, including review denial and the
  human approval gate.

Mention that Claude plugin installations are external state scoped by Claude,
not files in the repo. Reusing a destination may reuse an earlier local plugin
installation; use a new destination when the goal is a literal first install.

## Companion fixture

Both companion modes use the same five-node graph so differences point to the
installation source rather than the scenario:

```text
implement → unit → review → gate → ship
    ↑_________|
```

`implement` edits, `unit` executes `npm test`, `review` is read-only, `gate`
requires the user, and `ship` writes Git. The `unit → implement` loop-back must
be walked by the companion session itself; flow-code did not start that process
and cannot route it automatically.
