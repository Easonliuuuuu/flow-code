import { describe, expect, it } from 'vitest';
import { resolveNodeModel } from '../src/workflow/modelResolution.js';

describe('resolveNodeModel', () => {
  it("prefers the node's own config.model", () => {
    expect(resolveNodeModel({ model: 'opus' }, 'sonnet', 'haiku')).toEqual({
      model: 'opus',
      origin: 'node',
    });
  });

  it('falls back to the workflow settings model when the node has none', () => {
    expect(resolveNodeModel({ instructions: 'x' }, 'sonnet', 'haiku')).toEqual({
      model: 'sonnet',
      origin: 'settings',
    });
  });

  it('falls back to the provider default when neither the node nor settings has one', () => {
    expect(resolveNodeModel({}, undefined, 'haiku')).toEqual({
      model: 'haiku',
      origin: 'provider',
    });
  });

  it('resolves to no model at all when nothing is configured anywhere', () => {
    expect(resolveNodeModel({}, undefined, undefined)).toEqual({
      model: undefined,
      origin: 'provider',
    });
  });

  it('ignores a non-string or missing model field on the node config', () => {
    expect(resolveNodeModel({ model: 42 }, 'sonnet', 'haiku')).toEqual({
      model: 'sonnet',
      origin: 'settings',
    });
    expect(resolveNodeModel(undefined, 'sonnet', 'haiku')).toEqual({
      model: 'sonnet',
      origin: 'settings',
    });
  });
});
