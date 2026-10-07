import type {
  ApiError,
  ApprovalView,
  Gate,
  LogEntry,
  MemberView,
  ProjectView,
  SubmitMessageRequest,
  ThreadState,
  ThreadView,
} from '@tool/protocol';
import type { z } from 'zod';

/** The relay answered with an error; `error` carries the protocol code and thread state. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError['error'],
  ) {
    super(error.message);
  }
}

/** The relay could not be reached at all. Messages are queued; other calls fail. */
export class RelayUnreachable extends Error {}

export type MessageDraft = z.input<typeof SubmitMessageRequest>;

export interface Change {
  thread: ThreadView;
  entries: LogEntry[];
}

/** Typed client for the relay API (doc: "Relay API"). */
export class RelayClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  me() {
    return this.request<{ member: MemberView; project: ProjectView }>('GET', '/me');
  }

  members(projectId: string) {
    return this.request<{ members: MemberView[] }>('GET', `/projects/${projectId}/members`);
  }

  threads(projectId: string, state?: ThreadState) {
    return this.request<{ threads: ThreadView[] }>('GET', `/projects/${projectId}/threads${state ? `?state=${state}` : ''}`);
  }

  thread(threadId: string) {
    return this.request<{ thread: ThreadView; entries: LogEntry[] }>('GET', `/threads/${threadId}`);
  }

  submit(draft: MessageDraft) {
    return this.request<Change>('POST', '/messages', draft);
  }

  claim(threadId: string) {
    return this.request<Change>('POST', `/threads/${threadId}/claim`);
  }

  handOff(threadId: string, to: string) {
    return this.request<Change>('POST', `/threads/${threadId}/hand-off`, { to });
  }

  openApproval(input: { threadId: string; gate: Gate; planHash: string }) {
    return this.request<{ approval: ApprovalView; code: string }>('POST', '/approvals', input);
  }

  approval(approvalId: string) {
    return this.request<{ approval: ApprovalView }>('GET', `/approvals/${approvalId}`);
  }

  decide(approvalId: string, input: { code: string; decision: 'approved' | 'rejected'; note?: string }) {
    return this.request<Change>('POST', `/approvals/${approvalId}/decide`, input);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(method === 'POST' && { 'content-type': 'application/json' }),
        },
        ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new RelayUnreachable(`The relay at ${this.baseUrl} is unreachable.`, { cause: error });
    }
    const json = (await response.json().catch(() => undefined)) as T | ApiError | undefined;
    if (!response.ok) {
      const error = (json as ApiError | undefined)?.error ?? { code: 'HTTP_' + response.status, message: response.statusText, state: null };
      throw new RelayError(response.status, error);
    }
    return json as T;
  }
}
