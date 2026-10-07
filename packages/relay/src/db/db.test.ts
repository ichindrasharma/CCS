import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openThread, transition, type Header } from '@tool/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations.js';
import { openStore, type Store } from './index.js';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, clock++)).toISOString();

let store: Store;

beforeEach(() => {
  clock = 0;
  store = openStore({ path: ':memory:', now });
});

afterEach(() => store.db.close());

function seed() {
  const project = store.projects.create({ name: 'shop-app' });
  const asha = store.members.create({ projectId: project.id, name: 'asha', role: 'frontend', tokenHash: 'h-asha' });
  const ravi = store.members.create({ projectId: project.id, name: 'ravi', role: 'backend', tokenHash: 'h-ravi' });
  const opened = openThread({ member: asha.id, role: 'frontend' });
  if (!opened.ok) throw new Error('openThread failed');
  const thread = store.threads.create({ projectId: project.id, title: 'Orders list', snapshot: opened.next });
  return { project, asha, ravi, thread };
}

function header(over: Partial<Header> & Pick<Header, 'project' | 'thread' | 'from'>): Header {
  return {
    id: `msg_${clock}`,
    type: 'requirements',
    to: { role: 'backend' },
    in_reply_to: null,
    approval_id: null,
    supersedes: null,
    created_at: now(),
    ...over,
  };
}

