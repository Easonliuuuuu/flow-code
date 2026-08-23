# Keyboard and mouse

Press `?` in a run for the full key map, including everything below and the
panel gestures. This page is the version you can read before you start.

## Keys worth knowing first

| Key | Action |
| --- | --- |
| `?` | The whole key map, in a panel |
| `tab` / `shift+tab` | Focus the next / previous node |
| `enter` | Open the focused node's details — `esc` closes it |
| `e` | Edit the focused node's settings |
| `m` | Change the focused node's model |
| `s` | Attach or detach skills |
| `←→↑↓` | Pan the canvas (add `shift` while a panel has the keyboard) |
| `z` | Toggle compact cards — the canvas does this itself once the graph outgrows the terminal |
| `o` | Overview: one row per node, for a graph too big to read as cards |
| `c` | Centre the canvas on the focused node, or leave it where it is |
| `w` | Wrap a graph wider than the terminal into bands, or lay it flat |
| `q` | Quit |

## Editing a node mid-run

Focus a node and press `e` for its settings, `m` for its model, or `s` to attach
skills. Changes are written back to `.flow-code/workflow.yaml` and picked up by
any node that has not started yet — a node already running keeps the
configuration it started with.

This is the cheapest way to react to a run going wrong: drop a node onto a
smaller model, or attach a skill the step turned out to need, without stopping
and restarting.

## Mouse

The mouse is an enhancement layer, never the only way to do something.

- Click a card to focus it, drag it to move it
- Click a model or skill badge to open that picker
- Drag a panel by its `⠿` handle, resize it from the `⇲` corner, `ctrl+p` docks it again
- Wheel pans, `shift+wheel` pans sideways, `ctrl+wheel` zooms

## Watching rather than driving

`flow-code watch` opens the same canvas read-only against a run started
elsewhere. The per-node editing keys are disabled there — the key map says so
when you press `?` — because the process that owns the run is the only one
allowed to write it. See [Watching and status](observability.md).
