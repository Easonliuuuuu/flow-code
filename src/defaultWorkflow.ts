/**
 * The scaffolded default workflow: Discuss → Spec → Approval-Gate →
 * Implement → Test → Validate → Review → Approval-Gate → Git-ops. The second
 * gate sits before Git-ops so the "nothing is pushed without explicit
 * approval" guarantee holds with zero configuration. The first sits before
 * Implement so the contract everything downstream is judged against is fixed
 * with a human's sign-off, not adopted the moment an agent finishes writing
 * it — the run no longer completes unattended end to end.
 *
 * Both gates route a rejection back into a conversation rather than ending the
 * run, because "no" is nearly always the start of another pass rather than the
 * end of the work. Both loop-backs carry the same attempt bound as the
 * verification loops that share their target: the bound is counted once per
 * target across every loop-back pointing at it, so a lower number here would
 * mean the revision path starves first, after one failed test has already
 * spent an attempt.
 */
export const DEFAULT_WORKFLOW_YAML = `# flow-code workflow — checked into your repo, edit as needed.
# Run \`flow-code node-types\` to see every node type's capabilities and config.
#
# Any agent-driven node can carry \`skills: [name, …]\`, giving it project- or
# team-specific instructions on top of its built-in role. \`flow-code skills\`
# lists what is attachable. A skill governs *how* a node works; the node type
# still owns what it must return and what it is allowed to touch.

settings:
  # Max concurrently running agent sessions (only Worktree-Agent instances
  # ever actually run in parallel).
  concurrency: 2

  # Stop rules. A workflow that retries is a workflow that can spend without
  # bound, so say what it is allowed to cost. Remove a line to make that
  # dimension unbounded. A budget stop is final — it never retries, because
  # retrying past a ceiling is what the ceiling exists to prevent.
  budget:
    tokensPerRun: 2000000
    minutesPerRun: 60

nodes:
  # Discuss is the only interactive node type — the only one that can stop and
  # ask you something. Everything below it runs headless, so anything they need
  # to know has to be settled here (or written into their config).
  - id: discuss
    type: discuss
    config:
      topic: What should this change accomplish?
      # skills: [your-discovery-skill]

  - id: spec
    type: spec
    # No config: the spec is derived from the discussion above and written to
    # .flow-code/specs/<runId>.md. Its acceptance criteria become the contract
    # Validate checks one by one. To write it by hand instead (and skip the
    # agent call entirely):
    #   config:
    #     title: What we're building
    #     acceptanceCriteria:
    #       - Running \`foo --bar\` prints the parsed config and exits 0

  # A gate with nothing configured: it reads the spec from the Spec node it
  # depends on directly and needs no pointer to a path. The gate before Git-ops
  # shows a diff instead of a document, and routes its rejection through a
  # second conversation rather than straight back — see \`revise\` below.
  - id: spec-gate
    type: approval-gate
    config:
      title: Review the spec before implementation begins

  - id: implement
    type: implement
    config:
      # Implement owns the tests too — the Test node below only *runs* commands,
      # it has no agent and cannot author a test.
      instructions: Implement what the upstream spec requires, including tests covering it.

  # Test has no agent for its core run: commands, verdict, and exit code are
  # never a model's opinion. It can optionally carry \`agent: true\` (with
  # \`instructions\`/\`skills\`) for a read-only-by-default agent pass that runs
  # once after the commands finish and adds analysis alongside the verdict —
  # it can never change \`passed\`.
  #
  # No \`commands\`: the first time this node runs it works out how this project
  # runs its tests — package scripts and Makefile targets first, then a
  # read-only agent pass — and shows you what it found to confirm. Nothing is
  # executed before you confirm it, and your answer is written back into this
  # file, so it is asked once per project rather than once per run.
  #
  # To skip that entirely, say what to run:
  #   config:
  #     commands: [npm test]
  # Or \`commands: auto\` to rediscover on *every* execution and never persist —
  # for a workflow pointed at repositories that differ from run to run. That
  # one cannot be combined with a loop-back that re-runs this node, since a
  # node that picks and grades its own commands could pick easier ones.
  - id: test
    type: test

  - id: validate
    type: validate

  - id: review
    type: review
    # config:
    #   skills: [your-code-review-skill]

  - id: gate
    type: approval-gate
    config:
      title: Review the pending diff before git operations

  # Where a rejected diff goes. An ordinary Discuss node — the same type as
  # \`discuss\` above, placed a second time — reached only when \`gate\` is
  # rejected. It sees the diff you turned down, settles with you what should
  # change, and its conclusion becomes the context \`implement\` retries with.
  #
  # It exists because the gate itself has no way to say *why*: approve/reject
  # carries no text. Without this node the retry knows only that a human said
  # no, which is the same prompt again. The spec gate needs no equivalent —
  # its loop-back lands on \`discuss\`, which is already interactive and already
  # holds the conversation to reopen.
  #
  # To turn it off, delete this node and the two conditioned edges below, and
  # put back a single \`- { from: gate, to: git-ops }\`. A rejection then ends
  # the run. That costs nothing per rejection; this costs one agent session.
  - id: revise
    type: discuss
    config:
      topic: What has to change about this diff before it can be approved?

  - id: git-ops
    type: git-ops
    # Commits only, with a message written from the diff. To push, add:
    # config:
    #   push: { remote: origin, branch: my-branch }
    # To fix the message, or the style it is written in (never both):
    # config:
    #   commitMessage: "chore: sync"            # used exactly as written
    #   instructions: "Reference the ticket id" # or: how to write one

edges:
  - { from: discuss, to: spec }
  - { from: spec, to: spec-gate }
  # Unconditional out of a gate is read as \`when: "spec-gate.decision == 'approved'"\`
  # — same rule as the \`gate\` → \`git-ops\` edge below, spelled out there.
  - { from: spec-gate, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
  # Validate needs the spec's acceptance criteria, so it depends on the spec
  # directly: a node is given what it is wired to, and nothing else. This edge
  # is also why a loop-back never rewrites the contract — \`spec\` sits outside
  # the segment between \`implement\` and the node that failed, so every retry
  # is judged against the same criteria the first attempt was.
  - { from: spec, to: validate }
  - { from: validate, to: review }
  - { from: review, to: gate }
  # Both arms of the gate's decision, spelled out. An unconditional edge out of
  # a gate is read as \`when: "<gate>.decision == 'approved'"\` — so the first
  # line could be left bare, but mixing an implicit condition with the explicit
  # one beside it reads badly even though it works.
  - { from: gate, to: git-ops, when: "gate.decision == 'approved'" }
  - { from: gate, to: revise, when: "gate.decision == 'rejected'" }

  # Rejecting the spec reopens the discussion that produced it, rather than
  # ending the run — a spec is rejected in order to be rewritten, not
  # abandoned. \`loopback: true\` on a gate's edge means "on rejection", not
  # "on failure" in the generic sense a loop-back usually means: a gate that
  # got its answer never fails, but a rejected one is reported to the engine
  # as though it had, specifically so this one edge can fire on it and only
  # it. \`discuss\` is where it goes rather than \`spec-gate\` itself because the
  # gate has no way to say *why* it was rejected — only \`discuss\` can ask you,
  # and it resumes the same conversation to do it rather than starting cold.
  - { from: spec-gate, to: discuss, loopback: true }

  # The way back from a rejected diff. \`on: success\` is the part worth reading
  # twice: a loop-back normally fires when its source *fails*, which is what a
  # verification loop wants. Here the opposite is true — finishing the
  # conversation is the signal to go back, so a return path waiting for
  # \`revise\` to fail would wait forever.
  #
  # It returns to \`implement\`, not to \`discuss\`: \`spec\` stays outside the
  # segment, so every retry is still judged against the criteria the first
  # attempt was.
  #
  # maxAttempts matches the verification loop-backs below because they all
  # point at \`implement\` and the bound is counted once on the target. A lower
  # number here would not mean "fewer revisions" — it would mean the revision
  # path dies first, and a single earlier test failure would be enough to have
  # you hold the whole conversation and then find it had nowhere to go.
  - { from: revise, to: implement, loopback: { maxAttempts: 3, on: success } }

  # Loop-backs: when the \`from\` node fails, execution returns to \`to\` and
  # re-runs everything between them, with the failure passed in as context —
  # so a failing test or a rejected review is another iteration, not the end of
  # the run. maxAttempts is counted on the target and shared across every
  # loop-back pointing at it, so a loop that never converges still terminates
  # (after which the failure stands and downstream nodes are skipped).
  - { from: test, to: implement, loopback: { maxAttempts: 3 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
  - { from: review, to: implement, loopback: { maxAttempts: 3 } }

  # Rejection is wired to reconsider, above — but nothing forces that shape.
  # To retry with nothing but "a human said no" as context, skip \`revise\` and
  # loop the gate straight back:
  #
  #   - { from: gate, to: implement, loopback: { maxAttempts: 3 } }
  #
  # To make a rejection end the run instead, delete \`revise\` and both
  # conditioned edges, leaving \`- { from: gate, to: git-ops }\`. Nothing
  # downstream of the gate runs after a rejection either way: the halt is
  # carried by the recorded decision and the conditions on these edges, never
  # by an execution failure — the gate that was answered did not fail.

  # Conditional edges route; they don't just sequence. An edge with a \`when\`
  # still waits for its source, but only carries when the condition holds —
  # and when it doesn't, its target is skipped along with the rest of that
  # branch. A node the branches rejoin at still runs, as long as some other
  # path into it was taken.
  #
  #   - { from: implement, to: gate, when: "implement.changedFiles isNotEmpty" }
  #   - { from: review, to: rework, when: "review.findings.length > 0" }
  #   - { from: test, to: triage, when: "test.passed == false" }
  #
  # A condition reads \`<node>.<field>\` from a node's recorded output — the
  # edge's own source, or anything upstream of it. Operators: == != > < >= <=
  # contains isEmpty isNotEmpty. One condition per edge; use two edges for two
  # conditions.
`;
