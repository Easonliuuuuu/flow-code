## Context

`OpenAiCompatSessionRunner` takes a `OpenAiCompatProviderConfig` of exactly five fields — `providerId`, `label`, `baseUrl`, `defaultModel`, `apiKeyEnvVars` — and supplies everything else: the bounded tool-calling loop, the capability-scoped tool set, the per-call permission check, retry with `Retry-After` handling, key rotation on sustained 429/5xx, and split cached/uncached token accounting. Adding a provider that speaks OpenAI chat completions is therefore a config exercise, not an implementation one.

The one asymmetry is credential resolution. `claude` and `codex` resolve through their own SDK/CLI logins and get bespoke branches in `detectCredential`; `openai` and `openrouter` are plain env-var keys handled by that function's `default:` branch. OrcaRouter is the second kind, so detection, the `init` wizard menu, `.flow-code/credentials.json` persistence, and `isProviderId` validation all cover it without modification.

Facts below were verified against the live service while writing this document, not taken from the vendor's outreach email:

- `GET https://api.orcarouter.ai/v1/models` returns 190 models unauthenticated, provider-prefixed (`openai/`, `google/`, `qwen/`, `anthropic/`, `deepseek/`, `grok/`, `kimi/`, `minimax/`, `z-ai/`, `kling/`, `tencent/`).
- `openai/gpt-4o-mini` is present, so the OpenRouter runner's default transfers unchanged.
- Free ids in the live catalog are `deepseek/deepseek-v4-flash-free`, `qwen/qwen3.8-27b-free`, and `tencent/hy3-free`. The published docs list a `deepseek-v4-pro-free` that the catalog does not serve, and omit the Qwen and Tencent ids that it does — the catalog is authoritative, the docs page is stale in both directions.
- Billing is the upstream provider's published per-token price with no markup.

## Goals / Non-Goals

**Goals**

- Add OrcaRouter as a selectable provider with the same setup path as every other: `flow-code init`, or an env var already exported.
- Keep the runner config-only. If `OpenAiCompatSessionRunner` needs a change to accommodate OrcaRouter, that is a finding, not a task — see Risks.
- Give the model picker a usable catalog rather than a raw dump of 190 ids.

**Non-Goals**

- Routing anything to the free tier automatically.
- OrcaRouter's non-OpenAI protocol surfaces, `orcarouter/auto`, guardrails, firewall, or BYOK.
- Any change to how the other four providers behave, are detected, or are ordered in the wizard.
- Enrolling in the vendor's OSS partner program. That is a project-governance decision, unrelated to whether the integration is technically worth having, and nothing in this change depends on it.

## Decisions

### The runner is config-only, and that is a testable claim

`OrcaRouterSessionRunner` extends `OpenAiCompatSessionRunner` with a five-field config and no overridden methods, exactly as `OpenRouterSessionRunner` does. This is the whole integration. The design deliberately offers no escape hatch: if OrcaRouter turns out to need request-shape changes, the right response is to stop and reconsider, because a second provider needing bespoke handling means the abstraction does not hold and the fix belongs in the base class where every provider benefits.

### Default model `openai/gpt-4o-mini`, not a free id and not `orcarouter/auto`

Three candidates, and the reasoning against two of them matters more than the one chosen.

A `-free` id is the tempting default — zero cost is a real onboarding win. It is wrong here. Free traffic runs under undisclosed rate limits plus, below a lifetime-spend threshold, a per-request prompt-token cap that the vendor's own documentation flags as the limit that surprises people. flow-code's loops accumulate a growing message history and tool results across up to 40 iterations, which is precisely the shape that cap rejects. A default that works for a trivial first node and then fails partway through a real run, with no time-based pattern to the failures, is worse than a default that costs a fraction of a cent.

`orcarouter/auto` is wrong for a different reason: it resolves to a different model per request, so two runs of the same workflow are not comparable and a run cannot be reproduced from its recorded state. flow-code's per-node model resolution assumes a named model, and the detail view reports which model a node resolved to. An adaptive router defeats both.

