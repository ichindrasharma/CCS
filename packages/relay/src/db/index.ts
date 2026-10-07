import { RelayDb, type DatabaseOptions } from './database.js';
import { ApprovalsRepo } from './repos/approvals.js';
import { CursorsRepo } from './repos/cursors.js';
import { InvitesRepo } from './repos/invites.js';
import { LogRepo } from './repos/log.js';
import { MembersRepo } from './repos/members.js';
import { ProjectsRepo } from './repos/projects.js';
import { ThreadsRepo } from './repos/threads.js';

export interface Store {
  db: RelayDb;
  projects: ProjectsRepo;
  members: MembersRepo;
  invites: InvitesRepo;
  threads: ThreadsRepo;
  log: LogRepo;
  approvals: ApprovalsRepo;
  cursors: CursorsRepo;
}

/** Opens (and migrates) the relay database and wires up every repository. */
export function openStore(options: DatabaseOptions): Store {
  const db = new RelayDb(options);
  const projects = new ProjectsRepo(db);
  return {
    db,
    projects,
    members: new MembersRepo(db),
    invites: new InvitesRepo(db),
    threads: new ThreadsRepo(db),
    log: new LogRepo(db, projects),
    approvals: new ApprovalsRepo(db),
    cursors: new CursorsRepo(db),
  };
}

export { RelayDb, type Clock, type DatabaseOptions } from './database.js';
export type { Approval, ApprovalStatus } from './repos/approvals.js';
export type { EventEntry, LogEntry, MessageEntry } from './repos/log.js';
export type { Member } from './repos/members.js';
export type { Project } from './repos/projects.js';
export type { Thread } from './repos/threads.js';
