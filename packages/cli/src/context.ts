import { createInterface } from 'node:readline/promises';
import { findRepoRoot, loadConfig, RelayClient, type BridgeConfig } from '@tool/bridge';
import { CLI_NAME } from '@tool/protocol';

export interface Io {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  /**
   * Asks the person at the terminal. Undefined when stdin or stdout is not a terminal, which is
   * how an agent's shell looks; commands that need a human refuse to run without it.
   */
  prompt?: (question: string) => Promise<string>;
}

export function processIo(): Io {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    cwd: process.cwd(),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    ...(interactive && {
      prompt: async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return (await rl.question(question)).trim();
        } finally {
          rl.close();
        }
      },
    }),
  };
}

/** An error whose message is meant for the user as-is. */
export class CliError extends Error {}

export interface RepoContext {
  root: string;
  config: BridgeConfig;
  relay: RelayClient;
}

/** The repo this command runs in, with its member config and an authenticated relay client. */
export function repoContext(io: Io): RepoContext {
  const root = findRepoRoot(io.cwd);
  if (!root) throw new CliError(`This directory is not set up. Run \`${CLI_NAME} init\` or \`${CLI_NAME} join\` in your repo first.`);
  const config = loadConfig(root);
  return { root, config, relay: new RelayClient(config.relayUrl, config.token) };
}

export function requireHuman(io: Io, action: string): (question: string) => Promise<string> {
  if (!io.prompt) {
    throw new CliError(`${action} must be done by a developer in an interactive terminal, not by an agent or a script.`);
  }
  return io.prompt;
}
