# The README demo

There are two demos here, and they are made the same way.

| | Shows | Tape | Recording |
| --- | --- | --- | --- |
| **Companion** — the README hero, `flow-code.gif` | An agent session flow-code did not start, with the graph filling in beside it | `companion.tape` | `companion.cast` + `companion-run.jsonl` |
| **Engine** — `engine.gif`, not committed | flow-code driving the graph itself, including a loop-back firing | `flow-code.tape` | `run.jsonl.gz` |

`npm run demo:record` cuts the first; `npm run demo:record:engine` cuts the
second. The engine demo is kept because it is the only recording of a failing
Test node routing back to Implement, which is the thing a chat log cannot show.

Everything below describes the engine demo, whose pipeline came first and which
the companion demo is built on top of. [Part 3](#part-3--the-companion-demo)
covers what the second pane adds.

`docs/demo/engine.gif` is a **replay of a recorded run**, not a live one.

A real run takes minutes, spends tokens, and never repeats itself, so recording
one directly gives you a demo you can never reproduce — and a demo nobody can
re-record is a demo that goes stale the first time a card changes shape. So the
run is captured once, as data, and replayed through the real UI whenever the
GIF needs to be made again.

The engine writes the complete run-state document to
`.flow-code/runs/<runId>.json` on every change, which is what makes this
possible: a recording is that file's successive versions with timestamps
(`run.jsonl`, one JSON frame per line), and a replay pushes those versions back
into the same `RunStateStore` the engine writes to, driving the same `runUi`
that `flow-code run` mounts. Nothing is mocked or re-implemented, so the GIF
can only drift from the tool in one way: by being a recording of an older run.

One consequence worth knowing up front: **the terminal you record in has
nothing to do with the terminal in the GIF.** What's captured is state, not
pixels, so the replay re-renders the graph at whatever size the tape asks for.
Record in any window, at any font size.

---

## Part 1 — Re-recording the GIF from the committed recording

If `run.jsonl` is already what you want and only the GIF needs remaking:

```bash
npm run build
npm run demo:play -- --speed 16 --max-gap 600   # look at it yourself first
npm run demo:duration -- --speed 16 --max-gap 600 --hold 6000
npm run demo:record:engine                      # writes docs/demo/engine.gif
```

The committed recording is `run.jsonl.gz`. Full run-state documents repeated
once per frame compress to about a sixth of their size (4.9 MB → 771 KB), and
this blob is in git history permanently. `play` and `duration` read either form
transparently. Captures are written plain: a capture is append-only so a ctrl+c
keeps every frame it already had, which one gzip stream would not survive — so
pack it by hand before committing:

```bash
gzip -9 -c .flow-code/demo-run.jsonl > docs/demo/run.jsonl.gz
```

Both `demo:record` targets need [VHS](https://github.com/charmbracelet/vhs) on `PATH`
(`brew install vhs`, or `go install github.com/charmbracelet/vhs@latest` plus
`ttyd` and `ffmpeg`). `vhs themes` lists the theme names the tape can set.

Keep the GIF under ~5 MB — it is served on every README view, including npm's.
Framerate and the tape's `Sleep` are the two levers that actually move that
number. And re-record sparingly: each one is a new blob in git history,
permanently.

---

## Part 2 — Capturing a new run

### Before you start

1. **Commit or stash everything.** A run baselines against the working tree as
   it stands at start, so uncommitted work shows up in the agent's diff, in the
   Review node, and in whatever Git-ops commits. Start clean.

2. **Build, and run the local build.** Use `node dist/cli.js`, not a globally
   installed `flow-code`:

   ```bash
   npm run build
   ```

   This is not just tidiness. A replay rebuilds the graph from the `graph` key
   the run recorded into its own state file, and older builds didn't write one.
   A recording captured from a stale binary can't be played back at all.

3. **Check the workflow is the graph you want on camera.**

   ```bash
   node dist/cli.js validate
   ```

   `.flow-code/` is gitignored, so whatever is in your local `workflow.yaml`
   may be old — and an old scaffold is missing the things worth filming: the
   Spec node, its own gate and loop-back to Discuss, and the verification
   loop-back edges. The current default scaffolds 9 nodes and 13 edges;
   anything less, re-scaffold:

   ```bash
   node dist/cli.js init     # answer yes to overwriting, take the default preset
   ```

   `init` also runs the provider wizard when `.flow-code/credentials.json`
   doesn't exist yet. Get that out of the way now rather than on camera.

### The run

Two windows, from the repo root:

```bash
# window 1 — the run
node dist/cli.js run

# window 2 — records it; reads the run file, never writes to it
npm run demo:capture
```

Start the capture first or second, it doesn't matter — it waits for a run to
appear and starts its clock on the first frame it sees.

Then drive the run:

- **Discuss** — say what you want built, in one short sentence. It's persisted
  and shows up in the detail panel, so keep it legible.
- **Test** — the first time the Test node runs it asks what your test command
  is. Answer `npm test`. It saves the answer to `workflow.yaml`.
- **Gate** — approve. The pause before anything touches git is worth filming.
- **A failing Test is a win.** The loop-back arrow firing back to Implement is
  the one thing a chat log can't show. Let it fail; don't rescue it.

The capture stops on its own about a second after the run finishes, or on
ctrl+c. Nothing about it is invasive — it only reads — so leaving it running
during ordinary work is a fine way to collect candidate takes.

### Review what you got

```bash
npm run demo:play
```

**Read the recording before committing it.** Each frame carries the run's
activity log (every tool call and command line), each node's recorded output,
and the Discuss transcript — verbatim, from whatever repo you recorded in. The
GIF publishes whatever ends up on screen, and the JSONL publishes all of it.
`--redact` drops output, transcripts, and session ids for a run you'd rather
show only the shape of, at the cost of empty detail panels in the replay.

Every line is a standalone frame, so trimming is just cutting lines: drop
leading lines to start the demo later, trailing lines to end it earlier.

Then continue from Part 1 to cut the GIF.

---

## What a recording can't show

Streamed agent output. The store keeps that in memory only, so it never reaches
the run file and can't be captured from it. Statuses, attempts, token spend,
the activity log, and each node's recorded output all persist, and all replay.

## Playback knobs

`node scripts/demo.mjs play --help` lists them. The two that matter are
`--speed` (divides every gap, so streaming still reads as motion) and
`--max-gap` (clamps the minute-long silences while an agent thinks, which no
viewer will sit through). `--splash` includes the startup splash.

Because `play` mounts the real UI with its keys live, the tape can drive it —
`tab` to focus a node, `enter` to open its details over the graph, `z` for
compact cards. Add those to the tape as `Type`/`Sleep` pairs once you know
where the interesting moments land.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `this recording has no recorded graph` | Captured from a build older than recorded graphs. Re-capture with `node dist/cli.js`. |
| `demo: nothing captured` | `--repo` pointed somewhere without a run writing to `.flow-code/runs`. |
| `ignoring <id> — already finished` | Not an error: a run from an earlier session is sitting in `.flow-code/runs`. The capture waits for a live one. Pass `--run <id>` to record that finished run anyway. |
| `cannot rebuild the graph this run recorded` | The run used skills that don't exist on this machine — play it where they do. |
| Replay races past | Lower `--speed`; it divides real gaps, so 1 is real time. |
| Replay drags | Lower `--max-gap`. Long stalls are agents thinking, and they clamp well. |
| GIF too large | Fewer frames: drop `Set Framerate`, shorten `Sleep`, raise `--speed`. |

---

## Part 3 — The companion demo

The hero GIF shows a session flow-code did not start. That needs a second
recording: run-state describes what the graph did, and says nothing about what
the agent's own terminal looked like while it did it.

So one session is captured twice, at the same time.

```bash
# window 1 — the agent, recorded as terminal output
cd /path/to/a/testbed && asciinema rec --window-size 100x26 -c claude session.cast

# window 2 — the same run, recorded as state (reads the run file, never writes)
npm run demo:capture -- --repo /path/to/a/testbed --out session.jsonl
```

Nothing new is needed to capture the graph half: `src/guest/report.ts` writes to
the same `runFilePath` the engine does, so `demo:capture` sees a reported run
exactly as it sees a driven one. Use `.claude/skills/testbed/make-testbed.sh
--mode guest` for a repo to record in.

Two things ruin a take, and neither is visible until you replay it:

- **Delegation.** If the session dispatches the work to a subagent, its own
  pane shows a spinner and nothing else — the whole left half comes out empty.
  Leave auto mode off, and tell the agent to walk the steps itself. Non-interactive
  node briefs ask for a fresh subagent; Discuss and Plan explicitly stay in the
  user-facing conversation.
- **Stopping the capture early.** Let it run until the last node resolves. A
  capture that stops sooner leaves the two halves covering different spans, and
  they cannot be re-aligned afterwards.

### Putting the two halves together

```bash
node docs/demo/warp.mjs \
  --cast session.cast --run session.jsonl \
  --cast-out docs/demo/companion.cast --run-out docs/demo/companion-run.jsonl \
  --start 92 --end 435 --max-gap 3 --speed 7
```

`--start`/`--end` are seconds into the cast: the window worth showing. Read them
off the cast — the run's `createdAt` against the cast header's `timestamp` gives
you where the run opens, and there is usually a minute of typing before it.

The rest of what `warp.mjs` does is what makes the panes stay together:

- **One clock for both.** `demo.mjs --max-gap` and `asciinema -i` each clamp
  their own stream, which is correct alone and wrong in a pair: two streams
  clamped separately no longer describe the same time, and drift apart by
  whatever idle one had that the other did not. The warp is computed once over
  the union of both streams' event times and applied to both. Only intervals
  where *neither* stream did anything are shortened. On the committed recording
  that turns 343s of wall clock into 120s of activity, most of it the four
  minutes the gate spent waiting to be approved.
- **A paced head.** Events before the window are kept, so the pane opens on the
  scrollback the session had drawn — Claude Code renders its conversation as
  history, so clearing instead opens an empty pane that never fills. They are
  spread over ~2s rather than dumped at once.

It prints the `SPEED` and `DELAY` the tape and `companion.sh` need. They must
agree with each other, or the panes drift.

### Then cut it

```bash
./docs/demo/companion.sh    # watch the composition (SPEED=3 to study it)
npm run demo:record         # writes docs/demo/flow-code.gif and companion.webm
```

`companion.sh` documents the four constraints that took a render each to find —
pinned session size, the exact 100-column agent pane, no per-stream clamping,
and `restamp.mjs` moving the recording's clock to now so a running node reports
`0s` rather than `12h39m`.

### What the two recordings contain

`companion.cast` is a **verbatim terminal recording**: the prompt, the agent's
output, every tool call, and whatever was on screen. `companion-run.jsonl`
carries the run's activity log and each node's recorded output. Both are
committed, and both are permanent in git history. Record the take in a testbed,
never in a repo whose contents you would not publish — `demo:capture --redact`
covers the state half only, and there is no equivalent for the cast.
