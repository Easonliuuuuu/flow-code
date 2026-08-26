---
name: git-commit
description: Stage and commit all changes using conventional commits format, then optionally push and open a PR with a matching template. Use when the user wants to commit current working tree changes with a standardized message, or also wants a PR opened.
license: MIT
metadata:
  author: local
  version: "1.2"
---

Stage and commit all changes using the conventional commits format, then optionally push the branch and open a PR whose description mirrors the commit body.

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

   **Breaking changes** — release-please reads these to decide on a major version bump, so mark them explicitly whenever the change breaks an existing public API, CLI flag, config shape, or other consumer-facing contract:
   - Add `!` right after the type/scope: `feat(engine)!: drop support for the legacy config format`
   - And add a `BREAKING CHANGE: <description>` footer at the end of the body explaining what breaks and how to migrate.
   Only `feat`/`fix` (plain or with `!`) actually trigger a release-please version bump — other types are release-please no-ops regardless of `!`.

   **Scope** (in parentheses) — the bare name (no path, no slash) of the folder or file most responsible for the change, e.g. `ops.ts`, `engine`, `ci.yml`. Use a single file's name when the change is concentrated there; use the containing folder's name when several files in it changed together. Omit only when changes span unrelated top-level areas with no shared folder.

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
   - engine.ts: await worktree removal before releasing the run-state lock
   - reconcile.ts: skip worktrees still referenced by an in-flight run

   Root cause: findOrphanedWorktrees could see a worktree mid-teardown and
   remove it a second time, which git worktree treats as an error and
   surfaced as a spurious run failure.

   Testing: vitest 76/76 passed, including worktree.test.ts and reconcile.test.ts
   ```
   ```
   ci(ci.yml): run lint, typecheck, and test on pull requests and pushes to main

   Changes:
   - ci.yml: add workflow targeting Node 20.x (engines floor)
   - ci.yml: run npm ci, lint, typecheck, test in sequence

   Motivation: nothing currently catches a broken build/lint/test before it
   lands on main.

   Testing: workflow runs green on the PR that introduces it
   ```
   ```
   chore(package.json): bump vitest to 3.2.7
   ```
   ```
   feat(cli)!: require --workflow instead of inferring it from cwd

   Changes:
   - cli.ts: remove cwd-based workflow inference, require an explicit --workflow flag

   Motivation: inference silently picked the wrong workflow in nested repos;
   an explicit flag removes the ambiguity.

   BREAKING CHANGE: --workflow is now required. Scripts relying on cwd-based
   inference will fail until they pass the flag explicitly.

   Testing: vitest 12/12 passed, including cli.test.ts
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

7. **Offer to push and open a PR**

   Use **AskUserQuestion** with options: "Push & open PR", "Just commit (done)"

   If "Just commit (done)": stop here.

   If "Push & open PR":

   a. Check the current branch with `git branch --show-current`. If it's `main` (or the repo's default branch), create a new branch first — derive a short kebab-case name from the commit's `<type>(<scope>)` (e.g. `fix/ops-worktree-race`), or ask the user for one if nothing sensible can be derived:
      ```bash
      git checkout -b <branch-name>
      ```

   b. Push and set upstream:
      ```bash
      git push -u origin <branch-name>
      ```

   c. Build the PR title and body from the same material as the commit message — do not re-derive from scratch:
      - **Title**: same conventional-commit format as step 2 — `<type>(<scope>): <summary>`, identical to the commit's first line. Use the same `<type>` values: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `build`.
        Examples: `feat(canvas): draw loop-back edges for re-run nodes`, `fix(engine): stop worktree cleanup from racing the reconciler`, `refactor(ops.ts): extract shared retry helper`.
      - **Body** — reuse the commit's `Changes`, `Root cause`/`Motivation`, and `Testing` sections, and add a `Test plan` checklist (concrete, reviewer-actionable steps derived from `Testing`):

        ```
        ## Summary
        - <bullet from commit's Changes section>
        - <bullet from commit's Changes section>

        ## Root cause
        <or "## Motivation" — same content as the commit body>

        ## Test plan
        - [ ] <concrete step derived from Testing>
        - [ ] <concrete step derived from Testing>

        ## Testing
        <same content as the commit's Testing line>
        ```

      Never add a `Co-Authored-By`, "Generated with Claude Code", or similar footer to the PR body.

   d. Show the proposed PR title + body and confirm with **AskUserQuestion** ("Create PR", "Edit", "Cancel") before running:
      ```bash
      gh pr create --title "<title>" --body "$(cat <<'EOF'
      <body>
      EOF
      )"
      ```

   e. Display the returned PR URL.

**Guardrails**
- Never use `git add -A` or `git add .`
- Never skip pre-commit hooks (`--no-verify`)
- Never commit `.env` or credential files — warn and skip them
- Never add a `Co-Authored-By` (or similar) line to the commit message or PR body
- If `git commit` fails due to a hook, report the hook output and stop; do not retry automatically
- If there are no changes to stage, report "Nothing to commit" and stop
- Always use HEREDOC syntax for multi-line commit messages and PR bodies to preserve formatting
- Never push directly to `main`/the default branch — always create a feature branch first
- Never force-push (`--force`/`-f`) as part of this flow
- Only run `gh pr create` after the user has explicitly confirmed the PR title/body
