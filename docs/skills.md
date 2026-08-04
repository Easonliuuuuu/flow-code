# Skills

A skill is a `SKILL.md` file — Claude Code's format — carrying project- or team-specific
instructions you attach to a node. Your house review standards, your commit message
conventions, how your team writes specs.

A skill governs **how** a node works. The node type still owns **what** it must return
and what it is allowed to touch: attaching a skill to `review` cannot give it the
ability to edit files, because capabilities are enforced by the harness rather than
requested in a prompt.

## Attaching one

```yaml
nodes:
  - id: review
    type: review
    config:
      skills: [house-review]
```

Any agent-driven node type accepts `skills`, as do `test` and `approval-gate` when
their optional agent step is enabled (`agent: true`). Multiple skills are allowed and
apply in order.

Run `flow-code skills` to list what is attachable, with each skill's source and path.
An entry that cannot be resolved is a load error listing every location searched, so a
misspelled skill name never becomes a node that silently runs without it.

## Where skills are found

| Source | Location | Travels with the repo |
| --- | --- | --- |
| `project` | `.claude/skills/<name>/SKILL.md` in this repo | Yes |
| `user` | `~/.claude/skills/<name>/SKILL.md` | No |
| `plugin` | installed marketplaces, referenced as `plugin:<name>` | No |
| `path` | any path written directly in `workflow.yaml` | Yes, if inside the repo |

Resolution order for a bare name: **project shadows user.** Plugin skills always carry
a `plugin:` prefix, so they neither shadow nor are shadowed by a local skill of the
same name.

An entry is treated as a path when it *looks* like one — it starts with `.` or `/`, or
contains a `/`:

```yaml
      skills: [./team/skills/our-review]
```

Paths are resolved relative to the repo root.

## Portability

`workflow.yaml` is checked in, but `~/.claude/skills/` and your installed plugins are
not. A workflow referencing a `user` or `plugin` skill will not load on a teammate's
clone until that skill exists there too.

flow-code warns about this before a run rather than failing — it is your machine and
your call — and `flow-code skills` marks non-portable entries in its listing. To make a
skill portable, move it into the repo's own `.claude/skills/`.

## Writing a skill

A `SKILL.md` is markdown with optional YAML frontmatter:

```markdown
---
description: How this team reviews a diff before it is committed.
compatibility: requires ripgrep on PATH
---

Check every changed file against our conventions:

- Public functions carry doc comments; private ones do not unless non-obvious.
- No new dependency without a note in the PR description explaining the tradeoff.
- Tests live beside the code they cover, not in a parallel tree.
```

`description` is what `flow-code skills` shows. `compatibility` declares an external
dependency and is surfaced by `flow-code doctor`, so a skill that needs a tool says so
somewhere a user will actually see it.

Neither field is required. A file without frontmatter is still a usable skill — it just
has no description. Malformed frontmatter costs the description, not the skill.

The body is passed to the node's agent session as instructions on top of its built-in
role.
