## Why

`OpenAiCompatSessionRunner` (`src/executors/openaiCompatRunner.ts`) already generalizes everything an OpenAI-compatible endpoint needs — the tool-calling loop, capability enforcement, retry/backoff, multi-key rotation, and usage accounting — behind a five-field config. `OpenRouterSessionRunner` is the proof: eighteen lines, of which only `baseUrl`, `defaultModel`, and `apiKeyEnvVars` are provider-specific. The abstraction was built for exactly this, and `openaiCompatClient.ts` says so in a comment: *"only the base URL, key, and model differ."* Nothing has exercised that claim since OpenRouter.

OrcaRouter is a second OpenAI-compatible gateway worth adding on its own merits, independent of the partnership email that prompted this change. It charges no per-token markup — you pay the upstream provider's published price, and its revenue comes from subscriptions and a governance control plane rather than a spread on tokens. That makes it materially cheaper than OpenRouter's 5% for the same upstream model, which matters for flow-code specifically: agentic loops re-send a growing message history every turn, so a per-token spread compounds across a run in a way it does not for single-shot calls. It also carries a genuinely free tier, which lowers the cost of trying flow-code to zero for someone with no Anthropic or OpenAI billing set up.

The change is additive at every layer. No existing provider changes behavior, and no capability requirement moves.

## What Changes

- **New `orcarouter` provider** in `ProviderId` and the `PROVIDERS` table (`src/engine/providers.ts`), keyed to `ORCAROUTER_API_KEY`.
- **New `OrcaRouterSessionRunner`** (`src/executors/orcarouterRunner.ts`), a config-only subclass of `OpenAiCompatSessionRunner` against `https://api.orcarouter.ai/v1`, structurally identical to `OpenRouterSessionRunner`. Default model `openai/gpt-4o-mini` — the same default the OpenRouter runner uses, confirmed present in OrcaRouter's live catalog.
- **Two exhaustive switches gain a case**: `buildRunner` (`src/cli/provider.ts`) and `baseUrlFor` (`src/init/modelList.ts`). Both are `ProviderId`-exhaustive, so `tsc` names them; neither can be missed silently.
- **Model-picker filtering becomes provider-aware.** `NON_CHAT_ID_PATTERN` in `src/init/modelList.ts` is currently applied only to `openai`. OrcaRouter's catalog is 190 models, of which ~34 are image, video, TTS, or embedding endpoints (Kling and Seedance video, Imagen, Gemini `-image`/`-tts`, `gemini-embedding-*`) that cannot serve a chat completion at all. Without filtering, a third of the picker is models that would fail at run time.
- **No free-tier defaulting.** The free `-free` ids are reachable by naming them, like any other model, but nothing routes to them automatically — see design.md for why.
- **Documentation**: a row in `docs/providers.md`'s provider table and a sentence in its cost section.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
(none — and this is the point worth stating rather than glossing over)

No spec in `openspec/specs/` names a provider. `agent-execution`'s "Provider-backed node execution" requirement is written against "the project's configured provider" and `node-model-selection` against "the configured provider's models"; neither enumerates who those providers are. The provider roster sits below the requirement layer by construction, so a fifth entry changes no observable behavior that any requirement describes. If this change needed a spec delta, that would be evidence the abstraction had leaked.

## Impact

- **New files**: `src/executors/orcarouterRunner.ts`, and its test.
- **Modified**: `src/engine/providers.ts` (union member + table row), `src/executors/index.ts` (one export), `src/cli/provider.ts` (`buildRunner` case; the `fail()` message that lists candidate env vars), `src/init/modelList.ts` (`baseUrlFor` case; provider-aware non-chat filtering), `docs/providers.md`.
- **Unmodified but load-bearing**: `src/executors/openaiCompatRunner.ts` and `openaiCompatClient.ts` (the runner is config-only — if either needs an edit, an assumption in design.md is wrong and the change should stop); `src/engine/credentialDetect.ts`, whose `default:` branch already covers "every remaining provider is a plain API key in a single env var"; `src/engine/credentials.ts`, which validates via `isProviderId` and so accepts the new id for free.
- **Tests**: `test/cli.buildRunner.test.ts`, `test/credentialDetect.test.ts`, `test/init/modelList.test.ts` gain cases. Existing tests use `'openrouter'` as a fixture rather than asserting an exhaustive provider list, so none break.
- **Out of scope**: OrcaRouter's native Anthropic (`/v1/messages`) and Gemini (`/v1beta/`) surfaces — flow-code speaks OpenAI-shaped chat completions and gains nothing from the alternate protocols. Its `orcarouter/auto` router, guardrails, agent firewall, and BYOK mode are all reachable by configuration but are not modelled here. Adapting flow-code's retry policy to the free tier's distinct `free_rate_limited` 429 is deliberately deferred (design.md).
