import { describe, expect, it } from 'vitest';
import type { CredentialDetection } from '../../src/engine/credentialDetect.js';
import { preferredProviderIndex, providerLabel } from '../../src/init/providerWizard.js';

const found = (
  provider: CredentialDetection['provider'],
  source: string,
): CredentialDetection => ({ provider, source });
const missing = (provider: CredentialDetection['provider']): CredentialDetection => ({ provider });

describe('providerLabel', () => {
  it('names where the credential came from', () => {
    expect(providerLabel(found('claude', '`claude` CLI login'))).toBe(
      'Claude (Anthropic) — detected via `claude` CLI login',
    );
    expect(providerLabel(found('openai', 'OPENAI_API_KEY'))).toBe(
      'OpenAI — detected via OPENAI_API_KEY',
    );
  });

  it('says so plainly when nothing was found', () => {
    expect(providerLabel(missing('openrouter'))).toBe('OpenRouter — no credentials found');
  });

  it('never renders a secret, only the env var holding it', () => {
    const label = providerLabel({
      provider: 'openai',
      source: 'OPENAI_API_KEY',
      apiKey: 'sk-do-not-print-me',
    });
    expect(label).not.toContain('sk-do-not-print-me');
  });
});

describe('preferredProviderIndex', () => {
  it('starts on the first provider that already works', () => {
    expect(
      preferredProviderIndex([
        missing('claude'),
        missing('codex'),
        found('openai', 'OPENAI_API_KEY'),
        missing('openrouter'),
      ]),
    ).toBe(2);
  });

  it('starts at the top when nothing is detected', () => {
    expect(
      preferredProviderIndex([missing('claude'), missing('codex'), missing('openrouter')]),
    ).toBe(0);
  });

  it('keeps the list order — only the cursor moves', () => {
    const detections = [
      missing('claude'),
      found('codex', '`codex` CLI login'),
      found('openai', 'OPENAI_API_KEY'),
    ];
    expect(detections.map((d) => d.provider)).toEqual(['claude', 'codex', 'openai']);
    expect(preferredProviderIndex(detections)).toBe(1);
  });
});
