import { newId, type Role } from '@tool/protocol';
import type { RelayDb } from '../database.js';

export interface Member {
  id: string;
  projectId: string;
  name: string;
  role: Role;
  createdAt: string;
  revokedAt: string | null;
}

interface Row {
  id: string;
  project_id: string;
  name: string;
  role: Role;
  created_at: string;
  revoked_at: string | null;
}

const COLUMNS = 'id, project_id, name, role, created_at, revoked_at';

const toMember = (r: Row): Member => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  role: r.role,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

export class MembersRepo {
  constructor(private readonly db: RelayDb) {}

  /** Throws on a duplicate name in the project (UNIQUE constraint). */
  create(input: { projectId: string; name: string; role: Role; tokenHash: string }): Member {
    const member: Member = {
      id: newId('member'),
      projectId: input.projectId,
      name: input.name,
      role: input.role,
      createdAt: this.db.now(),
      revokedAt: null,
    };
    this.db.run(
      'INSERT INTO members (id, project_id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      member.id,
      member.projectId,
      member.name,
      member.role,
      input.tokenHash,
      member.createdAt,
    );
    return member;
  }

  get(id: string): Member | undefined {
    const row = this.db.get<Row>(`SELECT ${COLUMNS} FROM members WHERE id = ?`, id);
    return row && toMember(row);
  }

  /** Authentication lookup: only members whose token has not been revoked. */
  findActiveByTokenHash(tokenHash: string): Member | undefined {
    const row = this.db.get<Row>(`SELECT ${COLUMNS} FROM members WHERE token_hash = ? AND revoked_at IS NULL`, tokenHash);
    return row && toMember(row);
  }

  list(projectId: string, options: { includeRevoked?: boolean } = {}): Member[] {
    const filter = options.includeRevoked ? '' : 'AND revoked_at IS NULL';
    return this.db
      .all<Row>(`SELECT ${COLUMNS} FROM members WHERE project_id = ? ${filter} ORDER BY created_at, name`, projectId)
      .map(toMember);
  }

  /** Returns false if the member was already revoked or does not exist. */
  revoke(id: string): boolean {
    return this.db.run('UPDATE members SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', this.db.now(), id).changes === 1;
  }

  setRole(id: string, role: Role): boolean {
    return this.db.run('UPDATE members SET role = ? WHERE id = ? AND revoked_at IS NULL', role, id).changes === 1;
  }
}
