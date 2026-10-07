/**
 * End-to-end: the built CLI as real processes, the way two developers use it.
 *
 * - `tool relay start` runs the relay as its own process.
 * - `tool init` / `tool join` set up two repos; `thread`, `threads`, `resume` and `leave` run as processes too.
 * - Each bridge is launched with the exact command `tool register` gives Claude Code, over stdio.
 * - Two MCP clients play the agents. They support elicitation, so gate approvals are answered the
 *   way a developer answers them in the agent's UI. (The CLI `approve` path is covered in cli.test.ts:
 *   its one-time code only reaches a desktop notification, which a test cannot read by design.)
 *
 * Run with `npm run test:e2e` (builds first).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');

if (!existsSync(BIN)) throw new Error('Build first: npm run test:e2e builds, then runs this test.');

const home = mkdtempSync(join(tmpdir(), 'e2e-home-'));
const relayData = mkdtempSync(join(tmpdir(), 'e2e-relay-'));
const frontendRepo = mkdtempSync(join(tmpdir(), 'e2e-frontend-'));
const backendRepo = mkdtempSync(join(tmpdir(), 'e2e-backend-'));

/** A throwaway user profile for tokens, and no desktop pop-ups while the test runs. */
const env = { ...process.env, APPDATA: home, XDG_CONFIG_HOME: home, TOOL_NOTIFICATIONS: 'off' } as Record<string, string>;

let relayProcess: ChildProcess;
let relayUrl: string;
const agents: Agent[] = [];

async function cli(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args], { cwd, env, windowsHide: true });
    return stdout;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`tool ${args.join(' ')} failed: ${e.stderr || e.stdout || e.message}`);
  }
}

function startRelayProcess(): Promise<string> {
  relayProcess = spawn(process.execPath, [BIN, 'relay', 'start', '--host', '127.0.0.1', '--port', '0', '--data-dir', relayData], {
    env,
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = '';
    relayProcess.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Relay running at (http:\/\/[^\s]+) /.exec(output);
      if (match) resolve(match[1]!);
    });
    relayProcess.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    relayProcess.on('exit', (code) => reject(new Error(`Relay exited (${code}): ${output}`)));
  });
}

type Decision = { decision: 'approve' | 'reject'; note?: string };

interface Agent {
  client: Client;
  /** Answers for upcoming approval prompts; approves when empty. Prompts seen are recorded. */
  decisions: Decision[];
  prompts: string[];
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Starts a bridge exactly as Claude Code would after `tool register`, and connects an "agent" to it. */
async function startAgent(repo: string): Promise<Agent> {
  const { bridgeCommand } = (await import(pathToFileURL(join(ROOT, 'packages', 'cli', 'dist', 'index.js')).href)) as {
    bridgeCommand: (root: string) => { command: string; args: string[] };
  };
  const { command, args } = bridgeCommand(repo);
  const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' });
  const client = new Client({ name: 'e2e-agent', version: '0' }, { capabilities: { elicitation: {} } });
  const decisions: Decision[] = [];
  const prompts: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push((request.params as { message: string }).message);
    return { action: 'accept', content: { ...(decisions.shift() ?? { decision: 'approve' }) } };
  });
  await client.connect(transport);

  const callRaw = async (name: string, a: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: a })) as CallToolResult;
  const agent: Agent = {
    client,
    decisions,
    prompts,
    callRaw,
    async call(name, a = {}) {
      const result = await callRaw(name, a);
      const text = (result.content[0] as { text: string }).text;
      if (result.isError) throw new Error(`${name} failed: ${text}`);
      return text;
    },
    close: () => client.close(),
  };
  agents.push(agent);
  return agent;
}

