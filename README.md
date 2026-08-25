# dsh-alpha

English | [简体中文](README.zh-CN.md)

dsh-alpha is a multi-machine, multi-agent orchestration plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh). It gives a main agent a live inventory of available agents and workspaces, selects a suitable target, dispatches the task, and streams the result back into the same conversation.

The default entry point is the DSH Web experience. A headless profile and a standalone worker are also available for automation and cross-machine execution.

## What it provides

- Local orchestration across Codex, Claude Code, Kimi Code, and optional OpenCode, Qoder, and WorkBuddy runtimes.
- Reverse WebSocket gateway: workers connect out to the master, so workers do not need public IP addresses.
- Global workspace inventory: the same Git repository on different machines is presented as one logical workspace.
- Repository-aware scheduling and on-demand cloning into a worker's allowed root.
- Event-driven task results, approval forwarding, cancellation, reconnect handling, and historical task recovery.
- A Web sidebar entry and workspace selector, plus headless and diagnostic CLIs.
- Alpha sessions are grouped by target machine and target directory; each turn can choose a Worker agent, permission mode, and model, with automatic selection when omitted.

Current package version: 0.2.0.

## Requirements

For the published-plugin workflow:

- A Node.js version supported by your DSH installation.
- DSH 0.1.0-rc.8 or newer. The repository is tested against 0.1.0-rc.8.
- pnpm, because dsh plugin forwards package management to pnpm.
- The provider CLI you intend to use, already installed and authenticated on each machine that runs it.

For development from a checkout, the repository's devDependencies provide the DSH runtime used by the test suite.

Check the first two tools before installing:

~~~bash
dsh --version
pnpm --version
~~~

## Installation

### Option 1: install the published plugin

Choose the profile that matches the entry point you want. alpha and web are independent DSH profiles.

#### Headless alpha profile

Install the bundle and then install the alpha-specific preset and headless patch:

~~~bash
dsh plugin --profile alpha add dsh-alpha
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs
~~~

Run one task:

~~~bash
dsh --profile alpha "Use list_agents to inspect the available agents, dispatch the task 'write one short hello', and report the result."
~~~

The profile installer is idempotent. It updates only the dsh-alpha managed block in ~/.dsh/profiles/alpha/cordis.patch.yml and preserves configuration outside that block.

#### DSH Web

Install the common Web-safe bundle, copy the alpha preset, and start Web:

~~~bash
dsh plugin --profile web add dsh-alpha
node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
dsh web
~~~

Then open the Alpha master entry in the Web sidebar. Select a workspace or leave the selector in automatic mode, and send a task from the Alpha conversation.

The Web profile does not load the alpha headless runner. Do not start a headless alpha master and a Web master on the same gateway port at the same time. If both must run concurrently, give them separate ports, tokens, and worker connections.

#### Upgrade

After updating the package, rerun the matching installer so that presets and profile patches are refreshed:

~~~bash
dsh plugin --profile alpha update dsh-alpha
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs

dsh plugin --profile web update dsh-alpha
node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
~~~

### Option 2: develop from a checkout

~~~bash
git clone https://github.com/songofhawk/dsh-alpha.git
cd dsh-alpha
npm install
npm run setup
npm test
~~~

npm run setup creates or updates the user-level alpha profile and preset under $DSH_HOME (default: ~/.dsh) and links the checkout into that profile. Run the local DSH binary directly if dsh is not on your PATH:

~~~bash
./node_modules/.bin/dsh --profile alpha "Use list_agents to inspect the available agents and report their status."
~~~

Useful development commands:

~~~bash
npm test                  # run all Node.js tests
npm run worker:doctor     # validate worker configuration without connecting
node scripts/introspect-tools.mjs
~~~

## Cross-machine setup

The master listens for workers. Each worker makes an outbound WebSocket connection to the master and registers its machine, provider capabilities, and workspaces.

### 1. Configure the master

Set one token per worker. The token is mandatory whenever the gateway is enabled:

~~~bash
export DSH_ALPHA_GATEWAY_HOST=0.0.0.0
export DSH_ALPHA_GATEWAY_PORT=4310
export DSH_ALPHA_GATEWAY_TOKENS='work1:replace-with-a-long-random-token'

dsh --profile alpha "Use list_agents to confirm that work1 is online, then dispatch the task."
~~~

Allow the gateway port through the master's firewall only for the required worker sources. The health endpoint is:

~~~bash
curl http://<master>:4310/healthz
~~~

It reports gateway status and the number of connected workers; it does not expose machine IDs or tokens.

### 2. Install and configure a worker

On the worker machine:

~~~bash
npm install dsh-alpha

export DSH_ALPHA_HUB_URL='ws://<master>:4310/'
export DSH_ALPHA_WORKER_MACHINE_ID='work1'
export DSH_ALPHA_WORKER_TOKEN='replace-with-a-long-random-token'
export DSH_ALPHA_WORKER_ALLOWED_ROOTS='/work'

