import {
  newId,
  openSupersedingThread,
  openThread,
  transition,
  type Action,
  type Actor,
  type ApprovalRef,
  type Envelope,
  type Gate,
  type ProtocolError,
  type ThreadEvent,
  type ThreadState,
  type TransitionResult,
} from '@tool/protocol';
import type { Approval, LogEntry, Member, Store, Thread } from '../db/index.js';

export type ServiceError = ProtocolError | { code: 'NOT_FOUND' | 'INVALID_REQUEST'; message: string; state: null };

export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

/** What changed: the thread after the change and the log entries to deliver. */
export interface Change {
  thread: Thread;
  entries: LogEntry[];
}

/** Thrown inside a transaction to roll it back and return the error to the caller. */
class Rejection extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}

/**
 * Applies the protocol state machine to stored threads. Every method loads, checks, writes
 * the snapshot and appends the log entries in one transaction, so a rejected change leaves
 * nothing behind, including a consumed approval.
 *
 * `actor` is always the authenticated member; nothing the bridge sends about identity is trusted.
 */
export class ThreadService {
  constructor(private readonly store: Store) {}

  /**
   * Appends a message from a bridge. The relay assigns the message id, timestamp and `from`;
   * a `requirements` message, or a `contract` with `supersedes`, opens a new thread.
   * `title` names a new thread; it is stored in plain text even when payloads are encrypted.
   */
  submitMessage(actor: Member, envelope: Envelope, options: { title?: string } = {}): Result<Change> {
    return this.run(() => {
      const header = {
        ...envelope.header,
        id: newId('message'),
        from: { member: actor.id, role: actor.role },
        created_at: this.store.db.now(),
      };
      if (header.project !== actor.projectId) reject('NOT_FOUND', 'Unknown project.');

      if (header.type === 'requirements') {
        if (header.supersedes) reject('INVALID_REQUEST', 'Requirements cannot supersede a thread; only a contract can.');
        const addressedTo = this.addressee(actor, header.to);
        const { thread } = this.createThread(actor, openThread(asActor(actor), this.loopLimit(actor.projectId)), {
          title: options.title ?? 'Untitled feature',
          addressedTo,
        });
        header.thread = thread.id;
        return this.finish(thread, [this.store.log.appendMessage({ projectId: thread.projectId, threadId: thread.id, header, payload: envelope.payload })]);
      }

      if (header.type === 'contract' && header.supersedes) {
        const closed = this.thread(actor, header.supersedes);
        const approval = this.consume(header.approval_id, closed.id);
        const { thread, events } = this.createThread(actor, openSupersedingThread(closed.snapshot, asActor(actor), approval), {
          title: options.title ?? closed.title,
          supersedes: closed.id,
        });
        header.thread = thread.id;
        const message = this.store.log.appendMessage({ projectId: thread.projectId, threadId: thread.id, header, payload: envelope.payload });
        return this.finish(thread, [message, ...this.recordEvents(thread, events)]);
      }

      const thread = this.thread(actor, header.thread);
      const approval = header.type === 'inventory_and_plan' || header.type === 'contract' ? this.consume(header.approval_id, thread.id) : undefined;
      const events = this.apply(thread, { kind: 'send', type: header.type, ...(approval && { approval }) }, asActor(actor));
      const message = this.store.log.appendMessage({ projectId: thread.projectId, threadId: thread.id, header, payload: envelope.payload });
      return this.finish(thread, [message, ...this.recordEvents(thread, events)]);
    });
  }

  claim(actor: Member, threadId: string): Result<Change> {
    return this.act(actor, threadId, { kind: 'claim' });
  }

  handOff(actor: Member, threadId: string, toMemberId: string): Result<Change> {
    return this.run(() => {
      const target = this.store.members.get(toMemberId);
      if (!target || target.revokedAt || target.projectId !== actor.projectId || target.role !== actor.role) {
        reject('INVALID_TARGET', `A thread can only be handed to an active ${actor.role} member of this project.`);
      }
      return this.actInTransaction(actor, threadId, { kind: 'hand_off', to: target.id });
    });
  }

  /** A developer action from the CLI, never an agent tool. */
  resume(actor: Member, threadId: string, to?: ThreadState): Result<Change> {
    return this.act(actor, threadId, { kind: 'resume', ...(to && { to }) });
  }

  /**
   * Opens a pending approval for a gate. Fails now, rather than at decision time, if the gate
   * cannot be decided in the thread's current state or by this member.
   * The caller generates the one-time code and passes only its hash.
   */
  openApproval(actor: Member, input: { threadId: string; gate: Gate; planHash: string; codeHash: string }): Result<Approval> {
    return this.run(() => {
      const thread = this.thread(actor, input.threadId);
      const check = transition(thread.snapshot, { kind: 'decide_gate', gate: input.gate, decision: 'approved' }, asActor(actor));
      if (!check.ok) throw new Rejection(check.error);
      return this.store.approvals.open({
        threadId: thread.id,
        gate: input.gate,
        round: thread.snapshot.round,
        memberId: actor.id,
        planHash: input.planHash,
        codeHash: input.codeHash,
      });
    });
  }

