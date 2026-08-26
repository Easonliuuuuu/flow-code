---
name: testbed
description: Generate a clean throwaway repo for hands-on flow-code testing in engine or Claude/Codex companion mode, using either the local checkout or an official release, and print exactly how to run it.
license: MIT
metadata:
  author: local
  version: "4.0"
---

Generate a disposable Git repository for one of flow-code's product execution
paths. Keep the source distinction strict: a mode is either entirely local or
entirely released, never a mixture.

**Input**: optionally one mode (`engine`, `companion-local`, or
`companion-release`), a companion host (`claude` or `codex`), and/or a
destination path. Ask for the mode if none was provided. Companion mode
defaults to Claude for backward compatibility; an explicit Codex request
always selects Codex. Do not ask follow-up questions.

## Modes

- **`engine`** — an otherwise-empty repository with no `.flow-code/`
  directory. It exposes the current checkout's CLI through a shim beside the
  testbed. The user runs `flow-code init`, then `flow-code run`, exercising the
  local engine and the complete first-run flow.
- **`companion-local --host claude`** — an ordinary sample repository, no
  `.flow-code/` configuration yet. Both components under test are local: the
  CLI/MCP server comes from this checkout's `dist/`, and Claude loads this
  checkout's plugin with `--plugin-dir`. Nothing is installed into the project.
- **`companion-release --host claude`** — the same ordinary sample repository,
  driven only by the published `flow-code` executable and the public Claude
  marketplace plugin. Its launch commands and runtime never reference the
  current checkout.
- **`companion-local --host codex`** — an ordinary sample repository connected
  to Codex with the current checkout's CLI. The generator non-interactively
  scaffolds the default workflow and runs `flow-code connect --host codex`, so
  the resulting repo contains the Codex project surface and is ready for a new
  Codex session.
- **`companion-release --host codex`** — the same Codex-connected repository,
  generated only with the published `flow-code` executable. Its launch commands
  and runtime never reference the current checkout.

Release modes require a published `flow-code` executable on `PATH`; they never
substitute a local shim. Codex release mode additionally requires a release
whose help advertises `--host claude|codex|all`.

Claude companion repos contain no `.flow-code/workflow.yaml`, `.mcp.json`,
`.claude/`, `AGENTS.md`, or in-repo executable shim. A real plugin user's first
session starts from exactly that state and negotiates the workflow there.

Codex companion repos contain the default `.flow-code/workflow.yaml` plus the
four surfaces written by `flow-code connect --host codex`:
`.codex/config.toml`, `.codex/hooks.json`,
`.agents/skills/flow-code-workflow/SKILL.md`, and `AGENTS.md`. They contain no
Claude integration files. The setup is committed so the test starts from a
clean tree. Every testbed's regeneration marker lives under `.git`.

All modes can call a real provider and cost actual API usage. Never run
`flow-code run` or start the companion agent session for the user.

## Generate

Run:

```bash
scripts/make-testbed.sh --mode MODE [--host claude|codex] [--dest PATH] [--no-build]
```

`--no-build` is valid only for `engine` and `companion-local`. The default
destinations are separate so the mode/host combinations can coexist:

- `~/flow-code-testbed-engine`
- `~/flow-code-testbed-companion-local` (Claude)
- `~/flow-code-testbed-companion-release` (Claude)
- `~/flow-code-testbed-companion-codex-local`
- `~/flow-code-testbed-companion-codex-release`

The script deletes and recreates its destination only when it finds its own
marker. If it refuses a destination or shim, report that and stop. Never delete
or work around the guard manually.

Relay the script's launch commands verbatim. Do not launch the TUI from a tool
call: it needs a real TTY. Do not start the Claude or Codex companion session
from this conversation: testing a separate host session is the point.

## Checklists

### `engine`

- `flow-code init` begins with the preset/provider first-run experience and
  writes a plausible `.flow-code/workflow.yaml`.
- `flow-code run` drives live node transitions rather than rendering a static
  graph.
- The final gate and git operation behave like an engine-owned run.

Mention that `run` calls a real provider and costs actual API usage.

### `companion-local --host claude`

- `claude --plugin-dir …/plugin` exposes the `/flow-code` command and the MCP
  tools without marketplace installation.
- With no `.flow-code/workflow.yaml` yet, the agent surfaces that before
  opening a run and discusses it with the user: either a named preset
  (`openspec`, `spec-kit`, `frugal`, `planned`) as a one-off for this run, or
  `flow-code init` (bare or `--preset <name>`) run by the agent itself via
  Bash to scaffold the project's own workflow. It must not silently invent a
  graph, and it must not just tell the user to go run the command themselves.
- Once a workflow exists on disk, the agent also runs `flow-code connect
  --status-line` itself so Claude Code's footer shows run status — this
  writes only `.claude/settings.json` and its status script, never `.mcp.json`
  or instructions, since the plugin already provides those.
- The graph fills while the agent works, and the tier reads `hooks`, not
  `reported`.
- Once the run reaches an `approval-gate` node, git writes stay blocked until
  the user decides it; if the chosen workflow has a `review` node (the
  CLI-scaffolded default does), an edit attempted during it is denied.

Mention that both the plugin and CLI come from the current checkout. The
external shim must be exported on `PATH` in the Claude shell because the plugin
launches a bare `flow-code` command.

### `companion-release --host claude`

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

### `companion-local --host codex`

- `flow-code connect --host codex --check` reports all four Codex surfaces as
  current; `.mcp.json` and `.claude/` do not exist.
- `/hooks` shows the project `PreToolUse` hook and `/mcp` shows a healthy
  `flow-code` server after the project is trusted.
- The graph fills at the `hooks` tier while Codex works. It explicitly reports
  `hosted-tools-unobserved`, because hosted tools such as web search do not pass
  through the local hook.
- An edit attempted during `review` is denied. Git writes remain blocked until
  the user decides the approval gate.

Mention that the CLI, MCP server, hook, and generated project integration all
come from the current checkout. The external shim must remain exported on
`PATH` in the Codex shell because the generated config launches a bare
`flow-code` command.

### `companion-release --host codex`

- `flow-code --version` is the published CLI version intended for testing, and
  neither launch command nor generated Codex config contains a checkout path.
- `flow-code connect --host codex --check`, `/hooks`, and `/mcp` show the same
  healthy project surface as local mode.
- The graph and enforcement checks match Codex local mode, including the
  hosted-tool limitation, review denial, and human approval gate.

## Companion workflow selection

Claude companion modes ship no workflow at all — that mirrors a real first
plugin session. The flow-code plugin skill (`plugin/skills/flow-code/SKILL.md`)
governs what happens next: an explicit preset name the user gives wins and is
used for that run only, without ever being written to disk; otherwise, once the
agent discovers there is no `.flow-code/workflow.yaml`, it discusses the choice
with the user and — for a persistent project workflow — runs `flow-code init`
itself via Bash. It must not just tell the user to run that command elsewhere.

Codex has no equivalent zero-install plugin in this repository, so its testbed
must establish the project workflow and generated Codex surface before Codex
starts. In either host, do not pre-write a task — let the person testing tell
the companion agent what they actually want built.
