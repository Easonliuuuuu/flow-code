import { render } from 'ink';
import React from 'react';
import type { RunStateStore } from '../runstate/store.js';
import type { Workflow } from '../workflow/load.js';
import { App } from './App.js';
import type { UiInteractionPorts } from './ports.js';

export { UiInteractionPorts } from './ports.js';

/** Mount the terminal UI; resolves when the user exits. */
export function runUi(opts: {
  workflow: Workflow;
  store: RunStateStore;
  ports: UiInteractionPorts;
}): Promise<void> {
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(App, {
        workflow: opts.workflow,
        store: opts.store,
        ports: opts.ports,
        onExit: () => {
          instance.unmount();
          resolve();
        },
      }),
      { exitOnCtrlC: true },
    );
    void instance.waitUntilExit().then(() => resolve());
  });
}
