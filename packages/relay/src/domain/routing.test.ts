import type { LogEntry, MemberView, ThreadView } from '@tool/protocol';
import { describe, expect, it } from 'vitest';
import { isRecipient } from './routing.js';

const member = (id: string, role: 'frontend' | 'backend', revokedAt: string | null = null): MemberView => ({
  id,
  projectId: 'prj',
  name: id,
  role,
  createdAt: '',
  revokedAt,
});

const asha = member('asha', 'frontend');
const lee = member('lee', 'frontend');
const ravi = member('ravi', 'backend');
const mei = member('mei', 'backend');

function thread(over: Partial<ThreadView['snapshot']> = {}, addressedTo: string | null = null): ThreadView {
  return {
    id: 'thr',
    projectId: 'prj',
    title: 't',
    addressedTo,
    supersedes: null,
    createdAt: '',
    updatedAt: '',
    snapshot: { state: 'planning', frontendOwner: 'asha', backendOwner: 'ravi', round: 0, loopBase: 0, loopLimit: 3, escalatedFrom: null, ...over },
  };
}

function message(type: 'requirements' | 'question' | 'integrated', actor: string): LogEntry {
  return {
    kind: 'message',
    type,
    projectId: 'prj',
    seq: 1,
    id: 'msg',
    threadId: 'thr',
    actor,
    createdAt: '',
    header: {} as never,
    payload: {},
    signature: null,
  };
}

const recipients = (entry: LogEntry, t: ThreadView) =>
  [asha, lee, ravi, mei].filter((m) => isRecipient(m, entry, t)).map((m) => m.id);

describe('isRecipient', () => {
  it('requirements go to every backend member, or only the addressee', () => {
    const open = thread({ state: 'requested', backendOwner: null });
    expect(recipients(message('requirements', 'asha'), open)).toEqual(['asha', 'ravi', 'mei']);
    expect(recipients(message('requirements', 'asha'), thread({ state: 'requested', backendOwner: null }, 'mei'))).toEqual(['asha', 'mei']);
  });

  it('owners only, once both sides are owned', () => {
    expect(recipients(message('question', 'ravi'), thread())).toEqual(['asha', 'ravi']);
  });

  it('an unowned side is reached through its role, or its addressee', () => {
    expect(recipients(message('question', 'asha'), thread({ backendOwner: null }))).toEqual(['asha', 'ravi', 'mei']);
    expect(recipients(message('question', 'asha'), thread({ backendOwner: null }, 'mei'))).toEqual(['asha', 'mei']);
    expect(recipients(message('question', 'ravi'), thread({ frontendOwner: null }))).toEqual(['asha', 'lee', 'ravi']);
  });

  it('integrated goes to the whole project', () => {
    expect(recipients(message('integrated', 'asha'), thread({ state: 'integrated' }))).toEqual(['asha', 'lee', 'ravi', 'mei']);
  });

  it('revoked members and other projects get nothing', () => {
    expect(isRecipient(member('ravi', 'backend', '2026-01-01'), message('question', 'asha'), thread())).toBe(false);
    expect(isRecipient({ ...asha, projectId: 'other' }, message('integrated', 'ravi'), thread())).toBe(false);
  });
});
