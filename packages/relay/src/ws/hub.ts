import { ClientFrame, type DeliveredEntry, type LogEntry, type ServerFrame, type ThreadView } from '@tool/protocol';
import type { WebSocket } from 'ws';
import type { Member, Store } from '../db/index.js';
import { isRecipient } from '../domain/routing.js';
import type { Change } from '../domain/thread-service.js';

const BATCH = 200;
/** Close code sent when a member's token is revoked. */
export const CLOSE_REVOKED = 4001;

interface Connection {
  socket: WebSocket;
  memberId: string;
}

/**
 * Pushes log entries to connected bridges. One mechanism covers live delivery, reconnects and
 * offline catch-up: a connecting bridge first gets every entry after its cursor, then live ones.
 * Bridges ack by `seq`, and must ignore entries they already have (delivery is at least once).
 */
export class DeliveryHub {
  private readonly byProject = new Map<string, Set<Connection>>();

  constructor(private readonly store: Store) {}

  /** `after` is the bridge's own cursor if it has one; otherwise the stored cursor is used. */
  connect(socket: WebSocket, member: Member, after?: number): void {
    const connection: Connection = { socket, memberId: member.id };
    const cursor = after ?? this.store.cursors.get(member.id);

    // Registering and reading the backlog happen in the same synchronous turn, so no entry
    // can be appended in between and slip past both.
    const connections = this.byProject.get(member.projectId) ?? new Set();
    connections.add(connection);
    this.byProject.set(member.projectId, connections);

    send(socket, { type: 'hello', member, cursor });
    this.sendBacklog(socket, member, cursor);

    socket.on('message', (raw) => {
      let frame: ClientFrame;
      try {
        frame = ClientFrame.parse(JSON.parse(raw.toString()));
      } catch {
        send(socket, { type: 'error', message: 'Expected {"type":"ack","seq":<number>}.' });
        return;
      }
      this.store.cursors.ack(member.id, frame.seq);
    });
    socket.on('close', () => {
      connections.delete(connection);
      if (connections.size === 0) this.byProject.delete(member.projectId);
    });
  }

  /** Sends the entries of one or more changes to every connected recipient. */
  publish(changes: Change | Change[]): void {
    for (const change of Array.isArray(changes) ? changes : [changes]) {
      const connections = this.byProject.get(change.thread.projectId);
      if (!connections || change.entries.length === 0) continue;
      for (const connection of connections) {
        const member = this.store.members.get(connection.memberId);
        if (!member) continue;
        const entries = change.entries
          .filter((entry) => isRecipient(member, entry, change.thread))
          .map((entry) => ({ entry, thread: change.thread }));
        if (entries.length > 0) send(connection.socket, { type: 'entries', entries });
      }
    }
  }

  /** Closes every socket of a revoked member. */
  disconnect(memberId: string): void {
    for (const connections of this.byProject.values()) {
      for (const connection of connections) {
        if (connection.memberId === memberId) connection.socket.close(CLOSE_REVOKED, 'Membership revoked');
      }
    }
  }

  closeAll(): void {
    for (const connections of this.byProject.values()) {
      for (const connection of connections) connection.socket.close(1001, 'Relay shutting down');
    }
    this.byProject.clear();
  }

  private sendBacklog(socket: WebSocket, member: Member, cursor: number): void {
    const threads = new Map<string, ThreadView>();
    let after = cursor;
    for (;;) {
      const page: LogEntry[] = this.store.log.listProject(member.projectId, { afterSeq: after, limit: BATCH });
      if (page.length === 0) return;
      const entries: DeliveredEntry[] = [];
      for (const entry of page) {
        let thread = threads.get(entry.threadId);
        if (!thread) {
          thread = this.store.threads.get(entry.threadId)!;
          threads.set(thread.id, thread);
        }
        if (isRecipient(member, entry, thread)) entries.push({ entry, thread });
      }
      if (entries.length > 0) send(socket, { type: 'entries', entries });
      after = page[page.length - 1]!.seq;
    }
  }
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}
