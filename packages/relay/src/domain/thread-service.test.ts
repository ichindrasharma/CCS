import type { Envelope, Gate, MessageType } from '@tool/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Member, type Store } from '../db/index.js';
import { ThreadService, type Change, type Result } from './thread-service.js';

let store: Store;
let service: ThreadService;
let asha: Member; // frontend
let ravi: Member; // backend
let mei: Member; // backend
let projectId: string;

beforeEach(() => {
  let tick = 0;
  store = openStore({ path: ':memory:', now: () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)).toISOString() });
  service = new ThreadService(store);
  projectId = store.projects.create({ name: 'shop-app', loopLimit: 2 }).id;
  asha = store.members.create({ projectId, name: 'asha', role: 'frontend', tokenHash: 'h1' });
  ravi = store.members.create({ projectId, name: 'ravi', role: 'backend', tokenHash: 'h2' });
  mei = store.members.create({ projectId, name: 'mei', role: 'backend', tokenHash: 'h3' });
});

afterEach(() => store.db.close());

function envelope(type: MessageType, thread: string, extra: Partial<Envelope['header']> = {}): Envelope {
  return {
    header: {
      id: 'ignored',
      project: projectId,
      thread,
      type,
      // The relay must overwrite this.
      from: { member: 'someone-else', role: 'backend' },
      to: { role: type === 'requirements' ? 'backend' : 'frontend' },
      in_reply_to: null,
      approval_id: null,
      supersedes: null,
      created_at: '2000-01-01T00:00:00Z',
      ...extra,
    },
    payload: { body: type },
  };
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

/** Opens and approves a gate the way the bridge and CLI will. */
function approve(member: Member, threadId: string, gate: Gate): string {
  const approval = value(service.openApproval(member, { threadId, gate, planHash: 'plan', codeHash: 'code' }));
  value(service.decideApproval(member, approval.id, { codeHash: 'code', decision: 'approved' }));
  return approval.id;
}

function open(): string {
  return value(service.submitMessage(asha, envelope('requirements', ''), { title: 'Orders list' })).thread.id;
}

function stateOf(threadId: string) {
  return store.threads.get(threadId)!.snapshot.state;
}

function trail(threadId: string) {
  return store.log.listThread(threadId).map((e) => `${e.kind === 'message' ? 'msg' : 'evt'}:${e.type}`);
}

describe('main flow (spec Flow 3)', () => {
  it('runs from requirements to integrated and keeps the full decision trail', () => {
    const thread = open();
    expect(stateOf(thread)).toBe('requested');

    value(service.claim(ravi, thread));
    const plan = approve(ravi, thread, 'plan');
    value(service.submitMessage(ravi, envelope('inventory_and_plan', thread, { approval_id: plan })));
    expect(stateOf(thread)).toBe('building');

    const send = approve(ravi, thread, 'send');
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: send })));
    expect(stateOf(thread)).toBe('reviewing');

    value(service.submitMessage(asha, envelope('satisfied', thread)));
    approve(asha, thread, 'integration');
    expect(stateOf(thread)).toBe('integrating');

    value(service.submitMessage(asha, envelope('integrated', thread, { to: { project: true } })));
    expect(stateOf(thread)).toBe('integrated');

    expect(trail(thread)).toEqual([
      'msg:requirements',
      'evt:claimed',
      'evt:gate_approved',
      'msg:inventory_and_plan',
      'evt:gate_approved',
      'msg:contract',
      'msg:satisfied',
      'evt:gate_approved',
      'msg:integrated',
    ]);
  });

  it('the relay sets id, sender and time; the bridge cannot', () => {
    const change = value(service.submitMessage(asha, envelope('requirements', ''), { title: 'Orders list' }));
    const message = change.entries[0]!;
    expect(message.kind).toBe('message');
    if (message.kind !== 'message') return;
    expect(message.header.from).toEqual({ member: asha.id, role: 'frontend' });
    expect(message.header.id).toMatch(/^msg_/);
    expect(message.header.id).not.toBe('ignored');
    expect(message.header.thread).toBe(change.thread.id);
    expect(message.header.created_at).not.toBe('2000-01-01T00:00:00Z');
    expect(change.thread.title).toBe('Orders list');
  });

  it('nothing missing: a contract goes straight from planning to reviewing', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const send = approve(ravi, thread, 'send');
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: send })));
    expect(stateOf(thread)).toBe('reviewing');
  });
});

