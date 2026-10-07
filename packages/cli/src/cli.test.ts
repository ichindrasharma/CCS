import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BridgeCache, credentialsPath, loadConfig, RelayClient } from '@tool/bridge';
import { TOOLS_BY_ROLE } from '@tool/protocol';
import { buildRelay, openStore, type Store } from '@tool/relay';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from './context.js';
import { run } from './program.js';

let store: Store;
let relayApp: FastifyInstance;
let relayUrl: string;
let home: string;
let frontendRepo: string;
let backendRepo: string;
const savedEnv = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
const registered: string[] = [];

beforeEach(async () => {
  store = openStore({ path: ':memory:' });
  relayApp = (await buildRelay(store)).app;
  relayUrl = await relayApp.listen({ port: 0, host: '127.0.0.1' });
  home = mkdtempSync(join(tmpdir(), 'cli-home-'));
  frontendRepo = mkdtempSync(join(tmpdir(), 'cli-fe-'));
  backendRepo = mkdtempSync(join(tmpdir(), 'cli-be-'));
  // Credentials go to a throwaway profile, never the developer's real one.
  process.env.APPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  registered.length = 0;
});

afterEach(async () => {
  await relayApp.close();
  store.db.close();
  process.env.APPDATA = savedEnv.APPDATA;
  process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of [home, frontendRepo, backendRepo]) rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI in a repo. `answers` are typed at prompts; without them the terminal is not interactive. */
async function cli(cwd: string, args: string[], answers?: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...(answers ?? [])];
  const io: Io = {
    cwd,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ...(answers && { prompt: async (q: string) => (out.push(q), queue.shift() ?? '') }),
  };
  const code = await run(args, io, { register: (root) => (registered.push(root), { ok: true, message: 'registered (test)' }) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function setUpTeam() {
  const created = await cli(frontendRepo, ['init', '--relay', `${relayUrl}/`, '--project', 'shop-app', '--name', 'asha', '--role', 'frontend']);
  expect(created.code, created.err).toBe(0);
  const code = /^\s+(inv_\S+)$/m.exec(created.out)![1]!;
  const joined = await cli(backendRepo, ['join', '--relay', relayUrl, '--code', code, '--name', 'ravi', '--role', 'backend']);
  expect(joined.code, joined.err).toBe(0);
  const fe = loadConfig(frontendRepo);
  const be = loadConfig(backendRepo);
  return { created, fe, be, feRelay: new RelayClient(fe.relayUrl, fe.token), beRelay: new RelayClient(be.relayUrl, be.token) };
}

/** What the bridge does when an agent calls request_approval: open it and keep the plan locally. */
async function pendingApproval(team: Awaited<ReturnType<typeof setUpTeam>>) {
  const draft = {
    header: { project: team.fe.projectId, thread: '', type: 'requirements' as const, to: { role: 'backend' as const }, in_reply_to: null, approval_id: null, supersedes: null },
    payload: { body: 'Needs GET /orders', contract: {} },
    title: 'Orders list',
  };
  const threadId = (await team.feRelay.submit(draft)).thread.id;
  await team.beRelay.claim(threadId);
  const { approval, code } = await team.beRelay.openApproval({ threadId, gate: 'plan', planHash: 'sha256:x' });
  const cache = new BridgeCache(team.be.dataDir);
  cache.savePlan({ approvalId: approval.id, threadId, gate: 'plan', plan: 'Add a status filter to GET /orders.' });
  cache.close();
  return { threadId, approvalId: approval.id, code };
}

describe('init and join', () => {
  it('sets up both repos, keeps tokens out of the repo, and git-ignores the data dir', async () => {
    const { created, fe, be } = await setUpTeam();
    expect(created.out).toContain('Created project "shop-app". You are asha (frontend).');
    expect(created.out).toContain(`tool join --relay ${relayUrl} --code inv_`);
    expect(fe).toMatchObject({ relayUrl, name: 'asha', role: 'frontend' });
    expect(be).toMatchObject({ relayUrl, name: 'ravi', role: 'backend', projectId: fe.projectId });

    const repoConfig = readFileSync(join(frontendRepo, '.tool', 'config.json'), 'utf8');
    expect(repoConfig).not.toContain(fe.token);
    expect(readFileSync(credentialsPath(), 'utf8')).toContain(fe.token);
    expect(readFileSync(join(frontendRepo, '.gitignore'), 'utf8')).toBe('.tool/\n');
    expect(registered).toEqual([frontendRepo, backendRepo]);

    const members = await cli(frontendRepo, ['members']);
    expect(members.out).toMatch(/asha\s+frontend\s+\(you\)\nravi\s+backend/);
  });

  it('refuses to overwrite a setup, and --no-register skips registration', async () => {
    await setUpTeam();
    const again = await cli(frontendRepo, ['init', '--relay', relayUrl, '--project', 'x', '--name', 'asha', '--role', 'frontend']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already set up');

    const other = mkdtempSync(join(tmpdir(), 'cli-other-'));
    try {
      const result = await cli(other, ['init', '--relay', relayUrl, '--project', 'y', '--name', 'lee', '--role', 'frontend', '--no-register']);
      expect(result.out).toContain('Skipped agent registration');
      expect(registered).not.toContain(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports a bad invite code and an invalid role clearly', async () => {
    const bad = await cli(backendRepo, ['join', '--relay', relayUrl, '--code', 'inv_nope', '--name', 'ravi', '--role', 'backend']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('unknown, used up or expired');
    const role = await cli(backendRepo, ['join', '--relay', relayUrl, '--code', 'x', '--name', 'ravi', '--role', 'designer']);
    expect(role.code).not.toBe(0);
    expect(role.err).toContain('Allowed choices are frontend, backend');
  });

  it('reports an unreachable relay', async () => {
    const result = await cli(frontendRepo, ['init', '--relay', 'http://127.0.0.1:9', '--project', 'p', '--name', 'a', '--role', 'frontend']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('unreachable');
  });
});

describe('approve and reject', () => {
  it('shows the stored plan, needs the code and a confirmation, then approves', async () => {
    const team = await setUpTeam();
    const { approvalId, code } = await pendingApproval(team);
    const result = await cli(backendRepo, ['approve', approvalId], [code, 'y']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('Backend plan for "Orders list"');
    expect(result.out).toContain('Add a status filter to GET /orders.');
    expect(result.out).toContain('Approved.');
    expect((await team.beRelay.approval(approvalId)).approval.status).toBe('approved');
  });

  it('refuses without an interactive terminal, so an agent cannot approve', async () => {
    const team = await setUpTeam();
    const { approvalId, code } = await pendingApproval(team);
    const result = await cli(backendRepo, ['approve', approvalId, '--code', code]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('interactive terminal');
    expect((await team.beRelay.approval(approvalId)).approval.status).toBe('pending');
  });

  it('does nothing unless the developer confirms, and refuses a wrong code', async () => {
    const team = await setUpTeam();
    const { approvalId, code } = await pendingApproval(team);
    expect((await cli(backendRepo, ['approve', approvalId], [code, 'n'])).out).toContain('Not approved');
    const wrong = await cli(backendRepo, ['approve', approvalId], ['AAAAA-AAAAA', 'y']);
    expect(wrong.code).toBe(1);
    expect((await team.beRelay.approval(approvalId)).approval.status).toBe('pending');
  });

  it('rejects with a note for the agent', async () => {
    const team = await setUpTeam();
    const { approvalId, code } = await pendingApproval(team);
    const result = await cli(backendRepo, ['reject', approvalId, '--note', 'Reuse the existing filter.'], [code]);
    expect(result.code, result.err).toBe(0);
    expect((await team.beRelay.approval(approvalId)).approval).toMatchObject({ status: 'rejected', note: 'Reuse the existing filter.' });
  });

  it("another member's approval looks absent", async () => {
    const team = await setUpTeam();
    const { approvalId, code } = await pendingApproval(team);
    const result = await cli(frontendRepo, ['approve', approvalId], [code, 'y']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('NOT_FOUND');
  });
});

describe('threads, resume and leave', () => {
  it('lists threads, shows the trail, and resumes an escalated thread', async () => {
    const team = await setUpTeam();
    const { threadId } = await pendingApproval(team);
    await team.feRelay.submit({
      header: { project: team.fe.projectId, thread: threadId, type: 'escalate', to: { role: 'backend' }, in_reply_to: null, approval_id: null, supersedes: null },
      payload: { body: 'We disagree on pagination.' },
    });

    const list = await cli(backendRepo, ['threads']);
    expect(list.out).toMatch(new RegExp(`${threadId}\\s+escalated\\s+Orders list\\s+\\(frontend asha, backend ravi\\)`));
    const trail = await cli(backendRepo, ['thread', threadId]);
    expect(trail.out).toContain('asha  requirements: Needs GET /orders');
    expect(trail.out).toContain('ravi  [claimed]');
    expect(trail.out).toContain('asha  escalate: We disagree on pagination.');

    const resumed = await cli(backendRepo, ['resume', threadId]);
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.out).toContain(': planning, round 0');
  });

  it('leave revokes the token and removes the local config', async () => {
    const team = await setUpTeam();
    const result = await cli(backendRepo, ['leave', '--yes']);
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(backendRepo, '.tool', 'config.json'))).toBe(false);
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain(team.be.token);
    await expect(team.beRelay.me()).rejects.toThrow();
    expect((await cli(backendRepo, ['members'])).err).toContain('not set up');
  });
});

describe('bridge command', () => {
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

  it.skipIf(!existsSync(bin))('runs as a real stdio MCP server, the way an agent starts it', async () => {
    await setUpTeam();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, 'bridge', '--repo', frontendRepo],
      env: { ...process.env, APPDATA: home, XDG_CONFIG_HOME: home } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual([...TOOLS_BY_ROLE.frontend].sort());
      const result = (await client.callTool({ name: 'list_members', arguments: {} })) as { content: { text: string }[] };
      expect(result.content[0]!.text).toBe('asha (frontend) ← you\nravi (backend)');
    } finally {
      await client.close();
    }
  }, 20_000);
});
