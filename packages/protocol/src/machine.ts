import type { ErrorCode, ProtocolError } from './errors.js';
import type { ThreadEvent } from './events.js';
import { GATE_ROLE, type Gate } from './gates.js';
import { SENDER_ROLE, type MessageType } from './messages.js';
import type { Role, ToolName } from './roles.js';
import { isClosed, type ThreadState } from './states.js';

/** What the state machine needs to know about a thread. The relay stores it in `threads`. */
export interface ThreadSnapshot {
  state: ThreadState;
  frontendOwner: string | null;
  backendOwner: string | null;
  /** Gap lists sent so far. Never decreases, so approvals can be bound to it. */
  round: number;
  /** `round` at the last resume; the loop limit counts gap lists from here. */
  loopBase: number;
  loopLimit: number;
  escalatedFrom: ThreadState | null;
}

export interface Actor {
  member: string;
  role: Role;
}

/** An approval the relay has already verified as approved, unconsumed and for this thread. */
export interface ApprovalRef {
  gate: Gate;
  round: number;
}

export type Action =
  | { kind: 'claim' }
  | { kind: 'send'; type: Exclude<MessageType, 'requirements'>; approval?: ApprovalRef }
  | { kind: 'decide_gate'; gate: Gate; decision: 'approved' | 'rejected'; note?: string }
  | { kind: 'resume'; to?: ThreadState }
  /** The relay must check that `to` is a member with the same role. */
  | { kind: 'hand_off'; to: string }
  /** Issued by the relay for the member being released (revoked, removed or role changed). */
  | { kind: 'release' };

export type TransitionResult =
  | { ok: true; next: ThreadSnapshot; events: ThreadEvent[] }
  | { ok: false; error: ProtocolError };

export const DEFAULT_LOOP_LIMIT = 3;

/** The gate each gated message needs. */
const SEND_GATE: Partial<Record<MessageType, Gate>> = {
  inventory_and_plan: 'plan',
  contract: 'send',
};

/** Opens a thread with a `requirements` message. */
export function openThread(actor: Actor, loopLimit = DEFAULT_LOOP_LIMIT): TransitionResult {
  if (actor.role !== 'frontend') {
    return fail('WRONG_ROLE', 'Only a frontend member can send requirements.', null);
  }
  return {
    ok: true,
    next: {
      state: 'requested',
      frontendOwner: actor.member,
      backendOwner: null,
      round: 0,
      loopBase: 0,
      loopLimit,
      escalatedFrom: null,
    },
    events: [],
  };
}

/**
 * Opens a new thread for a contract change after `closed` was integrated.
 * The approval is the backend `send` gate, passed on the closed thread.
 */
export function openSupersedingThread(
  closed: ThreadSnapshot,
  actor: Actor,
  approval: ApprovalRef | undefined,
): TransitionResult {
  if (actor.role !== 'backend') {
    return fail('WRONG_ROLE', 'Only a backend member can send a contract change.', closed.state);
  }
  if (closed.state !== 'integrated') {
    return fail('WRONG_STATE', 'Only an integrated thread can be superseded; send the contract in the open thread instead.', closed.state);
  }
  const approvalError = checkApproval(closed, 'send', approval);
  if (approvalError) return approvalError;
  return {
    ok: true,
    next: {
      state: 'reviewing',
      frontendOwner: closed.frontendOwner,
      backendOwner: actor.member,
      round: 0,
      loopBase: 0,
      loopLimit: closed.loopLimit,
      escalatedFrom: null,
    },
    events: [{ kind: 'claimed', actor: actor.member }],
  };
}

/** The single rulebook for an existing thread. Pure: the caller persists `next` and `events`. */
export function transition(s: ThreadSnapshot, action: Action, actor: Actor): TransitionResult {
  switch (action.kind) {
    case 'claim':
      return claim(s, actor);
    case 'send':
      return send(s, action.type, action.approval, actor);
    case 'decide_gate':
      return decideGate(s, action.gate, action.decision, action.note, actor);
    case 'resume':
      return resume(s, action.to, actor);
    case 'hand_off':
      return handOff(s, action.to, actor);
    case 'release':
      return release(s, actor);
  }
}

function claim(s: ThreadSnapshot, actor: Actor): TransitionResult {
  if (isClosed(s.state)) return closedError(s);
  const owner = ownerOf(s, actor.role);
  if (owner !== null) {
    return fail('ALREADY_CLAIMED', `This thread is already owned by ${owner}.`, s.state);
  }
  const next = withOwner(s, actor.role, actor.member);
  if (s.state === 'requested' && actor.role === 'backend') next.state = 'planning';
  return ok(next, [{ kind: 'claimed', actor: actor.member }]);
}

