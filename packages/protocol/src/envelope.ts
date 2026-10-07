import { z } from 'zod';
import { MESSAGE_TYPES, PAYLOAD_SCHEMAS, type MessageType } from './messages.js';
import { ROLES } from './roles.js';

/**
 * Everything the relay needs to route a message and enforce the rules.
 * Never encrypted, so it must not carry content (spec, "Message envelope").
 */
export const Header = z.object({
  id: z.string(),
  project: z.string(),
  thread: z.string(),
  type: z.enum(MESSAGE_TYPES),
  /** Set and signed by the relay; whatever the bridge sends here is discarded. */
  from: z.object({ member: z.string(), role: z.enum(ROLES) }),
  to: z.union([
    z.object({ role: z.enum(ROLES) }),
    z.object({ member: z.string() }),
    z.object({ project: z.literal(true) }),
  ]),
  in_reply_to: z.string().nullable(),
  approval_id: z.string().nullable(),
  supersedes: z.string().nullable(),
  created_at: z.iso.datetime(),
});

export type Header = z.infer<typeof Header>;

/** Payload is JSON until Milestone 4, then a ciphertext string. */
export const Envelope = z.object({
  header: Header,
  payload: z.union([z.record(z.string(), z.unknown()), z.string()]),
});

export type Envelope = z.infer<typeof Envelope>;

/** Validates a decoded payload against its message type. Runs on the bridges, not the relay. */
export function parsePayload<T extends MessageType>(type: T, payload: unknown) {
  return PAYLOAD_SCHEMAS[type].safeParse(payload);
}
