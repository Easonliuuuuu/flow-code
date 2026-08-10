# The README demo

`docs/demo/flow-code.gif` is a **replay of a recorded run**, not a live one.

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
npm run demo:play       # look at it in your own terminal first
npm run demo:duration    # how long the replay runs; retune the tape's Sleep
npm run demo:record      # writes docs/demo/flow-code.gif
```

`demo:record` needs [VHS](https://github.com/charmbracelet/vhs) on `PATH`
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
   may be old — and an old scaffold is missing the two things worth filming:
   the Spec node and the loop-back edges. The current default scaffolds 8 nodes
   and 11 edges; anything less, re-scaffold:

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
