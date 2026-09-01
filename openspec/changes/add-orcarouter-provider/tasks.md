## 1. Provider registration

- [ ] 1.1 Add `'orcarouter'` to the `ProviderId` union in `src/engine/providers.ts`
- [ ] 1.2 Add `{ id: 'orcarouter', label: 'OrcaRouter', apiKeyEnvVar: 'ORCAROUTER_API_KEY' }` to `PROVIDERS`, after `openrouter` so wizard menu order stays stable for existing users
- [ ] 1.3 Confirm no change is needed in `src/engine/credentialDetect.ts` — the `default:` branch handles single-env-var providers; add a `detectCredential('orcarouter')` test asserting it picks up `ORCAROUTER_API_KEY` rather than editing the switch
- [ ] 1.4 Confirm no change is needed in `src/engine/credentials.ts` — `isProviderId` gates the union, so persistence accepts the new id; add a save/load round-trip test for `provider: 'orcarouter'`

## 2. Session runner

- [ ] 2.1 Create `src/executors/orcarouterRunner.ts` exporting `ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1'` and `DEFAULT_ORCAROUTER_MODEL = 'openai/gpt-4o-mini'`, mirroring `openrouterRunner.ts`'s shape
- [ ] 2.2 Implement `OrcaRouterSessionRunner extends OpenAiCompatSessionRunner` with config `{ providerId: 'orcarouter', label: 'OrcaRouter', baseUrl, defaultModel, apiKeyEnvVars: ['ORCAROUTER_API_KEY', 'ORCAROUTER_API_KEY_2'] }` and **no overridden methods**
- [ ] 2.3 Export `OrcaRouterSessionRunner` from `src/executors/index.ts`
- [ ] 2.4 Stop and reassess if any step above requires editing `openaiCompatRunner.ts` or `openaiCompatClient.ts` — per design.md, that means the config-only claim is false and the fix belongs in the base class, not this runner

## 3. Wiring the exhaustive switches

- [ ] 3.1 Add `case 'orcarouter': return new OrcaRouterSessionRunner();` to `buildRunner` in `src/cli/provider.ts`
- [ ] 3.2 Add `case 'orcarouter': return ORCAROUTER_BASE_URL;` to `baseUrlFor` in `src/init/modelList.ts`
- [ ] 3.3 Add `ORCAROUTER_API_KEY` to the `fail()` message in `resolveProvider` (`src/cli/provider.ts`) that lists candidate env vars
- [ ] 3.4 Run `npm run typecheck` and confirm it reported 3.1 and 3.2 before they were written — if it did not, the switches are not exhaustive over `ProviderId` and that is a separate bug worth filing

## 4. Model picker filtering

- [ ] 4.1 Add a `NON_CHAT_MODALITY_PATTERN` in `src/init/modelList.ts` covering modality-suffixed ids: image (`imagen`, `-image`), video (`^kling/`, `seedance`), speech (`-tts`), and `embedding`
- [ ] 4.2 Replace the inline `if (provider === 'openai')` filter with a per-provider lookup of which patterns apply: `openai` keeps `NON_CHAT_ID_PATTERN` **unchanged**, `orcarouter` gets `NON_CHAT_MODALITY_PATTERN`, `openrouter` keeps none
- [ ] 4.3 Test: a fixture catalog containing `kling/kling-v3`, `google/imagen-4.0-generate-001`, `google/gemini-2.5-flash-preview-tts`, `google/gemini-embedding-001`, and `openai/gpt-4o-mini` yields only the last one for `orcarouter`
- [ ] 4.4 Test: the existing `openai` filtering behavior is byte-for-byte unchanged — same fixture in, same list out as before this change

## 5. Live verification

- [ ] 5.1 Confirm `GET https://api.orcarouter.ai/v1/models` still returns `openai/gpt-4o-mini`; if the catalog has moved, revisit the default rather than shipping a dead id
- [ ] 5.2 With a real `ORCAROUTER_API_KEY`, run `flow-code init`, select OrcaRouter, and confirm the wizard detects the env var, lists a filtered catalog, and writes `.flow-code/credentials.json` mode `0600`
- [ ] 5.3 Execute a workflow with at least one Implement and one Validate node end to end; confirm tool calls execute, the activity log populates, and token counts accumulate — the harness is shared, so this is verifying the config, not the enforcement
- [ ] 5.4 Confirm a capability denial (a node without `edit` attempting a write) is blocked and logged identically to the OpenRouter path
- [ ] 5.5 Confirm per-node `config.model` override selects an OrcaRouter model id and the node detail view names it

## 6. Documentation and close-out

- [ ] 6.1 Add an OrcaRouter row to the provider table in `docs/providers.md` (`ORCAROUTER_API_KEY`, no CLI fallback)
- [ ] 6.2 Add OrcaRouter to that document's cost section alongside OpenAI and OpenRouter — it bills against the key provided, at upstream list price with no per-token markup
- [ ] 6.3 Add `orcarouter` to `keywords` in `package.json`
- [ ] 6.4 `npm run typecheck && npm run lint && npm test` all green
- [ ] 6.5 `npm run docs:check` passes, or regenerate with `npm run docs:generate` if the provider list feeds generated docs
