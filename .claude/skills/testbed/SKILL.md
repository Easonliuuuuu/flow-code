---
name: testbed
description: Generate a clean throwaway repo for driving flow-code by hand, and print how to run it. Use after changing anything in src/ui — canvas, panels, mouse, layout, zoom, splash, or the init/run flow — or anything in src/guest or plugin/, when the change needs to be looked at rather than asserted on.
license: MIT
metadata:
  author: local
  version: "2.1"
---

Ask which mode to generate, rebuild `dist/`, generate a disposable git repo
matching that mode, and tell the user how to launch flow-code against it.

**Input**: optionally a mode (`ui`, `splash`, `clean`, `guest`, `revise`), a shape
(`wide`, `tall`, `tiny`, `ui` mode only), an install path (`connect`,
`plugin`, `guest` mode only), and/or a destination path, given as free text
after `/testbed`. Use whatever's given to skip the matching question below;
ask for anything that's missing.

---

## Why this exists

`src/ui` is judged by looking at it. Unit tests pin geometry and end-to-end
render tests pin frames, but neither catches "the cards jump when I close the
panel" — that needs a real terminal and a graph big enough to have somewhere
to jump to. `src/guest` has the same problem for a different reason: its
subject is a *host agent* nobody here controls, so the only honest test of it
is a real session on the other side of the boundary. The four modes exist
because "look at it" means different things depending on what changed:

- **`ui`** — the graph itself: canvas, panels, mouse, layout, zoom. Backed by
  `flow-code watch`, which draws a whole graph from `workflow.yaml` with every
  node idle, and never reads credentials or starts an agent session. It only
  needs a git repo with a workflow in it.
- **`splash`** — the startup animation, decoupled from graph content.
- **`clean`** — the first-run experience: `flow-code init`'s preset picker and
  provider wizard, then a real `flow-code run`.
- **`revise`** — what a rejection *does*: the gate's rejection branch, the
  conversation it routes into, and the loop back to `implement`. Scaffolded
  already wired and driven by `flow-code run`, because neither `clean` (starts
  bare) nor `ui` (never runs an agent) can show a gate being rejected and the
  run coming back round.
- **`guest`** — the outside-agent path: the MCP reporting tools, the generated
  instructions, the PreToolUse enforcement hook, the tier the run records, and
  reconciliation. Nothing in this mode is driven from here — a real Claude Code
  session walks the graph and reports it, and `flow-code watch` attaches to a
  run it did not start.

`clean`, `guest` and `revise` call a real provider and cost real API usage;
`ui` and `splash` are free.

---

## Steps

1. **Ask which mode**, unless the input already named one. Use
   `AskUserQuestion`:

   - **ui** — "Check the graph UI — canvas, panels, drag, zoom, pickers."
   - **splash** — "Just watch the startup animation."
   - **clean** — "Bare repo — I'll run `init` and `run` myself. Calls a real
     provider."
   - **guest** — "Drive the graph from my own Claude session — MCP tools,
     hook enforcement, tier. Calls a real provider."
   - **revise** — "Reject a gate and watch it route into a conversation and
     loop back. Already wired, no `init`. Calls a real provider."

   Then ask one follow-up question, depending on what was picked:

   - `ui` — the **shape**, using the table below as the option descriptions.
   - `guest` — the **install path**, unless the input already named one:
     - **connect** — "`flow-code connect` writes `.mcp.json`, the skill, the
       instructions section, and the hook into the testbed. Works from this
       checkout as-is."
     - **plugin** — "Install `plugin/` as a Claude Code plugin. Needs a PATH
       shim, which the script generates. Tests the manifest and `hooks.json`
       themselves."

   `splash`, `clean` and `revise` get no follow-up — `splash` is always `tiny`
   internally, and `clean` has no shape.

2. **Run the generator.**

   ```bash
   .claude/skills/testbed/make-testbed.sh --mode MODE [--shape SHAPE] [--install PATH] [--dest PATH] [--no-build]
   ```

   It rebuilds `dist/` (skip with `--no-build`), deletes and recreates the
   destination, scaffolds it for the chosen mode, and makes an initial commit.
   It prints the exact `cd` and `node …` lines to run.

   The script refuses to delete a directory that doesn't carry its
   `.flow-code-testbed` marker, so a mistyped `--dest` can't take a real
   directory with it. If it refuses, report that and stop — don't work around
   it by deleting anything yourself.

