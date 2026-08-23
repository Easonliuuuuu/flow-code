# Security and privacy

flow-code runs agent sessions with file and shell access against your
repository, and writes a record of what they did. This page says what is
protected, what is not, and what ends up on disk — including the parts that are
weaker than they might look.

## What lives in `.flow-code/`

| Path | Contents | Committed? |
| --- | --- | --- |
| `workflow.yaml` | The graph. Reviewable source, like anything else in the repo | **Yes** |
| `.gitignore` | The guard below, so a fresh clone is protected too | **Yes** |
| `credentials.json` | Your provider and, for key-based providers, a **plaintext API key** | No |
| `runs/<runId>.json` | Run state: per-node status, token spend, outputs, and the **verbatim transcript** of every Discuss turn | No |
| `specs/<runId>.md` | The acceptance criteria a run was judged against | No |
| `worktrees/`, `reconcile/`, `enforcement.json` | Transient run state | No |

`flow-code init` writes `.flow-code/.gitignore` the moment it creates the
directory, and it denies by default:

```gitignore
*
!.gitignore
!workflow.yaml
```

Deny-by-default rather than a list of things to exclude, so state added in a
later version is covered on the day it lands rather than the day someone
remembers to add a line. flow-code also appends the same paths to
`.git/info/exclude`, but that file is per-clone and never travels — the
committed `.gitignore` is what protects a colleague who clones the repo and
runs before they have ever run `init`.

**If you upgraded from a version before this existed**, check what git can see:

```bash
git status --short --untracked-files=all .flow-code/
```

Anything beyond `.gitignore` and `workflow.yaml` should not be there. If a run
record was already committed, it is in your history: removing the file in a new
commit does not remove the transcript from earlier ones.

## Transcripts

A Discuss node is a conversation, and the run record keeps it in full so
`flow-code run --resume` can pick it back up where it stopped. That is the most
likely thing in `.flow-code/` to contain something you would not choose to
publish — whatever you typed while working out what to build, quoted alongside
whatever the agent read out of your codebase to answer.

To scrub without losing the run:

```bash
# Drop transcripts from every stored run, keeping status and token history.
for f in .flow-code/runs/*.json; do
  node -e 'const fs=require("fs"),p=process.argv[1],r=JSON.parse(fs.readFileSync(p,"utf8"));
    for (const n of Object.values(r.nodes)) delete n.discussTranscript;
    fs.writeFileSync(p, JSON.stringify(r));' "$f"
done
```

A scrubbed run can still be watched and reconciled; it can no longer resume an
interrupted conversation with its history intact.

To keep nothing at all, delete `.flow-code/runs/` between runs — nothing else
reads it.

## Credentials

`credentials.json` is written mode `0600` and holds a plaintext key for OpenAI
and OpenRouter. Claude and Codex prefer their own CLI login, in which case no
key is stored here at all and the session draws on that subscription — which is
both the cheaper and the safer path, and is what `init` starts on when it finds
one.

There is no telemetry. flow-code makes no network call except the ones your
configured provider's SDK makes to run a session.

## What the engine actually enforces

Each node type holds a fixed **capability** set, and the harness compiles it
into restrictions on the session rather than into instructions:

| Capability | Grants |
| --- | --- |
| `read` | Reading files |
| `edit` | Writing files |
| `exec` | Running shell commands |
| `git-read` | Git commands that cannot mutate the repo, its refs, or a remote |
| `git-write` | Git commands that can |

The vocabulary is closed, and **there is no network capability**: `WebFetch`
and `WebSearch` are unavailable to every session, of every node type. A node
without `edit` cannot write a file whatever its instructions say, and a
subagent is bounded by its parent node's set.

Two structural guarantees sit on top of that:

- **Nothing reaches git without an explicit human approval.** A graph in which
  a git-writing node is reachable without passing a gate is rejected at load
  time, not at run time — see [Every git-writing node must be
  gated](workflow-reference.md#every-git-writing-node-must-be-gated).
- **The test verdict is an exit code**, never a model's opinion, so the loop-back
  that gates progress cannot be talked out of failing.

## What it does not enforce

Stated plainly, because the difference matters more than the guarantees do:

- **Shell-command classification is a guardrail, not a sandbox.** `git-write` is
  withheld by inspecting the command string, and `eval`, exotic quoting, or
  writing a script and then running it can defeat string inspection. It stops a
  well-intentioned agent from doing something you did not ask for. It does not
  contain a hostile one. The env-scoped push-url block is the defence in depth
  behind it.
- **`exec` is `exec`.** A node that can run your test suite can run anything
  your shell can, within its working directory. There is no container.
- **A run driven from your own agent enforces less, and says so.** Only an
  `engine`-tier run has the guarantees above; `hooks` blocks out-of-capability
  tool calls and nothing else; `reported` enforces nothing and records what the
  session *claimed*. `flow-code reconcile` is the check that makes that last
  tier worth anything. See [enforcement
  tiers](agent-integration.md).
- **Prompt injection is not solved here.** Content the agent reads — an issue
  body, a dependency's README, a fixture — is input to a model that holds your
  capabilities. The approval gates are the backstop: a human sees the diff
  before it is committed.

## Sensible practice

Run against a repository you would be comfortable handing to a contractor for
an afternoon. Read the diff at the second gate rather than approving on
autopilot — it is the one place the whole design assumes a human is actually
looking. Prefer a CLI login over a stored key. And if a run touched something
sensitive, remember the transcript kept a copy.
