# dsh-alpha

[English](README.md) | 简体中文

dsh-alpha 是 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 的多机多 Agent 编排插件。它让主控 Agent 获取实时的 Agent 与工作区目录，选择合适的目标，派发任务，并把结果流式回传到同一段对话中。

默认入口是 DSH Web，也支持用于自动化的 headless profile，以及跨机器执行的独立 worker。

## 功能概览

- 本机编排 Codex、Claude Code、Kimi Code，以及可选的 ZCode、OpenCode、Qoder、WorkBuddy runtime。
- 反向 WebSocket gateway：worker 主动连接 master，因此 worker 不需要公网 IP。
- 全局工作区目录：不同机器上的同一个 Git 仓库会合并为一个逻辑工作区。
- 基于仓库身份的调度，以及在 worker 的 allowed root 下按需 clone。
- 事件驱动的任务结果、审批转发、取消、断线重连与历史任务恢复。
- Web 侧栏入口和工作区选择器，以及 headless/诊断 CLI。
- Alpha 主控完整目录页：查看所有受控机器及其项目，登记新项目，并维护机器、项目和 Agent 的选择说明。
- 选定机器后可由本机或 Worker 浏览 allowed roots、创建目录并登记为新的 Alpha 工作区。
- Alpha 会话按目标机与目标工作目录分组；每个 turn 可指定 Worker Agent、权限模式和模型，未指定时自动调度。

当前包版本：0.2.0。

## 环境要求

使用已发布插件时：

- DSH 安装所支持的 Node.js 版本。
- DSH 0.1.0-rc.8 或更高版本；本仓库按 0.1.0-rc.8 验证。
- pnpm，因为 dsh plugin 会把包管理操作转发给 pnpm。
- 每台实际执行 Agent 的机器上，预先安装并登录对应的 provider CLI。

从源码 checkout 开发时，仓库的 devDependencies 会提供测试所需的 DSH runtime。

安装前检查：

~~~bash
dsh --version
pnpm --version
~~~

## 安装

### 方式一：安装已发布插件

根据入口选择对应 profile。alpha 与 web 是相互独立的 DSH profile。

#### Headless alpha profile

先安装 bundle，再安装 alpha 专用 preset 和 headless patch：

~~~bash
dsh plugin --profile alpha add dsh-alpha
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs
~~~

运行一次任务：

~~~bash
dsh --profile alpha "用 list_agents 查看可用 Agent，把任务《写一句简短的 hello》派发出去，并汇报结果。"
~~~

profile 安装脚本是幂等的。它只更新 ~/.dsh/profiles/alpha/cordis.patch.yml 中由 dsh-alpha 托管的区块，并保留区块之外的配置。

#### DSH Web

安装 Web-safe 的通用 bundle，复制 alpha preset，然后启动 Web：

~~~bash
dsh plugin --profile web add dsh-alpha
node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
dsh web
~~~

随后在 Web 侧栏打开 Alpha 主控入口。可以选择一个工作区，也可以保持自动模式，然后在 Alpha 会话中发送任务。

Web profile 不会加载 alpha headless runner。不要让 headless alpha master 与 Web master 同时占用同一个 gateway 端口；如果确实需要并行运行，请为两个入口配置不同的端口、token 和 worker 连接。

#### 升级

升级包后，重新执行对应安装脚本以刷新 preset 和 profile patch：

~~~bash
dsh plugin --profile alpha update dsh-alpha
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs

dsh plugin --profile web update dsh-alpha
node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
~~~

### 方式二：从源码 checkout 开发

~~~bash
git clone https://github.com/songofhawk/dsh-alpha.git
cd dsh-alpha
npm install
npm run setup
npm test
~~~

npm run setup 会在 $DSH_HOME（默认 ~/.dsh）下创建或更新用户级 alpha profile 和 preset，并把当前 checkout 链接到该 profile。如果 dsh 不在 PATH 中，可直接运行仓库内的二进制：

~~~bash
./node_modules/.bin/dsh --profile alpha "用 list_agents 查看可用 Agent 并汇报状态。"
~~~

常用开发命令：

~~~bash
npm test                  # 运行全部 Node.js 测试
npm run worker:doctor     # 不连接 gateway，校验 worker 配置
node scripts/introspect-tools.mjs
~~~

