import { DEFAULT_NVIDIA_MODEL, NVIDIA_BASE_URL } from './nvidiaClient.js';
import { OpenAiCompatSessionRunner } from './openaiCompatRunner.js';

/** SessionRunner backed by NVIDIA's OpenAI-compatible NIM chat-completions API. */
export class NvidiaSessionRunner extends OpenAiCompatSessionRunner {
  constructor() {
    super({
      providerId: 'nvidia',
      label: 'NVIDIA',
      baseUrl: NVIDIA_BASE_URL,
      defaultModel: DEFAULT_NVIDIA_MODEL,
      apiKeyEnvVar: 'NVIDIA_API_KEY',
    });
  }
}
