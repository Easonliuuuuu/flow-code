import { describe, expect, it } from 'vitest';
import { Notifier } from '../src/notify/notifier.js';
import type { NotifyEvent } from '../src/notify/types.js';
import { UiInteractionPorts } from '../src/ui/ports.js';

describe('UiInteractionPorts notification dispatch', () => {
  it('dispatches gate-waiting event when approval is requested', async () => {
    const events: NotifyEvent[] = [];
    const notifier = new Notifier({ bell: true, desktop: true }, {
      write: () => true,
      exec: () => {},
    });
    notifier.notify = (event) => events.push(event);

    const ports = new UiInteractionPorts(undefined, notifier);

    const promise = ports.approval.request({
      nodeId: 'gate-1',
      title: 'Review proposal',
      diffs: [],
      upstreamSummaries: [],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'gate-waiting',
      title: 'Approval Required',
      message: 'Review proposal',
      subtitle: 'gate-1',
    });

    ports.pendingApproval?.resolve('approve');
    await promise;
  });

  it('dispatches turn-waiting event when discuss waits for user reply', async () => {
    const events: NotifyEvent[] = [];
    const notifier = new Notifier({ bell: true, desktop: true }, {
      write: () => true,
      exec: () => {},
    });
    notifier.notify = (event) => events.push(event);

    const ports = new UiInteractionPorts(undefined, notifier);

    ports.discuss.begin('discuss-1', 'What should we build?');
    const promise = ports.discuss.nextUserMessage('discuss-1');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'turn-waiting',
      title: 'Input Needed',
      message: 'Discussion waiting for your reply at discuss-1',
      subtitle: 'discuss-1',
    });

    ports.submitUserMessage('Build feature X');
    await promise;
  });

  it('dispatches test-discovery-waiting event when test commands confirmation is requested', async () => {
    const events: NotifyEvent[] = [];
    const notifier = new Notifier({ bell: true, desktop: true }, {
      write: () => true,
      exec: () => {},
    });
    notifier.notify = (event) => events.push(event);

    const ports = new UiInteractionPorts(undefined, notifier);

    const promise = ports.testCommands.request({
      nodeId: 'test-1',
      detected: ['npm test'],
      proposals: [{ command: 'npm test', rationale: 'default' }],
      discover: async () => [],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'test-discovery-waiting',
      title: 'Confirm Test Commands',
      message: 'Confirm test commands for test-1',
      subtitle: 'test-1',
    });

    ports.pendingTestCommands?.resolve(['npm test']);
    await promise;
  });
});
