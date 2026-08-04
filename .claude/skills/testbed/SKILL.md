---
name: testbed
description: Generate a clean throwaway repo for driving the flow-code TUI by hand, and print how to run it. Use after changing anything in src/ui — canvas, panels, mouse, layout, zoom — when the change needs to be looked at rather than asserted on.
license: MIT
metadata:
  author: local
  version: "1.0"
---

Rebuild `dist/`, generate a disposable git repo with a workflow in it, and tell
the user how to launch the TUI against it.

**Input**: optionally a shape (`wide`, `tall`, `tiny`) and/or a destination
path. Defaults to `wide` at `~/flow-code-testbed`.

---

## Why this exists

`src/ui` is judged by looking at it. Unit tests pin geometry and end-to-end
render tests pin frames, but neither catches "the cards jump when I close the
panel" — that needs a real terminal and a graph big enough to have somewhere to
jump to.

`flow-code watch` is the cheap way in: it draws the whole graph from
`workflow.yaml` with every node idle, and never reads credentials or starts an
agent session. It only needs a git repo with a workflow in it.

---

## Steps

1. **Run the generator.**

   ```bash
   .claude/skills/testbed/make-testbed.sh [--shape SHAPE] [--dest PATH] [--no-build]
   ```

   It rebuilds `dist/` (skip with `--no-build`), deletes and recreates the
   destination, writes the workflow plus two discoverable project skills, and
   makes an initial commit. It prints the exact `cd` and `node …` lines to run.

   The script refuses to delete a directory that doesn't carry its
   `.flow-code-testbed` marker, so a mistyped `--dest` can't take a real
   directory with it. If it refuses, report that and stop — don't work around
   it by deleting anything yourself.

2. **Relay the launch command**, verbatim from the script's output. The user
   runs the TUI themselves: it needs a real TTY, and Ink dies with "Raw mode is
   not supported" under a captured shell, so don't try to run it and don't
   report that error as a bug.

3. **Give a checklist** of what to look at, chosen for the change that was just
   made — not the whole list below every time. Two or three specific things
   beat a wall of table rows. Draw from:

   - Drag a node: does it track the pointer 1:1, with the rest of the graph
     staying put? Does it pin at the border instead of vanishing?
   - `ctrl`+wheel over the canvas zooms; over an open panel it scrolls the
     panel. `z` steps one stop, `o` jumps to mini and back, `c` toggles camera.
   - Zoom out, rearrange nodes, zoom back in: the arrangement should survive.
   - Enter then Enter again: nothing should shift or overlap the header.
   - Resize narrow: header and hint truncate, never wrap to a second row.
   - Click a card's badge row (`implement`, `review`, `docs` in the `wide`
     shape) — model picker, model picker, skill picker respectively.

4. **Mention the two gotchas**, but only once per conversation:

   - Badge clicks write to `workflow.yaml` even under `watch`, because the
     read-only guard covers the `m`/`s`/`e` keys and not the mouse path. The
     testbed is a git repo, so `git checkout .` inside it undoes that.
   - Several terminals (iTerm2, GNOME Terminal, Windows Terminal) bind
     ctrl+wheel to their own font zoom and never forward it. `z` and `o` do the
     same job if nothing happens.

---

## Shapes

| shape | graph | what it's for |
| --- | --- | --- |
| `wide` (default) | 10 nodes, 290 × 13 | Wider than any terminal, two layers stacked two-deep, three badged cards. Panning, dragging, zoom, both pickers. |
| `tall` | 9 nodes, 57 × 55 | Taller than the canvas, so auto-zoom starts compact. Checks the auto rule, and that dragging a node down doesn't re-densify the graph. |
| `tiny` | 2 nodes, 57 × 6 | Fits the canvas whole — nothing off-screen, no auto-zoom. The "does this look right at rest" baseline. |

Add a shape by extending the `case "$SHAPE"` block in `make-testbed.sh` and the
table above. Keep each one justified by something it makes visible that the
others don't.

## Guardrails

- Never `rm -rf` a destination yourself — that is the script's job, and the
  marker check is the only thing standing between a typo and real data.
- Don't launch the TUI from a tool call; it needs a TTY the harness can't give.
- Don't add the testbed path to the repo's `.gitignore` or commit it. It lives
  outside the repo on purpose.