3. **Relay the launch command(s)**, verbatim from the script's output. The
   user runs them themselves: the TUI needs a real TTY, and Ink dies with "Raw
   mode is not supported" under a captured shell, so don't try to run it and
   don't report that error as a bug. In `guest` mode the second terminal is a
   real Claude Code session — likewise the user's to start, never yours.

4. **Give a checklist** matching the mode — see below. Two or three specific
   things beat a wall of table rows.

---

## Checklists

### `ui` mode

Choose two or three, picked for the change that was just made:

- Drag a node: does it track the pointer 1:1, with the rest of the graph
  staying put? Does it pin at the border instead of vanishing?
- `ctrl`+wheel over the canvas zooms; over an open panel it scrolls the
  panel. `z` steps one stop, `o` jumps to mini and back, `c` toggles camera.
- Zoom out, rearrange nodes, zoom back in: the arrangement should survive.
- Enter then Enter again: nothing should shift or overlap the header.
- Resize narrow: header and hint truncate, never wrap to a second row.
- Click a card's badge row (`implement`, `review`, `docs` in the `wide`
  shape) — model picker, model picker, skill picker respectively.

Mention this gotcha once per conversation: badge clicks write to
`workflow.yaml` even under `watch`, because the read-only guard covers the
`m`/`s`/`e` keys and not the mouse path. The testbed is a git repo, so
`git checkout .` inside it undoes that.

### `splash` mode

- Logo reveals line-by-line, not all at once.
- Pacing feels intentional, not sluggish or rushed — this is what usually
  regresses.
- The fail/retry chain animation and its fireworks, if the change touched
  that path.
- Handoff into the graph: raw mode should stay on across splash → graph, no
  flicker or dropped input right after.
- `--no-splash` (or `FLOW_CODE_NO_SPLASH=1`) skips straight to the graph —
  worth a quick check that it still does.

### `clean` mode

- `init`'s preset picker, then the provider wizard if no credentials are
  saved yet.
- The scaffolded `.flow-code/workflow.yaml` looks right for the chosen
  preset.
- `run` actually drives the graph live: node states transition, not just
  render once.

Mention this gotcha once per conversation: `run` in this mode is a real
agent call against a real provider — it costs actual API usage, unlike `ui`
and `splash`.

### `revise` mode

- Reject at the gate: `ship` renders skipped (`⊘`), **not** errored. Nothing
  failed — it was routed around, and the difference is the whole design.
- The gate card must not read as a success. It reaches `done` like an approved
  one, so it takes the failed glyph off its recorded decision instead.
- `revise` opens already knowing what it is reconsidering — the rejected diff
  reaches it through the gate, which is context-transparent.
- Reject a **second** time. This is the one worth watching: `revise` resumes
  its earlier session, so the new retry reason is sent as a fresh turn into
  that conversation. If it picks up as though nothing happened between the two
  rejections, that is the bug this mode exists to catch.
- `echo $?` after a rejected run — still non-zero, because the run did not do
  what it set out to do.

Mention this gotcha once per conversation: `maxAttempts` is counted on the
loop-back **target** (`implement`) and shared across every loop-back pointing
at it. This graph has 3 and only one loop-back, so there is room to reject
twice and still ship — add another return path into `implement` and that
budget is shared, not doubled.

### `guest` mode

Start `watch` first, then the agent session, so the run appears under a
viewer that was already attached. Choose two or three:

- The graph fills in *while* the agent works, not in one burst at the end —
  a run only visible after it finished is the failure this surface exists to
  prevent.
- The tier badge reads `hooks`, not `reported`. `reported` here means the
  enforcement layer never verified, which is a bug in `connect`/the plugin,
  not in the agent.
- Ask the agent to edit a file during the `review` step: the hook must deny
  it. A denial is the boundary working — check it is *reported* as one and
  doesn't get routed around.
