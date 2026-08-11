## Context

`latestRunState` (`src/runstate/watch.ts`) already resolves the newest run document for a repository, and `RunStateWatcher` already follows one across processes — that module carries an explicit note that nothing in it ever writes, because "a viewer that could scribble on the run it is watching would be a far worse bug than a viewer that lags a frame." A status strip is the smallest possible consumer of that seam: one read, one render, exit.

The consuming surface is a host's status bar. The shape those share, and what this design is written against: the command is re-run on host events and optionally on a short timer, it is given the terminal width, it may be cancelled while running if another update arrives, and whatever it prints is displayed as-is including ANSI. That makes latency and side effects the binding constraints, not features.

`src/cli/runs.ts` already renders run summaries for `flow-code runs`, and `tallyNodeStatuses` (`src/cli/run.ts`) already reduces node statuses to a phrase. `pidAlive` already distinguishes a finished run from one whose driver died. This change is mostly composition of things that exist; the new work is the width ladder and the choice of what to say.

## Goals / Non-Goals

**Goals:**
- Answer "where is the run, what has it cost, what does it need from me" in one or two rows, correctly, from outside the driving process.
- Degrade legibly from a wide terminal to a narrow one, never by wrapping and never by silently dropping the most important thing.
- Cost nothing to run: no writes, no locks, no network, fast enough to be re-run on every session event.
- Be usable from anything that can run a command, not only from a host extension.

**Non-Goals:**
- Interaction. Nothing in this surface approves, focuses, opens, or edits.
- Reproducing graph structure. Edges, loop-back arcs, and layout are the canvas's job; the strip shows sequence and status, not shape.
- Following a run continuously. The strip is a snapshot per invocation; the host's refresh cadence is the host's business.
- Host-specific installation. Which file a script is registered in belongs to whichever change packages an extension for that host.

## Decisions

**The headline resolves to exactly one node: waiting, then running, then error, then nothing.** A strip that lists several nodes at once buries the only one the user can act on. Waiting outranks running because a waiting node is the only state where the run is stopped and the human is the reason. *Alternative considered:* show the node the run is "on" by topological position. Rejected — under concurrency there is no single such node, and the interesting node is rarely the furthest one.

**One segment, not one bar.** The default `--line` output is a fragment a user pastes into whatever status bar they already have. Claiming the whole bar means overwriting a configuration the user built and, on hosts where a custom bar suppresses built-in footer hints, silently costing them keyboard affordances they had before. *Alternative considered:* ship the full script as the primary path. Kept, but as the convenience for users with no bar, never as the default assumption.

**Width degradation drops context before it drops the blocking node.** The ladder is: labelled chain on its own row → glyph chain inline with the headline → headline alone. Numbers (spend, budget, progress) go before node labels, node labels go before glyphs, and the blocking node's identity and reason are the last thing standing. *Alternative considered:* ellipsize the whole line at width. Rejected — it truncates from the right, which is where the reason lives.

**A dead driver reads as dead, not as frozen.** A run with no `finishedAt` whose recorded pid is gone is reported as crashed, reusing the same liveness interpretation the viewer applies. A strip that shows a stalled `running` node forever is worse than one that says the driver is gone, because the first one looks like work in progress. *Alternative considered:* infer staleness from file mtime. Rejected as a second definition of liveness for the same fact.

**Unavailable is rendered as unavailable.** For a run whose enforcement tier provides no token accounting, spend renders as unknown rather than as zero — matching what `add-guest-mode-reporter` requires of the viewer. The strip must not become the one surface that quietly implies a guarantee.

**Failure renders as "no run", never as an error.** A missing directory, a partially written document, a schema from a future version: all of them print the idle form and exit zero. A status bar that displays a stack trace where a run summary should be is a broken status bar, and the user cannot debug it from there. *Alternative considered:* exit non-zero so a misconfiguration is noticed. Rejected for the display path; `flow-code status` in its human-facing form can still be explicit about why it found nothing.

## Risks / Trade-offs

- **The strip is a compressed lie by construction** — it says "implement, running" while eight things are happening → Accepted and bounded: the strip's job is to be the pointer, and `flow-code watch` remains the thing you open when the pointer is not enough. The requirement that it never overstate (unavailable, crashed, blocked) is what keeps compression honest.
- **A host that re-runs the command aggressively multiplies its cost** → One file read and no allocation beyond the document itself; if that ever becomes visible, the fix is caching against mtime, not doing less work per call.
- **Node ids are the labels, and a project can name them anything** → Ids come from the user's own `workflow.yaml`, so they are as good as the names the user chose. Nothing is invented for display.
- **Two renderers for the same run state (canvas and strip) can drift in what they claim** → Real; the mitigation is that both read the same document and that liveness, tier, and status vocabulary come from shared code rather than being re-derived here.

## Migration Plan

Purely additive: a new read-only subcommand. No existing command, file format, or run behavior changes. Rollback is deleting the subcommand.

## Open Questions

- Does the strip identify which run it is summarizing (a short run id) in the narrow forms, or is that only worth the columns in the wide form? It matters exactly when a user has two runs going and not otherwise.
- Should the notification path be part of this change or of whichever extension consumes it? It is the one piece that needs a host to hook into, which cuts against this change's independence.
- Is there a second row worth spending on — recent activity, subagent count, rate-limit meters — or does anything beyond two rows stop being a status and start being a bad canvas?
