# dsh-alpha

English | [简体中文](README.zh-CN.md) · [Live site](https://songofhawk.github.io/dsh-alpha/) · [Architecture](docs/design.md)

> A control plane for dispatching coding work across machines and agent runtimes from one DSH conversation.

![dsh-alpha product demo](site/assets/dsh-alpha-demo.gif)

_The demo uses an isolated environment. Machine, workspace, and path information is redacted._

## Why dsh-alpha

Coding agents are useful on their own, but real work quickly spreads across laptops, build hosts, GPU machines, and repositories that live at different paths. dsh-alpha adds the missing control plane:

- see which machines and agents are online;
- treat the same Git repository on different machines as one logical workspace;
- route a task to the right machine, runtime, model, and permission mode;
- stream progress, approvals, cancellation, and results back into the same conversation;
- reconnect and recover durable task history when a Worker temporarily disappears.

dsh-alpha is a plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh). It coordinates existing provider CLIs; it does not replace their installation, authentication, or security controls.

## Mental model

~~~text
DSH Web / headless master
  ├─ global workspace inventory
  ├─ agent capability and load catalog
  ├─ task / approval / recovery state
  └─ reverse WebSocket gateway
          ├─ Worker A → Codex / Claude Code
          ├─ Worker B → Kimi Code / ZCode
          └─ Worker C → OpenCode / Qoder / WorkBuddy
~~~

Workers connect outward to the master, so they do not need public IP addresses. Repository identity is separated from machine-local paths, and execution remains constrained to each Worker's explicit allowed roots.

## Highlights

| Capability | What it changes |
| --- | --- |
| Global workspace inventory | One repository can be recognized across several machines and local paths. |
| Repository-aware scheduling | Prefer a Worker that already has the repository; clone on demand only inside an allowed root. |
| Per-turn Worker controls | Select Agent, model, reasoning effort, and permission mode without leaving the conversation. |
| Event-driven results | Dispatch once, wait on events, and resume with the same durable task ID after interruption. |
| Approval handoff | Worker approval requests return to the active Alpha session instead of hanging invisibly. |
| Reverse gateway | Workers connect to the master through authenticated WebSocket sessions and reconnect automatically. |
| Operational tooling | Web sidebar, headless runner, status CLI, Worker doctor, and multi-device acceptance checklist. |

## Quick start

### Requirements

- Node.js supported by your DSH installation
- DSH `0.1.0-rc.8` or newer
- pnpm (used by `dsh plugin`)
- the provider CLI you want to run, already installed and authenticated on the machine that executes it

~~~bash
dsh --version
pnpm --version
~~~

### DSH Web

~~~bash
dsh plugin --profile web add dsh-alpha
node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
dsh web
~~~

Open **Alpha master** from the Web sidebar, choose a workspace or keep automatic routing enabled, then start a conversation.

### Headless master

~~~bash
dsh plugin --profile alpha add dsh-alpha
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs
dsh --profile alpha "Use list_agents, dispatch a short task, and report the result."
~~~

The installer updates only the dsh-alpha managed block and preserves configuration outside it.

### Develop from source

~~~bash
git clone https://github.com/songofhawk/dsh-alpha.git
cd dsh-alpha
npm install
npm run setup
npm test
~~~

## Add a remote Worker

Configure one token per Worker on the master:

~~~bash
export DSH_ALPHA_GATEWAY_HOST=0.0.0.0
export DSH_ALPHA_GATEWAY_PORT=4310
export DSH_ALPHA_GATEWAY_TOKENS='build-1:replace-with-a-long-random-token'
~~~

Install and start the Worker on the target machine:

~~~bash
npm install dsh-alpha

export DSH_ALPHA_HUB_URL='ws://<master>:4310/'
export DSH_ALPHA_WORKER_MACHINE_ID='build-1'
export DSH_ALPHA_WORKER_TOKEN='replace-with-a-long-random-token'
export DSH_ALPHA_WORKER_ALLOWED_ROOTS='/work'

./node_modules/.bin/dsh-alpha-worker-doctor
./node_modules/.bin/dsh-alpha-worker
~~~

Use `wss://` and network-level source restrictions outside a trusted LAN or VPN. Keep tokens out of repositories, URLs, screenshots, and process logs.

## Supported runtimes

The default set is Codex, Claude Code, and Kimi Code. Optional runtimes must be enabled explicitly.

| Provider ID | Runtime | Default |
| --- | --- | --- |
| `codex` | Codex app server / CLI | Enabled |
| `claude-code` | Claude Code headless | Enabled |
| `kimi-code` | Kimi ACP | Enabled |
| `zcode` | Zhipu ZCode headless | Opt-in |
| `opencode` | OpenCode ACP | Opt-in |
| `qoder` | Qoder headless | Opt-in |
| `workbuddy` | Tencent WorkBuddy via codebuddy | Opt-in |

Each runtime is installed and authenticated independently. `mock` exists for tests and local diagnostics only.

## Daily workflow

1. `list_workspaces` resolves the logical repository and its machine locations.
2. `list_agents` exposes availability, capabilities, load, and workspace affinity.
3. `dispatch_task` returns a durable `taskId`; `wait_task` follows the event stream without busy polling.
4. `agent_approve` or `agent_cancel` resolves Worker approvals in the current Alpha session.
5. `task_status` and `task_result` recover disconnected or historical work.

The Web workspace selector can create a hard machine/workspace constraint. With no manual selection, the scheduler may choose a matching Worker and clone the Git workspace into its allowed root.

## Safety defaults

- Gateway startup fails closed when authentication tokens are missing.
- Every local and remote path is checked against explicit allowed roots.
- Clone destinations are chosen by the Worker, never by an arbitrary task path.
- Web master and headless master must not share one gateway port.
- Health endpoints expose liveness and Worker counts, not identities or secrets.
- Worker doctor is read-only and never prints the Worker token.
- Approval, cancellation, reconnect, and interrupted-task behavior are covered by automated tests.

## Useful commands

~~~bash
dsh-alpha status
dsh-alpha web
dsh-alpha run "summarize the current workspace"
dsh-alpha-worker-doctor
dsh-alpha-worker
npm test
~~~

## Documentation

- [Design and architecture](docs/design.md)
- [Deployment guide](docs/deployment.md)
- [Multi-device acceptance checklist](docs/multi-device-acceptance.md)
- [LAN access bundle](packages/dsh-lan-access/README.md)
- [Vendored adapter notes](src/adapters/vendor/README.md)
- [Launch article: Chinese](site/article.zh-CN.md) / [English](site/article.en.md)
- Doco publication: [Chinese](https://doco.page/s/k2KWDVuEhWMDUA5mGpf_nUd7hMI_Um-u) / [English](https://doco.page/s/WBbyHRtlsfr1lhwr_iDTLQbpdSXL0QeM)

## Project status

Current public source version: **0.2.1**. The repository covers local orchestration, reverse-gateway Workers, repository-aware scheduling, recursive masters, approval forwarding, global workspace selection, durable task recovery, and seven production runtime integrations.

Before upgrading a running installation, rerun the matching preset/profile installer and execute the acceptance checklist for every connected machine.
