import { newId, type ThreadSnapshot, type ThreadState, type ThreadView } from '@tool/protocol';
import type { RelayDb } from '../database.js';

export type Thread = ThreadView;

interface Row {
  id: string;
  project_id: string;
  title: string;
  state: ThreadState;
  frontend_owner: string | null;
  backend_owner: string | null;
  addressed_to: string | null;
  round: number;
  loop_base: number;
  loop_limit: number;
  escalated_from: ThreadState | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
}

const toThread = (r: Row): Thread => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  addressedTo: r.addressed_to,
  supersedes: r.supersedes,
  snapshot: {
    state: r.state,
    frontendOwner: r.frontend_owner,
    backendOwner: r.backend_owner,
    round: r.round,
    loopBase: r.loop_base,
    loopLimit: r.loop_limit,
    escalatedFrom: r.escalated_from,
  },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ThreadsRepo {
  constructor(private readonly db: RelayDb) {}

  /** `snapshot` comes from `openThread` or `openSupersedingThread` in the protocol package. */
  create(input: {
    projectId: string;
    title: string;
    snapshot: ThreadSnapshot;
    addressedTo?: string | null;
    supersedes?: string | null;
  }): Thread {
    const now = this.db.now();
    const s = input.snapshot;
    const thread: Thread = {
      id: newId('thread'),
      projectId: input.projectId,
      title: input.title,
      addressedTo: input.addressedTo ?? null,
      supersedes: input.supersedes ?? null,
      snapshot: { ...s },
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO threads (id, project_id, title, state, frontend_owner, backend_owner, addressed_to,
         round, loop_base, loop_limit, escalated_from, supersedes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      thread.id,
      thread.projectId,
      thread.title,
      s.state,
      s.frontendOwner,
      s.backendOwner,
      thread.addressedTo,
      s.round,
      s.loopBase,
      s.loopLimit,
      s.escalatedFrom,
      thread.supersedes,
      now,
      now,
    );
    return thread;
  }

  get(id: string): Thread | undefined {
    const row = this.db.get<Row>('SELECT * FROM threads WHERE id = ?', id);
    return row && toThread(row);
  }

  /** Writes the `next` snapshot from a successful transition. */
  saveSnapshot(id: string, s: ThreadSnapshot): void {
    const { changes } = this.db.run(
      `UPDATE threads SET state = ?, frontend_owner = ?, backend_owner = ?, round = ?, loop_base = ?,
         loop_limit = ?, escalated_from = ?, updated_at = ?
       WHERE id = ?`,
      s.state,
      s.frontendOwner,
      s.backendOwner,
      s.round,
      s.loopBase,
      s.loopLimit,
      s.escalatedFrom,
      this.db.now(),
      id,
    );
    if (changes !== 1) throw new Error(`Unknown thread ${id}`);
  }

  /** Most recently active first. */
  list(projectId: string, options: { state?: ThreadState } = {}): Thread[] {
    const rows = options.state
      ? this.db.all<Row>('SELECT * FROM threads WHERE project_id = ? AND state = ? ORDER BY updated_at DESC', projectId, options.state)
      : this.db.all<Row>('SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC', projectId);
    return rows.map(toThread);
  }

  /** Open threads a member owns on either side; used to release them on revoke or role change. */
  listOpenOwnedBy(memberId: string): Thread[] {
    return this.db
      .all<Row>(
        `SELECT * FROM threads WHERE (frontend_owner = ? OR backend_owner = ?) AND state <> 'integrated'`,
        memberId,
        memberId,
      )
      .map(toThread);
  }
}
