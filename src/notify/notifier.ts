import { execFile } from 'node:child_process';
import type { NotifyEvent, ResolvedNotificationConfig } from './types.js';

export type ExecFunction = (
  file: string,
  args: string[],
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export type WriteFunction = (chunk: string) => boolean;

export interface NotifierDependencies {
  exec?: ExecFunction;
  write?: WriteFunction;
  platform?: NodeJS.Platform;
  isWsl?: boolean;
}

/** Check if running under Windows Subsystem for Linux (WSL). */
export function detectWsl(env = process.env): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function escapeAppleScriptString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapePowerShellString(str: string): string {
  return str.replace(/'/g, "''");
}

function safeUnref(child: unknown): void {
  if (child !== null && typeof child === 'object' && 'unref' in child) {
    const unref = (child as { unref?: unknown }).unref;
    if (typeof unref === 'function') {
      unref.call(child);
    }
  }
}

export class Notifier {
  private readonly config: ResolvedNotificationConfig;
  private readonly exec: ExecFunction;
  private readonly write: WriteFunction;
  private readonly platform: NodeJS.Platform;
  private readonly isWsl: boolean;

  constructor(
    config: ResolvedNotificationConfig = { bell: true, desktop: true },
    deps: NotifierDependencies = {},
  ) {
    this.config = config;
    this.exec = deps.exec ?? execFile;
    this.write = deps.write ?? ((chunk: string) => process.stdout.write(chunk));
    this.platform = deps.platform ?? process.platform;
    this.isWsl = deps.isWsl ?? detectWsl();
  }

  /** Ring the terminal bell (ASCII \x07). */
  emitBell(): void {
    if (!this.config.bell) return;
    try {
      this.write('\x07');
    } catch {
      // Best-effort: ignore write errors on closed streams
    }
  }

  /** Send a cross-platform OS desktop notification. */
  sendDesktop(event: NotifyEvent): void {
    if (!this.config.desktop) return;

    try {
      if (this.platform === 'darwin') {
        this.sendMacOs(event);
      } else if (this.platform === 'linux') {
        this.sendLinux(event);
      } else if (this.platform === 'win32' || this.isWsl) {
        this.sendWindows(event);
      }
    } catch {
      // Best-effort: desktop notifications must never crash execution
    }
  }

  /** Dispatch both bell and desktop alert for a given event. */
  notify(event: NotifyEvent): void {
    this.emitBell();
    this.sendDesktop(event);
  }

  private sendMacOs(event: NotifyEvent): void {
    const title = escapeAppleScriptString(event.title);
    const message = escapeAppleScriptString(event.message);
    const subtitle = event.subtitle ? ` subtitle "${escapeAppleScriptString(event.subtitle)}"` : '';
    const script = `display notification "${message}" with title "${title}"${subtitle}`;

    const child = this.exec('osascript', ['-e', script], () => {
      // Ignore errors (e.g. headless/non-GUI environment)
    });
    safeUnref(child);
  }

  private sendLinux(event: NotifyEvent): void {
    const title = event.subtitle ? `${event.title} — ${event.subtitle}` : event.title;
    const args = [title, event.message, '--app-name=flow-code'];

    const child = this.exec('notify-send', args, (err) => {
      // If notify-send fails on WSL, try fallback to powershell.exe
      if (err && this.isWsl) {
        this.sendWindows(event);
      }
    });
    safeUnref(child);
  }

  private sendWindows(event: NotifyEvent): void {
    const title = escapePowerShellString(event.subtitle ? `${event.title} (${event.subtitle})` : event.title);
    const message = escapePowerShellString(event.message);
    const psCommand =
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ` +
      `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
      `$textNodes = $template.GetElementsByTagName('text'); ` +
      `$textNodes.Item(0).AppendChild($template.CreateTextNode('${title}')) > $null; ` +
      `$textNodes.Item(1).AppendChild($template.CreateTextNode('${message}')) > $null; ` +
      `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('flow-code'); ` +
      `$notification = [Windows.UI.Notifications.ToastNotification]::new($template); ` +
      `$notifier.Show($notification);`;

    const binary = this.platform === 'win32' ? 'powershell.exe' : 'powershell.exe';
    const child = this.exec(binary, ['-NoProfile', '-NonInteractive', '-Command', psCommand], () => {
      // Ignore powershell toast errors (e.g. if disabled in Windows settings)
    });
    safeUnref(child);
  }
}