describe('approvals', () => {
  it('a gated message without an approval is refused and nothing is logged', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const before = trail(thread);
    expect(errorCode(service.submitMessage(ravi, envelope('inventory_and_plan', thread)))).toBe('APPROVAL_REQUIRED');
    expect(trail(thread)).toEqual(before);
  });

  it('an approval for the wrong gate is refused and stays unused', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const send = approve(ravi, thread, 'send');
    expect(errorCode(service.submitMessage(ravi, envelope('inventory_and_plan', thread, { approval_id: send })))).toBe('APPROVAL_REQUIRED');
    // Rolled back, so it still works for the message it was meant for.
    expect(store.approvals.get(send)?.status).toBe('approved');
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: send })));
  });

  it('an approval works only once', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const plan = approve(ravi, thread, 'plan');
    value(service.submitMessage(ravi, envelope('inventory_and_plan', thread, { approval_id: plan })));
    // Back in planning after a gap list, the old approval is spent.
    const send = approve(ravi, thread, 'send');
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: send })));
    value(service.submitMessage(asha, envelope('gap_list', thread)));
    expect(errorCode(service.submitMessage(ravi, envelope('inventory_and_plan', thread, { approval_id: plan })))).toBe('APPROVAL_REQUIRED');
  });

  it('an approval left over from an earlier round cannot be decided', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    // Requested in round 0 but never decided.
    const stale = value(service.openApproval(ravi, { threadId: thread, gate: 'plan', planHash: 'p', codeHash: 'c' }));
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: approve(ravi, thread, 'send') })));
    value(service.submitMessage(asha, envelope('gap_list', thread)));
    // Back in planning, where a plan gate is valid, but now in round 1.
    expect(stateOf(thread)).toBe('planning');
    expect(errorCode(service.decideApproval(ravi, stale.id, { codeHash: 'c', decision: 'approved' }))).toBe('APPROVAL_REQUIRED');
    expect(store.approvals.get(stale.id)?.status).toBe('pending');
  });

  it('cannot open an approval for a gate that is not reachable', () => {
    const thread = open();
    expect(errorCode(service.openApproval(asha, { threadId: thread, gate: 'plan', planHash: 'p', codeHash: 'c' }))).toBe('WRONG_ROLE');
    value(service.claim(ravi, thread));
    expect(errorCode(service.openApproval(asha, { threadId: thread, gate: 'integration', planHash: 'p', codeHash: 'c' }))).toBe('WRONG_STATE');
    expect(errorCode(service.openApproval(mei, { threadId: thread, gate: 'plan', planHash: 'p', codeHash: 'c' }))).toBe('NOT_OWNER');
  });

  it('a wrong code decides nothing, and only the requester can decide', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const approval = value(service.openApproval(ravi, { threadId: thread, gate: 'plan', planHash: 'p', codeHash: 'code' }));
    expect(errorCode(service.decideApproval(ravi, approval.id, { codeHash: 'guess', decision: 'approved' }))).toBe('INVALID_REQUEST');
    expect(errorCode(service.decideApproval(mei, approval.id, { codeHash: 'code', decision: 'approved' }))).toBe('NOT_FOUND');
    expect(store.approvals.get(approval.id)?.status).toBe('pending');
  });

  it('a rejection records the note and keeps the state', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const approval = value(service.openApproval(ravi, { threadId: thread, gate: 'plan', planHash: 'p', codeHash: 'code' }));
    const change = value(service.decideApproval(ravi, approval.id, { codeHash: 'code', decision: 'rejected', note: 'reuse /orders' }));
    expect(change.thread.snapshot.state).toBe('planning');
    expect(change.entries[0]).toMatchObject({ type: 'gate_rejected', data: { gate: 'plan', note: 'reuse /orders', approval_id: approval.id } });
  });

  it('the integration approval is used up when it moves the thread', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: approve(ravi, thread, 'send') })));
    value(service.submitMessage(asha, envelope('satisfied', thread)));
    const id = approve(asha, thread, 'integration');
    expect(store.approvals.get(id)?.status).toBe('consumed');
  });
});

