---
name: "Testbed"
description: Generate a clean repo for testing engine or companion mode
category: Dev
tags: [ui, tui, manual-testing, scaffold]
---

Generate a fresh throwaway repo for one of flow-code's three execution paths,
then print exactly how to launch it.

**Input**: optionally a mode (`engine`, `companion-local`, or
`companion-release`) and/or a destination after `/testbed` — e.g. `/testbed
engine`, `/testbed companion-local`, or `/testbed companion-release --dest
~/scratch/fc`. Ask for the mode when it is omitted.

Use the **Skill tool** to invoke `testbed` with any provided input as context.