describe('migrations', () => {
  it('records the schema version', () => {
    expect(store.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
  });

  it('reopening a file database does not re-run migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-db-'));
    try {
      const path = join(dir, 'relay.db');
      const first = openStore({ path });
      first.projects.create({ name: 'kept' });
      first.db.close();
      const second = openStore({ path });
      expect(second.db.all('SELECT * FROM projects')).toHaveLength(1);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transaction', () => {
  it('rolls back everything when the callback throws', () => {
    expect(() =>
      store.db.transaction(() => {
        store.projects.create({ name: 'doomed' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.db.all('SELECT * FROM projects')).toHaveLength(0);
  });

  it('nested failures roll back only the inner part', () => {
    store.db.transaction(() => {
      store.projects.create({ name: 'outer' });
      expect(() =>
        store.db.transaction(() => {
          store.projects.create({ name: 'inner' });
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(store.db.all<{ name: string }>('SELECT name FROM projects').map((r) => r.name)).toEqual(['outer']);
  });
});

describe('members and invites', () => {
  it('finds active members by token hash and stops after revoke', () => {
    const { asha } = seed();
    expect(store.members.findActiveByTokenHash('h-asha')?.id).toBe(asha.id);
    expect(store.members.revoke(asha.id)).toBe(true);
    expect(store.members.revoke(asha.id)).toBe(false);
    expect(store.members.findActiveByTokenHash('h-asha')).toBeUndefined();
    expect(store.members.list(asha.projectId).map((m) => m.name)).toEqual(['ravi']);
    expect(store.members.list(asha.projectId, { includeRevoked: true })).toHaveLength(2);
  });

  it('rejects a duplicate name in one project', () => {
    const { project } = seed();
    expect(() => store.members.create({ projectId: project.id, name: 'asha', role: 'backend', tokenHash: 'other' })).toThrow();
  });

  it('invites run out and expire', () => {
    const { project, asha } = seed();
    store.invites.create({ codeHash: 'c1', projectId: project.id, createdBy: asha.id, uses: 1, expiresAt: '2099-01-01T00:00:00Z' });
    store.invites.create({ codeHash: 'c2', projectId: project.id, createdBy: asha.id, uses: 5, expiresAt: '2000-01-01T00:00:00Z' });
    expect(store.invites.redeem('c1')).toBe(project.id);
    expect(store.invites.redeem('c1')).toBeUndefined();
    expect(store.invites.redeem('c2')).toBeUndefined();
    expect(store.invites.redeem('unknown')).toBeUndefined();
  });
});

describe('threads', () => {
  it('round-trips a snapshot from the state machine', () => {
    const { ravi, thread } = seed();
    const claimed = transition(thread.snapshot, { kind: 'claim' }, { member: ravi.id, role: 'backend' });
    if (!claimed.ok) throw new Error(claimed.error.message);
    store.threads.saveSnapshot(thread.id, claimed.next);
    const loaded = store.threads.get(thread.id)!;
    expect(loaded.snapshot).toEqual(claimed.next);
    expect(loaded.updatedAt > loaded.createdAt).toBe(true);
  });

  it('lists open threads a member owns', () => {
    const { asha, ravi, thread } = seed();
    store.threads.saveSnapshot(thread.id, { ...thread.snapshot, state: 'planning', backendOwner: ravi.id });
    expect(store.threads.listOpenOwnedBy(ravi.id).map((t) => t.id)).toEqual([thread.id]);
    store.threads.saveSnapshot(thread.id, { ...thread.snapshot, state: 'integrated', backendOwner: ravi.id });
    expect(store.threads.listOpenOwnedBy(asha.id)).toEqual([]);
  });

  it('the schema rejects an unknown state', () => {
    const { thread } = seed();
    expect(() => store.threads.saveSnapshot(thread.id, { ...thread.snapshot, state: 'bogus' as never })).toThrow();
  });
});

describe('log', () => {
  it('assigns gap-free project-wide sequence numbers across messages and events', () => {
    const { project, asha, ravi, thread } = seed();
    const msg = store.log.appendMessage({
      projectId: project.id,
      threadId: thread.id,
      header: header({ project: project.id, thread: thread.id, from: { member: asha.id, role: 'frontend' } }),
      payload: { body: 'Orders list', contract: {} },
    });
    const evt = store.log.appendEvent({ projectId: project.id, threadId: thread.id, type: 'claimed', actor: ravi.id });
    expect([msg.seq, evt.seq]).toEqual([1, 2]);

    const history = store.log.listThread(thread.id);
    expect(history.map((e) => `${e.kind}:${e.type}`)).toEqual(['message:requirements', 'event:claimed']);
    expect(history[0]).toMatchObject({ kind: 'message', payload: { body: 'Orders list' } });
    expect(store.log.listProject(project.id, { afterSeq: 1 }).map((e) => e.seq)).toEqual([2]);
  });

  it('stores a ciphertext payload as-is', () => {
    const { project, asha, thread } = seed();
    store.log.appendMessage({
      projectId: project.id,
      threadId: thread.id,
      header: header({ project: project.id, thread: thread.id, from: { member: asha.id, role: 'frontend' } }),
      payload: 'base64-ciphertext',
    });
    expect(store.log.listThread(thread.id)[0]).toMatchObject({ payload: 'base64-ciphertext' });
  });

  it('a failed append does not burn a sequence number', () => {
    const { project, asha, thread } = seed();
    expect(() =>
      store.log.appendMessage({
        projectId: project.id,
        threadId: 'thr_missing',
        header: header({ project: project.id, thread: 'thr_missing', from: { member: asha.id, role: 'frontend' } }),
        payload: {},
      }),
    ).toThrow();
    const evt = store.log.appendEvent({ projectId: project.id, threadId: thread.id, type: 'claimed', actor: asha.id });
    expect(evt.seq).toBe(1);
  });

  it('the schema rejects an event kind that does not exist', () => {
    const { project, asha, thread } = seed();
    expect(() => store.log.appendEvent({ projectId: project.id, threadId: thread.id, type: 'bogus' as never, actor: asha.id })).toThrow();
  });
});

describe('approvals', () => {
  function openPlan() {
    const { ravi, thread } = seed();
    const approval = store.approvals.open({ threadId: thread.id, gate: 'plan', round: 0, memberId: ravi.id, planHash: 'p', codeHash: 'code' });
    return { ravi, thread, approval };
  }

  it('pending → approved → consumed exactly once', () => {
    const { thread, approval } = openPlan();
    expect(store.approvals.consume(approval.id, thread.id)).toBeUndefined();
    expect(store.approvals.decide(approval.id, { codeHash: 'code', decision: 'approved' })?.status).toBe('approved');
    expect(store.approvals.consume(approval.id, thread.id)).toEqual({ gate: 'plan', round: 0 });
    expect(store.approvals.consume(approval.id, thread.id)).toBeUndefined();
    expect(store.approvals.get(approval.id)?.status).toBe('consumed');
  });

  it('a wrong code does not decide anything', () => {
    const { approval } = openPlan();
    expect(store.approvals.decide(approval.id, { codeHash: 'guess', decision: 'approved' })).toBeUndefined();
    expect(store.approvals.get(approval.id)?.status).toBe('pending');
  });

  it('a decision cannot be changed', () => {
    const { approval } = openPlan();
    store.approvals.decide(approval.id, { codeHash: 'code', decision: 'rejected', note: 'split it' });
    expect(store.approvals.decide(approval.id, { codeHash: 'code', decision: 'approved' })).toBeUndefined();
    expect(store.approvals.get(approval.id)).toMatchObject({ status: 'rejected', note: 'split it' });
  });

  it('an approval cannot be used on another thread', () => {
    const { approval, ravi } = openPlan();
    store.approvals.decide(approval.id, { codeHash: 'code', decision: 'approved' });
    const other = store.threads.create({
      projectId: store.threads.get(approval.threadId)!.projectId,
      title: 'Other',
      snapshot: { ...store.threads.get(approval.threadId)!.snapshot, backendOwner: ravi.id },
    });
    expect(store.approvals.consume(approval.id, other.id)).toBeUndefined();
  });

  it('consumption rolls back with a failed transition', () => {
    const { thread, approval } = openPlan();
    store.approvals.decide(approval.id, { codeHash: 'code', decision: 'approved' });
    expect(() =>
      store.db.transaction(() => {
        store.approvals.consume(approval.id, thread.id);
        throw new Error('transition rejected');
      }),
    ).toThrow();
    expect(store.approvals.get(approval.id)?.status).toBe('approved');
  });
});

describe('cursors', () => {
  it('only move forward', () => {
    const { asha } = seed();
    expect(store.cursors.get(asha.id)).toBe(0);
    store.cursors.ack(asha.id, 5);
    store.cursors.ack(asha.id, 3);
    expect(store.cursors.get(asha.id)).toBe(5);
  });
});
