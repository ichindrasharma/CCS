import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { DeliveredEntry, LogEntry, ThreadView } from '@tool/protocol';
import type { MessageDraft } from '../relay-client/http.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS threads (
    id          TEXT PRIMARY KEY,
    json        TEXT NOT NULL
  ) STRICT;

  -- Entries delivered to this member, in project order. The inbox is the unread ones.
  CREATE TABLE IF NOT EXISTS entries (
    seq         INTEGER PRIMARY KEY,
    thread_id   TEXT NOT NULL,
    json        TEXT NOT NULL,
    read        INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  -- Plans awaiting a gate decision, so the CLI can show the developer what they approve.
  -- The one-time code is never stored here: the agent can read this file.
  CREATE TABLE IF NOT EXISTS plans (
    approval_id TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL,
    gate        TEXT NOT NULL,
    plan        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  ) STRICT;

  -- Messages written while the relay was unreachable, sent in order when it is back.
  CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    draft       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    error       TEXT
  ) STRICT;
`;

export interface OutboxItem {
  id: number;
  draft: MessageDraft;
  createdAt: string;
  error: string | null;
}

/**
 * The bridge's local SQLite cache at `<repo>/.tool/cache.db`. Several agent sessions in one repo
 * share it (WAL mode), so read marks and the outbox are shared too.
 */
export class BridgeCache {
  private readonly db: DatabaseSync;

  constructor(dataDir: string | ':memory:') {
    if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'cache.db'));
    if (dataDir !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  /** Highest delivered seq; the bridge reconnects from here. */
  cursor(): number {
    return (this.db.prepare('SELECT max(seq) AS seq FROM entries').get() as { seq: number | null }).seq ?? 0;
  }

  /**
   * Stores delivered entries and their threads. Returns only entries not seen before, since
   * delivery is at least once. Entries the member wrote themselves arrive already read.
   */
  storeDelivered(delivered: DeliveredEntry[], me: string): DeliveredEntry[] {
    const insert = this.db.prepare('INSERT OR IGNORE INTO entries (seq, thread_id, json, read) VALUES (?, ?, ?, ?)');
    const fresh: DeliveredEntry[] = [];
    this.db.exec('BEGIN');
    try {
      for (const item of delivered) {
        const { changes } = insert.run(item.entry.seq, item.entry.threadId, JSON.stringify(item.entry), item.entry.actor === me ? 1 : 0);
        if (Number(changes) === 1) fresh.push(item);
        this.putThread(item.thread);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return fresh;
  }

  /** Keeps the newest copy of a thread (threads only move forward in `updatedAt`). */
  putThread(thread: ThreadView): void {
    const existing = this.getThread(thread.id);
    if (existing && existing.updatedAt > thread.updatedAt) return;
    this.db.prepare('INSERT INTO threads (id, json) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json').run(thread.id, JSON.stringify(thread));
  }

  getThread(id: string): ThreadView | undefined {
    const row = this.db.prepare('SELECT json FROM threads WHERE id = ?').get(id) as { json: string } | undefined;
    return row && (JSON.parse(row.json) as ThreadView);
  }

  unread(): LogEntry[] {
    return (this.db.prepare('SELECT json FROM entries WHERE read = 0 ORDER BY seq').all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as LogEntry,
    );
  }

  markRead(seqs: number[]): void {
    const update = this.db.prepare('UPDATE entries SET read = 1 WHERE seq = ?');
    for (const seq of seqs) update.run(seq);
  }

  savePlan(input: { approvalId: string; threadId: string; gate: string; plan: string }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO plans (approval_id, thread_id, gate, plan, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.approvalId, input.threadId, input.gate, input.plan, new Date().toISOString());
  }

  getPlan(approvalId: string): { threadId: string; gate: string; plan: string } | undefined {
    const row = this.db.prepare('SELECT thread_id, gate, plan FROM plans WHERE approval_id = ?').get(approvalId) as
      | { thread_id: string; gate: string; plan: string }
      | undefined;
    return row && { threadId: row.thread_id, gate: row.gate, plan: row.plan };
  }

  queue(draft: MessageDraft): void {
    this.db.prepare('INSERT INTO outbox (draft, created_at) VALUES (?, ?)').run(JSON.stringify(draft), new Date().toISOString());
  }

  /** Items still waiting to be sent, oldest first; failed ones are kept until reported. */
  outbox(): OutboxItem[] {
    return (this.db.prepare('SELECT id, draft, created_at, error FROM outbox ORDER BY id').all() as {
      id: number;
      draft: string;
      created_at: string;
      error: string | null;
    }[]).map((r) => ({ id: r.id, draft: JSON.parse(r.draft) as MessageDraft, createdAt: r.created_at, error: r.error }));
  }

  markOutboxFailed(id: number, error: string): void {
    this.db.prepare('UPDATE outbox SET error = ? WHERE id = ?').run(error, id);
  }

  removeOutbox(id: number): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
