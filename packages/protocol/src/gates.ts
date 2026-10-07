import type { Role } from './roles.js';

/** The three gates per round (spec, "Gate approvals"). */
export const GATES = ['plan', 'send', 'integration'] as const;

export type Gate = (typeof GATES)[number];

/** Each gate belongs to one side; only that side's developer can pass it. */
export const GATE_ROLE: Record<Gate, Role> = {
  plan: 'backend',
  send: 'backend',
  integration: 'frontend',
};
