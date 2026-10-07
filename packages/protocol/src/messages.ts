import { z } from 'zod';
import type { Role } from './roles.js';

/** The nine message types (spec, "Message types"). */
export const MESSAGE_TYPES = [
  'requirements',
  'inventory_and_plan',
  'contract',
  'gap_list',
  'satisfied',
  'integrated',
  'question',
  'answer',
  'escalate',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Which role may send each type; `null` means either role. */
export const SENDER_ROLE: Record<MessageType, Role | null> = {
  requirements: 'frontend',
  inventory_and_plan: 'backend',
  contract: 'backend',
  gap_list: 'frontend',
  satisfied: 'frontend',
  integrated: 'frontend',
  question: null,
  answer: null,
  escalate: null,
};

/** An OpenAPI 3.1 fragment. Checked loosely here; the `contract` package validates it fully. */
export const ContractFragment = z.record(z.string(), z.unknown());

export const RequirementStatus = z.enum(['available', 'mismatched', 'missing']);

const Classification = z.array(
  z.object({
    requirement: z.string(),
    status: RequirementStatus,
    note: z.string().optional(),
  }),
);

const prose = z.string().min(1);

/** Payload schema per message type. The relay never sees these when payloads are encrypted. */
export const PAYLOAD_SCHEMAS = {
  requirements: z.object({ body: prose, contract: ContractFragment }),
  inventory_and_plan: z.object({
    body: prose,
    classification: Classification,
    contract: ContractFragment,
    plan: prose,
    cannot_build: z.array(z.object({ requirement: z.string(), reason: prose, alternative: z.string().optional() })),
  }),
  contract: z.object({ body: prose, contract: ContractFragment, classification: Classification }),
  gap_list: z.object({
    body: prose,
    items: z.array(z.object({ requirement: z.string(), problem: prose })).min(1),
  }),
  satisfied: z.object({ body: z.string().optional() }),
  integrated: z.object({ body: z.string().optional() }),
  question: z.object({ body: prose }),
  answer: z.object({ body: prose }),
  escalate: z.object({ body: prose }),
} satisfies Record<MessageType, z.ZodType>;

export type Payload<T extends MessageType> = z.infer<(typeof PAYLOAD_SCHEMAS)[T]>;
