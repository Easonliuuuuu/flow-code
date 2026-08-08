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

- **Open decision, the biggest one.** `brief.md` says the second audience has
  "the *most* to gain," but the roadmap gives them two sub-bullets and no BR.
  The missing outcome is roughly *"a gate is approvable without reading the
  diff"* — today the gate renders a diff, so constraint #3 ("nothing reaches git
  without explicit approval") only means something to someone who can evaluate
  what they're approving. For everyone else, approval is a rubber stamp, which
  is a weaker guarantee presented as a stronger one (constraint #2). Either this
  becomes a BR in M2, or `brief.md` should stop claiming the second audience is
  the one with the most to gain. Both are honest; leaving it as-is is not.
- If that decision lands as a BR, `approval-gate` probably splits out of BR-08
  to serve it. Noted so the ledger's five-capability BR has a known seam.
- `flow-code watch` has no spec coverage at all — a whole user-facing command.
  Already noted in the guest-mode proposal's Impact section, never tracked.
- `src/runstate/` has no capability spec, and it is the file watch and guest
  mode both depend on.
- BR-01 has no capability spec of its own. The first-run surface — `src/init/`,
  `src/presets.ts`, the scaffold, the discovery confirmation prompts — is real
  code described in pieces inside `workflow-graph` and `test-command-discovery`,
  but nothing is *about* first-run. Probably why "ship-ready" feels unfinished.
- BR-05 has no capability either, and it's the same shape from the other end:
  it needs the navigation half of `terminal-canvas-ui` (viewport, pan/zoom,
  collapse, off-screen indication) split into its own spec. Deferred ER work.
- Should the splash screen be part of `terminal-canvas-ui`, or is it its own
  thing? Shipped without deciding.
- A real commit-scope convention (beyond the historical aliases already in
  `coverage.yaml`) would stop scopes like a bare filename from happening again.
  Not urgent — `status:check` catches the cases it causes as they occur.
- `wire-up-cicd-and-readme` is 0/13 in `STATUS.md` while CI, the README,
  `CONTRIBUTING.md`, and release-please have all shipped. Task checkboxes are a
  hand-maintained status column — the exact thing this layer exists to distrust
  — and the check only catches unchecked boxes on *archived* changes, so a
  change that shipped and was never archived falls in the blind spot. Archive
  it; then decide whether that blind spot deserves a fourth drift kind.
- `staleness_days: 30` in a repo whose whole history is six days old and holds
  six archived changes. Relative to this project's cadence the warning cannot
  fire before the habits it exists to correct have already set.

## Triaged

- `node-skills`, `node-subagents`, `worktree-agent-node` — all three serve one
  outcome, now written as **BR-07**: a node can gain capability without the run
  losing its boundaries. Skills extend the agent, subagents delegate within it,
  worktrees isolate where it writes; in all three the node stays the unit of
  budget, envelope, and approval. Mapped in `capabilities:`; GAP-07/08/09 closed.
- `src/executors/` — already mapped to `agent-execution` in `coverage.yaml`.
  The line was stale; it had been fixed and never triaged out.
- `presets` — folded into `workflow-graph`'s existing "Workflow presets"
  requirement (it was already there, just incomplete): added scenarios for the
  spec-kit preset, the CLI-install offer, and the skill-scaffold offer. Small
  feature, no OpenSpec change needed — a direct spec.md edit was enough. GAP-03
  and GAP-04 closed.
- `feat(nvidia-integration.yml)` — not a real feature, a CI file typed as
  `feat`. Registered permanently as GAP-06, nothing to fix.
