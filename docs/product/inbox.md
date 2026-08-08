# Inbox

Anything you thought of and don't want to lose. **One line. No format, no ID, no
ceremony.** If capture costs more than a sentence you won't do it mid-flow, and
the thing will die in a prompt somewhere.

This is the only file here you should feel free to write badly.

Triage when you feel like it: each line either becomes a `BR-XX` in
`roadmap.md`, becomes an OpenSpec change, gets folded into an existing one, or
gets deleted. Deleting is a real outcome — most lines should end that way.

---

## Unsorted

- `flow-code watch` has no spec coverage at all — a whole user-facing command.
  Already noted in the guest-mode proposal's Impact section, never tracked.
- `src/runstate/` has no capability spec, and it is the file watch and guest
  mode both depend on.
- `src/executors/` has no capability spec.
- `presets` has three shipped `feat(presets)` commits and one passing mention in
  the specs.
- Should the splash screen be part of `terminal-canvas-ui`, or is it its own
  thing? Shipped without deciding.

## Triaged

*(Move lines here with what happened to them, or just delete them.)*
