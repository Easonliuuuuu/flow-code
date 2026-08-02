/**
 * The scaffolded default workflow: Discuss → Implement → Test → Validate →
 * Review → Approval-Gate → Git-ops. The gate sits before Git-ops so the
 * "nothing is pushed without explicit approval" guarantee holds with zero
 * configuration.
 */
export const DEFAULT_WORKFLOW_YAML = `# flow-code workflow — checked into your repo, edit as needed.
# Run \`flow-code node-types\` to see every node type's capabilities and config.

settings:
  # Max concurrently running agent sessions (only Worktree-Agent instances
  # ever actually run in parallel).
  concurrency: 2

nodes:
  - id: discuss
    type: discuss
    config:
      topic: What should this change accomplish?

  - id: implement
    type: implement
    config:
      # Implement owns the tests too — the Test node below only *runs* commands,
      # it has no agent and cannot author a test.
      instructions: Implement what was agreed in the discussion, including tests covering it.

  - id: test
    type: test
    config:
      commands:
        - echo "replace me with your project's test command"

  - id: validate
    type: validate

  - id: review
    type: review

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
  - { from: discuss, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
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
`;
