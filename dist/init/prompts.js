import { jsxs as _jsxs } from "react/jsx-runtime";
import { Text, render, useInput } from 'ink';
import React, { useState } from 'react';
// These used to be implemented with node:readline and manual raw-mode stdin
// reads, interleaved with Ink components like the provider/model SelectList.
// That mix turned out to be unreliable: verified with a pty repro, handing
// stdin off from an unmounted Ink component to our own readline/raw-mode
// code could leave stdin reporting perfectly healthy (not paused, raw mode
// on, a 'data' listener attached) and *still* let Node's event loop decide
// there's nothing to do and exit — while consecutive Ink-to-Ink handoffs
// (e.g. the provider picker straight into the model picker) never had any
// issue. Rather than continue patching one handoff direction at a time,
// every prompt here is now an Ink component too, so the entire wizard flows
// through the one stdin-ownership path that's actually proven reliable.
function useSubmittableLine(onSubmit) {
    const [value, setValue] = useState('');
    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            process.exit(130);
        }
        if (key.return) {
            onSubmit(value);
            return;
        }
        if (key.backspace || key.delete) {
            setValue((v) => v.slice(0, -1));
            return;
        }
        if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
            setValue((v) => v + input);
        }
    });
    return value;
}
function ConfirmPrompt({ question, defaultAnswer, onSubmit, }) {
    const value = useSubmittableLine((raw) => {
        const trimmed = raw.trim().toLowerCase();
        onSubmit(trimmed === '' ? defaultAnswer : trimmed === 'y' || trimmed === 'yes');
    });
    const suffix = defaultAnswer ? '[Y/n]' : '[y/N]';
    return (_jsxs(Text, { children: [question, " ", suffix, " ", value] }));
}
export function confirm(question, opts = {}) {
    const defaultAnswer = opts.defaultAnswer ?? false;
    if (!process.stdin.isTTY)
        return Promise.resolve(defaultAnswer);
    return new Promise((resolve) => {
        const instance = render(React.createElement(ConfirmPrompt, {
            question,
            defaultAnswer,
            onSubmit: (value) => {
                instance.unmount();
                resolve(value);
            },
        }), { exitOnCtrlC: false });
    });
}
function TextPrompt({ question, onSubmit, }) {
    const value = useSubmittableLine((raw) => onSubmit(raw.trim()));
    return (_jsxs(Text, { children: [question, value] }));
}
/** Plain, unmasked free-text prompt — used for things like a typed-in model id. */
export function promptText(question) {
    return new Promise((resolve) => {
        const instance = render(React.createElement(TextPrompt, {
            question,
            onSubmit: (value) => {
                instance.unmount();
                resolve(value);
            },
        }), { exitOnCtrlC: false });
    });
}
function SecretPrompt({ question, onSubmit, }) {
    const value = useSubmittableLine(onSubmit);
    return (_jsxs(Text, { children: [question, '*'.repeat(value.length)] }));
}
/** Reads one line from stdin without echoing it, masking each keystroke with `*`. Caller must check isTTY first. */
export function promptSecret(question) {
    return new Promise((resolve) => {
        const instance = render(React.createElement(SecretPrompt, {
            question,
            onSubmit: (value) => {
                instance.unmount();
                resolve(value);
            },
        }), { exitOnCtrlC: false });
    });
}
//# sourceMappingURL=prompts.js.map