import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROLES, type Role } from '@tool/protocol';
import { z } from 'zod';

export interface BridgeConfig {
  relayUrl: string;
  token: string;
  projectId: string;
  memberId: string;
  name: string;
  role: Role;
  /** Where the cache lives: `<repo>/.tool`. */
  dataDir: string;
}

/** `<repo>/.tool/config.json`, written by `tool init` / `tool join`. Never holds the token. */
const RepoConfig = z.object({
  relayUrl: z.url(),
  projectId: z.string(),
  memberId: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
});

const Credentials = z.record(z.string(), z.string());

export function credentialsPath(): string {
  return process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'tool', 'credentials.json')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tool', 'credentials.json');
}

/** Tokens are keyed per relay, project and member, so one machine can hold several memberships. */
export function credentialKey(relayUrl: string, projectId: string, memberId: string): string {
  return `${relayUrl.replace(/\/+$/, '')}#${projectId}#${memberId}`;
}

export function loadConfig(repoRoot: string): BridgeConfig {
  const dataDir = join(repoRoot, '.tool');
  const repo = RepoConfig.parse(readJson(join(dataDir, 'config.json'), 'Run `tool init` or `tool join` in this repo first.'));
  const credentials = Credentials.parse(readJson(credentialsPath(), 'No saved member tokens on this machine.'));
  const token = credentials[credentialKey(repo.relayUrl, repo.projectId, repo.memberId)];
  if (!token) throw new Error(`No token for member ${repo.name} on ${repo.relayUrl}. Run \`tool join\` again.`);
  return { ...repo, relayUrl: repo.relayUrl.replace(/\/+$/, ''), token, dataDir };
}

function readJson(path: string, hint: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path}. ${hint}`, { cause: error });
  }
}