describe('loop limit and escalation', () => {
  function toReviewing(thread: string) {
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: approve(ravi, thread, 'send') })));
  }

  it('auto-escalates at the project loop limit, then resumes with fresh rounds', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    toReviewing(thread);
    value(service.submitMessage(asha, envelope('gap_list', thread)));
    toReviewing(thread);
    const last = value(service.submitMessage(asha, envelope('gap_list', thread)));
    expect(last.thread.snapshot.state).toBe('escalated');
    expect(last.entries.map((e) => e.type)).toEqual(['gap_list', 'auto_escalated']);

    value(service.resume(ravi, thread));
    expect(stateOf(thread)).toBe('planning');
    toReviewing(thread);
    value(service.submitMessage(asha, envelope('gap_list', thread)));
    expect(stateOf(thread)).toBe('planning');
  });

  it('resume can choose a different state', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    toReviewing(thread);
    value(service.submitMessage(asha, envelope('escalate', thread)));
    value(service.resume(asha, thread, 'planning'));
    expect(stateOf(thread)).toBe('planning');
  });
});

describe('ownership', () => {
  it('first claim wins', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    const second = service.claim(mei, thread);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatchObject({ code: 'ALREADY_CLAIMED', state: 'planning' });
  });

  it('hand-off only to an active member with the same role', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    expect(errorCode(service.handOff(ravi, thread, asha.id))).toBe('INVALID_TARGET');
    expect(errorCode(service.handOff(ravi, thread, 'mem_nobody'))).toBe('INVALID_TARGET');
    value(service.handOff(ravi, thread, mei.id));
    expect(store.threads.get(thread)!.snapshot.backendOwner).toBe(mei.id);
  });

  it('revoking a member releases their open threads so a teammate can claim them', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    value(service.submitMessage(ravi, envelope('inventory_and_plan', thread, { approval_id: approve(ravi, thread, 'plan') })));
    const changes = value(service.revokeMember(ravi.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.thread.snapshot).toMatchObject({ state: 'building', backendOwner: null });
    expect(store.members.get(ravi.id)?.revokedAt).not.toBeNull();
    value(service.claim(mei, thread));
    expect(store.threads.get(thread)!.snapshot).toMatchObject({ state: 'building', backendOwner: mei.id });
  });

  it('changing role releases threads owned under the old role', () => {
    const thread = open();
    value(service.claim(ravi, thread));
    value(service.changeRole(ravi.id, 'frontend'));
    expect(store.threads.get(thread)!.snapshot.backendOwner).toBeNull();
    expect(store.members.get(ravi.id)?.role).toBe('frontend');
  });
});

describe('addressing and isolation', () => {
  it('requirements can be addressed to one backend member', () => {
    const change = value(service.submitMessage(asha, envelope('requirements', '', { to: { member: mei.id } })));
    expect(change.thread.addressedTo).toBe(mei.id);
    expect(errorCode(service.submitMessage(asha, envelope('requirements', '', { to: { member: asha.id } })))).toBe('INVALID_TARGET');
  });

  it("another project's threads look like they do not exist", () => {
    const thread = open();
    const otherProject = store.projects.create({ name: 'other' }).id;
    const outsider = store.members.create({ projectId: otherProject, name: 'eve', role: 'backend', tokenHash: 'h9' });
    expect(errorCode(service.claim(outsider, thread))).toBe('NOT_FOUND');
    expect(errorCode(service.submitMessage(outsider, envelope('question', thread)))).toBe('NOT_FOUND');
  });
});

describe('contract change after integration (supersedes)', () => {
  function integrated(): string {
    const thread = open();
    value(service.claim(ravi, thread));
    value(service.submitMessage(ravi, envelope('contract', thread, { approval_id: approve(ravi, thread, 'send') })));
    value(service.submitMessage(asha, envelope('satisfied', thread)));
    approve(asha, thread, 'integration');
    value(service.submitMessage(asha, envelope('integrated', thread)));
    return thread;
  }

  it('opens a new thread in reviewing, linked to the closed one', () => {
    const closed = integrated();
    const send = approve(mei, closed, 'send');
    const change: Change = value(service.submitMessage(mei, envelope('contract', '', { supersedes: closed, approval_id: send })));
    expect(change.thread).toMatchObject({ supersedes: closed, title: 'Orders list' });
    expect(change.thread.snapshot).toMatchObject({ state: 'reviewing', frontendOwner: asha.id, backendOwner: mei.id });
    expect(change.entries.map((e) => e.type)).toEqual(['contract', 'claimed']);
    expect(stateOf(closed)).toBe('integrated');
  });

  it('needs the send gate', () => {
    const closed = integrated();
    expect(errorCode(service.submitMessage(mei, envelope('contract', '', { supersedes: closed })))).toBe('APPROVAL_REQUIRED');
    expect(store.threads.list(projectId)).toHaveLength(1);
  });
});
