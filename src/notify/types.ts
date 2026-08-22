export type NotifyEventKind =
  | 'gate-waiting'
  | 'turn-waiting'
  | 'test-discovery-waiting'
  | 'convergence-waiting'
  | 'run-finished'
  | 'run-failed';

export interface NotifyEvent {
  kind: NotifyEventKind;
  title: string;
  message: string;
  subtitle?: string;
}

export interface ResolvedNotificationConfig {
  bell: boolean;
  desktop: boolean;
}
