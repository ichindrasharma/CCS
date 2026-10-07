import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from './migrations.js';

export type Clock = () => string;

export interface DatabaseOptions {
  /** File path, or `:memory:` for tests. */
  path: string;
  /** ISO timestamp source; injectable so tests are deterministic. */
  now?: Clock;
}

/**
 * The relay's SQLite connection. Synchronous by design: one relay process owns the file,
 * and every state change runs inside `transaction`, so a transition and its log entries
 * commit together or not at all.
 */
export class RelayDb {
  readonly now: Clock;
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(options: DatabaseOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(options.path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    migrate(this);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const { changes } = this.db.prepare(sql).run(...params);
    return { changes: Number(changes) };
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Runs `fn` atomically. Nested calls become savepoints, so repositories can compose. */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
