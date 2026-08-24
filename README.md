# dsh-alpha

主控 agent 统一编排：一个 dsh 插件项目，让**主控 agent** 根据各 agent 特点、机器环境与可达性，把任务智能分派给多台机器上的多个 agent（Codex / Claude Code / Kimi，以及后续扩展的 provider）执行。

- 设计文档：[docs/design.md](docs/design.md)
- 多设备验收清单：[docs/multi-device-acceptance.md](docs/multi-device-acceptance.md)
- 背景与完整推演：agent-anywhere 仓库 `docs/metacontroller-design.md`

## 状态

- [x] 阶段 0：单机主控闭环（本机 adapters + list/dispatch 工具原型）
- [x] 阶段 1：gateway 跨机通道（反向 WS + 心跳 + 目录注册）
- [x] 阶段 2：任务协议与审批桥接（事件回流 + approve/reject 双向传导）
- [x] 阶段 3：负载 / repo 选机 / 按需 clone / 主控可递归
- [x] 阶段 4：对齐 dsh rc.8（本地执行收敛官方 provider + gateway 反向注册 alpha-gateway + `dsh plugin` 可安装）
- [x] 阶段 5：全局逻辑工作区（多机 inventory 聚合 + Alpha Web 选择器 + 按表述自动解析 + 目标机路径约束）

自动化验收覆盖真实 TCP loopback、多 worker 目录、事件/审批/取消/断线、repo 选机和按需 clone。`0.1.1` 另已在两台实体 Linux worker 上完成 Codex / Claude Code / Kimi 真实任务、双 worker readiness、健康检查，以及首次 clone → 心跳广播 → 二次复用验收。

## 安装

### 方式 A：`dsh plugin`（面向使用者，推荐）

前提：本机已装 dsh（`0.1.0-rc.8`+）与 pnpm。

```bash
# 1) 把 dsh-alpha 装成 alpha profile 的 bundle 层。
#    alpha profile 不存在时自动以 dsh-base 打底创建；
#    dsh-alpha 声明了 dsh.bundle.patch，装好后自动进入层栈。
dsh plugin --profile alpha add dsh-alpha

# 2) 安装 alpha 专用 headless profile patch + preset。
#    通用 bundle 只挂控制平面，不会把 headless runner 注入 Web：
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs

# 3) 验收运行：主控 agent 查目录 → LLM 决策 → 派发 → 结果回流
dsh --profile alpha "用 list_agents 查看目录，把任务《写一句 hello》派发给最合适的 agent，并汇报结果。"
```

> 升级后先运行 `dsh plugin --profile alpha update dsh-alpha`，再重跑一次 `install-alpha-profile.mjs`，以同步可能更新的专用 patch；脚本会幂等替换托管区块并保留其它本地配置。

### 安装进 DSH Web 插件列表

Web 与 alpha 是相互隔离的 profile。要在 Web 的「设置 → 插件列表」中看到并使用 dsh-alpha，需要单独安装到 `web`；通用 bundle 是 Web-safe 的，不会挂载 `alpha-runner`：

```bash
dsh plugin --profile web add dsh-alpha
node ~/.dsh/profiles/web/node_modules/dsh-alpha/scripts/install-preset.mjs
dsh web
```

`0.1.2` 起发布包是薄插件：运行时只携带 Schemastery，Agent、Session 与 ToolRuntime 全部复用当前 DSH profile 已加载的宿主实例。不要把 DSH core 包重新加回 `dependencies`；同一 Web 进程存在两份 `@deepseek-ai/dsh-tools` 时，其模块私有 scheduler identity 不相同，会造成 `tool_calls` 后缺少对应 tool message。

插件列表读取的是当前 Web Loader 条目，而不是其它 profile 的依赖。Loader 必须使用精确包名 `dsh-alpha`，DSH 才会发现同包的 Web client；当前 DSH UI 会把开头的 `dsh-` 裁成 `alpha`。会话中的产品名称仍为“alpha 主控”，只有选中该 Agent preset 后，主控工具和全局工作区控件才会进入会话 scope。