- Ask it to commit before the gate is decided: git writes stay blocked until
  `decide_gate` records an approval, and the gate must reach the user rather
  than being answered by the agent.
- Make the `unit` step fail (break the test first): the guest has to walk the
  loop-back to `implement` itself, since nothing routes it.
- `flow-code node --help` and `flow-code connect --check` from inside the
  testbed: the CLI reporting path and the install report on the same run.

Mention this gotcha once per conversation: the plugin install path only works
with the shim on `PATH`, because `plugin/.claude-plugin/plugin.json` launches
a bare `flow-code` for both the MCP server and the hook. Without it the
session starts fine, reports nothing, and records `reported` — a working-
looking install with no enforcement behind it.

Several terminals (iTerm2, GNOME Terminal, Windows Terminal) bind ctrl+wheel
to their own font zoom and never forward it, which affects `ui` mode; `z` and
`o` do the same job if nothing happens.

---

## Shapes (`ui` mode only)

| shape | graph | what it's for |
| --- | --- | --- |
| `wide` (default) | 10 nodes, 290 × 13 | Wider than any terminal, two layers stacked two-deep, three badged cards. Panning, dragging, zoom, both pickers. |
| `tall` | 9 nodes, 57 × 55 | Taller than the canvas, so auto-zoom starts compact. Checks the auto rule, and that dragging a node down doesn't re-densify the graph. |
| `tiny` | 2 nodes, 57 × 6 | Fits the canvas whole — nothing off-screen, no auto-zoom. The "does this look right at rest" baseline. Also what `splash` mode uses internally. |
| `loops` | 9 nodes, 4 loop-backs over 2 targets | The only shape with return paths. Three loops funnel into `implement` and one into `spec`, so per-target merging, the marks-only resting state, and focus-driven reveal are all visible — and against each other. Use it for anything touching how loop-backs are drawn; the other three shapes have no loop-back edge at all. |

Add a shape by extending the `case "$SHAPE"` block in `make-testbed.sh` and
the table above. Keep each one justified by something it makes visible that
the others don't.

`revise` mode has one fixed graph instead of shapes: five nodes
(`implement → unit → gate`, then `ship` on approval and `revise` on rejection,
looping back to `implement` with `on: success`), short enough to reach the gate
quickly and reject it more than once. Passing `--shape` there is an error.

`guest` mode has one fixed graph instead of shapes: five nodes covering every
enforcement-relevant kind (edit, exec-only, read-only, a zero-capability gate,
git-write) plus one loop-back, short enough for an agent to walk in a single
session. Passing `--shape` there is an error rather than a no-op.

## Install paths (`guest` mode only)

| install | what it does | what it tests that the other doesn't |
| --- | --- | --- |
| `connect` (default) | Runs `flow-code connect` in the testbed: `.mcp.json`, `.claude/skills/flow-code-workflow/SKILL.md`, an `AGENTS.md` section, and the `.claude/settings.json` hook. | The generated per-project instructions and their drift reporting. Works from a checkout with no PATH setup. |
| `plugin` | Writes a `bin/flow-code` shim and prints the `/plugin marketplace add` and `/plugin install` lines, plus the `PATH=` prefix they need. | `plugin/.claude-plugin/plugin.json` and `plugin/hooks/hooks.json` themselves — the no-per-project-step path real users get. |

Both land on the same tool surface. If they behave differently, that
difference is the finding.

## Guardrails

- Never `rm -rf` a destination yourself — that is the script's job, and the
  marker check is the only thing standing between a typo and real data.
- Don't launch the TUI from a tool call; it needs a TTY the harness can't give.
- Don't add the testbed path to the repo's `.gitignore` or commit it. It lives
  outside the repo on purpose.
- `clean` mode's `run` step and `guest` mode's agent session both cost real
  API usage — never run either yourself on the user's behalf; only relay the
  commands for them to run.
- In `guest` mode, don't walk the graph from this conversation. The point is a
  separate session on the other side of the boundary; driving it from here
  tests nothing, because the tools and the hook would be reaching the wrong
  session.
