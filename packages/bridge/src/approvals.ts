import { createHash } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CLI_NAME, type ApprovalView, type Gate } from '@tool/protocol';
import type { ApprovalPrompt } from './approval-dialog.js';
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
  /** A window with Approve / Reject buttons on the developer's desktop, when available. */
  prompt?: ApprovalPrompt;
  /** How long one tool call waits for a decision before returning `pending`. */
  waitMs: number;
  pollMs: number;
  /** The repo the developer must run the fallback command in; shown in the notice. */
  repoRoot?: string;
}

const GATE_LABEL: Record<Gate, string> = {
  plan: 'backend plan',
  send: 'sending the contract',
  integration: 'frontend integration plan',
};

/**
 * Collects a developer's gate decision without letting the agent make it (spec, "Gate approvals").
 * The relay returns a one-time code to the bridge, which asks the developer, in order:
 * 1. through MCP elicitation, in the agent's own UI, when the client supports it;
 * 2. in a window on their desktop with Approve / Reject buttons;
 * 3. by a notification carrying the code, for `approve` in a terminal (the fallback).
 * In 1 and 2 the bridge submits the code itself. The code is never put in a tool result.
 */
export class Approvals {
  constructor(private readonly o: ApprovalOptions) {}

  /** One-time codes of approvals this bridge opened, so a resumed wait can show the window again. */
  private readonly open = new Map<string, { code: string; gate: Gate; plan: string; title: string }>();

  async request(input: { threadId: string; gate: Gate; plan: string; title: string }): Promise<ApprovalOutcome> {
    const planHash = `sha256:${createHash('sha256').update(input.plan).digest('hex')}`;
    const { approval, code } = await this.o.relay.openApproval({ threadId: input.threadId, gate: input.gate, planHash });
    this.o.cache.savePlan({ approvalId: approval.id, threadId: input.threadId, gate: input.gate, plan: input.plan });
    this.open.set(approval.id, { code, gate: input.gate, plan: input.plan, title: input.title });

    if (this.o.server.getClientCapabilities()?.elicitation) {
      const decided = await this.elicit(approval, code, input);
      if (decided) return decided;
    }

    // The fallback, in case the window is dismissed or cannot be shown.
    const where = this.o.repoRoot ? `In ${this.o.repoRoot}, run:` : 'In this repo, run:';
    this.o.notifier.notify({
      title: `Approval needed: ${GATE_LABEL[input.gate]}`,
      message: `"${input.title}". Code ${code}. ${where} ${CLI_NAME} approve ${approval.id} --code ${code}`,
    });
    return this.decide(approval.id);
  }

  /** Continues waiting on an approval requested earlier, showing the window again if this bridge opened it. */
  resume(approvalId: string): Promise<ApprovalOutcome> {
    return this.decide(approvalId);
  }

  /** Waits for the first decision: from the window, or from the CLI (seen by polling the relay). */
  private async decide(approvalId: string): Promise<ApprovalOutcome> {
    const known = this.open.get(approvalId);
    const window =
      known && this.o.prompt
        ? this.o.prompt({
            title: `Approval needed: ${GATE_LABEL[known.gate]}`,
            heading: `Your agent asks you to approve the ${GATE_LABEL[known.gate]} for "${known.title}". Read the plan, then decide.`,
            plan: known.plan,
          })
        : undefined;

    let stopWaiting = false;
    const fromWindow = (window?.result ?? Promise.resolve(undefined)).then(async (choice) => {
      if (!choice) return undefined;
      try {
        await this.o.relay.decide(approvalId, { code: known!.code, decision: choice.decision, ...(choice.note && { note: choice.note }) });
      } catch (error) {
        // Already decided from the CLI, or the relay is briefly unreachable: polling settles it.
        if (!(error instanceof RelayError)) return undefined;
      }
      return this.status(approvalId);
    });

    try {
      return await Promise.race([
        this.wait(approvalId, () => stopWaiting),
        // A dismissed window ("Later") leaves the CLI path open, so only a decision wins the race.
        fromWindow.then((outcome) => outcome ?? new Promise<never>(() => {})),
      ]);
    } finally {
      stopWaiting = true;
      window?.close();
      const outcome = await this.status(approvalId).catch(() => undefined);
      if (outcome && outcome.status !== 'pending') this.open.delete(approvalId);
    }
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

  private async wait(approvalId: string, stopped: () => boolean = () => false): Promise<ApprovalOutcome> {
    const deadline = Date.now() + this.o.waitMs;
    for (;;) {
      const outcome = await this.status(approvalId);
      if (outcome.status !== 'pending' || Date.now() >= deadline || stopped()) return outcome;
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
