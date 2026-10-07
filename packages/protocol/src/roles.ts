export const ROLES = ['frontend', 'backend'] as const;

export type Role = (typeof ROLES)[number];

/** Agent tools exposed by the bridge (spec, "Tools by role"). */
export const TOOL_NAMES = [
  'send_requirements',
  'send_gap_list',
  'confirm_satisfied',
  'mark_integrated',
  'claim_thread',
  'send_inventory_and_plan',
  'send_contract',
  'request_approval',
  'check_inbox',
  'get_thread',
  'list_threads',
  'list_members',
  'hand_off_thread',
  'ask_question',
  'answer_question',
  'escalate',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const SHARED_TOOLS = [
  'request_approval',
  'check_inbox',
  'get_thread',
  'list_threads',
  'list_members',
  'hand_off_thread',
  'ask_question',
  'answer_question',
  'escalate',
] as const satisfies readonly ToolName[];

/** The bridge registers only these tools for a member's role. */
export const TOOLS_BY_ROLE: Record<Role, readonly ToolName[]> = {
  frontend: [
    'send_requirements',
    'send_gap_list',
    'confirm_satisfied',
    'mark_integrated',
    ...SHARED_TOOLS,
  ],
  backend: ['claim_thread', 'send_inventory_and_plan', 'send_contract', ...SHARED_TOOLS],
};