./node_modules/.bin/dsh-alpha-worker-doctor
./node_modules/.bin/dsh-alpha-worker
~~~

The doctor is read-only: it does not connect to the hub, create directories, or print the token. It checks the hub URL, authentication, allowed roots, and configured provider executables. Keep the worker process running; it reconnects automatically after a temporary connection loss.

DSH_ALPHA_WORKER_ALLOWED_ROOTS is deliberately explicit in this example. It limits execution paths and the destination of on-demand clones. When a task includes a repoUrl and the repository is not present on the worker, dsh-alpha clones it into the first allowed root under .dsh-alpha/repos/.

### 3. Enable provider runtimes on the worker

The default worker providers are codex, claude-code, and kimi-code. To opt into additional providers:

~~~bash
export DSH_ALPHA_WORKER_PROVIDERS='codex,opencode,qoder,workbuddy'
~~~

Provider CLIs must be installed and authenticated independently of dsh-alpha. See the provider table below for executable names and path overrides.

For a public or untrusted network, use wss:// and terminate TLS at a reverse proxy or tunnel. ws:// is appropriate only for localhost or a trusted private network. A token in the URL query is supported for compatibility, but DSH_ALPHA_WORKER_TOKEN is preferred because the worker sends it in a header and avoids URL/process-log leakage.

## CLI

The package exposes three binaries:

~~~bash
dsh-alpha --help
dsh-alpha --version
dsh-alpha status
dsh-alpha web
dsh-alpha run "summarize the current workspace"
dsh-alpha-worker-doctor
dsh-alpha-worker
~~~

Commands:

| Command | Purpose |
| --- | --- |
| dsh-alpha status | Read the local Web and gateway status, including connected worker count. |
| dsh-alpha web | Open the already-running Web UI in the default browser. It does not start Web. |
| dsh-alpha run <task> | Run a headless alpha task when a Web master is not occupying the gateway. |
| dsh-alpha-worker-doctor | Validate worker configuration without connecting to the gateway. |
| dsh-alpha-worker | Start the reverse-connected worker process. |

The status CLI checks http://127.0.0.1:3080/ and http://127.0.0.1:4310/healthz by default. Override them with DSH_ALPHA_WEB_URL and DSH_ALPHA_GATEWAY_HEALTH_URL. dsh-alpha run can load additional gateway environment variables from DSH_ALPHA_GATEWAY_ENV, defaulting to ~/.config/dsh-alpha/gateway.env.

## Typical task flow

In an Alpha conversation, the main agent normally follows this flow:

1. Call list_workspaces to inspect the logical workspaces and their machine locations.
2. Call list_agents to inspect online providers, capabilities, load, and workspace affinity.
3. Call dispatch_task once. The normal path is event-driven: the final worker output returns through the same tool result, without polling.
4. If the worker requests approval, use agent_approve or agent_cancel to resolve it.
5. Use task_status or task_result only for disconnected or historical task recovery.

The workspace selector can constrain the conversation before dispatch. When several machines are equally suitable for the same repository, Alpha asks for a selection instead of sending one machine's absolute path to another machine.

## Supported providers

Only the first three providers are enabled by default for automatic selection. Optional providers must be explicitly listed in DSH_ALPHA_PROVIDERS, DSH_ALPHA_WORKER_PROVIDERS, or the corresponding profile configuration.

| Provider ID | Runtime / executable | Path override | Default |
| --- | --- | --- | --- |
| codex | Codex app server / codex | CODEX_CLI_PATH | Enabled |
| claude-code | Claude Code headless / claude | CLAUDE_CODE_CLI_PATH or CLAUDE_CLI_PATH | Enabled |
| kimi-code | Kimi ACP / kimi | KIMI_CODE_CLI_PATH or KIMI_CLI_PATH | Enabled |
| opencode | OpenCode ACP / opencode | OPENCODE_CLI_PATH | Opt-in |
| qoder | Qoder headless / qoder | QODER_CLI_PATH | Opt-in |
| workbuddy | Tencent WorkBuddy through the codebuddy CLI | WORKBUDDY_CLI_PATH | Opt-in |
| mock | Test-only mock runtime | — | Test-only |

The provider ID is the name used in DSH_ALPHA_PROVIDERS; it does not install or authenticate the provider itself. mock should be enabled only for tests or local diagnostics.

## Configuration

Values can be supplied through environment variables or the profile's Cordis patch. Environment variables are convenient for deployment; keep tokens outside committed configuration.

### Master and local execution

