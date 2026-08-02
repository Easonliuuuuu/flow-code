import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
export { UiInteractionPorts } from './ports.js';
/** Mount the terminal UI; resolves when the user exits. */
export function runUi(opts) {
    return new Promise((resolve) => {
        const instance = render(React.createElement(App, {
            workflow: opts.workflow,
            store: opts.store,
            ports: opts.ports,
            modelContext: opts.modelContext,
            onExit: () => {
                instance.unmount();
                resolve();
            },
            // App owns ctrl+c (exitOnCtrlC below is off) so we can interrupt the
            // engine, not just unmount the UI over a still-running session.
            onInterrupt: () => {
                instance.unmount();
                opts.onInterrupt();
                resolve();
            },
        }), { exitOnCtrlC: false });
        void instance.waitUntilExit().then(() => resolve());
    });
}
//# sourceMappingURL=index.js.map