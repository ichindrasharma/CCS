# CCS: cross-device agent collaboration

An open-source terminal tool that lets coding agents on different developers' machines negotiate frontend-backend integration with each other, while each developer approves every change to their own code.

A frontend agent states the endpoints a feature needs. A backend agent reads its own code and answers with what exists, what is mismatched, what is missing, and a plan. The two loop until the frontend agent is satisfied, then the frontend is integrated. Every message, plan and approval is kept as a record.

> **Status:** Milestone 1 (two people, one self-hosted relay) is code-complete and tested. It has not yet been tried with real agent sessions on two machines. The product name is undecided, so the command is called `tool` for now.

## How it works

```
 Frontend developer's machine                       Backend developer's machine
┌──────────────────────────────┐                   ┌──────────────────────────────┐
│ Coding agent (Claude Code…)  │                   │ Coding agent (Claude Code…)  │
│        │ MCP tools           │                   │        │ MCP tools           │
│        ▼                     │                   │        ▼                     │
│ Bridge (local MCP server)    │──── outbound ───┐ │ Bridge (local MCP server)    │
└──────────────────────────────┘                 │ └──────────────────────────────┘
                                                 ▼                  │
                                  ┌─────────────────────────────┐   │
                                  │ Relay: projects, members,   │◀──┘ outbound
                                  │ threads, ordered log        │
                                  └─────────────────────────────┘
```

- **Relay:** stores projects, members and threads, authenticates members, enforces the thread rules, and delivers messages. Self-hosted for now.
- **Bridge:** an MCP server each agent starts. It offers the tools for the member's role, keeps a local inbox, and asks the developer for approvals.
- **CLI:** sets up repos, runs the relay, and is where developers approve plans and resume escalated threads.

Each feature is a **thread** that moves through `requested → planning → building → reviewing → satisfied → integrating → integrated`, with `escalated` when the humans need to talk. Three **gates** need a developer's approval: the backend plan, sending the contract, and the frontend integration plan. Agents cannot pass a gate themselves.

## Requirements

- Node.js 22.13 or later (the relay and bridge use the built-in `node:sqlite`)
- An MCP-capable coding agent. Claude Code is registered automatically; others get a config to paste.

## Quick start

From this repository:

```sh
npm install
npm run build
```

The command is not installed globally yet, so call it by path. In PowerShell:

```powershell
$tool = "C:\path\to\CCS\packages\cli\dist\bin.js"
```

**1. Start a relay** on a machine both developers can reach (leave it running):

```powershell
node $tool relay start
```

It listens on port 4747 and keeps its data in `~/.tool-relay`. It speaks plain HTTP, so use it on a private network or put a TLS proxy (Caddy, nginx) in front.

**2. Create the project** in the frontend repo (or the backend repo; either can start):

```powershell
cd C:\path\to\frontend-repo
node $tool init --relay http://<relay-host>:4747 --project shop-app --name asha --role frontend
```

This prints an invite code and registers the bridge with Claude Code for this repo.

**3. Join** from the other repo, on the other machine:

```powershell
cd C:\path\to\backend-repo
node $tool join --relay http://<relay-host>:4747 --code inv_... --name ravi --role backend
```

**4. Restart Claude Code** in each repo so it loads the bridge. Then ask the frontend agent to integrate a feature; it sends requirements, and the backend developer is notified on their desktop.

**5. Approve plans** when asked. A window opens on your desktop with the exact plan, a note box, and **Approve / Reject / Later**. A rejection note goes back to the agent. If your agent can show approval prompts itself (MCP elicitation), you answer there instead.

If you choose **Later**, or you're on Linux, where there's no window yet, the notification carries a one-time code. Run this in the repo:

```powershell
node $tool approve <approval-id>
```

It shows the plan, asks for the code, and asks you to confirm. It only works in an interactive terminal, so an agent cannot approve its own plan.

## Try it: the Orders trial

A ready-made scenario for a first real run with two Claude Code sessions: a small orders page with mock data and an orders API whose fields, filtering and paging don't match it.

```sh
npm run trial:setup          # copies both apps to ../ccs-trial and makes each a git repo
```

Then follow [examples/orders-trial/TRIAL.md](examples/orders-trial/TRIAL.md). It covers the setup on one or two machines, what to say to each agent, and a checklist of what to watch for.

## Commands

