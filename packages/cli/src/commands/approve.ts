import { BridgeCache } from '@tool/bridge';
import type { Gate } from '@tool/protocol';
import { CliError, repoContext, requireHuman, type Io } from '../context.js';

const GATE_LABEL: Record<Gate, string> = {
  plan: 'Backend plan',
  send: 'Send the contract',
  integration: 'Frontend integration plan',
};

/**
 * The developer's side of a gate (spec, "Gate approvals"). It shows the exact plan the agent
 * submitted, then needs the one-time code from the desktop notification and a typed confirmation.
 * It refuses to run without an interactive terminal, so an agent cannot approve its own plan.
 */
export async function decide(
  io: Io,
  approvalId: string,
  decision: 'approved' | 'rejected',
  options: { code?: string; note?: string },
): Promise<void> {
  const ask = requireHuman(io, decision === 'approved' ? 'Approving a plan' : 'Rejecting a plan');
  const { config, relay } = repoContext(io);

  const { approval } = await relay.approval(approvalId);
  if (approval.status !== 'pending') throw new CliError(`This approval is already ${approval.status}.`);
  const { thread } = await relay.thread(approval.threadId);

  const cache = new BridgeCache(config.dataDir);
  const saved = cache.getPlan(approvalId);
  cache.close();

  io.out(`${GATE_LABEL[approval.gate]} for "${thread.title}" (${thread.id}, round ${approval.round})`);
  io.out('─'.repeat(60));
  io.out(saved?.plan ?? '(The plan is not stored in this repo, so it cannot be shown. Ask your agent to show it before you decide.)');
  io.out('─'.repeat(60));

  const note = decision === 'rejected' ? (options.note ?? (await ask('Note for the agent (what to change, optional): '))) : options.note;
  const code = options.code ?? (await ask('Code from the notification: '));
  if (!code) throw new CliError('No code entered; nothing was decided.');
  if (decision === 'approved') {
    const confirm = await ask('Approve this plan? [y/N] ');
    if (!/^y(es)?$/i.test(confirm)) return void io.out('Not approved. The agent keeps waiting until you decide.');
  }

  const result = await relay.decide(approvalId, { code, decision, ...(note && { note }) });
  io.out(
    decision === 'approved'
      ? `Approved. The thread is ${result.thread.snapshot.state}; your agent can continue.`
      : 'Rejected. Your agent will revise the plan and ask again.',
  );
}
