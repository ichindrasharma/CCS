/** Thread events recorded in the log beside messages (spec, "Thread events"). */
export const EVENT_KINDS = [
  'claimed',
  'handed_off',
  'gate_approved',
  'gate_rejected',
  'escalated',
  'auto_escalated',
  'resumed',
  'released',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface ThreadEvent {
  kind: EventKind;
  /** Member id of whoever caused the event. */
  actor: string;
  data?: Record<string, unknown>;
}
