import { newId, type EventKind, type Header, type MessageType } from '@tool/protocol';
import type { RelayDb } from '../database.js';
import type { ProjectsRepo } from './projects.js';

interface Base {
  projectId: string;
  seq: number;
  id: string;
  threadId: string;
  actor: string;
  createdAt: string;
}

export interface MessageEntry extends Base {
  kind: 'message';
  type: MessageType;
  header: Header;
  /** JSON object, or a ciphertext string once payloads are encrypted. */
  payload: Record<string, unknown> | string;
  signature: string | null;
}

export interface EventEntry extends Base {
  kind: 'event';
  type: EventKind;
  data: Record<string, unknown> | null;
}

export type LogEntry = MessageEntry | EventEntry;

interface Row {
  project_id: string;
  seq: number;
  id: string;
  thread_id: string;
  kind: 'message' | 'event';
  type: string;
  actor: string;
  header: string | null;
  payload: string | null;
  data: string | null;
  signature: string | null;
  created_at: string;
}

function toEntry(r: Row): LogEntry {
  const base: Base = {
    projectId: r.project_id,
    seq: r.seq,
    id: r.id,
    threadId: r.thread_id,
    actor: r.actor,
    createdAt: r.created_at,
  };
  if (r.kind === 'message') {
    return {
      ...base,
      kind: 'message',
      type: r.type as MessageType,
      header: JSON.parse(r.header!) as Header,
      payload: JSON.parse(r.payload!) as MessageEntry['payload'],
      signature: r.signature,
    };
  }
  return { ...base, kind: 'event', type: r.type as EventKind, data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null };
}

/** Append-only. Entries are never updated or deleted. */
export class LogRepo {
  constructor(
    private readonly db: RelayDb,
    private readonly projects: ProjectsRepo,
  ) {}

  /** The header must already carry the relay-assigned id and `from`. */
  appendMessage(input: {
    projectId: string;
    threadId: string;
    header: Header;
    payload: MessageEntry['payload'];
    signature?: string | null;
  }): MessageEntry {
    return this.db.transaction(() => {
      const entry: MessageEntry = {
        projectId: input.projectId,
        seq: this.projects.takeSeq(input.projectId),
        id: input.header.id,
        threadId: input.threadId,
        actor: input.header.from.member,
        createdAt: this.db.now(),
        kind: 'message',
        type: input.header.type,
        header: input.header,
        payload: input.payload,
        signature: input.signature ?? null,
      };
      this.insert(entry, JSON.stringify(entry.header), JSON.stringify(entry.payload), null, entry.signature);
      return entry;
    });
  }

  appendEvent(input: {
    projectId: string;
    threadId: string;
    type: EventKind;
    actor: string;
    data?: Record<string, unknown> | null;
  }): EventEntry {
    return this.db.transaction(() => {
      const entry: EventEntry = {
        projectId: input.projectId,
        seq: this.projects.takeSeq(input.projectId),
        id: newId('event'),
        threadId: input.threadId,
        actor: input.actor,
        createdAt: this.db.now(),
        kind: 'event',
        type: input.type,
        data: input.data ?? null,
      };
      this.insert(entry, null, null, entry.data && JSON.stringify(entry.data), null);
      return entry;
    });
  }

  /** A thread's history in order: the decision trail. */
  listThread(threadId: string, options: { afterSeq?: number } = {}): LogEntry[] {
    return this.db
      .all<Row>('SELECT * FROM log WHERE thread_id = ? AND seq > ? ORDER BY seq', threadId, options.afterSeq ?? 0)
      .map(toEntry);
  }

  /** Everything after a cursor, for delivery and catch-up. Routing decides who may see each entry. */
  listProject(projectId: string, options: { afterSeq?: number; limit?: number } = {}): LogEntry[] {
    return this.db
      .all<Row>(
        'SELECT * FROM log WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        projectId,
        options.afterSeq ?? 0,
        options.limit ?? 500,
      )
      .map(toEntry);
  }

  private insert(entry: LogEntry, header: string | null, payload: string | null, data: string | null, signature: string | null) {
    this.db.run(
      `INSERT INTO log (project_id, seq, id, thread_id, kind, type, actor, header, payload, data, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.projectId,
      entry.seq,
      entry.id,
      entry.threadId,
      entry.kind,
      entry.type,
      entry.actor,
      header,
      payload,
      data,
      signature,
      entry.createdAt,
    );
  }
}
