# The README demo. Regenerate with `npm run demo:record` (needs VHS:
# https://github.com/charmbracelet/vhs), which replays docs/demo/run.jsonl.gz
# through the real UI and records the result.
#
# Everything up to `Show` is setup that never reaches the GIF, so the recording
# opens on the graph itself rather than on a shell prompt.
#
# Composition: the run plays out in full cards — status, summary, tokens, clock
# per node — and then `o` pulls back to the whole graph, all eight nodes green
# with the loop-back arcs visible. Full cards are worth the run; the pull-back
# is worth the ending, because an eight-node chain does not fit on screen at a
# readable font size and the gate is the last thing you want cropped.
#
# Two numbers to re-tune after re-capturing:
#   npm run demo:duration -- --speed 16 --max-gap 600 --hold 6000
# reports how long the replay runs. `Sleep` before `o` should land a little
# after the frames end, and --hold must outlast the final Sleep.

Output docs/demo/flow-code.gif

Require node

Set Shell "bash"
Set FontSize 13
# ~200 columns, which is what the eight-node graph needs in compact form.
Set Width 1600
Set Height 560
Set Padding 20
Set Framerate 20
# Dark, so the GIF reads the same against GitHub's light and dark themes.
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "clear && node scripts/demo.mjs play --speed 16 --max-gap 600 --hold 6000"
Enter
# Let Ink mount and paint a full frame before the recording starts.
Sleep 2s
Show

# The run itself: frames end at ~29s.
Sleep 27s

# Pull back to the finished graph.
Type "o"
Sleep 6s
