import { createHash } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ApprovalView, Gate } from '@tool/protocol';
import type { Notifier } from './notify.js';
import { RelayError, type RelayClient } from './relay-client/http.js';
import type { BridgeCache } from './store/cache.js';

export type ApprovalOutcome =
  | { status: 'approved'; approvalId: string }
  | { status: 'rejected'; approvalId: string; note: string | null }
  | { status: 'pending'; approvalId: string };

export interface ApprovalOptions {
  relay: RelayClient;
  cache: BridgeCache;
  notifier: Notifier;
  /** The MCP server, to ask the developer through elicitation when the client supports it. */
  server: Server;
  /** How long one tool call waits for a CLI decision before returning `pending`. */
  waitMs: number;
  pollMs: number;
}

const GATE_LABEL: Record<Gate, string> = {
  plan: 'backend plan',
  send: 'sending the contract',
  integration: 'frontend integration plan',
};

/**
 * Collects a developer's gate decision without letting the agent make it (spec, "Gate approvals").
 * The relay returns a one-time code to the bridge. The bridge either asks the developer directly
 * through MCP elicitation and submits the code itself, or shows the code by desktop notification
 * for the developer to type into `tool approve`. The code is never put in a tool result.
 */
export class Approvals {
  constructor(private readonly o: ApprovalOptions) {}

  async request(input: { threadId: string; gate: Gate; plan: string; title: string }): Promise<ApprovalOutcome> {
    const planHash = `sha256:${createHash('sha256').update(input.plan).digest('hex')}`;
    const { approval, code } = await this.o.relay.openApproval({ threadId: input.threadId, gate: input.gate, planHash });
    this.o.cache.savePlan({ approvalId: approval.id, threadId: input.threadId, gate: input.gate, plan: input.plan });

    if (this.o.server.getClientCapabilities()?.elicitation) {
      const decided = await this.elicit(approval, code, input);
      if (decided) return decided;
    }

    this.o.notifier.notify({
      title: `Approval needed: ${GATE_LABEL[input.gate]}`,
      message: `"${input.title}". Review the plan, then run: tool approve ${approval.id} --code ${code}`,
    });
    return this.wait(approval.id);
  }

  /** Continues waiting on an approval requested earlier. */
  resume(approvalId: string): Promise<ApprovalOutcome> {
    return this.wait(approvalId);
  }

  /** Returns undefined if the developer dismissed the prompt; the caller falls back to the CLI. */
  private async elicit(
    approval: ApprovalView,
    code: string,
    input: { gate: Gate; plan: string; title: string },
  ): Promise<ApprovalOutcome | undefined> {
    let result;
    try {
      result = await this.o.server.elicitInput({
        message: `Approve the ${GATE_LABEL[input.gate]} for "${input.title}"?\n\n${input.plan}`,
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', title: 'Decision', enum: ['approve', 'reject'] },
            note: { type: 'string', title: 'Note for the agent (optional)', description: 'Why, or what to change.' },
          },
          required: ['decision'],
        },
      });
    } catch {
      return undefined;
    }
    if (result.action === 'cancel') return undefined;
    const approve = result.action === 'accept' && result.content?.decision === 'approve';
    const note = typeof result.content?.note === 'string' && result.content.note ? result.content.note : undefined;
    await this.o.relay.decide(approval.id, {
      code,
      decision: approve ? 'approved' : 'rejected',
      ...(note !== undefined ? { note } : result.action === 'decline' ? { note: 'Declined in the approval prompt.' } : {}),
    });
    return this.status(approval.id);
  }

  private async wait(approvalId: string): Promise<ApprovalOutcome> {
    const deadline = Date.now() + this.o.waitMs;
    for (;;) {
      const outcome = await this.status(approvalId);
      if (outcome.status !== 'pending' || Date.now() >= deadline) return outcome;
      await new Promise((resolve) => setTimeout(resolve, this.o.pollMs));
    }
  }

  private async status(approvalId: string): Promise<ApprovalOutcome> {
    let approval: ApprovalView;
    try {
      ({ approval } = await this.o.relay.approval(approvalId));
    } catch (error) {
      if (error instanceof RelayError && error.status === 404) throw new Error(`Unknown approval ${approvalId}.`);
      throw error;
    }
    switch (approval.status) {
      case 'pending':
        return { status: 'pending', approvalId };
      case 'rejected':
        return { status: 'rejected', approvalId, note: approval.note };
      // The integration gate's approval is used up the moment it is decided.
      case 'approved':
      case 'consumed':
        return { status: 'approved', approvalId };
    }
  }
}