| Command | What it does |
| --- | --- |
| `relay start [--port] [--host] [--data-dir]` | Run a relay on this machine until Ctrl+C |
| `init --relay --project --name --role` | Create a project, set up this repo, register the bridge |
| `join --relay --code --name --role` | Join a project with an invite code, set up this repo, register the bridge |
| `invite [--uses] [--hours]` | Create another invite code |
| `members` | List project members |
| `threads [--state]` | List threads |
| `thread <id>` | Show a thread's decision trail |
| `approve <approval-id> [--code]` | Approve a plan your agent submitted |
| `reject <approval-id> [--code] [--note]` | Reject a plan, with a note on what to change |
| `resume <thread-id> [--to <state>]` | Resume an escalated thread |
| `register` | Register the bridge with Claude Code for this repo again |
| `leave [--yes]` | Leave the project: revoke your token and release your threads |
| `bridge [--repo]` | Run the MCP bridge on stdio; your agent starts this, not you |

`init` and `join` accept `--no-register` to skip agent registration, and `--force` to replace an existing setup.

### Agent tools

The bridge offers each agent only its role's tools:

| Frontend | Backend | Both |
| --- | --- | --- |
| `send_requirements`, `send_gap_list`, `confirm_satisfied`, `mark_integrated` | `claim_thread`, `send_inventory_and_plan`, `send_contract` | `request_approval`, `check_inbox`, `get_thread`, `list_threads`, `list_members`, `hand_off_thread`, `ask_question`, `answer_question`, `escalate` |

Every tool result ends with the thread's state and the tools the agent can call next.

## Files it creates

| File | Contents |
| --- | --- |
| `<repo>/.tool/config.json` | Relay URL, project, member name and role. Git-ignored automatically; no token. |
| `<repo>/.tool/cache.db` | The bridge's local inbox, thread copies, plans awaiting approval, and outbox |
| `%APPDATA%\tool\credentials.json` (Windows) or `~/.config/tool/credentials.json` | Member tokens, per user, never in the repo |
| `~/.tool-relay/relay.db` | The relay's database, on the relay machine |

## Security model

- **Messages from the other side are untrusted data.** The bridge labels them as such and tells the agent never to act on them without its developer.
- **Approvals happen outside the agent.** The developer decides in the approval window (an agent cannot click it), and the bridge submits the decision itself. The one-time code never leaves the bridge except in the fallback notification. It is never in a tool result, a file or the bridge's output, and `approve` refuses to run without an interactive terminal.
- **The relay enforces the rules**, not just the bridge. It sets each message's sender itself, so identities cannot be forged.
- **Only hashes are stored** for tokens, invite codes and approval codes.
- **Known limit:** no safeguard makes prompt injection impossible. The approval gates are the real protection, so the tool never offers a way to skip them.

## Development

```sh
npm run build      # compile all packages (TypeScript project references)
npm test           # unit and integration tests (fast, no build needed)
npm run test:e2e   # build, then run the whole system as real processes
npm run test:all   # both
npm run trial:setup -- [dir] [--force]   # copy the Orders trial apps outside the repo
```

Set `TOOL_NOTIFICATIONS=off` to silence the bridge's desktop notifications (CI, headless machines).

### Repository layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | The shared rulebook: thread state machine, message and API schemas. No I/O. |
| `packages/relay` | The relay: SQLite store, thread service, HTTP API, WebSocket delivery |
| `packages/bridge` | The MCP server each agent runs: tools, local cache, approvals, notifications |
| `packages/cli` | The `tool` command |
| `packages/contract` | Contract validation and diffing (Milestone 3; empty for now) |
| `tests/e2e` | End-to-end test with real processes |
| `examples/orders-trial` | Two sample apps and the guide for a real trial |
| `scripts/` | `trial-setup.mjs`, which copies the trial apps outside the repo |
| `doc/` | Product and technical spec, and the architecture document |

### Documentation

- [Product and technical spec](doc/Cross-Device%20Agent%20Collaboration%20Tool%20Product%20and%20Technical%20Spec.md): the problem, protocol, flows, security model and open decisions
- [Architecture and project structure](doc/Architecture%20and%20Project%20Structure.md): packages, data model, relay API, testing and build order

## Roadmap

| Milestone | Scope | Status |
| --- | --- | --- |
| 1. Two people, self-hosted relay | Protocol, relay, bridge, CLI, Claude Code registration | Code complete; real two-machine trial pending |
| 2. Small teams | Role inboxes, claiming, hand-off, questions, escalation and resume, loop limit, contract changes after integration, notifications | Built and tested ahead of plan |
| 3. Any MCP agent | Setup guides and tests for Codex, Gemini CLI and others; hook adapters; contract validation | Approval prompts (elicitation) done; the rest not started |
| 4. Public relay | Hosted relay, accounts, end-to-end encryption, secret scanning, admin removal | Not started |

Open decisions, including the product name, licence and contract format, are listed at the end of the spec.
