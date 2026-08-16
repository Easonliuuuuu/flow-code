# Watching and status

Two ways to see a run without driving it: a second window showing the full
graph, or a compressed row for when there is no window to spare.

## Watching a run from another window

The engine writes complete run state to `.flow-code/runs/<runId>.json` after every change, so a run can be followed from anywhere that can read the repo:

```bash
flow-code run      # window 1 — drives the workflow
flow-code watch    # window 2 — same graph, read-only
```

`watch` attaches to whichever run is currently being written, and picks up a run started *after* it was opened, so it can be left open on a second monitor. Pass a run id (`flow-code watch <runId>`) to pin it to one run. It never writes: the keys that edit `workflow.yaml` are disabled, and the header reports whether the process driving the run is still alive. If two runs are live at once, `watch` names them and asks which — it will not pick one and appear to flip between them.

A run document records which process on which machine owns it, and only that process may write it: a second writer is refused rather than allowed to interleave. That makes the driver's state one of three things, and every reader — `watch`, `runs`, `status`, `doctor` — reports them apart:

| | What it means |
| --- | --- |
| **live** | The owning process is running on this machine. |
| **gone** | The owning process was on this machine and has exited — a crash, or a `kill -9` that skipped the shutdown path. Distinct from a run you interrupted with ctrl+c, which records that it ended and stays resumable. |
| **unknown** | This machine cannot answer: the run was driven from another machine over a shared checkout, or its document predates ownership being recorded. |

`unknown` is deliberately never rounded to either neighbour. It is why `flow-code doctor` leaves worktrees belonging to an unanswerable run alone rather than reclaiming them — "I can't tell" must not authorize deleting someone else's working tree.

## Keeping a run in view without a window

When there is no window to spare — you are in an agent CLI, an editor terminal, or a tmux pane doing something else — `flow-code status` compresses the same run into a row or two:

```
●discuss ●spec ●implement ●test ●validate ●review ◆gate ○git-ops  ◆ gate needs your approval  6/8 · 2.1M tok · 12% budget
```

It answers the three questions a graph answers — where the run is, what it has cost, what it needs from you — and nothing else. It shows sequence and status, not shape: no edges, no loop-back arcs, no layout. It is a pointer to the canvas, not a replacement for it.

```bash
flow-code status                  # a row or two, sized to your terminal
flow-code status --line           # exactly one row, for embedding in a status bar
flow-code status --json           # the same summary as data, plus an attention token
flow-code status --script         # a ready-made status-bar script, if you have none
```

`--line` emits one row and nothing else, so it can be pasted into a status bar you already have — in Claude Code, call it from your existing `statusLine` script rather than replacing that script, since a custom status line replaces some of the built-in footer hints. `--script` prints a complete one for a host with none; register it yourself (`status` never edits your host's configuration — `flow-code connect` is the one command that does, and it names every file it touches).

The output narrows as the width does: labelled nodes, then status glyphs, then whichever node is blocking the run and why — that last part is the thing it never drops. It works against any run in the repo, whoever started it, and it reads the run file without writing, locking, or slowing the process driving it. A run whose driver died reads as *driver gone* rather than as work in progress.

`--json` exists for scripting a notification: the payload carries an `attention` token that stays the same while the same node is blocked and changes when a different one is, so a hook can announce a waiting gate once instead of on every check. flow-code keeps no record of what it has announced — pass the last token back with `--since`.
