import type { DeliveredEntry, MessageType, ServerFrame } from '@tool/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { openStore, type Store } from '../db/index.js';
import { CLOSE_REVOKED } from '../ws/hub.js';
import { buildRelay } from './server.js';

let store: Store;
let app: FastifyInstance;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  store = openStore({ path: ':memory:' });
  ({ app } = await buildRelay(store));
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.close();
  store.db.close();
});

interface Session {
  token: string;
  memberId: string;
  projectId: string;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, session?: Session | null, body?: unknown) {
  const response = await app.inject({
    method,
    url,
    ...(session && { headers: { authorization: `Bearer ${session.token}` } }),
    ...(body !== undefined && { payload: body as object }),
  });
  return { status: response.statusCode, body: response.body ? response.json() : undefined };
}

async function ok(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, session?: Session | null, body?: unknown) {
  const response = await call(method, url, session, body);
  if (response.status >= 300) throw new Error(`${method} ${url} → ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

/** asha (frontend) creates the project; ravi and mei (backend) join with the invite. */
async function team() {
  const created = await ok('POST', '/projects', null, { name: 'shop-app', memberName: 'asha', role: 'frontend' });
  const asha: Session = { token: created.token, memberId: created.member.id, projectId: created.project.id };
  const join = async (name: string) => {
    const joined = await ok('POST', '/join', null, { code: created.invite.code, name, role: 'backend' });
    return { token: joined.token, memberId: joined.member.id, projectId: joined.project.id } as Session;
  };
  return { asha, ravi: await join('ravi'), mei: await join('mei'), invite: created.invite.code as string };
}

function draft(session: Session, type: MessageType, thread: string, extra: Record<string, unknown> = {}) {
  return {
    header: {
      project: session.projectId,
      thread,
      type,
      to: { role: type === 'requirements' ? 'backend' : 'frontend' },
      in_reply_to: null,
      approval_id: null,
      supersedes: null,
      ...extra,
    },
    payload: { body: type },
  };
}

/** What the bridge and CLI do together: open an approval, then decide it with the code. */
async function approve(session: Session, threadId: string, gate: string): Promise<string> {
  const opened = await ok('POST', '/approvals', session, { threadId, gate, planHash: 'sha256:plan' });
  await ok('POST', `/approvals/${opened.approval.id}/decide`, session, { code: opened.code, decision: 'approved' });
  return opened.approval.id;
}

/** A connected bridge that records every frame it receives. */
async function connect(session: Session, after?: number) {
  const frames: ServerFrame[] = [];
  const socket = (await app.injectWS(`/ws${after === undefined ? '' : `?after=${after}`}`, {
    headers: { authorization: `Bearer ${session.token}` },
  }, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
  })) as unknown as WebSocket;
  sockets.push(socket);
  const entries = () => frames.flatMap((f) => (f.type === 'entries' ? f.entries : []));
  const types = () => entries().map((e: DeliveredEntry) => e.entry.type);
  return { socket, frames, entries, types };
}

/** Lets pending socket frames arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('membership', () => {
  it('creates a project, joins by invite and lists members', async () => {
    const { asha } = await team();
    const { members } = await ok('GET', `/projects/${asha.projectId}/members`, asha);
    expect(members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(['asha:frontend', 'ravi:backend', 'mei:backend']);
    const me = await ok('GET', '/me', asha);
    expect(me.project.name).toBe('shop-app');
  });

  it('rejects a taken name, an unknown code and invalid input', async () => {
    const { invite } = await team();
    expect((await call('POST', '/join', null, { code: invite, name: 'RAVI', role: 'backend' })).status).toBe(409);
    expect((await call('POST', '/join', null, { code: 'inv_nope', name: 'zed', role: 'backend' })).status).toBe(404);
    const invalid = await call('POST', '/join', null, { code: invite, name: 'has spaces', role: 'designer' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_REQUEST');
  });

  it('needs a valid token, and leaving revokes it', async () => {
    const { asha, ravi } = await team();
    expect((await call('GET', '/me', null)).status).toBe(401);
    expect((await call('GET', '/me', { ...asha, token: 'tk_forged' })).status).toBe(401);
    expect((await call('DELETE', '/me', ravi)).status).toBe(204);
    expect((await call('GET', '/me', ravi)).status).toBe(401);
  });

  it("another project's routes look absent", async () => {
    const { asha } = await team();
    const other = await ok('POST', '/projects', null, { name: 'other', memberName: 'eve', role: 'backend' });
    expect((await call('GET', `/projects/${other.project.id}/members`, asha)).status).toBe(404);
  });
});

describe('negotiation over HTTP', () => {
  it('runs the main flow and returns protocol errors with code and state', async () => {
    const { asha, ravi } = await team();
    const opened = await ok('POST', '/messages', asha, { ...draft(asha, 'requirements', ''), title: 'Orders list' });
    const thread = opened.thread.id as string;
    expect(opened.thread.snapshot.state).toBe('requested');

    await ok('POST', `/threads/${thread}/claim`, ravi);
    const refused = await call('POST', '/messages', ravi, draft(ravi, 'inventory_and_plan', thread));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', state: 'planning' });

    await ok('POST', '/messages', ravi, draft(ravi, 'inventory_and_plan', thread, { approval_id: await approve(ravi, thread, 'plan') }));
    await ok('POST', '/messages', ravi, draft(ravi, 'contract', thread, { approval_id: await approve(ravi, thread, 'send') }));
    await ok('POST', '/messages', asha, draft(asha, 'satisfied', thread));
    await approve(asha, thread, 'integration');
    await ok('POST', '/messages', asha, draft(asha, 'integrated', thread, { to: { project: true } }));

    const { thread: final, entries } = await ok('GET', `/threads/${thread}`, asha);
    expect(final.snapshot.state).toBe('integrated');
    expect(entries).toHaveLength(9);
    const { threads } = await ok('GET', `/projects/${asha.projectId}/threads?state=integrated`, ravi);
    expect(threads.map((t: { id: string }) => t.id)).toEqual([thread]);
  });

  it('the approval code is never stored, and a wrong one is refused', async () => {
    const { asha, ravi } = await team();
    const thread = (await ok('POST', '/messages', asha, draft(asha, 'requirements', ''))).thread.id;
    await ok('POST', `/threads/${thread}/claim`, ravi);
    const opened = await ok('POST', '/approvals', ravi, { threadId: thread, gate: 'plan', planHash: 'h' });
    expect(opened.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(JSON.stringify(store.db.all('SELECT * FROM approvals'))).not.toContain(opened.code);
    expect((await call('POST', `/approvals/${opened.approval.id}/decide`, ravi, { code: 'AAAAA-AAAAA', decision: 'approved' })).status).toBe(400);
    // Typed in lower case without the dash still works.
    const typed = opened.code.replace('-', '').toLowerCase();
    await ok('POST', `/approvals/${opened.approval.id}/decide`, ravi, { code: typed, decision: 'approved' });
  });

  it('the sender cannot be forged', async () => {
    const { asha, ravi } = await team();
    const body = draft(asha, 'requirements', '');
    (body.header as Record<string, unknown>).from = { member: ravi.memberId, role: 'backend' };
    const created = await ok('POST', '/messages', asha, body);
    expect(created.entries[0].header.from).toEqual({ member: asha.memberId, role: 'frontend' });
  });
});

describe('delivery over WebSocket', () => {
  it('routes live entries: role inbox before a claim, owners after', async () => {
    const { asha, ravi, mei } = await team();
    const ashaWs = await connect(asha);
    const raviWs = await connect(ravi);
    const meiWs = await connect(mei);

    const thread = (await ok('POST', '/messages', asha, draft(asha, 'requirements', ''))).thread.id;
    await ok('POST', `/threads/${thread}/claim`, ravi);
    await ok('POST', '/messages', ravi, draft(ravi, 'question', thread));
    await settle();

    expect(raviWs.types()).toEqual(['requirements', 'claimed', 'question']);
    // mei saw the open thread and that ravi took it, but not the owners' conversation.
    expect(meiWs.types()).toEqual(['requirements', 'claimed']);
    expect(ashaWs.types()).toEqual(['requirements', 'claimed', 'question']);
    expect(raviWs.entries()[2]!.thread.snapshot.backendOwner).toBe(ravi.memberId);
  });

  it('a reconnecting bridge catches up from its cursor and acks move it', async () => {
    const { asha, ravi } = await team();
    const thread = (await ok('POST', '/messages', asha, draft(asha, 'requirements', ''))).thread.id;
    await ok('POST', `/threads/${thread}/claim`, ravi);

    const first = await connect(ravi);
    await settle();
    expect(first.frames[0]).toMatchObject({ type: 'hello', cursor: 0 });
    expect(first.types()).toEqual(['requirements', 'claimed']);
    const lastSeq = first.entries().at(-1)!.entry.seq;
    first.socket.send(JSON.stringify({ type: 'ack', seq: lastSeq }));
    await settle();
    first.socket.terminate();

    await ok('POST', '/messages', asha, draft(asha, 'question', thread));
    const second = await connect(ravi);
    await settle();
    expect(second.frames[0]).toMatchObject({ type: 'hello', cursor: lastSeq });
    expect(second.types()).toEqual(['question']);

    // A bridge with its own cache can ask for an earlier point.
    const replay = await connect(ravi, 0);
    await settle();
    expect(replay.types()).toEqual(['requirements', 'claimed', 'question']);
  });

  it('refuses the upgrade without a token, and closes sockets on revoke', async () => {
    const { ravi } = await team();
    await expect(app.injectWS('/ws')).rejects.toThrow();

    const ws = await connect(ravi);
    const closed = new Promise<number>((resolve) => ws.socket.on('close', (code) => resolve(code)));
    await ok('DELETE', '/me', ravi);
    expect(await closed).toBe(CLOSE_REVOKED);
  });

  it('answers a malformed frame without dropping the connection', async () => {
    const { ravi } = await team();
    const ws = await connect(ravi);
    ws.socket.send('not json');
    await settle();
    expect(ws.frames.at(-1)).toMatchObject({ type: 'error' });
    expect(ws.socket.readyState).toBe(ws.socket.OPEN);
  });
});
