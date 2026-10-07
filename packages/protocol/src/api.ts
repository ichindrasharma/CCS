import { z } from 'zod';
import { Envelope, Header } from './envelope.js';
import type { EventKind } from './events.js';
import { GATES } from './gates.js';
import type { ThreadSnapshot } from './machine.js';
import type { MessageType } from './messages.js';
import { ROLES, type Role } from './roles.js';
import { THREAD_STATES, type ThreadState } from './states.js';

// --- what the relay returns ----------------------------------------------------

export interface ProjectView {
  id: string;
  name: string;
  loopLimit: number;
  createdAt: string;
}

export interface MemberView {
  id: string;
  projectId: string;
  name: string;
  role: Role;
  createdAt: string;
  revokedAt: string | null;
}

export interface ThreadView {
  id: string;
  projectId: string;
  title: string;
  /** Member the requirements were addressed to; null means the backend role. */
  addressedTo: string | null;
  supersedes: string | null;
  snapshot: ThreadSnapshot;
  createdAt: string;
  updatedAt: string;
}

interface EntryBase {
  projectId: string;
  /** Project-wide order; also the delivery cursor. */
  seq: number;
  id: string;
  threadId: string;
  actor: string;
  createdAt: string;
}

export interface MessageEntry extends EntryBase {
  kind: 'message';
  type: MessageType;
  header: Header;
  /** JSON object, or a ciphertext string once payloads are encrypted. */
  payload: Record<string, unknown> | string;
  signature: string | null;
}

export interface EventEntry extends EntryBase {
  kind: 'event';
  type: EventKind;
  data: Record<string, unknown> | null;
}

export type LogEntry = MessageEntry | EventEntry;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

export interface ApprovalView {
  id: string;
  threadId: string;
  gate: (typeof GATES)[number];
  round: number;
  memberId: string;
  status: ApprovalStatus;
  planHash: string;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
}

export interface ApiError {
  error: { code: string; message: string; state: ThreadState | null };
}

// --- request bodies ------------------------------------------------------------

const Name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,39}$/i, 'Use 1–40 letters, digits, dots, dashes or underscores.');

export const CreateProjectRequest = z.object({
  name: z.string().trim().min(1).max(100),
  memberName: Name,
  role: z.enum(ROLES),
  loopLimit: z.int().min(1).max(20).optional(),
});

export const CreateInviteRequest = z.object({
  uses: z.int().min(1).max(100).default(10),
  expiresInHours: z.number().positive().max(24 * 30).default(24 * 7),
});

export const JoinRequest = z.object({ code: z.string().min(1), name: Name, role: z.enum(ROLES) });

export const UpdateMeRequest = z.object({ role: z.enum(ROLES) });

export const HandOffRequest = z.object({ to: z.string().min(1) });

export const ResumeRequest = z.object({ to: z.enum(THREAD_STATES).optional() });

/** The bridge leaves id, sender and time to the relay. */
export const DraftHeader = Header.omit({ id: true, from: true, created_at: true });

export const SubmitMessageRequest = z.object({
  header: DraftHeader,
  payload: Envelope.shape.payload,
  /** Names a new thread. Stored in plain text, even when payloads are encrypted. */
  title: z.string().trim().min(1).max(200).optional(),
});

export const OpenApprovalRequest = z.object({
  threadId: z.string().min(1),
  gate: z.enum(GATES),
  /** Hash of the plan the developer is shown; the plan itself never reaches the relay. */
  planHash: z.string().min(1).max(128),
});

export const DecideApprovalRequest = z.object({
  code: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});

export const ThreadLogQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

export const ListThreadsQuery = z.object({ state: z.enum(THREAD_STATES).optional() });

// --- WebSocket frames (GET /ws) --------------------------------------------------

export interface DeliveredEntry {
  entry: LogEntry;
  /** The thread as it is now, so the bridge can update its cache without another request. */
  thread: ThreadView;
}

export type ServerFrame =
  | { type: 'hello'; member: MemberView; cursor: number }
  | { type: 'entries'; entries: DeliveredEntry[] }
  | { type: 'error'; message: string };

export const ClientFrame = z.object({ type: z.literal('ack'), seq: z.int().min(0) });

export type ClientFrame = z.infer<typeof ClientFrame>;