侧栏提供独立的 `Alpha 主控` 入口：先列出所有机器广播的 workspace，用户选定或保持自动模式后，再创建 Alpha 会话，不需要先挑一个目标项目的本机路径。DSH 会把主控会话归档到插件自建的中性 `alpha-control` Workspace；它只承载会话，不参与任务执行。进入 Alpha 会话后，左上角原本的本机 Workspace 位置会被全局工作区选择器接管，不占用输入栏；弹层固定在视口内，只有结果区滚动。目录按 canonical Git repo 把不同机器路径合并为一个逻辑项目；出现多个同分候选时 Alpha 会先询问，不会把一台机器的绝对路径直接传给另一台。

任务派发采用事件驱动等待：主控只发起一次 `dispatch_task`，受控 Agent 的最终输出会作为同一次工具结果直接回到当前对话。`task_status` / `task_result` 仅保留给断线或历史任务恢复，不用于正常轮询。

若 Web 进程配置了 `DSH_ALPHA_GATEWAY_PORT` 并作为常驻 master，同一时间不要再启动使用相同端口的 `dsh --profile alpha` headless master；二者是两种入口，应择一占用该 Gateway。需要并行时必须为另一入口配置独立端口、token 与 worker 连接。

### 可选诊断命令

插件仍由标准 `dsh web` 启动并自动加载。安装包另提供可选诊断命令：

```bash
dsh-alpha status        # 只读检查 Web、Gateway、worker 数量
```

profile 内安装会生成 `node_modules/.bin/dsh-alpha`；若希望在任意终端直接调用，应把该 bin 链接或安装到 PATH 中。

### 方式 B：源码 checkout（本仓库开发态）

```bash
npm install                 # 项目内依赖
npm run setup               # 装 ~/.dsh/profiles/alpha + ~/.dsh/.agent-presets/alpha
npm test                    # node --test

dsh --profile alpha "用 list_agents 查看目录，把任务《写一句 hello》派发给最合适的 agent，并汇报结果。"
```

配置（环境变量 / profile 的 cordis.patch.yml 覆盖）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_ALPHA_PROVIDERS` | `codex,claude-code,kimi-code` | 本机注册哪些 provider agent；`mock` 仅在测试时显式开启，避免被自动选机 |
| `DSH_ALPHA_ALLOWED_ROOTS` | cwd 父目录 | 本机目录边界（与 `AGENT_ANYWHERE_ALLOWED_ROOTS` 同款语义） |
| `DSH_ALPHA_WORKSPACES` | 自动发现 | 主控机显式 workspace JSON；自动发现只检查 allowed root 本身与直属 Git 仓库 |
| `DSH_ALPHA_DATA_DIR` | `$DSH_HOME/storages/dsh-alpha` | 任务/事件/审批 JSON 存储目录 |
| `DSH_ALPHA_DEFAULT_MODE` / `DSH_ALPHA_APPROVAL_POLICY` / `DSH_ALPHA_DEFAULT_MODEL` | `auto-review` / `on-request` / 能力默认 | 派发默认设置 |
| `DSH_ALPHA_GATEWAY_PORT` / `DSH_ALPHA_GATEWAY_TOKENS` | （关闭） | 启用主控 gateway hub：port 监听 + `machineId:token,...`（认证硬前提） |
| `DSH_ALPHA_GATEWAY_HOST` | `127.0.0.1` | hub 监听地址；跨机直连显式设为 `0.0.0.0`，并用防火墙限制来源 |
| `DSH_ALPHA_GATEWAY_READY_TIMEOUT_MS` | `2000` | headless 主控在首次查目录前等待 token 清单中的全部 worker 重连；设为 `0` 可禁用等待 |
| `DSH_ALPHA_HUB_URL` / `DSH_ALPHA_WORKER_TOKEN` / `DSH_ALPHA_WORKER_MACHINE_ID` | 本机 URL / 无 / hostname | worker 的 hub 地址、独立认证 token 与稳定机器 ID；token 默认通过 WS header 发送 |
| `DSH_ALPHA_WORKER_WORKSPACES` | 自动发现 | worker 显式 workspace JSON：`[{name?,repo_url?,path}]`；非 Git 目录必须显式登记 |
| `DSH_ALPHA_WORKER_DISCOVER_WORKSPACES` | `1` | 是否扫描 allowed root 本身与直属 Git 仓库；设为 `0` 仅使用显式目录 |
| `DSH_ALPHA_WORKER_REPOS` | 无 | 旧配置兼容别名；并入全局 workspace inventory |
| `DSH_ALPHA_WORKER_PROVIDERS` / `DSH_ALPHA_WORKER_ALLOWED_ROOTS` | 本机全部 / cwd 父目录 | worker 只广播探测可用的 provider；所有执行路径和 clone 目标均受 roots 约束 |
| `DSH_ALPHA_WORKER_RECONNECT_MIN_MS` / `DSH_ALPHA_WORKER_RECONNECT_MAX_MS` | `1000` / `5000` | 连接失败指数退避边界；按需启动 master 时最大值应小于 readiness timeout |

## 跨机（被控机 worker）

被控机无需 dsh profile，装包后直接跑 worker（反向连出，无需公网 IP）：

```bash
npm install dsh-alpha       # 或源码 checkout
DSH_ALPHA_HUB_URL="ws://<master>:4310/" \
DSH_ALPHA_WORKER_TOKEN="<该机 token>" \
DSH_ALPHA_WORKER_MACHINE_ID=work1 \
DSH_ALPHA_WORKER_ALLOWED_ROOTS="/work" \
./node_modules/.bin/dsh-alpha-worker
```

启动前可运行只读 doctor；它不会连接 hub 或打印 token：

```bash
./node_modules/.bin/dsh-alpha-worker-doctor
```

master 侧示例：

```bash
DSH_ALPHA_GATEWAY_HOST=0.0.0.0 \
DSH_ALPHA_GATEWAY_PORT=4310 \
DSH_ALPHA_GATEWAY_TOKENS="work1:<与 worker 相同的 token>" \
dsh --profile alpha "先用 list_agents 确认 work1 在线，再派发任务。"
```

认证 token 是硬前提。公网链路必须使用 `wss://`（通常由反向代理或隧道终止 TLS）；`ws://` 只用于可信局域网或本机。兼容旧配置时 token 仍可放在 URL query，但独立环境变量会改用 header，减少 URL/进程日志泄露。

