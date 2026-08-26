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
- **`companion-local`** — an ordinary sample repository, no `.flow-code/`
  configuration yet. Both components under test are local: the CLI/MCP server
  comes from this checkout's `dist/`, and Claude loads this checkout's plugin
  with `--plugin-dir`. Nothing is installed into the project.
- **`companion-release`** — the same ordinary sample repository, driven only
  by the published `flow-code` executable and the public Claude marketplace
  plugin. Its launch commands and runtime never reference the current checkout.
  If a published `flow-code` executable is not already on `PATH`, generation
  stops and prints the global install prerequisite; it must never substitute a
  local shim.

Neither companion repo contains `.flow-code/workflow.yaml`. A real user's
first companion session starts from exactly this state — no project workflow,
no pre-picked task — so the testbed must not scaffold one for them. They also
contain no `.mcp.json`, `.claude/`, `AGENTS.md`, in-repo executable shim, or
visible testbed marker. The regeneration marker lives under `.git`.

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
- With no `.flow-code/workflow.yaml` yet, the agent surfaces that before
  opening a run and discusses it with the user: either a named preset
  (`openspec`, `spec-kit`, `frugal`, `planned`) as a one-off for this run, or
  `flow-code init` (bare or `--preset <name>`) run by the agent itself via
  Bash to scaffold the project's own workflow. It must not silently invent a
  graph, and it must not just tell the user to go run the command themselves.
- The graph fills while the agent works, and the tier reads `hooks`, not
  `reported`.
- Once the run reaches an `approval-gate` node, git writes stay blocked until
  the user decides it; if the chosen workflow has a `review` node (the
  CLI-scaffolded default does), an edit attempted during it is denied.

Mention that both the plugin and CLI come from the current checkout. The
external shim must be exported on `PATH` in the Claude shell because the plugin
launches a bare `flow-code` command.

### `companion-release`

- `flow-code --version` is the published CLI version the user intended to
  test, and neither launch command contains a checkout path.
- The public marketplace plugin loads without warnings and its MCP server is
  healthy (`claude plugin list`, `claude mcp list`).
- Same as `companion-local`: no workflow exists yet, so the agent must
  establish one through conversation — a named preset for this run, or
  scaffolding the project's own workflow itself via `flow-code init` — before
  opening a run.
- The graph fills live at the `hooks` tier, including the human approval gate
  and, if the chosen workflow has one, review denial.

Mention that Claude plugin installations are external state scoped by Claude,
not files in the repo. Reusing a destination may reuse an earlier local plugin
installation; use a new destination when the goal is a literal first install.

## Companion workflow selection

Companion modes ship no workflow at all — that mirrors a real first session on
a real project. The flow-code plugin skill (`plugin/skills/flow-code/SKILL.md`)
governs what happens next: an explicit preset name the user gives wins and is
used for that run only, without ever being written to disk; otherwise, once
the agent discovers there is no `.flow-code/workflow.yaml`, it discusses the
choice with the user and — for a persistent project workflow — runs
`flow-code init` itself via Bash. It must not just tell the user to go run
that command in another terminal. Do not pre-decide any of this for the
person running the testbed, and do not pre-write a task — let them tell the
agent what they actually want built.
