# The README demo: companion mode. Regenerate with `npm run demo:record`
# (needs VHS — https://github.com/charmbracelet/vhs — plus tmux and asciinema),
# which replays two recordings of one real session side by side and records the
# result. `companion.sh` holds the composition and explains what is fragile
# about it; `warp.mjs` prepares the pair.
#
# Everything up to `Show` is setup that never reaches the GIF, so the recording
# opens on the two panes rather than on a shell prompt.
#
# Composition: a Claude Code session on the left doing the work, the graph it is
# reporting into on the right. The payoff is the approval gate — the prompt
# appears in the agent pane while the gate card waits in the graph, which is the
# one moment that shows the two panes are the same run.
#
# Geometry is not a preference. 255x29 is the smallest grid that holds a 100-col
# agent pane (the width the cast was recorded at — anything else re-wraps
# Claude's UI) beside a 154-col graph pane (narrower crops the fifth node), and
# Height must leave a row of slack: land exactly on the row count and VHS draws
# the last two rows on top of each other, which merges Claude's mode line into
# the flow-code status row.
#
# FontSize 11 rather than 14 is a size decision, not a legibility one: the grid
# is identical, and it brings the GIF from 5.7MB to 3.8MB. It is served on every
# README view, including npm's, so keep it under ~5MB.
#
# After re-cutting the recordings, re-run `warp.mjs` — it prints the SPEED and
# DELAY this tape and `companion.sh` need, and they must agree or the panes
# drift apart.

Output docs/demo/flow-code.gif
Output docs/demo/companion.webm

Require node
Require tmux

Set Shell "bash"
Set FontSize 11
Set Width 1886
Set Height 417
Set Padding 16
Set Framerate 12
# Dark, so the GIF reads the same against GitHub's light and dark themes.
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "clear && ./docs/demo/companion.sh"
Enter
# Both panes idle 2s before playback, and the left spends 2s catching up on the
# scrollback that precedes the window. Show after both have settled.
Sleep 6s
Show

# 17.1s of warped replay at SPEED=7, plus a beat on the finished graph.
Sleep 21s
