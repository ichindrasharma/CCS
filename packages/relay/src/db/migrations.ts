import { GATES, MESSAGE_TYPES, EVENT_KINDS, ROLES, THREAD_STATES } from '@tool/protocol';
import type { RelayDb } from './database.js';

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/**
 * Append-only: never edit a shipped migration, add a new one.
 * The applied version is kept in `PRAGMA user_version`.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: initial schema (doc/Architecture and Project Structure.md, "Relay data model") */ `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    loop_limit  INTEGER NOT NULL CHECK (loop_limit >= 1),
    -- Next value for log.seq in this project; incremented inside the appending transaction.
    next_seq    INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  ) STRICT;

  CREATE TABLE members (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN (${list(ROLES)})),
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    revoked_at  TEXT,
    UNIQUE (project_id, name)
  ) STRICT;

  CREATE TABLE invites (
    code_hash   TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    created_by  TEXT REFERENCES members(id),
    uses_left   INTEGER NOT NULL CHECK (uses_left >= 0),
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  ) STRICT;

  CREATE TABLE threads (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id),
    title           TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN (${list(THREAD_STATES)})),
    frontend_owner  TEXT REFERENCES members(id),
    backend_owner   TEXT REFERENCES members(id),
    -- A member id when requirements were addressed to one person; NULL means the backend role.
    addressed_to    TEXT REFERENCES members(id),
    round           INTEGER NOT NULL DEFAULT 0,
    loop_base       INTEGER NOT NULL DEFAULT 0,
    loop_limit      INTEGER NOT NULL CHECK (loop_limit >= 1),
    escalated_from  TEXT CHECK (escalated_from IN (${list(THREAD_STATES)})),
    supersedes      TEXT REFERENCES threads(id),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  ) STRICT;
  CREATE INDEX threads_by_project ON threads (project_id, updated_at);

  -- Messages and events in one ordered log per project: delivery, catch-up and the decision trail.
  CREATE TABLE log (
    project_id  TEXT NOT NULL REFERENCES projects(id),
    seq         INTEGER NOT NULL,
    id          TEXT NOT NULL UNIQUE,
    thread_id   TEXT NOT NULL REFERENCES threads(id),
    kind        TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    type        TEXT NOT NULL,
    actor       TEXT NOT NULL REFERENCES members(id),
    header      TEXT,
    payload     TEXT,
    data        TEXT,
    signature   TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, seq),
    CHECK (
      (kind = 'message' AND type IN (${list(MESSAGE_TYPES)}) AND header IS NOT NULL AND payload IS NOT NULL)
      OR (kind = 'event' AND type IN (${list(EVENT_KINDS)}) AND header IS NULL AND payload IS NULL)
    )
  ) STRICT;
  CREATE INDEX log_by_thread ON log (thread_id, seq);

  CREATE TABLE approvals (
    id           TEXT PRIMARY KEY,
    thread_id    TEXT NOT NULL REFERENCES threads(id),
    gate         TEXT NOT NULL CHECK (gate IN (${list(GATES)})),
    round        INTEGER NOT NULL,
    member_id    TEXT NOT NULL REFERENCES members(id),
    status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
    plan_hash    TEXT NOT NULL,
    code_hash    TEXT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL,
    decided_at   TEXT,
    consumed_at  TEXT
  ) STRICT;
  CREATE INDEX approvals_by_gate ON approvals (thread_id, gate, round);

  CREATE TABLE cursors (
    member_id       TEXT PRIMARY KEY REFERENCES members(id),
    last_acked_seq  INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  `,
];

export function migrate(db: RelayDb): void {
  const current = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this relay (${MIGRATIONS.length}). Upgrade the relay.`);
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]!);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}
