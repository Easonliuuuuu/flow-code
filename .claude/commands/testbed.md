---
name: "Testbed"
description: Generate a clean mock repo for driving the flow-code TUI by hand
category: Dev
tags: [ui, tui, manual-testing, scaffold]
---

Rebuild `dist/` and generate a fresh throwaway repo to run the flow-code TUI
against, then print how to launch it.

**Input**: optionally a mode (`ui`, `splash`, `clean`), a shape (`ui` mode
only — `wide`, `tall`, `tiny`), and/or a destination after `/testbed` — e.g.
`/testbed ui tall`, `/testbed splash`, `/testbed clean --dest ~/scratch/fc`.
Anything not given is asked for.

Use the **Skill tool** to invoke `testbed` with any provided input as context.
