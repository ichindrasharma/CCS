import type { Role } from './roles.js';

/** The eight thread states (spec, "Thread states"). */
export const THREAD_STATES = [
  'requested',
  'planning',
  'building',
  'reviewing',
  'satisfied',
  'integrating',
  'integrated',
  'escalated',
] as const;

export type ThreadState = (typeof THREAD_STATES)[number];

/** Who must act next in each state. `escalated` waits on both developers. */
export const NEXT_ACTOR: Record<ThreadState, readonly Role[]> = {
  requested: ['backend'],
  planning: ['backend'],
  building: ['backend'],
  reviewing: ['frontend'],
  satisfied: ['frontend'],
  integrating: ['frontend'],
  integrated: [],
  escalated: ['frontend', 'backend'],
};

export function isClosed(state: ThreadState): boolean {
  return state === 'integrated';
}