function send(
  s: ThreadSnapshot,
  type: Exclude<MessageType, 'requirements'>,
  approval: ApprovalRef | undefined,
  actor: Actor,
): TransitionResult {
  if (isClosed(s.state)) return closedError(s);
  const senderRole = SENDER_ROLE[type];
  if (senderRole !== null && senderRole !== actor.role) {
    return fail('WRONG_ROLE', `Only a ${senderRole} member can send ${type}.`, s.state);
  }

  // Clarifications never change state, and an unclaimed side may still ask.
  if (type === 'question' || type === 'answer') {
    const owner = ownerOf(s, actor.role);
    if (owner !== null && owner !== actor.member) return notOwner(s, actor.role);
    return ok({ ...s }, []);
  }

  if (type === 'escalate') {
    if (s.state === 'escalated') return wrongState(s, type);
    if (!isOwner(s, actor)) return notOwner(s, actor.role);
    return ok({ ...s, state: 'escalated', escalatedFrom: s.state }, [
      { kind: 'escalated', actor: actor.member, data: { from: s.state } },
    ]);
  }

  const allowedFrom: Record<'inventory_and_plan' | 'contract' | 'gap_list' | 'satisfied' | 'integrated', readonly ThreadState[]> = {
    inventory_and_plan: ['planning'],
    // From `planning` is the "nothing is missing" shortcut.
    contract: ['planning', 'building'],
    gap_list: ['reviewing'],
    satisfied: ['reviewing'],
    integrated: ['integrating'],
  };
  if (!allowedFrom[type].includes(s.state)) return wrongState(s, type);
  if (!isOwner(s, actor)) return notOwner(s, actor.role);

  const gate = SEND_GATE[type];
  if (gate) {
    const approvalError = checkApproval(s, gate, approval);
    if (approvalError) return approvalError;
  }

  switch (type) {
    case 'inventory_and_plan':
      return ok({ ...s, state: 'building' }, []);
    case 'contract':
      return ok({ ...s, state: 'reviewing' }, []);
    case 'satisfied':
      return ok({ ...s, state: 'satisfied' }, []);
    case 'integrated':
      return ok({ ...s, state: 'integrated' }, []);
    case 'gap_list': {
      const round = s.round + 1;
      if (round - s.loopBase >= s.loopLimit) {
        // The gap list is still delivered; resuming sends the thread to where it was headed.
        return ok({ ...s, round, state: 'escalated', escalatedFrom: 'planning' }, [
          { kind: 'auto_escalated', actor: actor.member, data: { round } },
        ]);
      }
      return ok({ ...s, round, state: 'planning' }, []);
    }
  }
}

function decideGate(
  s: ThreadSnapshot,
  gate: Gate,
  decision: 'approved' | 'rejected',
  note: string | undefined,
  actor: Actor,
): TransitionResult {
  if (GATE_ROLE[gate] !== actor.role) {
    return fail('WRONG_ROLE', `The ${gate} gate belongs to the ${GATE_ROLE[gate]} developer.`, s.state);
  }
  // A send gate on an integrated thread approves a contract change (a superseding thread);
  // any backend member may do that, since the old owner may be gone.
  const superseding = gate === 'send' && s.state === 'integrated';
  const validIn: Record<Gate, readonly ThreadState[]> = {
    plan: ['planning'],
    send: ['planning', 'building'],
    integration: ['satisfied'],
  };
  if (!superseding) {
    if (isClosed(s.state)) return closedError(s);
    if (!validIn[gate].includes(s.state)) {
      return fail('WRONG_STATE', `The ${gate} gate cannot be decided while the thread is ${s.state}.`, s.state);
    }
    if (!isOwner(s, actor)) return notOwner(s, actor.role);
  }

  const data: Record<string, unknown> = { gate, round: s.round };
  if (note !== undefined) data.note = note;
  if (decision === 'rejected') {
    return ok({ ...s }, [{ kind: 'gate_rejected', actor: actor.member, data }]);
  }
  const next = { ...s };
  if (gate === 'integration') next.state = 'integrating';
  return ok(next, [{ kind: 'gate_approved', actor: actor.member, data }]);
}

function resume(s: ThreadSnapshot, to: ThreadState | undefined, actor: Actor): TransitionResult {
  if (s.state !== 'escalated') {
    return fail('WRONG_STATE', `Only an escalated thread can be resumed; this one is ${s.state}.`, s.state);
  }
  if (!isOwner(s, actor)) return notOwner(s, actor.role);
  const target = to ?? s.escalatedFrom ?? 'planning';
  if (target === 'escalated' || isClosed(target)) {
    return fail('INVALID_TARGET', `A thread cannot be resumed into ${target}.`, s.state);
  }
  // `requested` means unclaimed; every later state needs a backend owner.
  if ((target === 'requested') !== (s.backendOwner === null)) {
    return fail(
      'INVALID_TARGET',
      target === 'requested'
        ? 'The thread already has a backend owner, so it cannot return to requested.'
        : `The thread has no backend owner, so it cannot resume into ${target}.`,
      s.state,
    );
  }
  return ok({ ...s, state: target, escalatedFrom: null, loopBase: s.round }, [
    { kind: 'resumed', actor: actor.member, data: { to: target } },
  ]);
}

