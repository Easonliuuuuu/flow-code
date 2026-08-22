import { ensureGitExclude } from '../git/exclude.js';
import { credentialsPath, saveCredentials } from '../engine/credentials.js';
import { detectCredentials, type CredentialDetection } from '../engine/credentialDetect.js';
import { providerInfo, type ProviderId } from '../engine/providers.js';
import { fetchModelIds } from './modelList.js';
import { confirm, promptSecret, promptText } from './prompts.js';
import { selectFromList } from './SelectList.js';

const CUSTOM_MODEL_SENTINEL = '__custom__';

/**
 * Menu label for one provider, annotated with what is already on this machine.
 * `source` is an env var name or a login description, never a secret, so this
 * is safe to render.
 */
export function providerLabel(detection: CredentialDetection): string {
  const { label } = providerInfo(detection.provider);
  return detection.source ? `${label} — detected via ${detection.source}` : `${label} — no credentials found`;
}

/**
 * Index of the provider the cursor should start on: the first one already
 * usable, or 0 when none is. Chosen over sorting detected providers to the
 * top so the menu's order stays the same everywhere and only the starting
 * position reacts to the machine.
 */
export function preferredProviderIndex(detections: CredentialDetection[]): number {
  const found = detections.findIndex((d) => d.source !== undefined);
  return found === -1 ? 0 : found;
}

/**
 * Walks the user through picking a provider and model for the whole project,
 * then saves the choice (and any API key entered) to
 * `.flow-code/credentials.json`. Returns undefined if the user cancels at
 * any point — nothing is saved in that case.
 *
 * Credentials already on the machine are found first and offered for reuse:
 * the common case is someone who has logged into `claude` or `codex`, or who
 * already exports an API key, and asking them to paste a secret they have
 * plainly got is the single most avoidable step in this wizard.
 */
export async function runProviderWizard(
  repoRoot: string,
): Promise<{ provider: ProviderId; model: string } | undefined> {
  console.log('\nflow-code: pick the provider and model that will back every agent-driven node.\n');

  const detections = detectCredentials();
  const provider = await selectFromList(
    detections.map((d) => ({ label: providerLabel(d), value: d.provider })),
    { prompt: 'Provider:', initialIndex: preferredProviderIndex(detections) },
  );
  if (!provider) return undefined;

  const info = providerInfo(provider);
  const detected = detections.find((d) => d.provider === provider);
  let apiKey: string | undefined;
  let apiKey2: string | undefined;

  if (info.apiKeyEnvVar) {
    if (detected?.apiKey) {
      // Saved rather than left in the environment on purpose: the env var may
      // only exist in the shell this wizard was run from, and a `flow-code
      // run` that works here but not in the next terminal is exactly the
      // friction reusing the key was meant to remove. The env var still wins
      // at run time (see resolveProvider), so this is a fallback, not a
      // shadow copy that can go stale unnoticed.
      const choice = await selectFromList(
        [
          { label: `Use $${detected.source} (saved to this repo's credentials file)`, value: 'reuse' },
          { label: 'Enter a different key', value: 'enter' },
        ],
        { prompt: `${info.label} key found in your environment. Use it?` },
      );
      if (choice === undefined) return undefined;
      apiKey = choice === 'reuse' ? detected.apiKey : await promptSecret(`${info.label} API key: `);
    } else {
      apiKey = await promptSecret(`${info.label} API key: `);
    }
    process.env[info.apiKeyEnvVar] = apiKey;
    if (await confirm('Add a second key (a different account) to rotate onto under rate limits?')) {
      apiKey2 = await promptSecret(`Second ${info.label} API key: `);
    }
  } else if (detected?.source) {
    // claude/codex: the SDK resolves its own credentials, so there is nothing
    // to collect — just confirm what it will use, since "no key asked for" is
    // otherwise indistinguishable from "this step was skipped".
    console.log(`  Using your existing ${info.label} credentials (${detected.source}) — nothing to paste.`);
  } else if (provider === 'claude') {
    console.log(
      '  No Claude credentials detected yet (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or a `claude` CLI ' +
        'login). `flow-code run` will need one of those before this works.',
    );
  } else if (provider === 'codex') {
    console.log(
      '  No Codex credentials detected yet (OPENAI_API_KEY, CODEX_API_KEY, or a `codex` CLI login). ' +
        '`flow-code run` will need one of those before this works.',
    );
  }

  console.log('  Fetching available models…');
  const { models, error } = await fetchModelIds(provider, apiKey);

  let model: string | undefined;
  if (error) {
    console.log(`  Could not fetch the model list (${error}) — type a model id instead.`);
    model = await promptText('Model id: ');
  } else {
    const choice = await selectFromList(
      [
        ...models.map((id) => ({ label: id, value: id })),
        { label: '(custom — type a model id)', value: CUSTOM_MODEL_SENTINEL },
      ],
      { prompt: 'Model:' },
    );
    if (choice === undefined) return undefined;
    model = choice === CUSTOM_MODEL_SENTINEL ? await promptText('Model id: ') : choice;
  }

  if (!model) return undefined;

  saveCredentials(repoRoot, {
    provider,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKey2 !== undefined ? { apiKey2 } : {}),
  });
  ensureGitExclude(repoRoot);
  console.log(`flow-code: saved to ${credentialsPath(repoRoot)} (gitignored, chmod 600).`);

  return { provider, model };
}
