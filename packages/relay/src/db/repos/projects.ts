import { DEFAULT_LOOP_LIMIT, newId } from '@tool/protocol';
import type { RelayDb } from '../database.js';

export interface Project {
  id: string;
  name: string;
  loopLimit: number;
  createdAt: string;
}

interface Row {
  id: string;
  name: string;
  loop_limit: number;
  created_at: string;
}

const toProject = (r: Row): Project => ({ id: r.id, name: r.name, loopLimit: r.loop_limit, createdAt: r.created_at });

export class ProjectsRepo {
  constructor(private readonly db: RelayDb) {}

  create(input: { name: string; loopLimit?: number }): Project {
    const project: Project = {
      id: newId('project'),
      name: input.name,
      loopLimit: input.loopLimit ?? DEFAULT_LOOP_LIMIT,
      createdAt: this.db.now(),
    };
    this.db.run(
      'INSERT INTO projects (id, name, loop_limit, created_at) VALUES (?, ?, ?, ?)',
      project.id,
      project.name,
      project.loopLimit,
      project.createdAt,
    );
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db.get<Row>('SELECT id, name, loop_limit, created_at FROM projects WHERE id = ?', id);
    return row && toProject(row);
  }

  /** Reserves the next log sequence number. Call only inside the transaction that appends the entry. */
  takeSeq(projectId: string): number {
    const row = this.db.get<{ seq: number }>(
      'UPDATE projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq',
      projectId,
    );
    if (!row) throw new Error(`Unknown project ${projectId}`);
    return row.seq;
  }
}
