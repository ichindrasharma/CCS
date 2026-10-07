import type { ThreadState } from './states.js';

export const ERROR_CODES = [
  'WRONG_STATE',
  'WRONG_ROLE',
  'NOT_OWNER',
  'ALREADY_CLAIMED',
  'APPROVAL_REQUIRED',
  'INVALID_TARGET',
  'THREAD_CLOSED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Returned to the agent as-is, so the message must say what to do instead. */
export interface ProtocolError {
  code: ErrorCode;
  message: string;
  state: ThreadState | null;
}
