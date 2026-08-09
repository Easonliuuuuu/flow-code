import { describe, expect, it } from 'vitest';
import { buildRunner } from '../src/cli/provider.js';
import { PROVIDERS } from '../src/engine/providers.js';
import {
  CodexSessionRunner,
  OpenAiSessionRunner,
  OpenRouterSessionRunner,
  SdkSessionRunner,
} from '../src/executors/index.js';

describe('buildRunner', () => {
  it('maps each provider to its own session runner', () => {
    expect(buildRunner('claude')).toBeInstanceOf(SdkSessionRunner);
    expect(buildRunner('codex')).toBeInstanceOf(CodexSessionRunner);
    expect(buildRunner('openai')).toBeInstanceOf(OpenAiSessionRunner);
    expect(buildRunner('openrouter')).toBeInstanceOf(OpenRouterSessionRunner);
  });

  it('covers every registered provider — a new one must be wired up here too', () => {
    for (const info of PROVIDERS) {
      const runner = buildRunner(info.id);
      expect(runner, `no runner built for provider \`${info.id}\``).toBeDefined();
      expect(typeof runner.run).toBe('function');
      expect(typeof runner.openInteractive).toBe('function');
    }
  });
});
