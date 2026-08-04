---
name: "Testbed"
description: Generate a clean mock repo for driving the flow-code TUI by hand
category: Dev
tags: [ui, tui, manual-testing, scaffold]
---

Rebuild `dist/` and generate a fresh throwaway repo to run the flow-code TUI
against, then print how to launch it.

**Input**: optionally a shape and/or destination after `/testbed` — e.g.
`/testbed tall`, `/testbed tiny`, `/testbed --dest ~/scratch/fc`. Defaults to
the `wide` shape at `~/flow-code-testbed`.

Use the **Skill tool** to invoke `testbed` with any provided input as context.
