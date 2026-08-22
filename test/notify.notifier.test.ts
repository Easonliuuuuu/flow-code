import { describe, expect, it } from 'vitest';
import { Notifier } from '../src/notify/notifier.js';
import type { NotifyEvent } from '../src/notify/types.js';

describe('Notifier', () => {
  const dummyEvent: NotifyEvent = {
    kind: 'gate-waiting',
    title: 'Approval Required',
    message: 'Approve changes at gate',
    subtitle: 'gate-node',
  };

  it('emits terminal bell ASCII 0x07 when bell is enabled', () => {
    let written = '';
    const notifier = new Notifier(
      { bell: true, desktop: false },
      {
        write: (chunk) => {
          written += chunk;
          return true;
        },
      },
    );

    notifier.emitBell();
    expect(written).toBe('\x07');
  });

  it('does not emit bell when bell is disabled', () => {
    let written = '';
    const notifier = new Notifier(
      { bell: false, desktop: false },
      {
        write: (chunk) => {
          written += chunk;
          return true;
        },
      },
    );

    notifier.emitBell();
    expect(written).toBe('');
  });

  it('sends macOS notification using osascript', () => {
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const notifier = new Notifier(
      { bell: false, desktop: true },
      {
        platform: 'darwin',
        isWsl: false,
        exec: (file, args) => {
          execCalls.push({ file, args });
        },
      },
    );

    notifier.sendDesktop(dummyEvent);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe('osascript');
    expect(execCalls[0]?.args[0]).toBe('-e');
    expect(execCalls[0]?.args[1]).toContain('display notification "Approve changes at gate" with title "Approval Required" subtitle "gate-node"');
  });

  it('sends Linux notification using notify-send', () => {
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const notifier = new Notifier(
      { bell: false, desktop: true },
      {
        platform: 'linux',
        isWsl: false,
        exec: (file, args) => {
          execCalls.push({ file, args });
        },
      },
    );

    notifier.sendDesktop(dummyEvent);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe('notify-send');
    expect(execCalls[0]?.args).toEqual([
      'Approval Required — gate-node',
      'Approve changes at gate',
      '--app-name=flow-code',
    ]);
  });

  it('sends Windows / WSL notification using powershell.exe', () => {
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const notifier = new Notifier(
      { bell: false, desktop: true },
      {
        platform: 'win32',
        isWsl: false,
        exec: (file, args) => {
          execCalls.push({ file, args });
        },
      },
    );

    notifier.sendDesktop(dummyEvent);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe('powershell.exe');
    expect(execCalls[0]?.args[3]).toContain('CreateToastNotifier(\'flow-code\')');
  });

  it('does not send desktop notifications when desktop is disabled', () => {
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const notifier = new Notifier(
      { bell: true, desktop: false },
      {
        platform: 'darwin',
        exec: (file, args) => {
          execCalls.push({ file, args });
        },
      },
    );

    notifier.sendDesktop(dummyEvent);
    expect(execCalls).toHaveLength(0);
  });

  it('silently catches write or exec errors without throwing', () => {
    const notifier = new Notifier(
      { bell: true, desktop: true },
      {
        platform: 'darwin',
        write: () => {
          throw new Error('Stream closed');
        },
        exec: () => {
          throw new Error('Spawn error');
        },
      },
    );

    expect(() => notifier.notify(dummyEvent)).not.toThrow();
  });
});
