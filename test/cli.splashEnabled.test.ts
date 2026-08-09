import { describe, expect, it } from 'vitest';
import { splashEnabled } from '../src/cli.js';

describe('splashEnabled', () => {
  it('is on by default', () => {
    expect(splashEnabled([], {})).toBe(true);
    expect(splashEnabled(['run'], {})).toBe(true);
  });

  it('is off with --no-splash, regardless of the environment', () => {
    expect(splashEnabled(['run', '--no-splash'], {})).toBe(false);
    expect(splashEnabled(['watch', '--no-splash'], { FLOW_CODE_NO_SPLASH: '0' })).toBe(false);
  });

  it('is off with a truthy FLOW_CODE_NO_SPLASH', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(splashEnabled([], { FLOW_CODE_NO_SPLASH: value })).toBe(false);
    }
  });

  it('stays on with a falsy or empty FLOW_CODE_NO_SPLASH', () => {
    expect(splashEnabled([], { FLOW_CODE_NO_SPLASH: '0' })).toBe(true);
    expect(splashEnabled([], { FLOW_CODE_NO_SPLASH: '' })).toBe(true);
    expect(splashEnabled([], { FLOW_CODE_NO_SPLASH: 'no' })).toBe(true);
  });
});
