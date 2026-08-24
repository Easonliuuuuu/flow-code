#!/usr/bin/env bash
# Lays out the companion demo: a recorded Claude Code session on the left, the
# graph that session drove on the right. Both panes replay the same real
# session — one captured as terminal output, one as run-state — so nothing here
# calls a provider, and the pair can be re-cut as often as the UI changes.
#
# Driven by `companion.tape`; run it directly to watch the composition without
# recording it (SPEED=3 to study it slowly).
#
# Four things here are load-bearing, each one a bug that took a render to find:
#
#   * the session is created at its final size. tmux resizing a pane on attach
#     desyncs Ink's line accounting, and Claude's UI repaints on top of itself.
#   * the left pane is exactly the 100 columns the cast was recorded at.
#   * both streams scale by SPEED and nothing else. `demo.mjs --max-gap` and
#     `asciinema -i` each clamp their own stream, which drifts the panes apart
#     by whatever idle time one had and the other did not. `warp.mjs` does that
#     job for both at once, before playback.
#   * `restamp.mjs` moves the recording's clock to now. A running node reports
#     `now - startedAt`, which against a recording made days ago renders as
#     `12h39m` beside an agent pane saying `17s`.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SPEED=${SPEED:-7}
# Head catch-up (2s, see warp.mjs) + the gap between the window opening and the
# run opening. `warp.mjs` prints the right value for any speed.
DELAY=${DELAY:-2.78}
ASCIINEMA=${ASCIINEMA:-asciinema}

if ! command -v "$ASCIINEMA" >/dev/null 2>&1; then
  echo "companion: need asciinema on PATH (or set ASCIINEMA=/path/to/asciinema)" >&2
  exit 1
fi

LEFT="sleep 2; $ASCIINEMA play -q -s $SPEED $HERE/companion.cast; sleep 60"
RIGHT="sleep 2; node $HERE/restamp.mjs $HERE/companion-run.jsonl $HERE/.companion-run.play.jsonl $DELAY; sleep $DELAY; node $REPO/scripts/demo.mjs play --recording $HERE/.companion-run.play.jsonl --speed $SPEED --max-gap 999999 --hold 20000; sleep 60"

tmux kill-session -t companion 2>/dev/null
tmux -f /dev/null new-session -d -x 255 -y 29 -s companion "sh -c '$LEFT'"
tmux split-window -h -t companion -l 154 "sh -c '$RIGHT'"
tmux set -t companion status off
tmux set -t companion pane-border-lines simple
tmux attach -t companion
