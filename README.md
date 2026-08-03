# flow-code

[![CI](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Easonliuuuuu/flow-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

A terminal-native node-graph interface for running and observing agentic coding workflows. Instead of scrolling through chat logs, your coding task's lifecycle renders as a live, interactive graph in your terminal — spec discussion, implementation, validation, review, and git ops.

```
┌─────────┐    ┌───────────┐    ┌──────┐    ┌──────────┐    ┌────────┐    ┌──────┐    ┌─────────┐
│ Discuss │ ─▶ │ Implement │ ─▶ │ Test │ ─▶ │ Validate │ ─▶ │ Review │ ─▶ │ Gate │ ─▶ │ Git-ops │
└─────────┘    └───────────┘    └──────┘    └──────────┘    └────────┘    └──────┘    └─────────┘
                     ▲                           │
                     └──────── loop-back ────────┘
                        (on a failing verdict)
```

Each node is a live card showing status spinners, token consumption, model badges, and real-time execution logs.

---

## ⚡ Quickstart

Install globally and run in any repository in seconds:

```bash
npm install -g flow-code

# 1. Initialize workflow & select AI provider/model
flow-code init

# 2. Run the agentic workflow graph
flow-code run
```

*Or run locally from source:*
```bash
npm install && npm run build
node dist/cli.js init
node dist/cli.js run
```

---

## ✨ Why flow-code?

| Feature | Description |
|---|---|
| 📺 **Live Graph UI** | Watch `discuss → implement → test → validate → review → git-ops` light up in real-time. |
| 🤖 **Multi-Provider Support** | Use Claude, OpenAI, NVIDIA NIM, or OpenRouter with per-node model overrides. |
| 🔄 **Self-Healing Loops** | Failing `test` or `validate` nodes automatically route back upstream to auto-fix issues. |
| 🌳 **Safe Git Worktrees** | Parallel agent nodes run inside isolated git worktrees to prevent code conflicts. |
| 🚀 **Headless & CI Ready** | Zero interactive prompts in CI — seamless credential fallback via environment variables. |

---

## 🤖 AI Provider Setup

`flow-code init` includes an interactive setup wizard that configures your provider, API keys, and test commands automatically.

### Environment Variables (Headless / CI)

Skip the wizard by setting any standard API key:

* **Claude**: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
* **OpenAI**: `OPENAI_API_KEY`
* **NVIDIA NIM**: `NVIDIA_API_KEY`
* **OpenRouter**: `OPENROUTER_API_KEY`

---

## ⚙️ Workflow Configuration (`.flow-code/workflow.yaml`)

Workflows are defined per-project in `.flow-code/workflow.yaml`.

```yaml
nodes:
  - id: discuss
    type: discuss
  - id: implement
    type: implement
  - id: test
    type: test
    config:
      commands: ["npm test"]
  - id: validate
    type: validate
  - id: review
    type: review
  - id: git-ops
    type: git-ops

edges:
  - { from: discuss, to: implement }
  - { from: implement, to: test }
  - { from: test, to: validate }
  - { from: validate, to: review }
  - { from: review, to: git-ops }
  # Self-healing loop: if validation fails, retry implementation (up to 3 times)
  - { from: validate, to: implement, loopback: { maxAttempts: 3 } }
```

---

## 🛠️ CLI Commands

| Command | Description |
|---|---|
| `flow-code init` | Scaffold `.flow-code/workflow.yaml` & configure provider/models |
| `flow-code init --preset openspec` | Scaffold using the OpenSpec workflow graph (`explore → propose → apply → archive`) |
| `flow-code run` | Execute the workflow graph |
| `flow-code skills` | List available skills attached from `.claude/skills` or plugins |
| `flow-code doctor` | Diagnose environment, tools, and provider credentials |
| `flow-code help` | Show full CLI command reference |

---

## 💡 Advanced Features

<details>
<summary><b>Attaching Skills</b></summary>

Attach custom `SKILL.md` instructions (Claude Code format) to any node:

```yaml
  - id: review
    type: review
    config:
      skills: [house-review]
```
Discovered from `.claude/skills/`, `~/.claude/skills/`, or installed plugins.
</details>

<details>
<summary><b>Per-Node Model Overrides</b></summary>

Focus any node during `flow-code run` and press **`m`** to switch its model on the fly, or configure it directly in `workflow.yaml`.
</details>

<details>
<summary><b>Budget Limits</b></summary>

Set token or execution time ceilings in `.flow-code/workflow.yaml`:

```yaml
settings:
  budget:
    tokensPerNode: 300000
    tokensPerRun: 2000000
    minutesPerRun: 60
```
</details>

---

## 📄 License

[MIT](LICENSE)
