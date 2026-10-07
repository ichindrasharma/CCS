import type { ApiError, ThreadState } from '@tool/protocol';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Result, ServiceError } from '../domain/thread-service.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly state: ThreadState | null = null,
  ) {
    super(message);
  }

  toBody(): ApiError {
    return { error: { code: this.code, message: this.message, state: this.state } };
  }
}

const STATUS: Record<ServiceError['code'], number> = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_TARGET: 400,
  WRONG_ROLE: 403,
  NOT_OWNER: 403,
  WRONG_STATE: 409,
  ALREADY_CLAIMED: 409,
  APPROVAL_REQUIRED: 409,
  THREAD_CLOSED: 409,
};

/** Validates a body or query; failures become a 400 the agent can read and fix. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw new HttpError(400, 'INVALID_REQUEST', z.prettifyError(result.error));
  return result.data;
}

/** Unwraps a service result, or throws it as an HTTP error that keeps the protocol code and state. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const { code, message, state } = result.error;
  throw new HttpError(STATUS[code], code, message, state);
}

export function sendError(reply: FastifyReply, error: HttpError): FastifyReply {
  return reply.status(error.status).send(error.toBody());
}