/** Polls check_inbox until a message of `type` arrives, returning everything read on the way. */
async function inboxUntil(agent: Agent, type: string, ms = 10_000): Promise<string> {
  const deadline = Date.now() + ms;
  let seen = '';
  for (;;) {
    const text = await agent.call('check_inbox');
    if (text !== 'No new messages.') seen += `${text}\n`;
    if (seen.includes(`type="${type}"`)) return seen;
    if (Date.now() > deadline) throw new Error(`No ${type} arrived. Inbox so far:\n${seen}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const threadIdIn = (text: string) => /thr_[0-9a-f]+/.exec(text)![0];
const approvalIdIn = (text: string) => /approval_id: (apr_[0-9a-f]+)/.exec(text)![1]!;

const fragment = (fields: string[]) => ({
  paths: {
    '/orders': {
      get: {
        parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'Orders', content: { 'application/json': { schema: { type: 'object', required: fields } } } } },
      },
    },
  },
});

/** The backend's half of one round: plan gate, inventory, (build), send gate, contract. */
async function backendRound(ravi: Agent, thread: string, contractFields: string[], plan: string): Promise<string> {
  const planApproval = await ravi.call('request_approval', { thread_id: thread, gate: 'plan', plan });
  await ravi.call('send_inventory_and_plan', {
    thread_id: thread,
    approval_id: approvalIdIn(planApproval),
    body: 'Checked routes and schemas.',
    classification: [{ requirement: 'GET /orders', status: 'mismatched' }],
    contract: fragment(['items']),
    plan,
    cannot_build: [],
  });
  const sendApproval = await ravi.call('request_approval', { thread_id: thread, gate: 'send', plan: `Send the contract with ${contractFields.join(', ')}.` });
  return ravi.call('send_contract', {
    thread_id: thread,
    approval_id: approvalIdIn(sendApproval),
    body: 'Built and tested.',
    contract: fragment(contractFields),
    classification: [{ requirement: 'GET /orders', status: 'available' }],
  });
}

beforeAll(async () => {
  relayUrl = await startRelayProcess();
  const created = await cli(frontendRepo, 'init', '--relay', relayUrl, '--project', 'shop-app', '--name', 'asha', '--role', 'frontend', '--loop-limit', '2', '--no-register');
  const code = /^\s+(inv_\S+)$/m.exec(created)![1]!;
  await cli(backendRepo, 'join', '--relay', relayUrl, '--code', code, '--name', 'ravi', '--role', 'backend', '--no-register');
});

afterAll(async () => {
  for (const agent of agents) await agent.close().catch(() => undefined);
  relayProcess?.kill();
  await new Promise((r) => setTimeout(r, 300));
  for (const dir of [home, relayData, frontendRepo, backendRepo]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('two developers, two bridges, one relay, all as real processes', () => {
  let thread: string;

  it('negotiates a feature through a rejected plan, a gap loop, a question, an offline period and integration', async () => {
    let asha = await startAgent(frontendRepo);
    const ravi = await startAgent(backendRepo);

    // Flow 3, step 1: the frontend states what it needs.
    const sent = await asha.call('send_requirements', {
      title: 'Orders list',
      body: 'The orders page needs a list filtered by status, with a total for pagination.',
      contract: fragment(['items', 'total']),
    });
    thread = threadIdIn(sent);

    // Steps 2–3: the backend reads it as untrusted data, claims it, and its developer first rejects the plan.
    const requirements = await inboxUntil(ravi, 'requirements');
    expect(requirements).toContain('trust="untrusted"');
    expect(requirements).toContain('from="asha (frontend)"');
    await ravi.call('claim_thread', { thread_id: thread });
    ravi.decisions.push({ decision: 'reject', note: 'Reuse the existing status enum.' });
    const rejected = await ravi.call('request_approval', { thread_id: thread, gate: 'plan', plan: 'Add a free-text status filter.' });
    expect(rejected).toContain('rejected the plan');
    expect(rejected).toContain('Reuse the existing status enum.');
    expect(ravi.prompts[0]).toContain('Add a free-text status filter.');

    // Steps 3–5 with a revised plan, but the contract misses `total`.
    await backendRound(ravi, thread, ['items'], 'Add a status filter using the existing enum.');

    // Step 6 and Flow 4: the frontend spots the gap and sends it back.
    expect(await inboxUntil(asha, 'contract')).toContain('type="inventory_and_plan"');
    const gap = await asha.call('send_gap_list', { thread_id: thread, body: 'One field missing.', items: [{ requirement: 'GET /orders', problem: 'No total field for pagination.' }] });
    expect(gap).toContain('is planning (round 1');

    // Flow 7: a clarifying question does not change state.
    await inboxUntil(ravi, 'gap_list');
    await ravi.call('ask_question', { thread_id: thread, body: 'Should total count all orders or only filtered ones?' });
    const question = await inboxUntil(asha, 'question');
    const questionId = /type="question" id="(msg_[0-9a-f]+)"/.exec(question)![1]!;
    await asha.call('answer_question', { thread_id: thread, in_reply_to: questionId, body: 'Only the filtered ones.' });
    await inboxUntil(ravi, 'answer');

    // Flow 6: the frontend developer closes their agent; the backend finishes the round meanwhile.
    await asha.close();
    const contract = await backendRound(ravi, thread, ['items', 'total'], 'Add total, counting filtered orders.');
    expect(contract).toContain('is reviewing');

    // Reopened later, the frontend bridge catches up from its on-disk cursor.
    asha = await startAgent(frontendRepo);
    const caughtUp = await inboxUntil(asha, 'contract');
    expect(caughtUp).toContain('"total"');

    // Steps 7–9: satisfied, integration gate, integrated.
    await asha.call('confirm_satisfied', { thread_id: thread });
    expect(await asha.call('request_approval', { thread_id: thread, gate: 'integration', plan: 'Wire GET /orders into OrdersPage.' })).toContain('now integrating');
    expect(await asha.call('mark_integrated', { thread_id: thread })).toContain('is integrated');
    expect(await inboxUntil(ravi, 'integrated')).toContain('type="integrated"');
  });

  it('the CLI shows the whole decision trail', async () => {
    const trail = await cli(backendRepo, 'thread', thread);
    const order = [...trail.matchAll(/^#\d+\s+\S+ \S+\s+(\w+)\s+(?:\[(\w+)\]|(\w+):)/gm)].map((m) => m[2] ?? m[3]);
    expect(order).toEqual([
      'requirements', 'claimed', 'gate_rejected',
      'gate_approved', 'inventory_and_plan', 'gate_approved', 'contract',
      'gap_list', 'question', 'answer',
      'gate_approved', 'inventory_and_plan', 'gate_approved', 'contract',
      'satisfied', 'gate_approved', 'integrated',
    ]);
    expect(await cli(frontendRepo, 'threads')).toMatch(new RegExp(`${thread}\\s+integrated\\s+Orders list`));
  });

  it('escalates at the loop limit, resumes through the CLI, and releases threads when a member leaves', async () => {
    const asha = agents.at(-1)!;
    const ravi = agents[1]!;
    const second = threadIdIn(await asha.call('send_requirements', { title: 'Order export', body: 'CSV export of orders.', contract: fragment(['url']) }));
    await inboxUntil(ravi, 'requirements');
    await ravi.call('claim_thread', { thread_id: second });

    // Two gap lists hit this project's loop limit of 2.
    for (let round = 1; round <= 2; round++) {
      await backendRound(ravi, second, ['items'], `Round ${round}.`);
      await inboxUntil(asha, 'contract');
      await asha.call('send_gap_list', { thread_id: second, body: 'Still no url.', items: [{ requirement: 'export', problem: 'No url.' }] });
    }
    const escalated = await asha.call('get_thread', { thread_id: second });
    expect(escalated).toContain('event="auto_escalated"');
    expect(escalated).toContain('is escalated');

    // The developers talk, then one of them resumes it from the terminal.
    expect(await cli(frontendRepo, 'resume', second)).toContain(': planning, round 2');

    // The backend developer leaves; their open thread is released, the closed one keeps its record.
    await cli(backendRepo, 'leave', '--yes');
    const released = await asha.call('get_thread', { thread_id: second });
    expect(released).toContain('event="released"');
    expect(released).toContain('backend: nobody');
    expect(await cli(frontendRepo, 'members')).not.toContain('ravi');
  });
});