## 跨机器配置

master 负责监听 worker。每个 worker 主动通过 WebSocket 连接 master，并注册本机、provider 能力和工作区。

### 1. 配置 master

每个 worker 使用一个独立 token。启用 gateway 时必须配置 token：

~~~bash
export DSH_ALPHA_GATEWAY_HOST=0.0.0.0
export DSH_ALPHA_GATEWAY_PORT=4310
export DSH_ALPHA_GATEWAY_TOKENS='work1:replace-with-a-long-random-token'

dsh --profile alpha "先用 list_agents 确认 work1 在线，再派发任务。"
~~~

只允许必要的 worker 来源访问 master 防火墙上的 gateway 端口。健康检查地址：

~~~bash
curl http://<master>:4310/healthz
~~~

它只返回 gateway 状态和已连接 worker 数量，不暴露机器 ID 或 token。

### 2. 安装并配置 worker

在 worker 机器上：

~~~bash
npm install dsh-alpha

export DSH_ALPHA_HUB_URL='ws://<master>:4310/'
export DSH_ALPHA_WORKER_MACHINE_ID='work1'
export DSH_ALPHA_WORKER_TOKEN='replace-with-a-long-random-token'
export DSH_ALPHA_WORKER_ALLOWED_ROOTS='/work'

./node_modules/.bin/dsh-alpha-worker-doctor
./node_modules/.bin/dsh-alpha-worker
~~~

doctor 是只读检查：不会连接 hub、创建目录或打印 token。它会检查 hub URL、认证、allowed roots 和 provider 可执行文件。worker 进程需要持续运行；临时断线后会自动重连。

这里显式配置 DSH_ALPHA_WORKER_ALLOWED_ROOTS 是有意的。它同时限制执行路径和按需 clone 的目标路径。当任务带有 repoUrl 且 worker 上没有对应仓库时，dsh-alpha 会把仓库 clone 到第一个 allowed root 下的 .dsh-alpha/repos/。

### 3. 在 worker 上启用 provider runtime

默认 worker provider 是 codex、claude-code 和 kimi-code。如需启用其它 provider：

~~~bash
export DSH_ALPHA_WORKER_PROVIDERS='codex,zcode,opencode,qoder,workbuddy'
~~~

provider CLI 需要在 dsh-alpha 之外独立安装并登录。可执行文件名称和路径覆盖变量见下方 provider 表格。

ZCode 使用智谱 ZCode 应用自带的 headless CLI。Linux worker 可将 `ZCODE_CLI_PATH` 指向 `/opt/ZCode/resources/glm/zcode.cjs`；macOS 默认自动探测 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。运行前需要在 worker 上完成 ZCode 模型连接，并使用 Node.js 22.19 或更高版本。

公网或不可信网络应使用 wss://，由反向代理或隧道终止 TLS。ws:// 仅适合本机或可信内网。为了兼容旧配置，token 仍可放在 URL query 中；但更推荐使用 DSH_ALPHA_WORKER_TOKEN，此时 worker 会通过 header 发送 token，减少 URL/进程日志泄露。

## CLI

包提供三个二进制入口：

~~~bash
dsh-alpha --help
dsh-alpha --version
dsh-alpha status
dsh-alpha web
dsh-alpha run "总结当前工作区"
dsh-alpha-worker-doctor
dsh-alpha-worker
~~~

命令说明：

| 命令 | 作用 |
| --- | --- |
| dsh-alpha status | 只读检查本机 Web、gateway 和已连接 worker 数量。 |
| dsh-alpha web | 在默认浏览器打开已经运行的 Web；不会启动 Web。 |
| dsh-alpha run <task> | 在 Web master 未占用 gateway 时运行 headless alpha 任务。 |
| dsh-alpha-worker-doctor | 不连接 gateway，校验 worker 配置。 |
| dsh-alpha-worker | 启动反向连接 master 的 worker 进程。 |

status CLI 默认检查 http://127.0.0.1:3080/ 和 http://127.0.0.1:4310/healthz。可通过 DSH_ALPHA_WEB_URL 和 DSH_ALPHA_GATEWAY_HEALTH_URL 覆盖。dsh-alpha run 可从 DSH_ALPHA_GATEWAY_ENV 指定的文件加载额外 gateway 环境变量，默认文件为 ~/.config/dsh-alpha/gateway.env。

