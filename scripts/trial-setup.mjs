#!/usr/bin/env node
// Copies the Orders trial apps to a folder outside this repo and makes each a git repo,
// so agent edits during a trial never touch CCS and every trial starts from the same state.
//
//   npm run trial:setup -- [target-dir] [--force]
//
// Default target: ../ccs-trial next to this repo.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repo, 'packages', 'cli', 'dist', 'bin.js');
const templates = join(repo, 'examples', 'orders-trial');
const apps = ['shop-frontend', 'shop-backend'];

const args = process.argv.slice(2);
const force = args.includes('--force');
const target = resolve(args.find((a) => !a.startsWith('--')) ?? join(repo, '..', 'ccs-trial'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(bin)) fail('Build the tool first: npm run build');
if (target === repo || target.startsWith(repo + (process.platform === 'win32' ? '\\' : '/'))) {
  fail('Choose a folder outside the CCS repo, so the trial does not change it.');
}
if (existsSync(target) && readdirSync(target).length > 0) {
  if (!force) fail(`${target} is not empty. Pass --force to replace it.`);
  for (const app of apps) rmSync(join(target, app), { recursive: true, force: true });
}

mkdirSync(target, { recursive: true });
const git = (cwd, ...gitArgs) => execFileSync('git', gitArgs, { cwd, stdio: 'ignore' });
for (const app of apps) {
  const dest = join(target, app);
  cpSync(join(templates, app), dest, { recursive: true });
  git(dest, 'init', '--quiet', '--initial-branch=main');
  git(dest, 'add', '-A');
  git(dest, '-c', 'user.name=Trial', '-c', 'user.email=trial@example.invalid', 'commit', '--quiet', '-m', 'Starting point for the Orders trial');
}

const q = (p) => (p.includes(' ') ? `"${p}"` : p);
const fe = join(target, 'shop-frontend');
const be = join(target, 'shop-backend');
console.log(`Trial apps ready in ${target}

Next, in separate terminals (details: examples/orders-trial/TRIAL.md):

  1. Relay:     node ${q(bin)} relay start
  2. Backend:   cd ${q(be)}  &&  node server.js
  3. Frontend:  cd ${q(fe)}  &&  node serve.js
  4. Set up the frontend repo (prints an invite code):
                cd ${q(fe)}
                node ${q(bin)} init --relay http://localhost:4747 --project shop-app --name asha --role frontend
  5. Join from the backend repo with that code:
                cd ${q(be)}
                node ${q(bin)} join --relay http://localhost:4747 --code <invite-code> --name ravi --role backend
  6. Open Claude Code in each repo and follow the script in TRIAL.md.`);
