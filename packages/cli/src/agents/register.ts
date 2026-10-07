import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRIDGE_SERVER_NAME } from '@tool/protocol';

export interface Registration {
  ok: boolean;
  message: string;
}

/**
 * How an agent starts the bridge: this same CLI, by absolute path, with `bridge --repo <root>`.
 * Using node and the script path directly means no global install or PATH setup is needed.
 */
export function bridgeCommand(repoRoot: string): { command: string; args: string[] } {
  const entry = fileURLToPath(new URL('../bin.js', import.meta.url));
  return { command: process.execPath, args: [entry, 'bridge', '--repo', repoRoot] };
}

/**
 * Registers the bridge with Claude Code for this repo only (`--scope local`: kept in the user's
 * Claude Code settings, not in a committed file). Falls back to printing a config for other agents.
 */
export function registerAgent(repoRoot: string): Registration {
  // Claude Code keys local settings by the project's full path; resolve short (8.3) names and links.
  const root = realpathSync.native(repoRoot);
  const { command, args } = bridgeCommand(root);
  const claude = (claudeArgs: string[]) => spawnSync('claude', claudeArgs, { cwd: root, encoding: 'utf8', windowsHide: true });

  // Replace any earlier registration, e.g. after moving the repo or rejoining.
  claude(['mcp', 'remove', '--scope', 'local', BRIDGE_SERVER_NAME]);
  const added = claude(['mcp', 'add', '--scope', 'local', BRIDGE_SERVER_NAME, '--', command, ...args]);
  if (!added.error && added.status === 0) {
    return { ok: true, message: `Registered the bridge with Claude Code as "${BRIDGE_SERVER_NAME}" for this repo. Restart Claude Code here to load it.` };
  }
  return { ok: false, message: manualInstructions(root, added.error ? 'Claude Code was not found on PATH.' : added.stderr.trim()) };
}

export function manualInstructions(repoRoot: string, reason: string): string {
  const { command, args } = bridgeCommand(repoRoot);
  const config = { mcpServers: { [BRIDGE_SERVER_NAME]: { command, args } } };
  return [
    `Could not register the bridge automatically. ${reason}`,
    'Add this MCP server to your agent (Codex, Gemini CLI and others accept the same command):',
    JSON.stringify(config, null, 2),
  ].join('\n');
}
