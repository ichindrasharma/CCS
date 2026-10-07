import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { CLI_NAME, ROLES, type Role } from '@tool/protocol';
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

/** `<repo>/.tool/config.json`, written by `init` / `join`. Never holds the token. */
const RepoConfig = z.object({
  relayUrl: z.url(),
  projectId: z.string(),
  memberId: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
});

export type RepoConfig = z.infer<typeof RepoConfig>;

const Credentials = z.record(z.string(), z.string());

export const DATA_DIR = `.${CLI_NAME}`;

export function credentialsPath(): string {
  return process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), CLI_NAME, 'credentials.json')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), CLI_NAME, 'credentials.json');
}

/** Tokens are keyed per relay, project and member, so one machine can hold several memberships. */
export function credentialKey(relayUrl: string, projectId: string, memberId: string): string {
  return `${normaliseRelayUrl(relayUrl)}#${projectId}#${memberId}`;
}

export function normaliseRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The nearest directory at or above `from` that holds a repo config. */
export function findRepoRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, DATA_DIR, 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return undefined;
    dir = parent;
  }
}

export function loadConfig(repoRoot: string): BridgeConfig {
  const dataDir = join(repoRoot, DATA_DIR);
  const repo = RepoConfig.parse(readJson(join(dataDir, 'config.json'), `Run \`${CLI_NAME} init\` or \`${CLI_NAME} join\` in this repo first.`));
  const credentials = readCredentials();
  const token = credentials[credentialKey(repo.relayUrl, repo.projectId, repo.memberId)];
  if (!token) throw new Error(`No token for member ${repo.name} on ${repo.relayUrl}. Run \`${CLI_NAME} join\` again.`);
  return { ...repo, relayUrl: normaliseRelayUrl(repo.relayUrl), token, dataDir };
}

/** Writes the repo config and makes sure `.tool/` is git-ignored, since it holds the local cache. */
export function writeRepoConfig(repoRoot: string, config: RepoConfig): void {
  const dataDir = join(repoRoot, DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  writeAtomic(join(dataDir, 'config.json'), `${JSON.stringify({ ...config, relayUrl: normaliseRelayUrl(config.relayUrl) }, null, 2)}\n`);

  const gitignore = join(repoRoot, '.gitignore');
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!current.split(/\r?\n/).some((line) => line.trim() === `${DATA_DIR}/` || line.trim() === DATA_DIR)) {
    appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}${DATA_DIR}/\n`);
  }
}

/** Stores a member token in the per-user file, readable only by this user on POSIX systems. */
export function saveCredential(relayUrl: string, projectId: string, memberId: string, token: string): void {
  const credentials = readCredentials();
  credentials[credentialKey(relayUrl, projectId, memberId)] = token;
  writeCredentials(credentials);
}

export function removeCredential(relayUrl: string, projectId: string, memberId: string): void {
  const credentials = readCredentials();
  delete credentials[credentialKey(relayUrl, projectId, memberId)];
  writeCredentials(credentials);
}

function readCredentials(): Record<string, string> {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  return Credentials.parse(readJson(path, 'The saved token file is unreadable.'));
}

function writeCredentials(credentials: Record<string, string>): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, `${JSON.stringify(credentials, null, 2)}\n`, 0o600);
}

function writeAtomic(path: string, content: string, mode?: number): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, mode === undefined ? {} : { mode });
  renameSync(temp, path);
}

function readJson(path: string, hint: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path}. ${hint}`, { cause: error });
  }
}
