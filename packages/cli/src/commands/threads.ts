import type { LogEntry, MemberView, ThreadState, ThreadView } from '@tool/protocol';
import { repoContext, type Io } from '../context.js';

export async function members(io: Io): Promise<void> {
  const { config, relay } = repoContext(io);
  const { members: list } = await relay.members(config.projectId);
  for (const m of list) io.out(`${m.name.padEnd(20)} ${m.role.padEnd(9)} ${m.id === config.memberId ? '(you)' : ''}`.trimEnd());
}

export async function threads(io: Io, options: { state?: ThreadState }): Promise<void> {
  const { config, relay } = repoContext(io);
  const [{ threads: list }, { members: people }] = await Promise.all([relay.threads(config.projectId, options.state), relay.members(config.projectId)]);
  if (list.length === 0) return io.out('No threads.');
  const name = namer(people);
  for (const t of list) {
    io.out(`${t.id}  ${t.snapshot.state.padEnd(11)}  ${t.title}  (frontend ${name(t.snapshot.frontendOwner)}, backend ${name(t.snapshot.backendOwner)})`);
  }
}

/** A thread's decision trail, one line per message or event. */
export async function thread(io: Io, threadId: string): Promise<void> {
  const { config, relay } = repoContext(io);
  const [{ thread: t, entries }, { members: people }] = await Promise.all([relay.thread(threadId), relay.members(config.projectId)]);
  const name = namer(people);
  io.out(summary(t, name));
  io.out('');
  for (const entry of entries) io.out(line(entry, name));
}

export async function resume(io: Io, threadId: string, options: { to?: ThreadState }): Promise<void> {
  const { config, relay } = repoContext(io);
  const change = await relay.resume(threadId, options.to);
  const { members: people } = await relay.members(config.projectId);
  io.out(`Resumed. ${summary(change.thread, namer(people))}`);
}

export function summary(t: ThreadView, name: (id: string | null) => string): string {
  const s = t.snapshot;
  return `${t.id} "${t.title}": ${s.state}, round ${s.round}. Frontend ${name(s.frontendOwner)}, backend ${name(s.backendOwner)}.`;
}

function line(entry: LogEntry, name: (id: string | null) => string): string {
  const when = entry.createdAt.replace('T', ' ').slice(0, 19);
  const who = name(entry.actor);
  if (entry.kind === 'event') {
    const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    return `#${entry.seq}  ${when}  ${who}  [${entry.type}]${data}`;
  }
  const body = typeof entry.payload === 'string' ? '(encrypted)' : String(entry.payload.body ?? '').replace(/\s+/g, ' ');
  return `#${entry.seq}  ${when}  ${who}  ${entry.type}: ${body.length > 100 ? `${body.slice(0, 97)}...` : body}`;
}

function namer(people: MemberView[]): (id: string | null) => string {
  const byId = new Map(people.map((m) => [m.id, m.name]));
  return (id) => (id === null ? 'nobody' : (byId.get(id) ?? id));
}
