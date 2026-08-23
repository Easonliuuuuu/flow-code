import { describe, expect, it } from 'vitest';
import { UiInteractionPorts } from '../../src/ui/ports.js';
import { DemoInteractionPorts } from '../../src/demo/DemoInteractionPorts.js';
import { DEMO_DISCUSS_USER_MESSAGE, DEMO_REVISE_USER_MESSAGE } from '../../src/demo/fixtures.js';

describe('DemoInteractionPorts', () => {
  it('is a real UiInteractionPorts — the type runUi and AppProps require', () => {
    const ports = new DemoInteractionPorts(undefined, undefined, 0);
    expect(ports).toBeInstanceOf(UiInteractionPorts);
  });

  it('resolves nextUserMessage from the script instead of waiting on a keypress', async () => {
    const ports = new DemoInteractionPorts(undefined, undefined, 0);
    ports.discuss.begin('discuss', 'what to build');
    await expect(ports.discuss.nextUserMessage('discuss')).resolves.toBe(DEMO_DISCUSS_USER_MESSAGE);
  });

  it('ends the conversation after its one scripted turn', async () => {
    const ports = new DemoInteractionPorts(undefined, undefined, 0);
    ports.discuss.begin('discuss', undefined);
    await ports.discuss.nextUserMessage('discuss');
    await expect(ports.discuss.nextUserMessage('discuss')).resolves.toBeNull();
  });

  it('gives revise its own scripted line, independent of discuss', async () => {
    const ports = new DemoInteractionPorts(undefined, undefined, 0);
    ports.discuss.begin('revise', undefined);
    await expect(ports.discuss.nextUserMessage('revise')).resolves.toBe(DEMO_REVISE_USER_MESSAGE);
  });

  it('begin/postAssistant/end still populate the real reactive state the UI reads', () => {
    const ports = new DemoInteractionPorts(undefined, undefined, 0);
    ports.discuss.begin('discuss', 'topic');
    expect(ports.discussState?.nodeId).toBe('discuss');
    ports.discuss.postAssistant('discuss', 'hello');
    expect(ports.discussState?.transcript).toEqual([{ role: 'assistant', text: 'hello' }]);
    ports.discuss.end('discuss');
    expect(ports.discussState?.active).toBe(false);
  });

  it('approval, convergence, plan, and testCommands are the inherited real implementations, untouched', () => {
    const ports = new DemoInteractionPorts(undefined, undefined, 0);
    const real = new UiInteractionPorts(undefined, undefined);
    expect(typeof ports.approval.request).toBe(typeof real.approval.request);
    expect(typeof ports.convergence.select).toBe(typeof real.convergence.select);
    expect(typeof ports.plan.nextTurn).toBe(typeof real.plan.nextTurn);
    expect(typeof ports.testCommands.request).toBe(typeof real.testCommands.request);
  });
});