hub 健康检查为 `GET /healthz`，返回 `status` 与当前连接的 worker 数量，不暴露机器 ID 或 token。

任务带 `repoUrl` 且目标机没有该仓库时，worker 会调用 `git clone`，把仓库确定性地落到首个 allowed root 下的 `.dsh-alpha/repos/`，完成后立即加入 repo 广播。目标机因此必须安装 `git`，并提前配置好对应仓库凭证。

## 结构

```text
src/
├─ plugin.mjs        # 主控插件（host 平面）：目录/gateway/引擎装配，发布 alpha* 服务
├─ runner.mjs        # alpha-runner：headless 一次任务驱动 + 挂载 alpha preset
├─ client.js        # Web 左上角 Alpha 全局工作区选择器 + 侧栏入口
├─ tools.mjs         # alpha preset 工具面：list_workspaces/list_agents/dispatch_task/task_status/
│                    #   task_result/agent_approve/agent_cancel + 分派策略提示词
├─ lib/              # 目录(含 workspace 聚合/rankAgents) / 任务存储 / 任务引擎(含 repo 身份) /
│                    #   审批 broker / gateway hub+worker / 递归适配器（CJS）
├─ adapters/vendor/  # vendorized agent-anywhere runtimes + shared（websocket/协议/repo/调度）
├─ preset/alpha/     # alpha preset + 仅 alpha profile 使用的 headless patch
├─ scripts/          # install-preset/install-alpha-profile + setup-profile-alpha +
│                    #   alpha-worker.mjs（被控机进程）+ introspect-*（验收）
└─ cordis.patch.yml  # profile-neutral bundle：只挂 dsh-alpha 控制平面
```

## 技术栈

Node.js 原生风格（CommonJS + ESM 包装、JSON 存储、`node --test`），dsh（DeepSeek Harness）插件形态（Cordis）。runtime 适配层直接复用 agent-anywhere 已验证实现（vendor 在 `src/adapters/vendor/`）。