## 标准任务流程

在 Alpha 会话中，主控 Agent 通常按以下流程工作：

1. 调用 list_workspaces，查看逻辑工作区及其所在机器。
2. 调用 list_agents，查看在线 provider、能力、负载和工作区匹配情况。
3. 调用 `dispatch_task` 取得持久化 `taskId`，随后调用一次 `wait_task`。正常路径是事件驱动的，不需要轮询；等待中断后可用同一 `taskId` 续接，只有显式停止才取消 Worker 任务。
4. 如果 worker 请求审批，使用 agent_approve 或 agent_cancel 处理。
5. 只有在断线或恢复历史任务时，才使用 task_status 或 task_result。

可以在派发前通过工作区选择器约束当前会话。当同一仓库有多个机器候选且分数相同时，Alpha 会先询问，不会把一台机器的绝对路径直接传给另一台机器。

## 支持的 provider

只有前三个 provider 默认参与自动选机。其它 provider 必须在 DSH_ALPHA_PROVIDERS、DSH_ALPHA_WORKER_PROVIDERS 或对应 profile 配置中显式列出。

| Provider ID | Runtime / 可执行文件 | 路径覆盖变量 | 默认状态 |
| --- | --- | --- | --- |
| codex | Codex app server / codex | CODEX_CLI_PATH | 启用 |
| claude-code | Claude Code headless / claude | CLAUDE_CODE_CLI_PATH 或 CLAUDE_CLI_PATH | 启用 |
| kimi-code | Kimi ACP / kimi | KIMI_CODE_CLI_PATH 或 KIMI_CLI_PATH | 启用 |
| opencode | OpenCode ACP / opencode | OPENCODE_CLI_PATH | 需显式启用 |
| qoder | Qoder headless / qoder | QODER_CLI_PATH | 需显式启用 |
| workbuddy | 腾讯 WorkBuddy，通过 codebuddy CLI 运行 | WORKBUDDY_CLI_PATH | 需显式启用 |
| zcode | 智谱 ZCode Agent headless / zcode.cjs | ZCODE_CLI_PATH 或 ZCODE_BIN | 需显式启用 |
| mock | 仅用于测试的 mock runtime | — | 仅测试 |

provider ID 是 DSH_ALPHA_PROVIDERS 中使用的名称；dsh-alpha 不负责安装或登录 provider。mock 只应在测试或本地诊断时启用。

## 配置参考

配置可以通过环境变量或 profile 的 Cordis patch 提供。部署时环境变量更方便；不要把 token 写入提交到仓库的配置。

### Master 与本机执行

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| DSH_ALPHA_PROVIDERS | codex,claude-code,kimi-code | 注册到目录中的本机 provider ID。 |
| DSH_ALPHA_ALLOWED_ROOTS | 当前目录的父目录 | 本机执行、工作区发现和 clone 目标的文件系统边界。 |
| DSH_ALPHA_WORKSPACES | 自动发现 | 显式工作区 JSON 数组；自动发现只检查 allowed root 本身和直属 Git 仓库。 |
| DSH_ALPHA_DATA_DIR | $DSH_HOME/storages/dsh-alpha | 保存任务、事件、审批、结果和 Alpha 目录说明的 JSON 目录。 |
| DSH_ALPHA_DEFAULT_MODE | auto-review | 默认任务执行模式。 |
| DSH_ALPHA_APPROVAL_POLICY | on-request | 默认审批策略。 |
| DSH_ALPHA_DEFAULT_MODEL | provider 能力默认值 | 可选的默认模型。 |
| DSH_ALPHA_GATEWAY_PORT | 关闭 | 设置后启用 master gateway，同时必须配置 gateway token。 |
| DSH_ALPHA_GATEWAY_TOKENS | 无 | 逗号分隔的 machineId:token，例如 work1:secret1,work2:secret2。 |
| DSH_ALPHA_GATEWAY_HOST | 127.0.0.1 | gateway 监听地址。只有在防火墙限制来源时才使用 0.0.0.0。 |
| DSH_ALPHA_GATEWAY_READY_TIMEOUT_MS | 2000 | headless master 首次查询目录前的等待时间；设为 0 禁用等待。 |

