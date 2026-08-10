# The README demo. Regenerate with `npm run demo:record` (needs VHS:
# https://github.com/charmbracelet/vhs), which replays docs/demo/run.jsonl
# through the real UI and records the result.
#
# Everything up to `Show` is setup that never reaches the GIF, so the recording
# opens on the graph itself rather than on a shell prompt. The one number to
# re-tune after re-capturing is the `Sleep` below: it has to cover the whole
# replay, and `npm run demo:duration` prints exactly how long that is.

Output docs/demo/flow-code.gif

Require node

Set Shell "bash"
Set FontSize 13
Set Width 1200
Set Height 720
Set Padding 20
Set Framerate 20
# Dark, so the GIF reads the same against GitHub's light and dark themes.
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "clear && node scripts/demo.mjs play --speed 4 --hold 2500"
Enter
# Let Ink mount and paint a full frame before the recording starts.
Sleep 2s
Show

Sleep 40s
