# FAQ

## Does it work on Windows?

**Not natively. Use WSL.** This is a real limitation, not an untested guess:
`flow-code` runs your test commands through `sh -c`, which native Windows does
not provide, so the Test node fails there even though the rest of the UI comes
up. CI covers Linux and macOS.

| Platform | State |
| --- | --- |
| Linux | Tested in CI on every push |
| macOS | Tested in CI on every push |
| WSL | Developed on daily; desktop notifications fall back to a PowerShell toast |
| Windows (native) | Test node does not work. Please use WSL |

If you want native Windows support, the [issue
tracker](https://github.com/Easonliuuuuu/flow-code/issues) is the place to say
so — it is a bounded change (two `sh -c` call sites), and nobody has asked yet.

## Does it need a git repository?

Yes, and it fails immediately and clearly if you are not in one:

```
flow-code: not inside a git repository — flow-code runs per-repo.
```

The repository is not incidental. flow-code's central guarantee is that nothing
reaches git without your approval, and the diff shown at that gate is computed
against a baseline snapshot taken when the run started. Without a repo there is
no diff, no baseline, and no gate worth the name.

`flow-code try` is the exception — it seeds its own throwaway repo, so it works
from anywhere.

## Does it work in a monorepo?

Yes, with one thing to know: `.flow-code/` lives at the **git root**, not at the
package you are working in, because that is where the repository is. Test
commands run from the git root too, so scope them explicitly:

```yaml
- id: test
  type: test
  config:
    commands: ["npm test --workspace packages/api"]
```

If different packages want genuinely different graphs, declare them as [named
graphs](workflow-reference.md#named-graphs) in the one file and pick with
`flow-code run --graph api`.

## Can I run it in CI?

Partly, and probably not the way you want. The default graph has two approval
gates and a Discuss node, all of which wait for a human — in CI they wait
forever. A graph built for CI would have no Discuss node and no gates, which
also means no git-writing node, since flow-code refuses at load time to run a
graph where a git-writing node is reachable without passing a gate.

What does work well unattended is the read-only half. `flow-code reconcile`
checks a run's claims against the repository and **exits non-zero** when the
tree contradicts it, which makes it usable as a CI step directly.
`flow-code status --json` is a reporter rather than a check — it always exits
zero, so branch on its output rather than its status. Desktop notifications
suppress themselves automatically when `CI` is set.

## What does a run cost?

A small change on the default graph is a couple of dollars on a mid-tier model,
and nothing at all if you are signed in to the `claude` or `codex` CLI, because
flow-code uses that subscription rather than metered billing. The full
measurement, and five ways to spend less, are in [What a run
costs](cost.md).

## Do I have to let flow-code run the graph?

No. `flow-code connect` installs the reporting surface into your own agent's
configuration, and you walk the graph yourself from `claude`, `codex`, or
anything else — flow-code draws it beside you instead of driving it. You get
less enforcement that way, and it says exactly how much less: see [enforcement
tiers](agent-integration.md).

## Is any of this sent anywhere?

There is no telemetry. The only network calls are the ones your configured
provider's SDK makes to run a session. Run records — which include verbatim
Discuss transcripts — stay on your disk and are gitignored by default. See
[Security and privacy](security.md).

## Which model does it use?

Whichever you pick during `flow-code init`, per project. Each node can override
it, so an expensive step and a cheap one need not share one: set `model:` on the
node in `workflow.yaml`, or press `m` on a focused node during a run. See
[model resolution](glossary.md#providers).

## What happens if it crashes mid-run?

Nothing is lost that had finished. `flow-code runs` lists past runs and
`flow-code run --resume` picks the most recent one back up: completed nodes are
kept, the rest re-run, and an interrupted Discuss conversation resumes with its
history intact. If the crash left git worktrees behind, `flow-code doctor`
clears them.

## Why is my run stuck?

Check what it is waiting for without disturbing it:

```bash
flow-code status
```

Most often it is a gate, a Discuss turn, or the Test node asking you to confirm
the commands it discovered. If `status` reports the driver as *gone*, the
process that owned the run died — resume it.

## Can I use my own instructions for a step?

Yes — attach a skill. Any agent-driven node takes `skills: [name]`, which layers
your `SKILL.md` on top of its built-in role. `flow-code skills` lists what is
attachable in the current repo. See [Skills](skills.md).

## Something in the docs is wrong. Where do I say so?

[Open an issue](https://github.com/Easonliuuuuu/flow-code/issues). The node type
reference, the CLI table and the settings table are all generated from source
and cannot drift; everything else is written by hand and can.
