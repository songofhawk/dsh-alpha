# dsh-alpha

[English](README.md) | 简体中文 · [在线站点](https://songofhawk.github.io/dsh-alpha/) · [架构设计](docs/design.md)

> 在一段 DSH 对话里，把编码任务派发到不同机器、不同 Agent runtime 的统一主控层。

![dsh-alpha 产品演示](site/assets/dsh-alpha-demo.gif)

_演示使用隔离环境；机器名、工作区和路径信息均已打码。_

[项目主页](https://songofhawk.github.io/dsh-alpha/)中的方形宣传片使用开源 HyperFrames 框架在本地渲染。

## 为什么需要 dsh-alpha

单个编码 Agent 已经很有用，但真实工程很快会分散到笔记本、构建机、GPU 主机，以及路径各不相同的代码仓库。dsh-alpha 补上了中间缺失的控制面：

- 看清哪些机器、哪些 Agent 当前在线；
- 把不同机器上的同一个 Git 仓库识别为一个逻辑工作区；
- 按任务选择机器、runtime、模型、推理强度和权限模式；
- 把进度、审批、取消和结果持续回传到同一段对话；
- Worker 临时断线后重连，并恢复持久化的任务历史。

dsh-alpha 是 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 插件。它负责编排已有的 provider CLI，不替代它们各自的安装、登录和安全控制。

## 一张图理解

~~~text
DSH Web / headless 主控
  ├─ 全局工作区目录
  ├─ Agent 能力与负载目录
  ├─ 任务 / 审批 / 恢复状态
  └─ 反向 WebSocket gateway
          ├─ Worker A → Codex / Claude Code
          ├─ Worker B → Kimi Code / ZCode
          └─ Worker C → OpenCode / Qoder / WorkBuddy
~~~

Worker 主动连接主控，因此不需要公网 IP。仓库身份与机器本地路径彼此分离，实际执行始终受每台 Worker 显式配置的 allowed roots 约束。

## 核心能力

| 能力 | 带来的变化 |
| --- | --- |
| 全局工作区目录 | 同一个仓库可以跨多台机器、多个本地路径聚合展示。 |
| 仓库感知调度 | 优先选择已经持有仓库的 Worker；确需 clone 时也只能落在 allowed root。 |
| 逐轮 Worker 控制 | 不离开当前对话，即可选择 Agent、模型、推理强度和权限模式。 |
| 事件驱动结果 | 只派发一次，按事件等待；中断后用同一个持久化 task ID 继续。 |
| 审批回传 | Worker 的审批请求回到当前 Alpha 会话，不再隐形挂起。 |
| 反向 gateway | Worker 以带认证的 WebSocket 主动连接主控，断线后自动重连。 |
| 运维工具 | Web 侧栏、headless runner、状态 CLI、Worker doctor 和多设备验收清单。 |

## 快速开始

### 环境要求

- Node.js 22.13 或更高版本（任务事件使用内置 SQLite）
- DSH `0.2.1-rc.5` 或更高版本
- pnpm（`dsh plugin` 会调用）
- 实际执行任务的机器上，已经安装并登录所需 provider CLI

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

在 Web 侧栏打开 **Alpha 主控**，选择工作区或保留自动调度，然后创建会话。

### Headless 主控

~~~bash
dsh plugin --profile alpha add dsh-alpha
node ~/.dsh/profiles/alpha/node_modules/dsh-alpha/scripts/install-alpha-profile.mjs
dsh --profile alpha "用 list_agents 查看可用 Agent，派发一个简短任务，并汇报结果。"
~~~

安装脚本只更新 dsh-alpha 托管区块，不会覆盖区块之外的本地配置。

### 可选：Jev 自动路由

主控进程配置 `TYPESAFE_API_KEY` 并设置 `DSH_ALPHA_JEV_ROUTING=1` 后，未在界面指定 Agent 的新请求会先由 Jev 一次判断工作区、Agent 和模型。界面已指定 Agent 时仍直接派发。Jev 只从在线目录候选中选择；工作区范围、模型能力、目录边界和审批仍由现有任务引擎检查。Jev 不确定、超时或服务不可用时，交回原有主控 LLM。

密钥只放在主控进程环境中，不写入仓库。可通过 `DSH_ALPHA_JEV_ENDPOINT` 指向使用 HTTPS 且实现 TypeSafe `v1/systemone` 完整 Choice 响应的兼容服务，响应须包含 `choice`、`confidence` 和 `probabilities`。当前置信门槛是保守的试用值，上线前应以本项目真实请求评估正确率、回退率和延迟。

从源码测试可用 `node --env-file=.env` 加载本地配置；仅把 `.env` 放在目录中不会改变已运行主控进程的环境。

### 从源码开发

~~~bash
git clone https://github.com/songofhawk/dsh-alpha.git
cd dsh-alpha
npm install
npm run setup
npm test
~~~

## Alpha 主会话

侧栏的 **Alpha** 入口打开一个常驻主会话（`alpha-router` preset）。直接在里面连续发消息：每句话会归到某个任务，工作在后台并行，对话不会被运行中的任务阻塞。

- **归属**分三级：确定性规则（`#12`、任务详情输入框、输入框的本条选择），然后是 Jev 决策模型，最后是主控 LLM。每次判断都有记录，归错了可以在任务视图里“改归属”。
- **装上就默认进入 Alpha 整页界面**：左边是任务栏，右边是对话或任务详情；点任务栏顶部的「返回 DSH」回到宿主原来的界面，输入框旁和侧栏的「进入 Alpha」可以再回来。任务有进展不会让界面自己跳转。
- **对话是 IM 式的**：一条按时间排列的对话流，没有逐字输出。你的话、Alpha 的回复、Worker 的汇报各是完整一条，每句话下面有 `→ #12 任务名` 标签（点开看详情，归错了点「改归属」），待审批的命令以卡片固定在输入框上方。可以发图片和文本类文件（点回形针、拖进来或粘贴），点某条消息下面的「引用」，接着发的话就直接归到那个任务。
- **任务栏**：「任务按 [状态▾] 分组」可换成项目、类型、机器，最上面是需要你处理的事。类型没有预设，由 Alpha 根据你派的任务长出来，会尽量沿用已有的；你可以新建、改名、合并。审批只能点界面按钮完成（对话里输入框上方的审批卡片，或任务详情里）。
- **连续性**：runtime 支持时，追问续接同一个 runtime 会话，运行中的 turn 可以直接追加输入；不支持时用任务记录重建上下文。主控重启后，未完成的任务会自动继续。
- **选择器只管下一条**：在主会话里，Agent、模型、机器、项目的选择只约束下一条消息，发送后清空。

决策模型归属默认关闭，因为它会把任务标题、摘要和最近消息发给 Jev。设置 `DSH_ALPHA_JEV_ATTRIBUTION=1` 和 `TYPESAFE_API_KEY` 后开启；关闭时，确定性规则判断不了的消息都交给主控 LLM。开启前可以用 `node --env-file=.env scripts/eval-attribution.mjs --jev` 评测，这会把标注集发给 Jev。

经典的 **Alpha 主控**会话（`alpha` preset，`dispatch_task` / `wait_task`）保持不变，仍可从主控目录打开。

## 接入远程 Worker

在主控端为每台 Worker 配置独立 token：

~~~bash
export DSH_ALPHA_GATEWAY_HOST=0.0.0.0
export DSH_ALPHA_GATEWAY_PORT=4310
export DSH_ALPHA_GATEWAY_TOKENS='build-1:replace-with-a-long-random-token'
~~~

在目标机器上安装并启动 Worker：

~~~bash
npm install dsh-alpha

export DSH_ALPHA_HUB_URL='ws://<master>:4310/'
export DSH_ALPHA_WORKER_MACHINE_ID='build-1'
export DSH_ALPHA_WORKER_TOKEN='replace-with-a-long-random-token'
export DSH_ALPHA_WORKER_ALLOWED_ROOTS='/work'

./node_modules/.bin/dsh-alpha-worker-doctor
./node_modules/.bin/dsh-alpha-worker
~~~

离开可信局域网或 VPN 后，请使用 `wss://` 并在网络层限制来源。不要把 token 放进仓库、URL、截图或进程日志。

## 支持的 runtime

默认逐个探测以下 runtime，已安装且可执行的 Agent 自动出现在目录。`DSH_ALPHA_WORKER_PROVIDERS` 仅用于需要限制候选时的显式覆盖。

| Provider ID | Runtime | 发现方式 |
| --- | --- | --- |
| `codex` | Codex app server / CLI | 自动探测 |
| `claude-code` | Claude Code headless | 自动探测 |
| `kimi-code` | Kimi ACP | 自动探测 |
| `dsh` | DSH headless profile | 自动探测 |
| `zcode` | 智谱 ZCode headless | 自动探测 |
| `opencode` | OpenCode ACP | 自动探测 |
| `qoder` | Qoder headless | 自动探测 |
| `workbuddy` | 腾讯 WorkBuddy（通过 codebuddy） | 自动探测 |

自动探测只确认可执行文件存在；每个 runtime 仍需独立完成登录，并用真实任务验收。`mock` 只用于测试和本地诊断。

`dsh` 在 Worker 的目标目录执行 `dsh --profile headless`，使用该机器 headless profile 的默认模型。此入口只返回最终文本；暂不支持逐轮模型参数或把 DSH 内部审批转发到主控。

Codex Worker 会按目标机的实际执行目录查找 Codex 项目；没有匹配项目时，以目录名创建，并把目标机的 `projectId` 传给新会话。续接旧会话时也会补齐项目归属。同一目录的并发创建使用幂等键，主控的项目 ID 不会跨机器复用。目标机 Codex 需要支持 `project/list`、`project/create`、`thread/start.projectId` 和 `thread/metadata/update.projectId`；关联失败会报错并停止该轮执行。GUI 要显示这些项目和会话，需要访问同一目标机、同一用户的 Codex 存储。

## 日常派发流程

1. `list_workspaces` 解析逻辑仓库及其机器位置。
2. `list_agents` 提供在线状态、能力、负载和工作区亲和度。
3. `dispatch_task` 返回持久化 `taskId`；`wait_task` 通过事件流等待，不做忙轮询。
4. `agent_approve` 或 `agent_cancel` 在当前 Alpha 会话处理 Worker 审批。
5. `task_status` 与 `task_result` 用于断线恢复或历史任务回读。

Web 工作区选择器可以形成明确的机器/项目硬约束。未手工选择时，调度器可以自动选择匹配 Worker，并把 Git 工作区 clone 到该 Worker 的 allowed root。

## 默认安全边界

- Gateway 缺少认证 token 时拒绝启动。
- 本机和远程路径都必须通过显式 allowed roots 校验。
- Clone 目标由 Worker 在允许范围内决定，任务不能提交任意落盘路径。
- Web 主控与 headless 主控不能占用同一个 gateway 端口。
- 健康检查只暴露存活状态和 Worker 数量，不暴露身份与密钥。
- Worker doctor 是只读检查，且不会打印 Worker token。
- 审批、取消、重连和中断恢复都有自动化测试覆盖。

## 常用命令

~~~bash
dsh-alpha status
dsh-alpha web
dsh-alpha run "总结当前工作区"
dsh-alpha-worker-doctor
dsh-alpha-worker
npm test
~~~

## 文档导航

- [设计与架构](docs/design.md)
- [部署指南](docs/deployment.md)
- [多设备验收清单](docs/multi-device-acceptance.md)
- [局域网访问 bundle](packages/dsh-lan-access/README.zh-CN.md)
- [Vendor adapter 说明](src/adapters/vendor/README.md)
- [宣传文章：中文](site/article.zh-CN.md) / [English](site/article.en.md)
- Doco 发布版：[中文](https://doco.page/s/k2KWDVuEhWMDUA5mGpf_nUd7hMI_Um-u) / [English](https://doco.page/s/WBbyHRtlsfr1lhwr_iDTLQbpdSXL0QeM)

## 项目状态

当前公开源码版本：**0.2.1**。仓库已经覆盖本机编排、反向 gateway Worker、仓库感知调度、递归主控、审批转发、全局工作区选择、任务持久化恢复，以及七种产品 runtime 集成。

升级线上实例后，请重新运行对应的 preset/profile 安装脚本，并按多设备验收清单逐台验证。
