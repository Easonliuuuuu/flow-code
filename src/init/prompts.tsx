import { Text, render, useInput } from 'ink';
import React, { useState } from 'react';
import { selectFromList } from './SelectList.js';

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

function useSubmittableLine(onSubmit: (value: string) => void): string {
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

/**
 * A Yes/No choice as a two-item selectable list rather than a typed `[Y/n]`
 * line — consistent with every other choice in this CLI (preset picker,
 * provider picker, the openspec/spec-kit CLI-install prompt), all of which
 * are pick-from-a-list, not type-an-answer. The default sorts first so
 * Enter alone still picks it; Escape/Ctrl+C resolves to `false`, matching
 * `SelectList`'s existing cancel behavior rather than hard-exiting the
 * process the way the old typed prompt did on Ctrl+C.
 */
export async function confirm(question: string, opts: { defaultAnswer?: boolean } = {}): Promise<boolean> {
  const defaultAnswer = opts.defaultAnswer ?? false;
  if (!process.stdin.isTTY) return defaultAnswer;
  const items = defaultAnswer
    ? [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ]
    : [
        { label: 'No', value: false },
        { label: 'Yes', value: true },
      ];
  const chosen = await selectFromList(items, { prompt: question });
  return chosen ?? false;
}

function TextPrompt({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const value = useSubmittableLine((raw) => onSubmit(raw.trim()));
  return (
    <Text>
      {question}
      {value}
    </Text>
  );
}

/** Plain, unmasked free-text prompt — used for things like a typed-in model id. */
export function promptText(question: string): Promise<string> {
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(TextPrompt, {
        question,
        onSubmit: (value: string) => {
          instance.unmount();
          resolve(value);
        },
      }),
      { exitOnCtrlC: false },
    );
  });
}

function SecretPrompt({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const value = useSubmittableLine(onSubmit);
  return (
    <Text>
      {question}
      {'*'.repeat(value.length)}
    </Text>
  );
}

/** Reads one line from stdin without echoing it, masking each keystroke with `*`. Caller must check isTTY first. */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(SecretPrompt, {
        question,
        onSubmit: (value: string) => {
          instance.unmount();
          resolve(value);
        },
      }),
      { exitOnCtrlC: false },
    );
  });
}