  /**
   * Records the developer's decision and its event. Approving the integration gate also moves the
   * thread to `integrating`; that approval is used up immediately, since no message carries it.
   */
  decideApproval(
    actor: Member,
    approvalId: string,
    input: { codeHash: string; decision: 'approved' | 'rejected'; note?: string },
  ): Result<Change & { approval: Approval }> {
    return this.run(() => {
      const pending = this.store.approvals.get(approvalId);
      if (!pending || pending.memberId !== actor.id) reject('NOT_FOUND', 'Unknown approval.');
      const thread = this.thread(actor, pending.threadId);
      if (thread.snapshot.round !== pending.round) {
        reject('APPROVAL_REQUIRED', 'The thread has moved to a new round since this approval was requested. Request a new one.', thread.snapshot.state);
      }
      const approval = this.store.approvals.decide(approvalId, input);
      if (!approval) reject('INVALID_REQUEST', 'This approval was already decided, or the code is wrong.');

      const events = this.apply(
        thread,
        { kind: 'decide_gate', gate: approval.gate, decision: input.decision, ...(input.note !== undefined && { note: input.note }) },
        asActor(actor),
      ).map((e) => ({ ...e, data: { ...e.data, approval_id: approval.id } }));
      if (input.decision === 'approved' && approval.gate === 'integration') {
        this.store.approvals.consume(approval.id, thread.id);
      }
      const change = this.finish(thread, this.recordEvents(thread, events));
      return { ...change, approval: this.store.approvals.get(approval.id)! };
    });
  }

  /** Revokes a member and releases every open thread they own, atomically. */
  revokeMember(memberId: string): Result<Change[]> {
    return this.run(() => {
      const member = this.store.members.get(memberId);
      if (!member || !this.store.members.revoke(memberId)) reject('NOT_FOUND', 'Unknown or already revoked member.');
      return this.releaseAll(member);
    });
  }

  /** Changes a member's role and releases the threads they owned under the old one. */
  changeRole(memberId: string, role: Member['role']): Result<Change[]> {
    return this.run(() => {
      const member = this.store.members.get(memberId);
      if (!member || member.revokedAt) reject('NOT_FOUND', 'Unknown member.');
      if (member.role === role) return [];
      this.store.members.setRole(memberId, role);
      return this.releaseAll(member);
    });
  }

  // --- internals -------------------------------------------------------------

  private act(actor: Member, threadId: string, action: Action): Result<Change> {
    return this.run(() => this.actInTransaction(actor, threadId, action));
  }

  private actInTransaction(actor: Member, threadId: string, action: Action): Change {
    const thread = this.thread(actor, threadId);
    const events = this.apply(thread, action, asActor(actor));
    return this.finish(thread, this.recordEvents(thread, events));
  }

  private releaseAll(member: Member): Change[] {
    return this.store.threads.listOpenOwnedBy(member.id).map((thread) => {
      const role = thread.snapshot.frontendOwner === member.id ? 'frontend' : 'backend';
      const events = this.apply(thread, { kind: 'release' }, { member: member.id, role });
      return this.finish(thread, this.recordEvents(thread, events));
    });
  }

  /** Runs the state machine and saves the next snapshot onto `thread`. */
  private apply(thread: Thread, action: Action, actor: Actor): ThreadEvent[] {
    const result = transition(thread.snapshot, action, actor);
    if (!result.ok) throw new Rejection(result.error);
    this.store.threads.saveSnapshot(thread.id, result.next);
    thread.snapshot = result.next;
    return result.events;
  }

  private createThread(
    actor: Member,
    opened: TransitionResult,
    meta: { title: string; addressedTo?: string | null; supersedes?: string },
  ): { thread: Thread; events: ThreadEvent[] } {
    if (!opened.ok) throw new Rejection(opened.error);
    const thread = this.store.threads.create({ projectId: actor.projectId, snapshot: opened.next, ...meta });
    return { thread, events: opened.events };
  }

  private recordEvents(thread: Thread, events: ThreadEvent[]): LogEntry[] {
    return events.map((e) =>
      this.store.log.appendEvent({ projectId: thread.projectId, threadId: thread.id, type: e.kind, actor: e.actor, data: e.data ?? null }),
    );
  }

  private finish(thread: Thread, entries: LogEntry[]): Change {
    return { thread: this.store.threads.get(thread.id)!, entries };
  }

  /** Loads a thread in the actor's project; other projects' threads look like they do not exist. */
  private thread(actor: Member, threadId: string): Thread {
    const thread = this.store.threads.get(threadId);
    if (!thread || thread.projectId !== actor.projectId) reject('NOT_FOUND', `Unknown thread ${threadId}.`);
    return thread;
  }

  /** Uses up an approval for this thread. An invalid id yields no approval; the state machine then refuses. */
  private consume(approvalId: string | null, threadId: string): ApprovalRef | undefined {
    return approvalId ? this.store.approvals.consume(approvalId, threadId) : undefined;
  }

  private addressee(actor: Member, to: Envelope['header']['to']): string | null {
    if ('role' in to) {
      if (to.role !== 'backend') reject('INVALID_REQUEST', 'Requirements go to the backend role or a backend member.');
      return null;
    }
    if ('member' in to) {
      const target = this.store.members.get(to.member);
      if (!target || target.revokedAt || target.projectId !== actor.projectId || target.role !== 'backend') {
        reject('INVALID_TARGET', 'Requirements can only be addressed to an active backend member of this project.');
      }
      return target.id;
    }
    return reject('INVALID_REQUEST', 'Requirements go to the backend role or a backend member.');
  }

  private loopLimit(projectId: string): number {
    const project = this.store.projects.get(projectId);
    if (!project) reject('NOT_FOUND', 'Unknown project.');
    return project.loopLimit;
  }

  private run<T>(fn: () => T): Result<T> {
    try {
      return { ok: true, value: this.store.db.transaction(fn) };
    } catch (error) {
      if (error instanceof Rejection) return { ok: false, error: error.error };
      throw error;
    }
  }
}

function asActor(member: Member): Actor {
  return { member: member.id, role: member.role };
}

function reject(code: ServiceError['code'], message: string, state: ThreadState | null = null): never {
  throw new Rejection({ code, message, state } as ServiceError);
}
