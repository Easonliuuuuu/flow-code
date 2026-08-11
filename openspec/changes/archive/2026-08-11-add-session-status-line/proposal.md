## Why

The canvas cannot follow a user into an agent CLI session. A host session is an append-only transcript with an input line the host owns — there is no pane a third party can draw a graph in, and rendering one into the scrollback produces a snapshot that is wrong a second later. So a user working inside `claude` or `codex` beside a flow-code run has no idea where the run is without switching windows, which is the switching cost `add-guest-mode-reporter` exists to remove, reappearing one level down.

What a host session *does* offer is a status bar: a command the user owns, re-run on session events and on a timer, rendering as many rows as it prints. That is enough for the three questions `BR-09` asks — where is the run, what has it cost, what is it about to do — compressed into one or two rows that are always on screen. It is not the graph and this change does not pretend otherwise; it is the difference between knowing a run is blocked on your approval and finding out ten minutes later.

Two properties make this worth doing now rather than alongside the parked BR-06 work. It introduces **no second producer of run-state** — it reads `.flow-code/runs/<runId>.json` and writes nothing — so the M2 argument that parks `add-guest-mode-reporter` and `add-mcp-driver-connector` does not apply to it. And it is **independent of who is driving**: the same strip serves a run started by `flow-code run` in another window, by a host session under guest mode, or by an MCP-driven run, because all three write the same document.

## What Changes

- **New `flow-code status` command** rendering the current run of the repository as text: the node that most needs attention, per-node progress, spend against budget, and the run's enforcement tier when it is not engine-driven.
- **A `--line` mode producing one composable segment** rather than a whole status bar. A user's status bar usually already exists and already belongs to them; a tool that claims the whole bar is a tool people uninstall. The full-bar script stays available as a convenience for users who have none.
- **A width ladder.** Full labelled node chain when there is room, glyph chain plus the blocking node when there is less, and the blocking node alone when there is almost none. Truncation reuses `src/ui/textwrap.ts`, which already measures display columns rather than JS string length.
- **A turn-end notification path** for the transitions a passive strip can be missed on — a node entering `waiting` or `error` — announced once rather than on every subsequent check.
- **Read-only and side-effect free by construction.** The command never writes, never locks, never blocks, and renders a missing, partial, or unreadable run document as "no run" rather than failing. It is re-run constantly by whatever host is displaying it, and may be cancelled mid-flight.

Out of scope, deliberately: interaction of any kind (approving a gate, focusing a node, opening a diff), rendering the graph's edges or layout, and any host-specific packaging — installing the strip into a particular host's configuration belongs to that host's extension, not here.

## Capabilities

### New Capabilities
- `session-status-line`: summarizing a live run as a bounded text status for a surface flow-code does not own — what the summary must answer, how it degrades with width, how it names a run whose driver has died, and the guarantee that reading a run never disturbs it.

## Impact

- **Serves BR-03**, not BR-09. The strip is a second, read-only viewer attached to a live run in a process that is not the driver, which is BR-03's outcome; `terminal-canvas-ui` already owns "legible on one screen" for BR-09. This also gives BR-03 its first change, and closes part of what GAP-01 records about read-only viewing being unspecified.
- **`src/cli/`**: a new `status` subcommand alongside `run`/`init`/`watch`/`runs`. No existing subcommand changes.
- **`src/runstate/`**: a second read-only consumer through the existing `latestRunState` path. No new writer, no change to the document format, no change to `RunStateStore`.
- **`src/ui/`**: reuses `textwrap.ts` for width-correct truncation. The strip is not an Ink component and does not render through the canvas — it prints and exits.
- **Not blocked on M2.** Unlike the two parked BR-06 changes, this adds no entry point into the engine and no second writer of run-state.
- **Relationship to `add-guest-mode-reporter`**: that change's plugin installs this strip; this change makes it exist and keeps it usable outside any plugin — in a shell prompt, a tmux status line, or a bare terminal.