function handOff(s: ThreadSnapshot, to: string, actor: Actor): TransitionResult {
  if (isClosed(s.state)) return closedError(s);
  if (!isOwner(s, actor)) return notOwner(s, actor.role);
  if (to === actor.member) {
    return fail('INVALID_TARGET', 'You already own this thread.', s.state);
  }
  return ok(withOwner(s, actor.role, to), [{ kind: 'handed_off', actor: actor.member, data: { to } }]);
}

function release(s: ThreadSnapshot, actor: Actor): TransitionResult {
  if (isClosed(s.state)) return closedError(s);
  if (!isOwner(s, actor)) return notOwner(s, actor.role);
  return ok(withOwner(s, actor.role, null), [{ kind: 'released', actor: actor.member, data: { role: actor.role } }]);
}

function checkApproval(s: ThreadSnapshot, gate: Gate, approval: ApprovalRef | undefined): TransitionResult | null {
  if (!approval) {
    return fail('APPROVAL_REQUIRED', `This needs the ${gate} gate. Call request_approval first.`, s.state);
  }
  if (approval.gate !== gate || approval.round !== s.round) {
    return fail(
      'APPROVAL_REQUIRED',
      `That approval is for the ${approval.gate} gate in round ${approval.round}; this needs the ${gate} gate in round ${s.round}. Call request_approval.`,
      s.state,
    );
  }
  return null;
}

const ACTION_TOOL: Record<Exclude<MessageType, 'requirements'>, ToolName> = {
  inventory_and_plan: 'send_inventory_and_plan',
  contract: 'send_contract',
  gap_list: 'send_gap_list',
  satisfied: 'confirm_satisfied',
  integrated: 'mark_integrated',
  question: 'ask_question',
  answer: 'answer_question',
  escalate: 'escalate',
};

/**
 * The thread-changing tools this actor could call now, assuming any gate it needs gets approved.
 * The bridge appends this to tool results so agents stay on the protocol.
 */
export function allowedTools(s: ThreadSnapshot, actor: Actor): ToolName[] {
  const tools = new Set<ToolName>();
  if (transition(s, { kind: 'claim' }, actor).ok) tools.add('claim_thread');
  for (const [type, tool] of Object.entries(ACTION_TOOL) as [keyof typeof ACTION_TOOL, ToolName][]) {
    const gate = SEND_GATE[type];
    const approval = gate ? { gate, round: s.round } : undefined;
    const result = transition(s, { kind: 'send', type, ...(approval && { approval }) }, actor);
    if (!result.ok) continue;
    tools.add(tool);
    if (gate) tools.add('request_approval');
  }
  for (const gate of ['plan', 'send', 'integration'] as const) {
    if (transition(s, { kind: 'decide_gate', gate, decision: 'approved' }, actor).ok) tools.add('request_approval');
  }
  if (transition(s, { kind: 'hand_off', to: '\0' }, actor).ok) tools.add('hand_off_thread');
  return [...tools];
}

function ownerOf(s: ThreadSnapshot, role: Role): string | null {
  return role === 'frontend' ? s.frontendOwner : s.backendOwner;
}

function isOwner(s: ThreadSnapshot, actor: Actor): boolean {
  return ownerOf(s, actor.role) === actor.member;
}

function withOwner(s: ThreadSnapshot, role: Role, member: string | null): ThreadSnapshot {
  return role === 'frontend' ? { ...s, frontendOwner: member } : { ...s, backendOwner: member };
}

function ok(next: ThreadSnapshot, events: ThreadEvent[]): TransitionResult {
  return { ok: true, next, events };
}

function fail(code: ErrorCode, message: string, state: ThreadState | null): TransitionResult & { ok: false } {
  return { ok: false, error: { code, message, state } };
}

function wrongState(s: ThreadSnapshot, type: MessageType): TransitionResult {
  return fail('WRONG_STATE', `${type} cannot be sent while the thread is ${s.state}.`, s.state);
}

function notOwner(s: ThreadSnapshot, role: Role): TransitionResult {
  const owner = ownerOf(s, role);
  return fail(
    'NOT_OWNER',
    owner ? `Only the ${role} owner (${owner}) can act on this thread.` : `No ${role} member owns this thread; claim it first.`,
    s.state,
  );
}

function closedError(s: ThreadSnapshot): TransitionResult {
  return fail('THREAD_CLOSED', 'This thread is integrated and closed. Contract changes open a new thread.', s.state);
}
