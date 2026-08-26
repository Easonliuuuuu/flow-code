# Why a graph, not a chat log

This follows Anthropic's own split between *workflows* — LLMs and tools
orchestrated through predefined, inspectable code paths — and *agents*, where an
LLM directs its own process. flow-code commits to the first: a graph you can
read before it runs, not a plan improvised as it goes. See [Building Effective
Agents](https://www.anthropic.com/research/building-effective-agents).

The `spec` node and the `openspec`/`spec-kit` presets apply the same commitment
to the code itself: a written spec precedes implementation, outlives it, and is
what changes get checked against — [spec-driven
development](https://github.com/github/spec-kit), not a chat prompt discarded
once the code exists.

`--preset planned` is the one deliberate exception, worth naming rather than
leaving implicit: its graph isn't fixed at load, it's negotiated with you by a
`plan` node before anything runs headless. Not a graph read in advance, but one
agreed to before it runs — and nothing reaches git without approval either way.
See [planning the graph](workflow-reference.md#planning-the-graph).

## The default graph

`flow-code init` scaffolds this. Every node is optional and rewireable.

```
  Discuss ─→ Spec ─→ Gate ─→ Implement ─→ Test ─→ Validate ─→ Review ─→ Gate ─→ Git-ops
     ↑                 │         ↑         │         │          │         │
     └─────────────────┘         └─────────┴─────────┴──────────┘         ↓
                                 ↑                                      Revise
                                 └───────────────────────────────────────┘

  a rejected spec loops back to Discuss
  a failing verdict loops back to Implement
  a rejected diff opens Revise, and what you settle there goes back to Implement
```

| Node | What it does |
| --- | --- |
| **Discuss** | The only interactive step — settles what is being built before anything runs headless. |
| **Spec** | Turns that discussion into acceptance criteria, written to `.flow-code/specs/<runId>.md`. |
| **Gate** (first) | Pauses for an explicit yes or no on the spec before any code is written; a rejection reopens Discuss with your reason. |
| **Implement** | Writes the code and the tests covering it. |
| **Test** | Runs your test commands, working them out from the repo the first time and asking you to confirm. The verdict is an exit code, never a model's opinion. |
| **Validate** | Checks the result against the spec's acceptance criteria, one by one. |
| **Review** | Reviews the pending diff. |
| **Gate** (second) | Pauses for an explicit yes or no before anything touches git; a rejection opens Revise. |
| **Revise** | A second conversation, reached only when you turn a diff down — a gate records your decision but not your reasoning, so this is what carries the *why* back to Implement. |
| **Git-ops** | Commits, and pushes if you configured a remote. |

## The other presets

All of them are ordinary node graphs, as editable as anything else — a preset is
a starting `workflow.yaml` and nothing more.

| Preset | Graph |
| --- | --- |
| `openspec` | `explore → propose → gate → apply → test → validate → archive → gate → git-ops`, wired to the OpenSpec skills |
| `spec-kit` | `specify → plan → gate → tasks → implement → test → validate → gate → git-ops`, after GitHub Spec Kit |
| `frugal` | The default graph with the expensive parts removed — see [What a run costs](cost.md) |
| `planned` | `plan → gate → git-ops` — the middle is negotiated with you at run time |

## Where it does not fit

Worth saying plainly, since the trade is real:

- **A typo, a rename, a one-line fix.** The structure costs more than it saves.
  Ask your agent directly.
- **Fully unattended CI.** Two gates and a Discuss node all wait for a human —
  see the [FAQ](faq.md#can-i-run-it-in-ci).
- **A repository you would not hand to a contractor for an afternoon.** The
  shell guard is a guardrail, not a sandbox — see [Security and
  privacy](security.md).