| Variable | Default | Description |
| --- | --- | --- |
| DSH_ALPHA_PROVIDERS | codex,claude-code,kimi-code | Local provider IDs registered in the catalog. |
| DSH_ALPHA_ALLOWED_ROOTS | Parent of the current directory | Filesystem boundary for local execution, workspace discovery, and clone destinations. |
| DSH_ALPHA_WORKSPACES | Automatic discovery | JSON array of explicit workspaces. Automatic discovery checks the allowed root itself and its direct Git repositories. |
| DSH_ALPHA_DATA_DIR | $DSH_HOME/storages/dsh-alpha | JSON storage for tasks, events, approvals, and results. |
| DSH_ALPHA_DEFAULT_MODE | auto-review | Default task execution mode. |
| DSH_ALPHA_APPROVAL_POLICY | on-request | Default approval policy. |
| DSH_ALPHA_DEFAULT_MODEL | Provider capability default | Optional default model. |
| DSH_ALPHA_GATEWAY_PORT | Disabled | Enables the master gateway when set. Gateway tokens are also required. |
| DSH_ALPHA_GATEWAY_TOKENS | None | Comma-separated machineId:token pairs, for example work1:secret1,work2:secret2. |
| DSH_ALPHA_GATEWAY_HOST | 127.0.0.1 | Gateway listen address. Use 0.0.0.0 only with firewall restrictions. |
| DSH_ALPHA_GATEWAY_READY_TIMEOUT_MS | 2000 | Headless master wait before the first directory lookup. Set to 0 to disable the wait. |

Example explicit workspace configuration:

~~~bash
export DSH_ALPHA_WORKSPACES='[{"name":"ai-prd","repo_url":"https://github.com/example/ai-prd.git","path":"/work/ai-prd"}]'
~~~

Non-Git directories must be explicitly registered. Git repositories are grouped by canonical repository identity, so paths on different machines can appear as one logical workspace.

### Worker execution

| Variable | Default | Description |
| --- | --- | --- |
| DSH_ALPHA_HUB_URL | ws://127.0.0.1:4310/ | Master gateway URL. |
| DSH_ALPHA_WORKER_TOKEN | None | Worker token matching its master machineId:token entry. |
| DSH_ALPHA_WORKER_MACHINE_ID | Hostname | Stable machine ID. Set it explicitly when the hostname can change. |
| DSH_ALPHA_WORKER_PROVIDERS | Local default providers | Provider IDs advertised by this worker. |
| DSH_ALPHA_WORKER_ALLOWED_ROOTS | Parent of the current directory | Execution and clone boundary. Production workers should set this explicitly. |
| DSH_ALPHA_WORKER_WORKSPACES | Automatic discovery | JSON array such as [{"name":"repo","repo_url":"...","path":"/work/repo"}]. |
| DSH_ALPHA_WORKER_DISCOVER_WORKSPACES | 1 | Set to 0 to use only explicit worker workspaces. |
| DSH_ALPHA_WORKER_REPOS | None | Legacy JSON alias for repository path mappings. |
| DSH_ALPHA_WORKER_HEARTBEAT_MS | 15000 | Worker heartbeat interval. |
| DSH_ALPHA_WORKER_RECONNECT_MIN_MS | 1000 | Minimum reconnect backoff. |
| DSH_ALPHA_WORKER_RECONNECT_MAX_MS | 5000 | Maximum reconnect backoff. |

## Safety and operational notes

- Enabling the gateway without DSH_ALPHA_GATEWAY_TOKENS fails closed.
- Keep each worker token unique, long, and out of source control.
- Restrict DSH_ALPHA_ALLOWED_ROOTS and DSH_ALPHA_WORKER_ALLOWED_ROOTS to directories intended for agent work.
- A Web master and a headless master must not share one gateway port.
- A worker's repoUrl clone is placed under an allowed root, not an arbitrary path supplied by the task.
- Use wss:// outside a trusted network and restrict the gateway at the firewall or tunnel layer.
- The health endpoint is for liveness and worker-count checks only; it is not an authentication mechanism.

## Repository layout

~~~text
src/
├─ plugin.mjs             # Host-side catalog, gateway, engine, and service assembly
├─ runner.mjs             # Headless alpha runner
├─ client.js              # Web sidebar entry and global workspace selector
├─ tools.mjs              # list/dispatch/status/result/approval/cancel tools
├─ lib/                   # Catalog, workspace service, task engine, gateway, storage, adapters
├─ adapters/vendor/       # Vendored runtime and shared protocol implementations
└─ preset/alpha/          # Alpha agent preset and profile patch
scripts/
├─ setup-profile-alpha.mjs
├─ install-preset.mjs
├─ install-alpha-profile.mjs
├─ alpha-cli.mjs
├─ alpha-worker.mjs
└─ alpha-worker-doctor.mjs
~~~

## Further reading

- [Design and architecture](docs/design.md)
- [Multi-device acceptance checklist](docs/multi-device-acceptance.md)
- [Vendored adapter notes](src/adapters/vendor/README.md)

## Development status

The repository currently covers the local orchestration loop, reverse gateway, approval and event forwarding, repository-aware scheduling, recursive master support, global workspace selection, and the six provider integrations listed above. Run npm test after changes; the tests use real loopback TCP/WebSocket paths where appropriate and mock provider runtimes where external CLIs are not required.
