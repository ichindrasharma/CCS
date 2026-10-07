import type { LogEntry, MemberView, ThreadView } from '@tool/protocol';

const OWNERSHIP_EVENTS = new Set(['claimed', 'handed_off', 'released']);

/**
 * Whether a log entry goes to a member's inbox (spec, Flow 5). Reading is wider than this:
 * any member can read any thread in the project; routing only decides who is notified.
 *
 * - The member who caused the entry always gets it, so their other sessions stay in sync.
 * - `requirements` go to the addressed backend member, or every backend member.
 * - `integrated` and ownership changes go to the whole project.
 * - Everything else goes to the thread's owners. While a side has no owner, it goes to every
 *   member of that side (only the addressee, if the requirements named one).
 */
export function isRecipient(member: MemberView, entry: LogEntry, thread: ThreadView): boolean {
  if (member.revokedAt !== null || member.projectId !== entry.projectId) return false;
  if (entry.actor === member.id) return true;

  if (entry.kind === 'message' && entry.type === 'requirements') {
    return thread.addressedTo ? member.id === thread.addressedTo : member.role === 'backend';
  }
  if (entry.kind === 'message' && entry.type === 'integrated') return true;
  if (entry.kind === 'event' && OWNERSHIP_EVENTS.has(entry.type)) return true;

  const { frontendOwner, backendOwner } = thread.snapshot;
  if (member.id === frontendOwner || member.id === backendOwner) return true;
  const ownerOfMySide = member.role === 'frontend' ? frontendOwner : backendOwner;
  if (ownerOfMySide !== null) return false;
  return member.role === 'backend' && thread.addressedTo ? member.id === thread.addressedTo : true;
}
