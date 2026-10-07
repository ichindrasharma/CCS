import { describe, expect, it } from 'vitest';
import type { ErrorCode } from './errors.js';
import {
  allowedTools,
  openSupersedingThread,
  openThread,
  transition,
  type Action,
  type Actor,
  type ThreadSnapshot,
} from './machine.js';
import type { ThreadState } from './states.js';

const asha: Actor = { member: 'asha', role: 'frontend' };
const lee: Actor = { member: 'lee', role: 'frontend' };
const ravi: Actor = { member: 'ravi', role: 'backend' };
const mei: Actor = { member: 'mei', role: 'backend' };

function snap(state: ThreadState, overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    state,
    frontendOwner: 'asha',
    backendOwner: state === 'requested' ? null : 'ravi',
    round: 0,
    loopBase: 0,
    loopLimit: 3,
    escalatedFrom: null,
    ...overrides,
  };
}

interface Case {
  name: string;
  from: ThreadSnapshot;
  actor: Actor;
  action: Action;
  expect: { state: ThreadState; events?: string[]; patch?: Partial<ThreadSnapshot> } | ErrorCode;
}

const plan = { gate: 'plan', round: 0 } as const;
const sendGate = { gate: 'send', round: 0 } as const;

// One row per line of the spec's "Thread states" table, shortcuts and Flow 9 cases.
const cases: Case[] = [
  // requested
  { name: 'backend claims an open thread', from: snap('requested'), actor: ravi, action: { kind: 'claim' }, expect: { state: 'planning', events: ['claimed'], patch: { backendOwner: 'ravi' } } },
  { name: 'second claim loses to the first', from: snap('planning'), actor: mei, action: { kind: 'claim' }, expect: 'ALREADY_CLAIMED' },
  { name: 'frontend cannot claim a side it already owns', from: snap('requested'), actor: lee, action: { kind: 'claim' }, expect: 'ALREADY_CLAIMED' },
  { name: 'unclaimed backend member may ask a question', from: snap('requested'), actor: mei, action: { kind: 'send', type: 'question' }, expect: { state: 'requested', events: [] } },

  // planning
  { name: 'plan gate approval records an event, state unchanged', from: snap('planning'), actor: ravi, action: { kind: 'decide_gate', gate: 'plan', decision: 'approved' }, expect: { state: 'planning', events: ['gate_approved'] } },
  { name: 'plan rejection keeps the state', from: snap('planning'), actor: ravi, action: { kind: 'decide_gate', gate: 'plan', decision: 'rejected', note: 'split the endpoint' }, expect: { state: 'planning', events: ['gate_rejected'] } },
  { name: 'frontend cannot decide the plan gate', from: snap('planning'), actor: asha, action: { kind: 'decide_gate', gate: 'plan', decision: 'approved' }, expect: 'WRONG_ROLE' },
  { name: 'inventory_and_plan with plan approval moves to building', from: snap('planning'), actor: ravi, action: { kind: 'send', type: 'inventory_and_plan', approval: plan }, expect: { state: 'building' } },
  { name: 'inventory_and_plan without approval is rejected', from: snap('planning'), actor: ravi, action: { kind: 'send', type: 'inventory_and_plan' }, expect: 'APPROVAL_REQUIRED' },
  { name: 'inventory_and_plan with the wrong gate is rejected', from: snap('planning'), actor: ravi, action: { kind: 'send', type: 'inventory_and_plan', approval: sendGate }, expect: 'APPROVAL_REQUIRED' },
  { name: 'approval from an earlier round is rejected', from: snap('planning', { round: 1 }), actor: ravi, action: { kind: 'send', type: 'inventory_and_plan', approval: plan }, expect: 'APPROVAL_REQUIRED' },
  { name: 'non-owner backend cannot send the plan', from: snap('planning'), actor: mei, action: { kind: 'send', type: 'inventory_and_plan', approval: plan }, expect: 'NOT_OWNER' },
  { name: 'frontend cannot send inventory_and_plan', from: snap('planning'), actor: asha, action: { kind: 'send', type: 'inventory_and_plan', approval: plan }, expect: 'WRONG_ROLE' },
  { name: 'nothing missing: contract straight from planning', from: snap('planning'), actor: ravi, action: { kind: 'send', type: 'contract', approval: sendGate }, expect: { state: 'reviewing' } },

  // building
  { name: 'contract with send approval moves to reviewing', from: snap('building'), actor: ravi, action: { kind: 'send', type: 'contract', approval: sendGate }, expect: { state: 'reviewing' } },
  { name: 'contract without send approval is rejected', from: snap('building'), actor: ravi, action: { kind: 'send', type: 'contract' }, expect: 'APPROVAL_REQUIRED' },
  { name: 'contract cannot be sent twice', from: snap('reviewing'), actor: ravi, action: { kind: 'send', type: 'contract', approval: sendGate }, expect: 'WRONG_STATE' },

  // reviewing and the gap loop
  { name: 'gap list returns to planning and counts a round', from: snap('reviewing'), actor: asha, action: { kind: 'send', type: 'gap_list' }, expect: { state: 'planning', patch: { round: 1 } } },
  { name: 'gap list at the loop limit auto-escalates', from: snap('reviewing', { round: 2 }), actor: asha, action: { kind: 'send', type: 'gap_list' }, expect: { state: 'escalated', events: ['auto_escalated'], patch: { round: 3, escalatedFrom: 'planning' } } },
  { name: 'loop limit counts from the last resume', from: snap('reviewing', { round: 3, loopBase: 3 }), actor: asha, action: { kind: 'send', type: 'gap_list' }, expect: { state: 'planning', patch: { round: 4 } } },
  { name: 'satisfied moves to satisfied', from: snap('reviewing'), actor: asha, action: { kind: 'send', type: 'satisfied' }, expect: { state: 'satisfied' } },
  { name: 'non-owner frontend cannot confirm', from: snap('reviewing'), actor: lee, action: { kind: 'send', type: 'satisfied' }, expect: 'NOT_OWNER' },
  { name: 'questions do not change state', from: snap('reviewing'), actor: asha, action: { kind: 'send', type: 'question' }, expect: { state: 'reviewing', events: [] } },

  // satisfied and integrating
  { name: 'integration gate approval starts integrating', from: snap('satisfied'), actor: asha, action: { kind: 'decide_gate', gate: 'integration', decision: 'approved' }, expect: { state: 'integrating', events: ['gate_approved'] } },
  { name: 'integration plan rejected stays satisfied', from: snap('satisfied'), actor: asha, action: { kind: 'decide_gate', gate: 'integration', decision: 'rejected' }, expect: { state: 'satisfied', events: ['gate_rejected'] } },
  { name: 'cannot integrate before the gate', from: snap('satisfied'), actor: asha, action: { kind: 'send', type: 'integrated' }, expect: 'WRONG_STATE' },
  { name: 'integrated closes the thread', from: snap('integrating'), actor: asha, action: { kind: 'send', type: 'integrated' }, expect: { state: 'integrated' } },

  // integrated
  { name: 'closed threads take no messages', from: snap('integrated'), actor: asha, action: { kind: 'send', type: 'question' }, expect: 'THREAD_CLOSED' },
  { name: 'any backend member may approve a contract change on a closed thread', from: snap('integrated'), actor: mei, action: { kind: 'decide_gate', gate: 'send', decision: 'approved' }, expect: { state: 'integrated', events: ['gate_approved'] } },

  // escalation and resume
  { name: 'escalate records the state it left', from: snap('building'), actor: ravi, action: { kind: 'send', type: 'escalate' }, expect: { state: 'escalated', events: ['escalated'], patch: { escalatedFrom: 'building' } } },
  { name: 'cannot escalate twice', from: snap('escalated', { escalatedFrom: 'building' }), actor: asha, action: { kind: 'send', type: 'escalate' }, expect: 'WRONG_STATE' },
  { name: 'non-owner cannot escalate', from: snap('building'), actor: mei, action: { kind: 'send', type: 'escalate' }, expect: 'NOT_OWNER' },
  { name: 'resume returns to the state it left', from: snap('escalated', { escalatedFrom: 'satisfied', round: 2 }), actor: asha, action: { kind: 'resume' }, expect: { state: 'satisfied', events: ['resumed'], patch: { escalatedFrom: null, loopBase: 2 } } },
  { name: 'resume can choose a target', from: snap('escalated', { escalatedFrom: 'reviewing' }), actor: ravi, action: { kind: 'resume', to: 'planning' }, expect: { state: 'planning' } },
  { name: 'resume cannot target integrated', from: snap('escalated', { escalatedFrom: 'reviewing' }), actor: ravi, action: { kind: 'resume', to: 'integrated' }, expect: 'INVALID_TARGET' },
  { name: 'resume without a backend owner must return to requested', from: snap('escalated', { escalatedFrom: 'requested', backendOwner: null }), actor: asha, action: { kind: 'resume', to: 'planning' }, expect: 'INVALID_TARGET' },
  { name: 'resume of an unclaimed thread returns to requested', from: snap('escalated', { escalatedFrom: 'requested', backendOwner: null }), actor: asha, action: { kind: 'resume' }, expect: { state: 'requested' } },
  { name: 'only escalated threads resume', from: snap('planning'), actor: ravi, action: { kind: 'resume' }, expect: 'WRONG_STATE' },

  // ownership
  { name: 'owner hands off to a teammate', from: snap('building'), actor: ravi, action: { kind: 'hand_off', to: 'mei' }, expect: { state: 'building', events: ['handed_off'], patch: { backendOwner: 'mei' } } },
  { name: 'non-owner cannot hand off', from: snap('building'), actor: mei, action: { kind: 'hand_off', to: 'mei' }, expect: 'NOT_OWNER' },
  { name: 'release keeps the state and frees the slot', from: snap('building'), actor: ravi, action: { kind: 'release' }, expect: { state: 'building', events: ['released'], patch: { backendOwner: null } } },
  { name: 'a released thread can be claimed mid-flow', from: snap('building', { backendOwner: null }), actor: mei, action: { kind: 'claim' }, expect: { state: 'building', patch: { backendOwner: 'mei' } } },
];

