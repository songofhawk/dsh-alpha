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

自动化验收覆盖真实 TCP loopback、多 worker 目录、事件/审批/取消/断线、repo 选机和按需 clone。`0.1.1` 另已在两台实体 Linux worker 上完成 Codex / Claude Code / Kimi 真实任务、双 worker readiness、健康检查，以及首次 clone → 心跳广播 → 二次复用验收。

## 安装

### 方式 A：`dsh plugin`（面向使用者，推荐）

前提：本机已装 dsh（`0.1.0-rc.8`+）与 pnpm。

```bash
# 1) 把 dsh-alpha 装成 alpha profile 的 bundle 层。
#    alpha profile 不存在时自动以 dsh-base 打底创建；
#    dsh-alpha 声明了 dsh.bundle.patch，装好后自动进入层栈。
dsh plugin --profile alpha add dsh-alpha

# 2) 安装 alpha preset。preset 由 agent-presets 做文件系统发现，
#    不随 profile 层分发，装完包后补跑一次：
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-preset.mjs

# 3) 验收运行：主控 agent 查目录 → LLM 决策 → 派发 → 结果回流
dsh --profile alpha "用 list_agents 查看目录，把任务《写一句 hello》派发给最合适的 agent，并汇报结果。"
```

> preset 只需装一次；之后升级直接 `dsh plugin --profile alpha update dsh-alpha`。

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
| `DSH_ALPHA_DATA_DIR` | `$DSH_HOME/storages/dsh-alpha` | 任务/事件/审批 JSON 存储目录 |
| `DSH_ALPHA_DEFAULT_MODE` / `DSH_ALPHA_APPROVAL_POLICY` / `DSH_ALPHA_DEFAULT_MODEL` | `auto-review` / `on-request` / 能力默认 | 派发默认设置 |
| `DSH_ALPHA_GATEWAY_PORT` / `DSH_ALPHA_GATEWAY_TOKENS` | （关闭） | 启用主控 gateway hub：port 监听 + `machineId:token,...`（认证硬前提） |
| `DSH_ALPHA_GATEWAY_HOST` | `127.0.0.1` | hub 监听地址；跨机直连显式设为 `0.0.0.0`，并用防火墙限制来源 |
| `DSH_ALPHA_GATEWAY_READY_TIMEOUT_MS` | `2000` | headless 主控在首次查目录前等待 token 清单中的全部 worker 重连；设为 `0` 可禁用等待 |
| `DSH_ALPHA_HUB_URL` / `DSH_ALPHA_WORKER_TOKEN` / `DSH_ALPHA_WORKER_MACHINE_ID` | 本机 URL / 无 / hostname | worker 的 hub 地址、独立认证 token 与稳定机器 ID；token 默认通过 WS header 发送 |
| `DSH_ALPHA_WORKER_REPOS` | 无 | worker 本机已持有的 `[{repo_url,path}]`（repo 身份广播）；也接受 `{"repo_url": path}` |
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
├─ tools.mjs         # alpha preset 工具面：list_agents/dispatch_task/task_status/
│                    #   task_result/agent_approve/agent_cancel + 分派策略提示词
├─ lib/              # 目录(含 rankAgents) / 任务存储 / 任务引擎(含 repo 身份) /
│                    #   审批 broker / gateway hub+worker / 递归适配器（CJS）
├─ adapters/vendor/  # vendorized agent-anywhere runtimes + shared（websocket/协议/repo/调度）
├─ preset/alpha/     # alpha preset 模板（setup 脚本复制到 ~/.dsh/.agent-presets/）
├─ scripts/          # install-preset.mjs（preset 投递）+ setup-profile-alpha.mjs +
│                    #   alpha-worker.mjs（被控机进程）+ introspect-*（验收）
└─ cordis.patch.yml  # dsh-alpha bundle 补丁：控制面 + one-shot runner 挂载行
```

## 技术栈

Node.js 原生风格（CommonJS + ESM 包装、JSON 存储、`node --test`），dsh（DeepSeek Harness）插件形态（Cordis）。runtime 适配层直接复用 agent-anywhere 已验证实现（vendor 在 `src/adapters/vendor/`）。
