import { describe, expect, it } from 'vitest';
import { confirm } from '../../src/init/prompts.js';

describe('confirm', () => {
  it('resolves to the default answer without prompting when stdin is not a TTY', async () => {
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(confirm('Proceed?')).resolves.toBe(false);
    await expect(confirm('Proceed?', { defaultAnswer: true })).resolves.toBe(true);
  });
});
