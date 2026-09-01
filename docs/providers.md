# Providers, credentials and models

## Picking one

`flow-code init` configures a provider interactively, once per project. It looks
for credentials you already have first — every row below is checked, the picker
labels each provider with what it found, and it starts on the first one that
already works. If you are logged into `claude` or `codex`, or already export an
API key, there is nothing to paste.

| Provider | Environment variable | Fallback |
| --- | --- | --- |
| Claude | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | `claude` CLI login |
| Codex | `OPENAI_API_KEY` or `CODEX_API_KEY` | `codex` CLI login |
| OpenAI | `OPENAI_API_KEY` | — |
| OpenRouter | `OPENROUTER_API_KEY` | — |
| OrcaRouter | `ORCAROUTER_API_KEY` | — |

To skip the wizard entirely — headless, CI — set any standard API key before
running `init`.

## What it costs to run

Claude and Codex fall back to their own CLI login when no key is set, drawing on
**that subscription's usage rather than metered API billing**. For most people
this is the answer: the marginal cost of a run is zero. OpenAI, OpenRouter, and
OrcaRouter always bill against the key provided. OrcaRouter charges the
upstream model's published per-token price with no added markup, so the same
model tends to cost less through it than through OpenRouter's spread-based
pricing.

See [What a run costs](cost.md) for the measured token figures and what they
price out to.

## Where the credential lives

`.flow-code/credentials.json`, written mode `0600`, and gitignored by default —
`init` writes `.flow-code/.gitignore` before it writes anything sensitive
beside it. For Claude and Codex CLI logins no key is stored here at all. See
[Security and privacy](security.md).

## Models

A node's effective model is the first of these that is set:

1. the node's own `config.model`
2. the workflow's `settings.model`
3. the provider's default — the model chosen during `init`

All three are resolved when flow-code starts the session, so they apply to
`flow-code run` and nothing else: a run driven from your own Claude Code or
Codex session (`flow-code connect`) never sees them, and that session picks its
own model per step.

`flow-code node-types` says which node types take a `model` field. An expensive
step and a cheap one need not share one — set it per node in `workflow.yaml`, or
press `m` on a focused node to change it mid-run, which is written back to the
file and picked up by any node that has not started yet.

## Rate limits

A second key for the same provider can be stored as `apiKey2`, and flow-code
rotates onto it under sustained rate-limiting rather than failing the run.
