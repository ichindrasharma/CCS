import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_DIR,
  normaliseRelayUrl,
  RelayClient,
  removeCredential,
  runStdioBridge,
  saveCredential,
  findRepoRoot,
  writeRepoConfig,
  type Membership,
} from '@tool/bridge';
import { CLI_NAME, type Role } from '@tool/protocol';
import { DEFAULT_RELAY_PORT, startRelay } from '@tool/relay';
import { registerAgent, type Registration } from '../agents/register.js';
import { CliError, repoContext, type Io } from '../context.js';

export interface SetupDeps {
  /** Replaced in tests so they do not touch the developer's agent settings. */
  register?: (repoRoot: string) => Registration;
}

export async function relayStart(io: Io, options: { port: string; host: string; dataDir?: string }): Promise<void> {
  const dataDir = options.dataDir ?? join(homedir(), `.${CLI_NAME}-relay`);
  const relay = await startRelay({ port: Number(options.port), host: options.host, dataDir, logger: false });
  io.out(`Relay running at ${relay.url} (data in ${dataDir}).`);
  io.out(`Give teammates a URL they can reach, e.g. http://<this machine's address>:${options.port}.`);
  io.out('It speaks plain HTTP: use it on a private network, or put a TLS proxy in front. Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const stop = () => void relay.stop().then(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function init(
  io: Io,
  options: { relay: string; project: string; name: string; role: Role; loopLimit?: string; register: boolean; force?: boolean },
  deps: SetupDeps,
): Promise<void> {
  refuseIfSetUp(io, options.force);
  const relayUrl = normaliseRelayUrl(options.relay);
  const created = await RelayClient.createProject(relayUrl, {
    name: options.project,
    memberName: options.name,
    role: options.role,
    ...(options.loopLimit && { loopLimit: Number(options.loopLimit) }),
  });
  remember(io, relayUrl, created);
  io.out(`Created project "${created.project.name}". You are ${created.member.name} (${created.member.role}).`);
  io.out('');
  io.out(`Invite code (${created.invite.uses} uses, expires ${created.invite.expiresAt}):`);
  io.out(`  ${created.invite.code}`);
  io.out('Each teammate runs, in their own repo:');
  io.out(`  ${CLI_NAME} join --relay ${relayUrl} --code ${created.invite.code} --name <their-name> --role <frontend|backend>`);
  finishSetup(io, options.register, deps);
}

export async function joinProject(
  io: Io,
  options: { relay: string; code: string; name: string; role: Role; register: boolean; force?: boolean },
  deps: SetupDeps,
): Promise<void> {
  refuseIfSetUp(io, options.force);
  const relayUrl = normaliseRelayUrl(options.relay);
  const joined = await RelayClient.join(relayUrl, { code: options.code, name: options.name, role: options.role });
  remember(io, relayUrl, joined);
  io.out(`Joined "${joined.project.name}" as ${joined.member.name} (${joined.member.role}).`);
  finishSetup(io, options.register, deps);
}

export async function invite(io: Io, options: { uses: string; hours: string }): Promise<void> {
  const { config, relay } = repoContext(io);
  const created = await relay.invite(config.projectId, { uses: Number(options.uses), expiresInHours: Number(options.hours) });
  io.out(`Invite code (${created.uses} uses, expires ${created.expiresAt}):`);
  io.out(`  ${created.code}`);
  io.out(`  ${CLI_NAME} join --relay ${config.relayUrl} --code ${created.code} --name <their-name> --role <frontend|backend>`);
}

export function register(io: Io, deps: SetupDeps): void {
  const { root } = repoContext(io);
  report(io, (deps.register ?? registerAgent)(root));
}

/** Leaves the project: the token stops working, owned threads are released, local config is removed. */
export async function leave(io: Io, options: { yes?: boolean }): Promise<void> {
  const { root, config, relay } = repoContext(io);
  if (!options.yes) {
    if (!io.prompt) throw new CliError('Pass --yes to leave without a prompt.');
    const answer = await io.prompt(`Leave the project as ${config.name}? Your open threads will be released. [y/N] `);
    if (!/^y(es)?$/i.test(answer)) return void io.out('Cancelled.');
  }
  await relay.leave();
  removeCredential(config.relayUrl, config.projectId, config.memberId);
  rmSync(join(root, DATA_DIR, 'config.json'), { force: true });
  io.out('You left the project. Your token no longer works and your threads were released.');
}

/** What agents launch. Everything but MCP traffic must stay off stdout. */
export async function bridge(io: Io, options: { repo?: string }): Promise<void> {
  const root = options.repo ?? findRepoRoot(io.cwd);
  if (!root) throw new CliError(`No ${DATA_DIR}/config.json here or above. Run \`${CLI_NAME} init\` or \`${CLI_NAME} join\` first.`);
  await runStdioBridge(root);
}

function refuseIfSetUp(io: Io, force?: boolean): void {
  if (!force && existsSync(join(io.cwd, DATA_DIR, 'config.json'))) {
    throw new CliError(`This repo is already set up (${DATA_DIR}/config.json). Pass --force to replace it.`);
  }
}

function remember(io: Io, relayUrl: string, membership: Membership): void {
  saveCredential(relayUrl, membership.project.id, membership.member.id, membership.token);
  writeRepoConfig(io.cwd, {
    relayUrl,
    projectId: membership.project.id,
    memberId: membership.member.id,
    name: membership.member.name,
    role: membership.member.role,
  });
}

function finishSetup(io: Io, shouldRegister: boolean, deps: SetupDeps): void {
  io.out('');
  io.out(`Saved ${DATA_DIR}/config.json (git-ignored) and your token in your user profile.`);
  if (shouldRegister) report(io, (deps.register ?? registerAgent)(io.cwd));
  else io.out(`Skipped agent registration. Run \`${CLI_NAME} register\` later.`);
}

function report(io: Io, registration: Registration): void {
  (registration.ok ? io.out : io.err)(registration.message);
}

export { DEFAULT_RELAY_PORT };
