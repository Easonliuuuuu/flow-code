---
name: git-commit
description: Stage and commit all changes using conventional commits format. Use when the user wants to commit current working tree changes with a standardized message.
license: MIT
metadata:
  author: local
  version: "1.0"
---

Stage and commit all changes using the conventional commits format.

**Input**: Optional scope or hint from the user (e.g., "auth cleanup", "firearm router"). If omitted, derive everything from the diff.

---

**Steps**

1. **Inspect the working tree**

   Run in parallel:
   ```bash
   git status
   git diff HEAD
   git diff --staged
   git log --oneline -5
   ```

   Use these to understand:
   - Which files are modified/added/deleted (staged and unstaged)
   - What the actual changes are
   - The recent commit style of this repo

2. **Derive the conventional commit message**

   **Type** — pick exactly one:
   - `feat` — new capability visible to users or API consumers
   - `fix` — corrects a bug or broken behavior
   - `refactor` — restructures code without changing behavior
   - `chore` — dependency updates, config, tooling, cleanup with no behavior change
   - `docs` — documentation only
   - `test` — adds or fixes tests
   - `ci` — CI/CD pipeline changes
   - `build` — build system, Dockerfile, packaging

   **Scope** (optional, in parentheses) — the subsystem affected. Use the module name or domain area. Examples: `engine`, `ui`, `worktree`, `deps`, `ci`. Omit if changes span too many areas with no clear owner.

   **Summary** — imperative mood, lowercase, no period, ≤72 chars total for the first line. Describe what the change *does*, not what files changed.

   **Body** — include for any non-trivial change. Separate from the summary with a blank line. Use the following three sections:

   ```
   Changes:
   - <bullet describing each meaningful change; one line per logical unit>

   Root cause: <one or two sentences — WHY this change was needed (bug, design issue, obsolete dependency, broken test, etc.). Omit for pure feature additions; use "Motivation:" instead to explain the why.>

   Testing: <how correctness was verified — e.g., "vitest 76/76 passed", "manual run against flow-code run", "CI green", or "no tests — trivial config change">
   ```

   Omit the body only for single-line no-brainers (typo fix, rename, version bump). For everything else, always include all three sections.

   Do not add a `Co-Authored-By` (or similar) footer to the commit message.

   **Examples:**
   ```
   fix(engine): stop worktree cleanup from racing the reconciler

   Changes:
   - engine: await worktree removal before releasing the run-state lock
   - reconcile: skip worktrees still referenced by an in-flight run

   Root cause: findOrphanedWorktrees could see a worktree mid-teardown and
   remove it a second time, which git worktree treats as an error and
   surfaced as a spurious run failure.

   Testing: vitest 76/76 passed, including worktree.test.ts and reconcile.test.ts
   ```
   ```
   ci: run lint, typecheck, and test on pull requests and pushes to main

   Changes:
   - workflow: add .github/workflows/ci.yml targeting Node 20.x (engines floor)
   - workflow: run npm ci, lint, typecheck, test in sequence

   Motivation: nothing currently catches a broken build/lint/test before it
   lands on main.

   Testing: workflow runs green on the PR that introduces it
   ```
   ```
   chore(deps): bump vitest to 3.2.7
   ```

3. **Stage changes**

   Add specific files by name — never `git add -A` or `git add .` blindly.

   - List all modified/untracked files from `git status`
   - Skip files that look like secrets (`.env`, `*credentials*`, `*secret*`) — warn the user instead
   - Stage everything else:
     ```bash
     git add <file1> <file2> ...
     ```

4. **Show the proposed commit and ask for confirmation**

   Display:
   ```
   ## Proposed commit

   <full commit message>

   Files staged: <count>
   ```

   Use **AskUserQuestion tool** with options: "Commit", "Edit message", "Cancel"

   - If "Edit message": ask the user for their preferred message, then re-display and confirm once more
   - If "Cancel": stop, leave files staged
   - If "Commit": proceed

5. **Commit**

   ```bash
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <summary>

   Changes:
   - <change 1>
   - <change 2>

   Root cause: <why>

   Testing: <how verified>
   EOF
   )"
   ```

   For trivial single-line commits (no body):
   ```bash
   git commit -m "<type>(<scope>): <summary>"
   ```

6. **Display result**

   Run `git log --oneline -1` and show the commit hash + message.

   ```
   ## Committed

   <hash> <message>
   ```

**Guardrails**
- Never use `git add -A` or `git add .`
- Never skip pre-commit hooks (`--no-verify`)
- Never commit `.env` or credential files — warn and skip them
- Never add a `Co-Authored-By` (or similar) line to the commit message
- If `git commit` fails due to a hook, report the hook output and stop; do not retry automatically
- If there are no changes to stage, report "Nothing to commit" and stop
- Always use HEREDOC syntax for multi-line commit messages to preserve formatting
