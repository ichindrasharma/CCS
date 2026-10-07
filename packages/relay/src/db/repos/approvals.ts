import { newId, type ApprovalRef, type ApprovalStatus, type ApprovalView, type Gate } from '@tool/protocol';
import type { RelayDb } from '../database.js';

export type { ApprovalStatus };
export type Approval = ApprovalView;

interface Row {
  id: string;
  thread_id: string;
  gate: Gate;
  round: number;
  member_id: string;
  status: ApprovalStatus;
  plan_hash: string;
  note: string | null;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}

const COLUMNS = 'id, thread_id, gate, round, member_id, status, plan_hash, note, created_at, decided_at, consumed_at';

const toApproval = (r: Row): Approval => ({
  id: r.id,
  threadId: r.thread_id,
  gate: r.gate,
  round: r.round,
  memberId: r.member_id,
  status: r.status,
  planHash: r.plan_hash,
  note: r.note,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  consumedAt: r.consumed_at,
});

/**
 * pending → approved | rejected; approved → consumed (once).
 * Every transition is a single conditional UPDATE, so it cannot happen twice.
 */
export class ApprovalsRepo {
  constructor(private readonly db: RelayDb) {}

  /** `codeHash` is the hash of the one-time code shown only to the developer. */
  open(input: { threadId: string; gate: Gate; round: number; memberId: string; planHash: string; codeHash: string }): Approval {
    const approval: Approval = {
      id: newId('approval'),
      threadId: input.threadId,
      gate: input.gate,
      round: input.round,
      memberId: input.memberId,
      status: 'pending',
      planHash: input.planHash,
      note: null,
      createdAt: this.db.now(),
      decidedAt: null,
      consumedAt: null,
    };
    this.db.run(
      `INSERT INTO approvals (id, thread_id, gate, round, member_id, status, plan_hash, code_hash, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      approval.id,
      approval.threadId,
      approval.gate,
      approval.round,
      approval.memberId,
      approval.planHash,
      input.codeHash,
      approval.createdAt,
    );
    return approval;
  }

  get(id: string): Approval | undefined {
    const row = this.db.get<Row>(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`, id);
    return row && toApproval(row);
  }

  /** Records the developer's decision. Undefined if the approval is not pending or the code is wrong. */
  decide(id: string, input: { codeHash: string; decision: 'approved' | 'rejected'; note?: string | null }): Approval | undefined {
    const row = this.db.get<Row>(
      `UPDATE approvals SET status = ?, note = ?, decided_at = ?
       WHERE id = ? AND status = 'pending' AND code_hash = ?
       RETURNING ${COLUMNS}`,
      input.decision,
      input.note ?? null,
      this.db.now(),
      id,
      input.codeHash,
    );
    return row && toApproval(row);
  }

  /**
   * Uses an approval for a gated message on `threadId`. Returns the reference the state machine
   * checks (gate and round), or undefined if it is not approved, already used, or for another thread.
   * Call inside the same transaction as the transition so a rejected transition rolls this back.
   */
  consume(id: string, threadId: string): ApprovalRef | undefined {
    const row = this.db.get<{ gate: Gate; round: number }>(
      `UPDATE approvals SET status = 'consumed', consumed_at = ?
       WHERE id = ? AND thread_id = ? AND status = 'approved'
       RETURNING gate, round`,
      this.db.now(),
      id,
      threadId,
    );
    return row && { gate: row.gate, round: row.round };
  }

  listPending(threadId: string): Approval[] {
    return this.db
      .all<Row>(`SELECT ${COLUMNS} FROM approvals WHERE thread_id = ? AND status = 'pending' ORDER BY created_at`, threadId)
      .map(toApproval);
  }
}