显式配置工作区的例子：

~~~bash
export DSH_ALPHA_WORKSPACES='[{"name":"ai-prd","repo_url":"https://github.com/example/ai-prd.git","path":"/work/ai-prd"}]'
~~~

非 Git 目录必须显式登记。Git 仓库按 canonical repository identity 合并，因此不同机器上的路径可以呈现为同一个逻辑工作区。

### Worker 执行

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| DSH_ALPHA_HUB_URL | ws://127.0.0.1:4310/ | master gateway URL。 |
| DSH_ALPHA_WORKER_TOKEN | 无 | 与 master 上对应 machineId:token 相同的 worker token。 |
| DSH_ALPHA_WORKER_MACHINE_ID | hostname | 稳定的机器 ID；hostname 可能变化时应显式配置。 |
| DSH_ALPHA_WORKER_PROVIDERS | 本机默认 provider | 本 worker 广播的 provider ID。 |
| DSH_ALPHA_WORKER_ALLOWED_ROOTS | 当前目录的父目录 | 执行和 clone 边界；生产 worker 应显式设置。 |
| DSH_ALPHA_WORKER_WORKSPACES | 自动发现 | 如 [{"name":"repo","repo_url":"...","path":"/work/repo"}] 的 JSON 数组。 |
| DSH_ALPHA_WORKER_DISCOVER_WORKSPACES | 1 | 设为 0 后只使用显式工作区。 |
| DSH_ALPHA_WORKER_REPOS | 无 | 兼容旧配置的仓库路径映射 JSON 别名。 |
| DSH_ALPHA_WORKER_HEARTBEAT_MS | 15000 | worker 心跳间隔。 |
| DSH_ALPHA_WORKER_RECONNECT_MIN_MS | 1000 | 重连退避最小值。 |
| DSH_ALPHA_WORKER_RECONNECT_MAX_MS | 5000 | 重连退避最大值。 |

## 安全与运行注意事项

- 启用 gateway 但未配置 DSH_ALPHA_GATEWAY_TOKENS 时会拒绝启动。
- 每个 worker 使用唯一且足够长的 token，不要提交到源码仓库。
- 将 DSH_ALPHA_ALLOWED_ROOTS 和 DSH_ALPHA_WORKER_ALLOWED_ROOTS 限制在明确用于 Agent 工作的目录。
- Web master 与 headless master 不能共用一个 gateway 端口。
- worker 的 repoUrl clone 只能落在 allowed root 下，不能由任务指定任意路径。
- 不可信网络使用 wss://，并在防火墙或隧道层限制 gateway 来源。
- 健康检查只用于存活和 worker 数量检查，不是认证机制。

## 仓库结构

~~~text
src/
├─ plugin.mjs             # Host 侧目录、gateway、引擎和服务装配
├─ runner.mjs             # headless alpha runner
├─ client.js              # Web 侧栏入口和全局工作区选择器
├─ tools.mjs              # list/dispatch/status/result/approval/cancel 工具
├─ lib/                   # 目录、工作区、任务引擎、gateway、存储、adapter
├─ adapters/vendor/       # vendor runtime 和共享协议实现
└─ preset/alpha/          # Alpha Agent preset 与 profile patch
scripts/
├─ setup-profile-alpha.mjs
├─ install-preset.mjs
├─ install-alpha-profile.mjs
├─ alpha-cli.mjs
├─ alpha-worker.mjs
└─ alpha-worker-doctor.mjs
~~~

## 延伸阅读

- [设计与架构](docs/design.md)
- [多设备验收清单](docs/multi-device-acceptance.md)
- [Vendor adapter 说明](src/adapters/vendor/README.md)

## 当前开发状态

当前仓库已覆盖本机编排闭环、反向 gateway、审批与事件转发、基于仓库的调度、递归 master、全局工作区选择，以及上面列出的七种 provider 集成。修改后运行 npm test；测试会在适用处使用真实 loopback TCP/WebSocket 路径，并在不需要外部 CLI 时使用 mock runtime。
