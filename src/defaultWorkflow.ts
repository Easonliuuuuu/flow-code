import { PLACEHOLDER_TEST_COMMAND } from './registry/index.js';

/**
 * The scaffolded default workflow: Discuss → Spec → Implement → Test →
 * Validate → Review → Approval-Gate → Git-ops. The gate sits before Git-ops
 * so the "nothing is pushed without explicit approval" guarantee holds with
 * zero configuration, and the Spec node sits early so everything downstream
 * is judged against a contract fixed before any code was written.
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
    tokensPerNode: 300000
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

  - id: implement
    type: implement
    config:
      # Implement owns the tests too — the Test node below only *runs* commands,
      # it has no agent and cannot author a test.
      instructions: Implement what the upstream spec requires, including tests covering it.

  # Test has no agent: it only runs commands, so it takes no \`skills\`. That is
  # deliberate — it is the one node whose verdict is not a model's opinion.
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
    # Commits only. To push, add:
    # config:
    #   push: { remote: origin, branch: my-branch }

edges:
  - { from: discuss, to: spec }
  - { from: spec, to: implement }
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

  # Loop-backs: when the \`from\` node fails, execution returns to \`to\` and
  # re-runs everything between them, with the failure passed in as context —
  # so a failing test or a rejected review is another iteration, not the end of
  # the run. maxAttempts is counted on the target and shared across every
  # loop-back pointing at it, so a loop that never converges still terminates
  # (after which the failure stands and downstream nodes are skipped).
  - { from: test, to: implement, loopback: { maxAttempts: 3 } }
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
  - { from: review, to: implement, loopback: { maxAttempts: 3 } }

  # A rejected approval gate deliberately has no loop-back: "no" means stop.
  # To send a rejection back for another pass instead, add:
  # - { from: gate, to: implement, loopback: { maxAttempts: 2 } }

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
