import { describe, expect, it } from 'vitest';
import { resolveNotificationConfig } from '../src/cli/args.js';
import { notificationSettingsSchema, settingsSchema } from '../src/workflow/schema.js';

describe('notificationSettingsSchema', () => {
  it('defaults both bell and desktop to true when parsed directly with empty object', () => {
    const parsed = notificationSettingsSchema.parse({});
    expect(parsed).toEqual({ bell: true, desktop: true });
  });

  it('accepts boolean false to disable both', () => {
    const parsed = settingsSchema.parse({ notifications: false });
    expect(parsed.notifications).toEqual({ bell: false, desktop: false });
  });

  it('accepts boolean true to enable both', () => {
    const parsed = settingsSchema.parse({ notifications: true });
    expect(parsed.notifications).toEqual({ bell: true, desktop: true });
  });

  it('accepts explicit object overriding only one channel', () => {
    const parsed = settingsSchema.parse({ notifications: { bell: false } });
    expect(parsed.notifications).toEqual({ bell: false, desktop: true });
  });

  it('leaves notifications undefined in settingsSchema when omitted, resolving to default in args', () => {
    const parsed = settingsSchema.parse({});
    expect(parsed.notifications).toBeUndefined();
    expect(resolveNotificationConfig([], {}, parsed.notifications)).toEqual({ bell: true, desktop: true });
  });
});

describe('resolveNotificationConfig', () => {
  it('defaults to bell=true and desktop=true when no flags or env are set', () => {
    const res = resolveNotificationConfig([], {});
    expect(res).toEqual({ bell: true, desktop: true });
  });

  it('honors workflow settings defaults', () => {
    const res = resolveNotificationConfig([], {}, { bell: false, desktop: true });
    expect(res).toEqual({ bell: false, desktop: true });
  });

  it('--no-notify disables desktop notification while keeping bell', () => {
    const res = resolveNotificationConfig(['--no-notify'], {});
    expect(res).toEqual({ bell: true, desktop: false });
  });

  it('--no-bell disables terminal bell while keeping desktop notification', () => {
    const res = resolveNotificationConfig(['--no-bell'], {});
    expect(res).toEqual({ bell: false, desktop: true });
  });

  it('--no-alerts disables both bell and desktop notification', () => {
    const res = resolveNotificationConfig(['--no-alerts'], {});
    expect(res).toEqual({ bell: false, desktop: false });
  });

  it('--silent-alerts also disables both', () => {
    const res = resolveNotificationConfig(['--silent-alerts'], {});
    expect(res).toEqual({ bell: false, desktop: false });
  });

  it('FLOW_CODE_NO_NOTIFY env var disables desktop notification', () => {
    const res = resolveNotificationConfig([], { FLOW_CODE_NO_NOTIFY: '1' });
    expect(res).toEqual({ bell: true, desktop: false });
  });

  it('FLOW_CODE_NO_BELL env var disables terminal bell', () => {
    const res = resolveNotificationConfig([], { FLOW_CODE_NO_BELL: 'true' });
    expect(res).toEqual({ bell: false, desktop: true });
  });

  it('FLOW_CODE_NO_ALERTS env var disables both', () => {
    const res = resolveNotificationConfig([], { FLOW_CODE_NO_ALERTS: 'yes' });
    expect(res).toEqual({ bell: false, desktop: false });
  });

  it('CI=true suppresses desktop notifications by default', () => {
    const res = resolveNotificationConfig([], { CI: 'true' });
    expect(res).toEqual({ bell: true, desktop: false });
  });

  it('CLI flags override workflow settings that set channels to true', () => {
    const res = resolveNotificationConfig(['--no-bell', '--no-notify'], {}, { bell: true, desktop: true });
    expect(res).toEqual({ bell: false, desktop: false });
  });
});
