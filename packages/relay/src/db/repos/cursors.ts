import type { RelayDb } from '../database.js';

/** How far each member's bridge has acknowledged the project log. */
export class CursorsRepo {
  constructor(private readonly db: RelayDb) {}

  get(memberId: string): number {
    return this.db.get<{ last_acked_seq: number }>('SELECT last_acked_seq FROM cursors WHERE member_id = ?', memberId)?.last_acked_seq ?? 0;
  }

  /** Moves forward only; a late or duplicate ack never rewinds the cursor. */
  ack(memberId: string, seq: number): void {
    this.db.run(
      `INSERT INTO cursors (member_id, last_acked_seq) VALUES (?, ?)
       ON CONFLICT (member_id) DO UPDATE SET last_acked_seq = max(last_acked_seq, excluded.last_acked_seq)`,
      memberId,
      seq,
    );
  }
}
