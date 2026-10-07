// The local MCP server each agent launches. Layout: doc/Architecture and Project Structure.md, "Package: bridge".
export { Approvals, type ApprovalOutcome } from './approvals.js';
export { credentialKey, credentialsPath, loadConfig, type BridgeConfig } from './config.js';
export { createBridge, runStdioBridge, type Bridge, type BridgeOptions } from './main.js';
export { desktopNotifier, type Notice, type Notifier } from './notify.js';
export { RelayClient, RelayError, RelayUnreachable } from './relay-client/http.js';
export { BridgeCache } from './store/cache.js';
