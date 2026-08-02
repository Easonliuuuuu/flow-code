import { ensureGitExclude } from '../git/exclude.js';
import { credentialsPath, saveCredentials } from '../engine/credentials.js';
import { defaultCredentialsResolver } from '../engine/preflight.js';
import { PROVIDERS, providerInfo, type ProviderId } from '../engine/providers.js';
import { fetchModelIds } from './modelList.js';
import { confirm, promptSecret, promptText } from './prompts.js';
import { selectFromList } from './SelectList.js';

const CUSTOM_MODEL_SENTINEL = '__custom__';

/**
 * Walks the user through picking a provider and model for the whole project,
 * then saves the choice (and any API key entered) to
 * `.flow-code/credentials.json`. Returns undefined if the user cancels at
 * any point — nothing is saved in that case.
 */
export async function runProviderWizard(
  repoRoot: string,
): Promise<{ provider: ProviderId; model: string } | undefined> {
  console.log('\nflow-code: pick the provider and model that will back every agent-driven node.\n');

  const provider = await selectFromList(
    PROVIDERS.map((p) => ({ label: p.label, value: p.id })),
    { prompt: 'Provider:' },
  );
  if (!provider) return undefined;

  const info = providerInfo(provider);
  let apiKey: string | undefined;
  let apiKey2: string | undefined;

  if (info.apiKeyEnvVar) {
    apiKey = await promptSecret(`${info.label} API key: `);
    process.env[info.apiKeyEnvVar] = apiKey;
    if (await confirm('Add a second key (a different account) to rotate onto under rate limits?')) {
      apiKey2 = await promptSecret(`Second ${info.label} API key: `);
    }
  } else if (!defaultCredentialsResolver()) {
    console.log(
      '  No Claude credentials detected yet (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or a `claude` CLI ' +
        'login). `flow-code run` will need one of those before this works.',
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
