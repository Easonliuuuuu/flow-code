import { PLACEHOLDER_TEST_COMMAND } from './registry/index.js';

/**
 * The scaffolded default workflow: Discuss → Spec → Approval-Gate →
 * Implement → Test → Validate → Review → Approval-Gate → Git-ops. The second
 * gate sits before Git-ops so the "nothing is pushed without explicit
 * approval" guarantee holds with zero configuration. The first sits before
 * Implement so the contract everything downstream is judged against is fixed
 * with a human's sign-off, not adopted the moment an agent finishes writing
 * it — the run no longer completes unattended end to end.
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
  # depends on directly and needs no pointer to a path. See \`gate\` below for
  # why the gate before Git-ops looks different — a diff instead of a
  # document, and no loop-back scaffolded.
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
  - id: test
    type: test
    config:
      commands:
        - ${PLACEHOLDER_TEST_COMMAND}

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
  - { from: gate, to: git-ops }

  # Rejecting the spec reopens the discussion that produced it, rather than
  # ending the run — a spec is rejected in order to be rewritten, not
  # abandoned. \`loopback: true\` on a gate's edge means "on rejection", not
  # "on failure" in the generic sense a loop-back usually means: a gate that
  # got its answer never fails, but a rejected one is reported to the engine
  # as though it had, specifically so this one edge can fire on it and only
  # it. \`discuss\` is where it goes rather than \`spec-gate\` itself because the
  # gate has no way to say *why* it was rejected — only \`discuss\` can ask you,
  # and it resumes the same conversation to do it rather than starting cold.
  #
  # This is deliberately not extended to the gate before Git-ops below: that
  # one keeps to the documented-but-not-enabled pattern its own comment
  # explains, because finished work rejected there is finished work abandoned,
  # not reconsidered.
  - { from: spec-gate, to: discuss, loopback: true }

  # Loop-backs: when the \`from\` node fails, execution returns to \`to\` and
  # re-runs everything between them, with the failure passed in as context —
  # so a failing test or a rejected review is another iteration, not the end of
  # the run. maxAttempts is counted on the target and shared across every
  # loop-back pointing at it, so a loop that never converges still terminates
  # (after which the failure stands and downstream nodes are skipped).
  - { from: test, to: implement, loopback: { maxAttempts: 3 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
  - { from: review, to: implement, loopback: { maxAttempts: 3 } }

  # A rejected gate stops the run by default: "no" means stop. The gate itself
  # still finishes — it got its answer — and what holds \`git-ops\` back is that
  # an edge out of a gate is read as \`when: "gate.decision == 'approved'"\`
  # unless it says otherwise. You never have to write that; it is why the edge
  # above is safe as it stands.
  #
  # To send a rejection back for another pass instead, either loop straight
  # back:
  #
  #   - { from: gate, to: implement, loopback: { maxAttempts: 2 } }
  #
  # ...which retries with nothing but "a human said no" as context — or route
  # it through a conversation first, so the retry knows what to change:
  #
  #   nodes:
  #     - id: revise
  #       type: discuss
  #       config: { topic: what to change before this can be approved }
  #   edges:
  #     - { from: gate, to: git-ops, when: "gate.decision == 'approved'" }
  #     - { from: gate, to: revise, when: "gate.decision == 'rejected'" }
  #     - { from: revise, to: implement, loopback: { maxAttempts: 2, on: success } }
  #
  # \`revise\` is an ordinary Discuss node — the same type as \`discuss\` above,
  # placed second. It sees the rejected diff, settles what to fix with you, and
  # its conclusion becomes the context \`implement\` retries with. Each rejection
  # then costs an agent session, which is why this is off by default.
  #
  # \`on: success\` is the part worth reading twice. A loop-back normally fires
  # when its source *fails* — that is what a verification loop wants. Here the
  # opposite is true: finishing the conversation is the signal to go back, so a
  # return path that waited for \`revise\` to fail would wait forever.
  #
  # Note the loop returns to \`implement\`, not to \`discuss\`: \`spec\` stays
  # outside the segment, so every retry is still judged against the criteria the
  # first attempt was. Spell out the approved edge once you add the rejected
  # one — mixing an implicit condition with an explicit one reads badly even
  # though it works.

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
