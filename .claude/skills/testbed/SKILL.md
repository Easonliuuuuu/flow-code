---
name: testbed
description: Generate a clean throwaway repo for driving the flow-code TUI by hand, and print how to run it. Use after changing anything in src/ui — canvas, panels, mouse, layout, zoom, splash, or the init/run flow — when the change needs to be looked at rather than asserted on.
license: MIT
metadata:
  author: local
  version: "2.0"
---

Ask which mode to generate, rebuild `dist/`, generate a disposable git repo
matching that mode, and tell the user how to launch the TUI against it.

**Input**: optionally a mode (`ui`, `splash`, `clean`), a shape (`wide`,
`tall`, `tiny`, `ui` mode only), and/or a destination path, given as free text
after `/testbed`. Use whatever's given to skip the matching question below;
ask for anything that's missing.

---

## Why this exists

`src/ui` is judged by looking at it. Unit tests pin geometry and end-to-end
render tests pin frames, but neither catches "the cards jump when I close the
panel" — that needs a real terminal and a graph big enough to have somewhere
to jump to. The three modes exist because "look at it" means different things
depending on what changed:

- **`ui`** — the graph itself: canvas, panels, mouse, layout, zoom. Backed by
  `flow-code watch`, which draws a whole graph from `workflow.yaml` with every
  node idle, and never reads credentials or starts an agent session. It only
  needs a git repo with a workflow in it.
- **`splash`** — the startup animation, decoupled from graph content.
- **`clean`** — the first-run experience: `flow-code init`'s preset picker and
  provider wizard, then a real `flow-code run`. This is the only mode that
  calls a real provider and costs real API usage — everything else is free.

---

## Steps

1. **Ask which mode**, unless the input already named one. Use
   `AskUserQuestion`:

   - **ui** — "Check the graph UI — canvas, panels, drag, zoom, pickers."
   - **splash** — "Just watch the startup animation."
   - **clean** — "Bare repo — I'll run `init` and `run` myself. Calls a real
     provider."

   If `ui` was picked (by the question or by the input) and no shape was
   given, ask a second `AskUserQuestion` for the shape, using the table below
   as the option descriptions. Skip this question entirely for `splash` and
   `clean` — `splash` is always `tiny` internally, and `clean` has no shape.

2. **Run the generator.**

   ```bash
   .claude/skills/testbed/make-testbed.sh --mode MODE [--shape SHAPE] [--dest PATH] [--no-build]
   ```

   It rebuilds `dist/` (skip with `--no-build`), deletes and recreates the
   destination, scaffolds it for the chosen mode, and makes an initial commit.
   It prints the exact `cd` and `node …` lines to run.

   The script refuses to delete a directory that doesn't carry its
   `.flow-code-testbed` marker, so a mistyped `--dest` can't take a real
   directory with it. If it refuses, report that and stop — don't work around
   it by deleting anything yourself.

3. **Relay the launch command(s)**, verbatim from the script's output. The
   user runs the TUI themselves: it needs a real TTY, and Ink dies with "Raw
   mode is not supported" under a captured shell, so don't try to run it and
   don't report that error as a bug.

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

Add a shape by extending the `case "$SHAPE"` block in `make-testbed.sh` and
the table above. Keep each one justified by something it makes visible that
the others don't.

## Guardrails

- Never `rm -rf` a destination yourself — that is the script's job, and the
  marker check is the only thing standing between a typo and real data.
- Don't launch the TUI from a tool call; it needs a TTY the harness can't give.
- Don't add the testbed path to the repo's `.gitignore` or commit it. It lives
  outside the repo on purpose.
- `clean` mode's `run` step costs real API usage — never run it yourself on
  the user's behalf; only relay the command for them to run.
