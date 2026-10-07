import type { RelayDb } from '../database.js';

export class InvitesRepo {
  constructor(private readonly db: RelayDb) {}

  /** The caller hashes the code; the plain code is shown once and never stored. */
  create(input: { codeHash: string; projectId: string; createdBy: string | null; uses: number; expiresAt: string }): void {
    this.db.run(
      'INSERT INTO invites (code_hash, project_id, created_by, uses_left, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      input.codeHash,
      input.projectId,
      input.createdBy,
      input.uses,
      input.expiresAt,
      this.db.now(),
    );
  }

  /** Uses up one redemption atomically. Returns the project id, or undefined if unknown, used up or expired. */
  redeem(codeHash: string): string | undefined {
    const row = this.db.get<{ project_id: string }>(
      `UPDATE invites SET uses_left = uses_left - 1
       WHERE code_hash = ? AND uses_left > 0 AND expires_at > ?
       RETURNING project_id`,
      codeHash,
      this.db.now(),
    );
    return row?.project_id;
  }
}
