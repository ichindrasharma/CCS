import { RelayError, RelayUnreachable } from '@tool/bridge';
import { CLI_NAME, ROLES, THREAD_STATES } from '@tool/protocol';
import { Command, CommanderError, Option } from 'commander';
import { ZodError } from 'zod';
import { decide } from './commands/approve.js';
import { bridge, DEFAULT_RELAY_PORT, init, invite, joinProject, leave, register, relayStart, type SetupDeps } from './commands/setup.js';
import { members, resume, thread, threads } from './commands/threads.js';
import { CliError, type Io } from './context.js';

const role = () => new Option('--role <role>', 'Your side of the integration').choices(ROLES).makeOptionMandatory();

export function buildProgram(io: Io, deps: SetupDeps = {}): Command {
  const program = new Command(CLI_NAME)
    .description('Let coding agents on different machines negotiate frontend-backend integration, with each developer approving their own side.')
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .exitOverride();

  program
    .command('relay')
    .description('Run a relay server')
    .command('start')
    .description('Start a self-hosted relay on this machine')
    .option('--port <port>', 'Port to listen on', String(DEFAULT_RELAY_PORT))
    .option('--host <host>', 'Interface to bind', '0.0.0.0')
    .option('--data-dir <dir>', 'Where the relay database lives (default: ~/.<name>-relay)')
    .action((options) => relayStart(io, options));

  program
    .command('init')
    .description('Create a project on a relay and set up this repo')
    .requiredOption('--relay <url>', 'Relay URL, e.g. http://192.168.1.20:4747')
    .requiredOption('--project <name>', 'Project name')
    .requiredOption('--name <name>', 'Your member name')
    .addOption(role())
    .option('--loop-limit <n>', 'Gap-list rounds before automatic escalation (default 3)')
    .option('--no-register', 'Do not register the bridge with Claude Code')
    .option('--force', 'Replace an existing setup in this repo')
    .action((options) => init(io, options, deps));

  program
    .command('join')
    .description('Join a project with an invite code and set up this repo')
    .requiredOption('--relay <url>', 'Relay URL')
    .requiredOption('--code <code>', 'Invite code')
    .requiredOption('--name <name>', 'Your member name')
    .addOption(role())
    .option('--no-register', 'Do not register the bridge with Claude Code')
    .option('--force', 'Replace an existing setup in this repo')
    .action((options) => joinProject(io, options, deps));

  program
    .command('invite')
    .description('Create another invite code')
    .option('--uses <n>', 'How many people can use it', '10')
    .option('--hours <n>', 'Hours until it expires', '168')
    .action((options) => invite(io, options));

  program.command('members').description('List project members').action(() => members(io));

  program
    .command('threads')
    .description('List threads')
    .addOption(new Option('--state <state>', 'Only threads in this state').choices(THREAD_STATES))
    .action((options) => threads(io, options));

  program
    .command('thread')
    .description("Show a thread's decision trail")
    .argument('<thread-id>')
    .action((id: string) => thread(io, id));

  program
    .command('approve')
    .description('Approve a plan your agent submitted (needs the code from the notification)')
    .argument('<approval-id>')
    .option('--code <code>', 'One-time code from the desktop notification')
    .action((id: string, options) => decide(io, id, 'approved', options));

  program
    .command('reject')
    .description('Reject a plan your agent submitted, with a note on what to change')
    .argument('<approval-id>')
    .option('--code <code>', 'One-time code from the desktop notification')
    .option('--note <text>', 'What the agent should change')
    .action((id: string, options) => decide(io, id, 'rejected', options));

  program
    .command('resume')
    .description('Resume an escalated thread')
    .argument('<thread-id>')
    .addOption(new Option('--to <state>', 'State to resume into (default: where it was escalated from)').choices(THREAD_STATES))
    .action((id: string, options) => resume(io, id, options));

  program.command('register').description('Register the bridge with Claude Code for this repo').action(() => register(io, deps));

  program
    .command('leave')
    .description('Leave the project: revoke your token and release your threads')
    .option('--yes', 'Do not ask for confirmation')
    .action((options) => leave(io, options));

  program
    .command('bridge')
    .description('Run the MCP bridge on stdio (started by your agent, not by you)')
    .option('--repo <dir>', 'Repo root (default: nearest directory with a config)')
    .action((options) => bridge(io, options));

  return program;
}

/** Runs the CLI and returns the exit code. Errors are printed for people, not as stack traces. */
export async function run(argv: string[], io: Io, deps: SetupDeps = {}): Promise<number> {
  try {
    await buildProgram(io, deps).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.err(describe(error));
    return 1;
  }
}

function describe(error: unknown): string {
  if (error instanceof CliError || error instanceof RelayUnreachable) return error.message;
  if (error instanceof RelayError) return `${error.error.code}: ${error.error.message}${error.error.state ? ` (thread is ${error.error.state})` : ''}`;
  if (error instanceof ZodError) return `Invalid configuration: ${error.issues.map((i) => i.message).join('; ')}`;
  return error instanceof Error ? error.message : String(error);
}
