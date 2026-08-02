import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** SessionRunner backed by OpenAI's chat-completions API. */
export class OpenAiSessionRunner extends OpenAiCompatSessionRunner {
  constructor() {
    super({
      providerId: 'openai',
      label: 'OpenAI',
      baseUrl: OPENAI_BASE_URL,
      defaultModel: DEFAULT_OPENAI_MODEL,
      apiKeyEnvVar: 'OPENAI_API_KEY',
    });
  }
}
