import {
  CreateInviteRequest,
  CreateProjectRequest,
  DecideApprovalRequest,
  HandOffRequest,
  JoinRequest,
  ListThreadsQuery,
  OpenApprovalRequest,
  ResumeRequest,
  SubmitMessageRequest,
  ThreadLogQuery,
  UpdateMeRequest,
} from '@tool/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashSecret, newApprovalCode, newInviteCode, newToken } from '../auth/secrets.js';
import type { Store } from '../db/index.js';
import type { ThreadService } from '../domain/thread-service.js';
import type { DeliveryHub } from '../ws/hub.js';
import { HttpError, parse, unwrap } from './errors.js';

interface Deps {
  store: Store;
  service: ThreadService;
  hub: DeliveryHub;
}

const PUBLIC = { config: { public: true } } as const;

const WsQuery = z.object({ after: z.coerce.number().int().min(0).optional() });

export function registerRoutes(app: FastifyInstance, { store, service, hub }: Deps): void {
  /** Routes under /projects/:projectId only serve the caller's own project; others look absent. */
  function ownProject(request: FastifyRequest<{ Params: { projectId: string } }>): string {
    if (request.params.projectId !== request.member.projectId) {
      throw new HttpError(404, 'NOT_FOUND', 'Unknown project.');
    }
    return request.member.projectId;
  }

  function createInvite(projectId: string, createdBy: string | null, input: z.infer<typeof CreateInviteRequest>) {
    const code = newInviteCode();
    const expiresAt = new Date(Date.parse(store.db.now()) + input.expiresInHours * 3_600_000).toISOString();
    store.invites.create({ codeHash: hashSecret(code), projectId, createdBy, uses: input.uses, expiresAt });
    return { code, expiresAt, uses: input.uses };
  }

  app.get('/health', PUBLIC, async () => ({ ok: true }));

  // --- projects and membership (spec Flows 1 and 2) -------------------------------

  app.post('/projects', PUBLIC, async (request, reply) => {
    const body = parse(CreateProjectRequest, request.body);
    const token = newToken();
    const created = store.db.transaction(() => {
      const project = store.projects.create({ name: body.name, ...(body.loopLimit && { loopLimit: body.loopLimit }) });
      const member = store.members.create({ projectId: project.id, name: body.memberName, role: body.role, tokenHash: hashSecret(token) });
      const invite = createInvite(project.id, member.id, CreateInviteRequest.parse({}));
      return { project, member, invite };
    });
    return reply.status(201).send({ ...created, token });
  });

  app.post('/join', PUBLIC, async (request, reply) => {
    const body = parse(JoinRequest, request.body);
    const token = newToken();
    const joined = store.db.transaction(() => {
      const projectId = store.invites.redeem(hashSecret(body.code));
      if (!projectId) throw new HttpError(404, 'NOT_FOUND', 'This invite code is unknown, used up or expired.');
      const taken = store.members.list(projectId, { includeRevoked: true }).some((m) => m.name.toLowerCase() === body.name.toLowerCase());
      if (taken) throw new HttpError(409, 'NAME_TAKEN', `The name ${body.name} is already used in this project.`);
      const member = store.members.create({ projectId, name: body.name, role: body.role, tokenHash: hashSecret(token) });
      return { project: store.projects.get(projectId)!, member };
    });
    return reply.status(201).send({ ...joined, token });
  });

  app.get('/me', async (request) => ({ member: request.member, project: store.projects.get(request.member.projectId) }));

  app.patch('/me', async (request) => {
    const body = parse(UpdateMeRequest, request.body);
    const changes = unwrap(service.changeRole(request.member.id, body.role));
    hub.publish(changes);
    return { member: store.members.get(request.member.id), released: changes.map((c) => c.thread.id) };
  });

  /** Leaves the project: the token stops working and owned threads are released. */
  app.delete('/me', async (request, reply) => {
    const changes = unwrap(service.revokeMember(request.member.id));
    hub.publish(changes);
    hub.disconnect(request.member.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { projectId: string } }>('/projects/:projectId/invites', async (request, reply) => {
    const projectId = ownProject(request);
    const body = parse(CreateInviteRequest, request.body);
    return reply.status(201).send(createInvite(projectId, request.member.id, body));
  });

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/members', async (request) => ({
    members: store.members.list(ownProject(request)),
  }));

  // --- threads and messages (spec Flows 3–9) --------------------------------------

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/threads', async (request) => {
    const query = parse(ListThreadsQuery, request.query);
    return { threads: store.threads.list(ownProject(request), query.state ? { state: query.state } : {}) };
  });

  /** Any member may read any thread in their project; routing only limits who is notified. */
  app.get<{ Params: { threadId: string } }>('/threads/:threadId', async (request) => {
    const query = parse(ThreadLogQuery, request.query);
    const thread = store.threads.get(request.params.threadId);
    if (!thread || thread.projectId !== request.member.projectId) throw new HttpError(404, 'NOT_FOUND', 'Unknown thread.');
    return { thread, entries: store.log.listThread(thread.id, { afterSeq: query.after }) };
  });

  app.post('/messages', async (request, reply) => {
    const body = parse(SubmitMessageRequest, request.body);
    const envelope = {
      header: { ...body.header, id: '', from: { member: request.member.id, role: request.member.role }, created_at: store.db.now() },
      payload: body.payload,
    };
    const change = unwrap(service.submitMessage(request.member, envelope, body.title ? { title: body.title } : {}));
    hub.publish(change);
    return reply.status(201).send(change);
  });

  app.post<{ Params: { threadId: string } }>('/threads/:threadId/claim', async (request) => {
    const change = unwrap(service.claim(request.member, request.params.threadId));
    hub.publish(change);
    return change;
  });

  app.post<{ Params: { threadId: string } }>('/threads/:threadId/hand-off', async (request) => {
    const body = parse(HandOffRequest, request.body);
    const change = unwrap(service.handOff(request.member, request.params.threadId, body.to));
    hub.publish(change);
    return change;
  });

  /** A developer action through the CLI; the bridge offers no tool for it. */
  app.post<{ Params: { threadId: string } }>('/threads/:threadId/resume', async (request) => {
    const body = parse(ResumeRequest, request.body);
    const change = unwrap(service.resume(request.member, request.params.threadId, body.to));
    hub.publish(change);
    return change;
  });

  // --- gate approvals (spec "Gate approvals") -----------------------------------

  /**
   * Opens a pending approval and returns the one-time code to the bridge, which shows it to the
   * developer outside the agent (elicitation or OS notification). Only its hash is stored.
   */
  app.post('/approvals', async (request, reply) => {
    const body = parse(OpenApprovalRequest, request.body);
    const code = newApprovalCode();
    const approval = unwrap(service.openApproval(request.member, { ...body, codeHash: hashSecret(code) }));
    return reply.status(201).send({ approval, code });
  });

  app.get<{ Params: { approvalId: string } }>('/approvals/:approvalId', async (request) => {
    const approval = store.approvals.get(request.params.approvalId);
    if (!approval || approval.memberId !== request.member.id) throw new HttpError(404, 'NOT_FOUND', 'Unknown approval.');
    return { approval };
  });

  app.post<{ Params: { approvalId: string } }>('/approvals/:approvalId/decide', async (request) => {
    const body = parse(DecideApprovalRequest, request.body);
    const result = unwrap(
      service.decideApproval(request.member, request.params.approvalId, {
        codeHash: hashSecret(body.code),
        decision: body.decision,
        ...(body.note !== undefined && { note: body.note }),
      }),
    );
    hub.publish(result);
    return result;
  });

  // --- delivery -------------------------------------------------------------------

  app.get('/ws', { websocket: true }, (socket, request) => {
    const query = WsQuery.safeParse(request.query);
    hub.connect(socket, request.member, query.success ? query.data.after : undefined);
  });
}