`openai/gpt-4o-mini` is cheap, tool-calling-capable, present in the catalog, and already the OpenRouter default — so the two gateways behave identically out of the box, which makes them directly comparable on price. Users who want the free tier name it explicitly, per node or in `settings.model`.

### Non-chat filtering becomes provider-aware, not OpenRouter-shaped

`fetchModelIds` applies `NON_CHAT_ID_PATTERN` only when `provider === 'openai'`, because OpenRouter's catalog is chat-only and needed no filter. OrcaRouter's is not: ~34 of 190 ids are video (`kling/*`, Seedance), image (`imagen-*`, `*-image`), TTS (`*-tts`), or embedding (`gemini-embedding-*`) endpoints that cannot serve a chat completion.

The existing pattern is tuned to OpenAI's naming (`dall-e`, `^babbage`, `^davinci`) and catches only 5 of them. Rather than widen one regex until it serves two unrelated catalogs, add a second pattern for modality-suffixed ids and select which patterns apply per provider. This keeps OpenAI's filter exactly as it is — no risk of newly hiding a model that works today — and gives OrcaRouter its own.

Filtering is cosmetic, not enforcement: a user who types a video model id as `config.model` still gets a run-time failure from the endpoint. The picker's job is to not actively suggest it.

### No free-tier retry handling in this change

The free tier returns `429` with error code `free_rate_limited`, and the existing client treats 429 as retryable with backoff and then key rotation. For a prompt-cap rejection that is wrong — the request will never succeed, no matter how long the wait or which key is used — so flow-code would burn its full retry budget before failing. This is a real defect, but it is only reachable by a user who has explicitly opted into a free model, it needs a response-body error-code check that the client does not currently do for any provider, and getting it right means distinguishing three limits that share one status and message. It belongs in its own change against `openaiCompatClient.ts`, where it can be designed for every provider rather than special-cased for this one.

## Risks / Trade-offs

- **The vendor is real, the outreach is unverified.** OrcaRouter is operated by Continuum AI Corp, launched May 2026, with a live API and public docs — all independently checked. The email that prompted this came from `orcaroutermail.world`, which is not the company's domain, and its sender could not be verified. Nothing in this change depends on that email being genuine: the integration is justified by the zero-markup pricing and the catalog. Do not act on the partner-program offer through that email; if the program is wanted, start from the vendor's own site.
- **A fifth provider is a fifth thing to keep working.** Mitigated by the two exhaustive switches — a future `ProviderId` change cannot silently skip OrcaRouter — but the model-picker filter and the docs table have no such compiler backstop.
- **Catalog drift.** The default model is a string pinned in source. If `openai/gpt-4o-mini` leaves the catalog, `init` still succeeds and the failure surfaces at first run. This is the existing behavior for every provider, not a regression, and the picker's free-text entry is the escape hatch.
- **The docs are stale where the catalog is not.** Anything read from OrcaRouter's documentation should be confirmed against `/v1/models` or `/api/pricing` before it is encoded in flow-code.

## Migration Plan

None. No existing project's `.flow-code/credentials.json` names `orcarouter`, so no stored state changes meaning and nothing needs rewriting. Projects on other providers are untouched. The change is purely additive and reversible by deleting the runner and its two switch cases.

## Open Questions

- Should `docs/cost.md` gain measured OrcaRouter figures alongside the existing per-provider numbers? It would make the zero-markup claim concrete rather than asserted, but it needs a real metered run to produce honestly, so it is left out of tasks.md rather than guessed at.
- Should the wizard surface the free ids as a labelled hint once a user picks OrcaRouter, given they are legitimately useful for a first run even though they are a poor default? Deferred until the `free_rate_limited` handling above exists — advertising them before the retry path handles their 429s correctly would generate exactly the confusing failures the default-model decision avoids.
