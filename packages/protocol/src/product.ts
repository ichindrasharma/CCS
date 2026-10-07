/**
 * The product name is still open (spec, open decision #1). Every user-facing mention of the
 * command goes through these constants, so renaming is a one-line change.
 */
export const CLI_NAME = 'tool';

/** The name the bridge is registered under in each agent's MCP configuration. */
export const BRIDGE_SERVER_NAME = `${CLI_NAME}-bridge`;

/** Set to `off` to silence the bridge's desktop notifications (CI, headless machines, tests). */
export const NOTIFICATIONS_ENV = `${CLI_NAME.toUpperCase()}_NOTIFICATIONS`;