describe('transition', () => {
  it.each(cases)('$name', ({ from, actor, action, expect: expected }) => {
    const result = transition(from, action, actor);
    if (typeof expected === 'string') {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(expected);
        expect(result.error.state).toBe(from.state);
      }
      return;
    }
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.next.state).toBe(expected.state);
    if (expected.events) expect(result.events.map((e) => e.kind)).toEqual(expected.events);
    if (expected.patch) expect(result.next).toMatchObject(expected.patch);
  });

  it('never mutates the input snapshot', () => {
    const from = snap('reviewing');
    const copy = structuredClone(from);
    transition(from, { kind: 'send', type: 'gap_list' }, asha);
    expect(from).toEqual(copy);
  });
});

describe('openThread', () => {
  it('frontend opens a requested thread it owns', () => {
    const result = openThread(asha);
    expect(result.ok && result.next).toMatchObject({ state: 'requested', frontendOwner: 'asha', backendOwner: null, loopLimit: 3 });
  });

  it('backend cannot send requirements', () => {
    const result = openThread(ravi);
    expect(!result.ok && result.error.code).toBe('WRONG_ROLE');
  });
});

describe('openSupersedingThread', () => {
  const closed = snap('integrated', { round: 1 });

  it('opens a new thread in reviewing for the same frontend owner', () => {
    const result = openSupersedingThread(closed, mei, { gate: 'send', round: 1 });
    expect(result.ok && result.next).toMatchObject({ state: 'reviewing', frontendOwner: 'asha', backendOwner: 'mei', round: 0 });
  });

  it('needs the send gate', () => {
    const result = openSupersedingThread(closed, mei, undefined);
    expect(!result.ok && result.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('only supersedes integrated threads', () => {
    const result = openSupersedingThread(snap('building'), ravi, sendGate);
    expect(!result.ok && result.error.code).toBe('WRONG_STATE');
  });
});

describe('allowedTools', () => {
  it('frontend owner reviewing a contract', () => {
    expect(allowedTools(snap('reviewing'), asha).sort()).toEqual(
      ['answer_question', 'ask_question', 'confirm_satisfied', 'escalate', 'hand_off_thread', 'send_gap_list'].sort(),
    );
  });

  it('backend owner in building', () => {
    expect(allowedTools(snap('building'), ravi).sort()).toEqual(
      ['answer_question', 'ask_question', 'escalate', 'hand_off_thread', 'request_approval', 'send_contract'].sort(),
    );
  });

  it('unclaimed backend member on a requested thread', () => {
    expect(allowedTools(snap('requested'), mei).sort()).toEqual(['answer_question', 'ask_question', 'claim_thread'].sort());
  });

  it('nothing is allowed on a closed thread', () => {
    expect(allowedTools(snap('integrated'), asha)).toEqual([]);
  });
});
