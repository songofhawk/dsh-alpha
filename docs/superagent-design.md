# dsh-alpha SuperAgent 总体设计与实施规划

> 状态：待评审（2026-11-01）。本文是交给实现 agent 的唯一入口，第 7 节是接口契约，第 8 节是工作包。
> 参考：DeepSeek Harness 团队《Super-agent 设计探索》（2026-10-31，下称“论文”）；[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（下称“原型”）。

## 1. 结论

1. **方向**：把 dsh-alpha 从“用户在某个会话里选目标、等一个任务跑完”，改成“用户只面对一个常驻 Alpha，消息随时发，系统把每句话归到任务并在后台并行推进”。
2. **最大的结构性缺口不是事件接入，而是三件事**：对话会被任务阻塞；派发是一次性的，无法续接 Worker 上下文；没有“任务”这个一等实体。先解决这三件事，事件驱动才有意义。
3. **本项目相对原型的差异化**：
   - 原型只有“单仓库 + GitHub/飞书”，Thread 由来源天然给出。我们的主入口是**单一聊天窗口，消息没有天然 Thread**，所以需要逐句归属。这正是论文 8.2 留白的问题，也是本次用户补充的需求。
   - 我们已有多机反向 Worker、8 种 runtime、逻辑工作区，天然就是论文第 5 节的“计算与执行环境分离”。这部分不用重做。
4. **用户补充需求的落地方式**：Decision model（Jev）对每句话做**三级归属**；同一份数据投影成“对话视图”和“任务视图”，一键切换；任务的**状态由程序推导，类型由模型分类**，两者分开。
5. **第一个里程碑 R1 只做“单窗口多任务全双工 + 任务视图”**，不接任何外部事件源。主动行为和外部渠道放到 R3。
6. **前置条件**：依赖 DSH 升级。仓库锁定 `0.1.0-rc.8`，原型依赖 `^0.2.1-alpha.2`，npm latest 已到 `0.2.1-rc.5`。全双工需要的 `agent.inbox` 目前只在原型代码里见到，WP0 必须先验证。

## 2. 目标与非目标

**目标（R1 + R2 + R3）**

- 用户在一个窗口连续发消息，不需要选任务、不需要等上一件事结束。
- 每句话有可追溯、可纠正的归属；一键切到任务视图能看到全部工作的状态。
- 多任务并行且互不污染；机器离线、主控重启后任务自动续上。
- 系统能发现停滞；后续能接外部事件并在规则内主动行动。

**非目标**

- 多用户、团队共享、A2A（论文 8.3）。Alpha 仍是单一所有者实例。
- 云端无状态水平扩展（论文 5.1）。主控继续是单进程 + SQLite。
- 改写 Worker 内部的任务拆解。Worker 是不是 Agent Team 对主控透明。
- 替换旧模式。旧的 `alpha` preset、`dispatch_task` / `wait_task`、headless runner 全部保留。

## 3. 现状差距

| 论文模块 | dsh-alpha 现状 | 差距 | 代码证据 |
|---|---|---|---|
| Router 层（2.1） | 主控没有执行工具，Jev 已做目标路由；但会话按目标分散，每个目标一个会话 | 无单一常驻 Router；Jev 只选目标，不判断归属 | `src/lib/jev-router.mjs`、`src/tools.mjs:36` |
| Worker 层（2.2） | 已有隔离执行，但每次派发都是新 runtime 会话 | **无法续接**：`runtime_session` 事件只用于显示，没有回传；7 个 runtime 已支持 resume，但主控从未传入 | `src/lib/task-engine.js:296`、`:580` |
| 事件驱动（3） | 只有用户消息，无 Trigger/Thread/Subscription | 全缺 | — |
| 链式召回（3.3） | 只有按 taskId 的恢复工具 | 无引用图；任务列表按 session 过滤 | `src/lib/task-engine.js:631` |
| 全双工（4.1） | `dispatch_task` 后 `wait_task` 占住整个 turn | **对话被阻塞**；同一步的多条消息还会被合并成一个 prompt | `src/lib/direct-dispatch.mjs:31`、`:83` |
| 多信道（4.2） | 仅 Web | 无 Channel 抽象 | — |
| 执行环境分离（5.2） | 反向 WS Worker、allowedRoots、断线重放 | 基本具备；缺离线等待：机器离线直接报错 | `src/lib/task-engine.js:181` |
| Watchdog（6） | 只有心跳租约，判断活没活着 | 无法判断“活着但没进展” | `src/lib/task-engine.js:310` |

另有四个现状问题会直接阻塞新设计：

- **Steer 未打通**：协议有 `STEER_TURN`，Codex/mock runtime 也实现了 `steerTurn`，但 hub 和 worker 都没有实现这条路径（`src/adapters/vendor/shared/gateway-protocol.js:31`）。
- **审批不适合异步**：审批只存内存，10 分钟超时自动拒绝（`src/lib/approvals.js:5`）。用户不再盯着当前 turn 后，这会让任务大量失败；重启后待决审批也会丢。
- **重启即失败**：`recoverInterrupted` 把所有进行中任务置为 failed（`src/lib/task-store.js:466`），长期任务需要自动恢复。
- **同仓并行会互相覆盖**：任务直接跑在工作区路径上，没有隔离目录。

## 4. 目标架构

```text
入口（R1 只有 Web）
  Web 对话 / 任务详情输入框 ┐
  飞书 / GitHub（R3）       ├─► Source ─► Trigger（不可变、落库）
  Worker 报告 / 系统事件    ┘                │
                                            ▼
                     ┌──────────── 归属管线（程序 + Decision model）───────────┐
                     │ T0 确定性规则 → T1 Jev → T2 Router LLM                  │
                     └───────┬───────────────────────┬────────────────────────┘
                 已归属，快路径│                       │未决，慢路径
                             ▼                       ▼
                       Ticket Engine ◄────── Router Session（单一常驻，无执行工具）
                             │                 ▲     │ 只做路由、答复、跨任务协调
                 输入队列 / 串行 Run            │     └► 对用户的唯一出口
                             ▼                 │
                       Task Engine（现有）      │ 报告经 outbox 持久投递
                             │                 │
              本机 runtime / Gateway ─► Worker（多机、可 resume / steer）
                             │
                     SQLite：tasks + tickets + triggers + decisions + inputs + outbox
                             │
                  ┌──────────┴──────────┐
              对话视图               任务视图（同一份数据的两种投影）

独立回路：Watchdog（确定性巡检 + 模型判断进展）
```

**分层不变量（实现时不得破坏）**

1. Router 不持有 shell、文件写入等执行工具。任何实际工作都必须成为 Ticket。这是系统级约束，不靠提示词。论文 7.1 的实验说明，靠提示词约束“分工”并不稳定。
2. Worker 不直接向用户说话，所有对外输出都经 Router 层。
3. 一个 Ticket 同一时刻最多一个活动 Run。
4. 已确定归属的消息不经过 Router LLM。
5. 模型判断只决定路由和展示，绝不产生授权：不批准审批、不放宽目标范围、不提升权限模式。

## 5. 领域模型

概念尽量少，术语与原型对齐。**界面上一律叫“任务”，代码里叫 Ticket**，这样现有的 `tasks` 表和 `dispatch_task` 工具不用改名。

| 概念 | 定义 | 关键规则 |
|---|---|---|
| Trigger | 一条不可变事件：用户消息、Worker 报告、CI 通知等 | 幂等落库；带 `trust`（`user` / `system` / `external`） |
| Thread | 一串天然相关的 Trigger，例如一个 PR | 只有外部来源有。聊天窗口没有 Thread，改用逐句归属 |
| Ticket（任务） | 一件有授权的工作，用户可见 `#12` | 只有归属管线能创建；`open → ended`，人的新消息可重开；自身状态不跟随 Run |
| Run（运行） | 现有 `tasks` 表的一行，是 Worker 的一次 turn | 必属于一个 Ticket（旧数据除外） |
| Binding | Ticket 当前绑定的 agent、机器、路径、`runtimeSessionId` | 存在 Ticket 上；换 agent 就换 Binding，并用摘要交接 |
| Input | 待送达 Worker 的一条输入 | `pending → delivered`；Run 串行消费 |
| Subscription | Ticket 与 Thread 的多对多关系 | 同 Thread 的后续事件直通，R3 才用 |
| Decision | 一次归属判断的完整记录 | 含 tier、候选、置信度、是否被用户改过；这就是评测数据集 |

新增表放在同一个 `tasks.sqlite3`，保证 Ticket 和 Run 能同事务写入：

```sql
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,                 -- tkt_<uuid>
  seq INTEGER NOT NULL UNIQUE,         -- 用户可见编号
  status TEXT NOT NULL,                -- open | ended
  outcome TEXT,                        -- done | dropped | stopped | merged
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',    -- 滚动摘要，供 Jev 候选和 Router 使用
  origin TEXT NOT NULL,                -- user | proactive
  workspace_id TEXT,
  category TEXT,
  category_source TEXT,                -- auto | user；user 永不被自动覆盖
  binding_json TEXT,
  attention_json TEXT,                 -- 等待人回答的结构化问题
  merged_into TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE triggers (
  id TEXT PRIMARY KEY, source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,        -- 来源侧事件 ID，用于幂等
  thread_key TEXT, actor TEXT,
  kind TEXT NOT NULL, trust TEXT NOT NULL, text TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (source, source_event_id)
);
CREATE TABLE ticket_triggers (          -- 任务时间线；一句话可属于多个任务
  ticket_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  via TEXT NOT NULL,                    -- ui | t0 | jev | router | user_fix | fanout
  PRIMARY KEY (ticket_id, trigger_id)
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, tier INTEGER NOT NULL,
  action TEXT NOT NULL, ticket_id TEXT, confidence REAL, probability REAL,
  margin REAL, candidates_json TEXT, reason TEXT,
  overridden_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE ticket_inputs (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending | delivered | moved
  run_id TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE TABLE subscriptions (
  ticket_id TEXT NOT NULL, thread_key TEXT NOT NULL,
  role TEXT NOT NULL,                   -- own | context
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, thread_key)
);
CREATE TABLE outbox (                   -- 先落库后投递，崩溃可重放
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, done_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE approvals (                -- 审批持久化，替代内存 Map
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ticket_id TEXT,
  status TEXT NOT NULL, record_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
```

`tasks.record_json` 增加 `ticketId`、`inputIds`、`runtimeSessionId`。迁移只做加法，用 `PRAGMA user_version` 管版本。旧任务 `ticketId` 为空，界面归入“历史运行”，不回填。

## 6. 核心机制

### 6.1 一条消息的生命周期

```text
用户发送
 └─ 落库 Trigger（幂等）
     └─ 归属管线
         ├─ attach → 写 Input → 回一行确认 → turn 立刻结束
         │            └─ Ticket Engine：steer / 排队 / 新 Run（resume）
         ├─ new    → 建 Ticket → 回一行确认 → turn 立刻结束 → 启动 Run
         └─ router → 进入 Router LLM，由它调用 ticket_route 或直接回答
Run 结束
 └─ 写 outbox → 分类报告 → 投递到主会话 → 需要时才通知用户
```

用户要的体验由此成立：发消息后 1 到 4 秒内得到确认，输入框始终可用。

### 6.2 三级归属（用户补充需求的核心）

逐条处理，不再把同一步的多条消息合并。

**T0 确定性规则（不调模型）**，按顺序匹配：

| 条件 | 结果 |
|---|---|
| 在任务详情里发送 | 硬归属该任务 |
| 回复或引用了任务卡片 / 该任务的消息 | 硬归属该任务 |
| 明确写了 `#12` 或任务链接，且唯一命中 | 硬归属该任务 |
| 带有输入框的“本条约束”（选了 agent / 机器 / 项目） | 新建任务，约束作为硬范围 |
| 没有任何可归属的 open 任务且目录可判定 | 跳过 attach 候选，只判断是否新建 |

**T1 Decision model（Jev）**：一次请求同时问完，避免两次往返。沿用现有 `questions` 协议，超时 3 秒。

| 问题 | 类型 | 选项 / 含义 |
|---|---|---|
| `intent` | choice | `work` 提出或继续工作、`stop` 叫停、`status` 问进度、`chat` 闲聊、`unsure` |
| `ticket` | choice | `t0…tN` 候选任务、`new`、`multiple` 涉及多个任务、`unsure` |
| `selfContained` | noul | 这句话脱离前文能否被 Worker 看懂 |
| `target` / `needsShell` / `workspace` / `model_*` | 沿用 | 仅在结果为 `new` 时使用 |

候选任务由程序预筛，最多 30 个：优先 open 任务，其次 14 天内结束的任务；按最近活跃和工作区名命中排序。每个候选只给 `title`、`summary`、阶段、项目、最后一条用户消息前 50 字。`state` 里带最近 3 条消息及其归属，让“再加个测试”这类省略句能判断。

**接受规则（初始值，须用评测校准）**

| 动作 | 条件 |
|---|---|
| attach | `intent=work`；confidence ≥ 0.75，p ≥ 0.8，且与第二名差距 ≥ 0.25 |
| new | `intent=work`；confidence ≥ 0.6，p ≥ 0.7，且 `selfContained` 为真 |
| 其它一切 | 交给 T2 |

attach 的阈值更严，因为错误代价不对称：错误新建只多一个可合并的任务，错误归属会污染运行中的 Worker。这与原型“重复任务可以关闭，错误归属无法撤回”的判断一致。但原型只允许“明确指向”才归属，这在单窗口场景不够用，所以我们放宽到模型判断，并用下面的纠错能力兜底。

**T2 Router LLM**：`stop`、`status`、`chat`、`multiple`、`unsure`、依赖前文的新任务，以及 Jev 不可用时的全部消息，都走这里。它用 `ticket_route` 批量决定，可以把一句话拆给多个任务，也可以写不超过 30 字的路由备注。**不得改写用户原文**，备注只作补充。

**纠错是一等功能**

- 每条确认都能“改归属”：把这句话移到另一任务、拆成新任务，或标为无关。
- Input 尚未送达时直接移动；已送达时向原 Worker 发一条更正，并把 Decision 标记 `overridden_by`。
- 支持合并任务（`merged_into`）。
- 所有更正都进入评测集。

### 6.3 全双工 Router

- **单一常驻主会话**：每个主控一个 Alpha 主会话，由新 preset `alpha-router` 承载，侧栏入口直接打开它。工作目录复用中性的 `alpha-control`。
- **快路径**：升级 `installDirectDispatch`，在 `agent/pre-step` 完成归属，经 `llm/stream` 接缝返回一行确认后结束 turn，不调用模型，也**不再生成 `wait_task`**。工具执行仍走宿主唯一的 ToolRuntime，这条现有约束不变。
- **报告回流**：Run 结束写 outbox，经宿主 inbox 以 `dsh-alpha` 自己的消息来源投递到主会话（不得冒充用户消息），按幂等键去重。这对应原型 `agentDelivery.send` 的 `queue` / `steer` / `inject` 三种模式。
- **批处理**：Router 推理期间到达的 Trigger 由宿主合并到下一步，论文 7.2 证明这能抗突发，**不要自建合并逻辑**。
- **输入框的选择器语义变化**：在主会话里，agent、模型、机器、项目选择是“本条约束”，发送后清空；在任务详情里，它们显示并修改该任务的 Binding。旧 session 的行为不变。

**对外发言纪律**（写进 Router 提示词，按渠道配置）：只在需要决定或验收时说话；单条回复不超过 100 字（中文按字计）；进度留在任务视图。用户主动问进度时才汇总。短结果（600 字以内）可由程序直接转述；长结果由轻量模型摘要，完整内容放任务详情。

### 6.4 Ticket 执行与上下文续接

一条 Input 归属到 Ticket 后：

| Ticket 状态 | runtime 能力 | 行为 |
|---|---|---|
| 有活动 Run | 支持 steer | 经 `STEER_TURN` 注入当前 turn |
| 有活动 Run | 不支持 steer | 排队，当前 Run 结束后合并成下一个 Run 的 prompt |
| 空闲或已结束 | 支持 resume | 新 Run，传 `session.runtime_session_id` 续接；人的消息会重开 ended 任务（用户叫停的除外） |
| 空闲或已结束 | 不支持 resume（`dsh`） | 新 Run，用“标题 + 摘要 + 上次结果 + 新输入”重建上下文 |
| 目标机离线 | — | 进入 `waiting/machine`，上线后自动继续，或由用户改绑 |

改动要点：

- `runTask` 用 Ticket 的 Binding 组装 `session`，并在收到 `runtime_session` 事件时写回 Binding。
- 能力表增加 `session_resume`、`steer`，由各 adapter 声明，主控不靠 provider 名字硬编码。
- 打通 hub → worker 的 steer；断线时降级为排队。
- 主控重启：有活动 Run 的 Ticket 不再简单判失败，按 Binding 发起恢复 Run，提示 Worker 先检查目录和 git 状态再重复外部操作（原型 Restart 一节的做法）。
- 审批：持久化；移除“10 分钟自动拒绝”，改为任务停在 `person/approval` 等待人决定，由 Watchdog 提醒。Worker 侧等待超时保持 fail-closed，超时后任务显示受阻，可用 resume 继续。

### 6.5 任务状态与自动分类

**两个维度分开，这是分类能做好的关键。**

**状态（Stage）由程序推导，互斥且完备**，不让模型判断。从上到下匹配，第一个命中者生效：

| Stage | 条件 | 界面分组 |
|---|---|---|
| `person/approval` | 有待决审批 | 需要我 |
| `person/answer` | 有 attention | 需要我 |
| `person/blocked` | 最新报告 blocked / failed，且之后没有新的人类输入 | 需要我 |
| `person/review` | 最新报告 ready，待验收 | 待验收 |
| `waiting/machine` | 有待送达输入但目标机离线 | 等待中 |
| `working/queued` | 无活动 Run，但有待送达输入或等待槽位 | 进行中 |
| `working/running` | 有活动 Run | 进行中 |
| `idle` | 其它 open 任务 | 等待中 |
| `ended/*` | done · dropped · stopped · merged | 已结束 |

报告分类：第三方 CLI 只给最终文本，没有结构化报告。Run 结束时用 Jev 对最终文本判一次 `ready / question / blocked / done_no_action`，失败时回退 `person/review`。原型明确拒绝从自由文本推断等待状态，因为它能让 Executor 上报结构化字段；我们面对第三方 CLI 做不到，所以接受这个取舍，并把判定结果限定在展示层，不影响授权。

**类型（Category）由模型分类**：新建后异步调用 Jev，从固定列表选一个：缺陷修复、功能开发、重构、调研分析、运维部署、文档、其它。不阻塞确认消息；用户手改后 `category_source=user`，不再自动覆盖。**项目维度直接用 `workspaceId`，不需要模型。**

**标题与摘要**：T2 由 Router 给出；快路径先截取首句，随后用轻量模型异步补全。摘要在每次报告后更新，是 T1 候选质量的决定因素。

### 6.6 任务视图

原则取自原型面板：打开后先回答“有什么需要我”，健康状态不占空间。

- **切换**：对话 / 任务双态开关，显示“需要我”的数量角标，支持快捷键。切换不离开主会话，用 hash 深链 `#ticket/12`。
- **看板**：默认按 Stage 分组：需要我 → 待验收 → 进行中 → 等待中 → 已结束（默认折叠）。可切换按项目、类型、机器分组。
- **任务详情**：只显示归属到该任务的消息、Worker 报告、Run 过程（复用 `TaskMonitorPanel` 的事件渲染）、审批。这里的输入框走 T0 硬归属。
- **操作**：批准/拒绝、停止、验收、改类型、改绑 agent、合并、拆分。
- **对话视图**：每条用户消息显示归属标签。如果宿主没有消息级插槽，就退回到 Router 的确认行 `→ #12 登录修复`，这样**不依赖宿主 UI 也能交付**。输入框上方保留一条“待办条”，显示待审批和待回答的事项（复用现有 `monitorHost` portal）。
- **移动端**：看板在窄屏退化为单列列表。最近的提交说明手机端是实际使用场景，这是验收项。

实现路径：沿用现有 portal 方式全屏覆盖会话区（参考 `AlphaInventoryPage`），不依赖新插槽。列表用现有 `createTaskPoller`，只在视图可见时轮询。`src/client.js` 已有 1864 行且无构建步骤，WP0 须确定是否能拆分成多个模块。

### 6.7 上下文组织与链式召回

- **Inline**：Router 每步通过 system prompt section 看到看板快照：最多 20 个 open 任务的 `#seq / 标题 / Stage / 项目`，总量不超过 2000 字符。
- **Spill**：所有读工具统一返回“摘要 + 关联 ID + 续读游标”。文本页默认 4000 字符、列表默认 20 条，这是原型验证过的值。
- **召回路径**：`trigger → ticket → run → 关联 ticket/thread`。每跳的返回结果都内联下一跳的 ID。
- **Worker 的 prompt**：首次派发保持用户原文。这延续了现有“用户原文不变”的规则，也符合原型“Router 不把请求扩写成计划”的要求。

### 6.8 并行隔离与调度

- **Git 工作区**：每个写任务一个 worktree，路径由 Worker 决定（`<allowedRoot>/.dsh-alpha/worktrees/<seq>-<slug>`），分支 `alpha/<seq>-<slug>`。扩展现有 `PROVISION_PROJECT`，路径校验沿用 allowed roots。
- **非 Git 目录**：同一路径的 Run 串行。
- **读任务**：默认也走隔离。只有当 Worker 模式能真正保证只读时，才允许直接在主工作区运行。
- **槽位**：每台机器设 `maxRun`；人的消息可以占用一个额外槽位，保证新工作不会挤掉人对现有任务的跟进（原型 Concurrency 一节）。
- **技术债**：`shellRestricted` 里硬编码的机器名（`src/lib/jev-router.mjs:7`）要改成 Agent 能力声明。

### 6.9 Watchdog

- **确定性巡检**（主控内定时器）：Run 有心跳但 N 分钟无事件、审批或问题长时间未处理、输入长时间未送达、outbox 连续失败。
- **模型判断**（独立会话，定时唤醒，仅在有活动 Run 时运行）：读取任务摘要和近期事件，判断有无实质进展、是否偏离目标。可写备注、通知用户、向 Worker steer 一条提醒；**默认不自动取消任务**。
- **外部存活**：独立 systemd 单元探测主控健康端点，异常时重启并告警。进程内的巡检管不了进程本身挂掉。

### 6.10 事件源与主动行为（R3）

- `Source` 接口：`start(emit)`、`threadsOf(trigger)`、`send(address, message)`。首批 GitHub（轮询）和一个 IM。Web 聊天也实现成一个 Source，保证路径统一。
- **两级过滤**：程序层（来源、白名单、范围）→ 语义层（提示词策略）。
- **订阅直通**：同 Thread 后续事件按 Subscription 直达任务；人的消息可重开 ended 任务，bot/CI 不能。
- **主动行为**：必须由用户写的规则触发，且**默认影子模式，只记录“本来会做什么”**，确认合理后再开启。提前行动的结果只有在有价值时才打扰用户。

### 6.11 安全

事件驱动会把不可信文本带进主控，这是 R3 最大的风险。

- 外部内容（`trust=external`）一律是数据，不能授权。外部事件只能创建 `origin=proactive` 的任务，模式固定为最小权限，禁止 `full-access`。
- **在接入任何外部 Source 之前，必须从 `alpha-router` 移除 `agent_approve`**，审批只接受界面按钮。否则一段恶意 PR 评论就可能通过提示词注入批准危险命令。
- Decision model 只影响路由。发给 Jev 的内容按现状会离开主控，必须保持 HTTPS，并在文档中告知；外部内容默认不送 T1，直到完成隐私确认。
- allowed roots、per-machine token、审批 fail-closed 等现有边界不变。凭据不进入任何 prompt、Trigger 或 Decision。

## 7. 接口契约（并行开发时冻结）

修改本节需同步所有工作包。

```js
// src/lib/attribution.mjs
attribute({ trigger, ui, candidates, signal }) → Decision
// ui: { ticketId?, replyTo?, constraints? }
// Decision: { tier: 0|1|2, intent, action: "attach"|"new"|"router",
//             ticketId?, route?: { agentId, workspaceId, model },
//             confidence?, probability?, margin?, reason }
// 失败或超时必须返回 action:"router"，绝不抛错阻断对话。

// src/lib/ticket-engine.js
openTicket({ trigger, title, route, constraints, origin }) → ticket
submitInput(ticketId, triggerId, { via }) → input
stopTicket(ticketId, { by })
resolveAttention(ticketId, answerTriggerId)
reattribute(triggerId, { toTicketId | newTicket | none }) → decision
mergeTickets(fromId, intoId)
stageOf(ticket) → stage                  // 纯函数，第 6.5 节的表
board({ groupBy, filter, limit }) → rows
on("ticket.created" | "ticket.stage" | "ticket.report" | "ticket.ended", fn)

// src/lib/task-store.js：允许注入共享 DatabaseSync，新增 database 访问器
// src/lib/task-engine.js：dispatch 增加 { ticketId, session: { runtime_session_id } }
```

**新增 RPC**（`/api/dsh-alpha`）：`ticket/board`、`ticket/get`、`ticket/timeline`、`ticket/send`、`ticket/update`、`ticket/stop`、`ticket/merge`、`ticket/approval`、`message/reattribute`。权限与现有 `task/*` 一样限定在 alpha 会话。

**Router 工具**（`alpha-router` preset 只有这些）：

| 工具 | 说明 |
|---|---|
| `ticket_route({ items })` | 批量决定。`item: { triggerId, kind: accept/attach/stop/ignore, ticketId?, title?, note?, constraints? }`，按 triggerId 幂等 |
| `ticket_list({ filter, cursor })` | 任务列表 |
| `ticket_read({ ref, cursor })` | 读 `ticket/<id>`、`run/<id>`、`trigger/<id>` 等，遵循 Inline & Spill |
| `list_workspaces`、`list_agents` | 沿用 |

Router 没有 `dispatch_task`、`wait_task`、`agent_cancel`：派发由 `ticket_route` 完成，停止用 `kind=stop`。

## 8. 实施规划

### 8.1 工作包

依赖关系：

```text
WP0 ─► WP1 ─┬─► WP2 ─┐
            ├─► WP3 ─┼─► WP4 ─► [R1 验收]
            └─► WP5 ─┘
[R1] ─┬─► WP6 ─┐
      ├─► WP7 ─┼─► [R2 验收]
      └─► WP8 ─┘
[R2] ─► WP9 ─► WP10 ─► [R3 验收]
```

WP2、WP3、WP5 可并行，三者只通过第 7 节契约耦合。WP5 可先用 fixture 开发。WP6、WP7、WP8 同样可并行。

| WP | 内容 | 主要文件 | 验收 |
|---|---|---|---|
| **WP0** 宿主升级与探针 | 升级 DSH 到目标版本；验证第 10 节全部未验证项；产出 `docs/superagent-host-seams.md` | `package.json`、`scripts/*`、`preset/*` | 现有测试全绿；真机跑通一次派发和审批；探针结论写明 |
| **WP1** 数据层与 Ticket 核心 | 共享 DB、迁移、Ticket/Trigger/Decision/Input/outbox/approvals、`stageOf` | `src/lib/task-store.js`、新增 `ticket-store.js`、`ticket-engine.js`、`outbox.js` | 迁移可重复执行；stage 表每行都有测试；崩溃后 outbox 可重放 |
| **WP2** Worker 续接 | Binding、resume、steer 打通、能力声明、重启恢复、审批持久化 | `task-engine.js`、`gateway-hub.js`、`gateway-worker.js`、`approvals.js`、`capabilities.js` | 用 mock 与真实 codex/claude-code 各验证：第二条消息确实续上第一条的上下文；重启后自动恢复 |
| **WP3** 归属管线 | 抽出 Jev 客户端、T0/T1、候选预筛、Decision 落库、评测脚本 | `jev-router.mjs`、新增 `jev-client.mjs`、`attribution.mjs`、`scripts/eval-attribution.mjs` | 第 9 节指标达标；Jev 断开时全部降级到 T2 |
| **WP4** 全双工 Router | 主会话、`alpha-router` preset、快路径、报告回流、`ticket_route`、提示词 | `direct-dispatch.mjs`、`tools.mjs`、`plugin.mjs`、`preset/alpha-router/` | R1 场景通过；Worker 运行期间对话零阻塞；旧 preset 回归通过 |
| **WP5** 任务视图 | RPC、看板、详情、切换、改归属、移动端 | `plugin.mjs`、`client.js` | 手机和桌面都走通；数字与列表一致；改归属后时间线正确 |
| **WP6** 自动分类 | 类型分类、报告分类、标题摘要、分组 | `classifier.mjs`、`client.js` | 分类不阻塞确认；用户手改不被覆盖 |
| **WP7** 链式召回 | 看板快照、读工具、引用图 | `tools.mjs` | 主会话压缩后仍能从一句旧话追到对应 Run 结果 |
| **WP8** 并行隔离 | worktree、路径串行、槽位、离线等待、改绑交接 | `gateway-worker.js`、`workspace-service.js`、`scheduling.js` | 同仓 3 个任务并行不冲突；机器下线再上线后自动继续 |
| **WP9** Watchdog | 巡检、模型判断、外部存活 | 新增 `watchdog.mjs`、systemd 单元、`docs/deployment.md` | 故障注入：卡死的 Run 被发现并提醒；误报率可接受 |
| **WP10** Source 与主动 | 安全前置、Source 接口、GitHub、IM、过滤、订阅直通、影子模式 | 新增 `src/lib/sources/` | 安全测试通过：外部文本无法触发审批或越权；影子模式只记录不行动 |

### 8.2 里程碑验收场景

**R1：单窗口多任务（WP0 至 WP5）**。用 mock runtime 自动化，再用真实 Worker 手测一次：

1. 在主会话发“修复 A 项目登录 bug”，1 到 4 秒内收到确认，任务创建，输入框可用。
2. 不等结果，发“看下 B 项目 CI 为什么挂了”，新建第二个任务，两者并行。
3. 发“登录那个再加个回归测试”，归属到第一个任务，内容送达 Worker。
4. 发“现在都什么进度”，Router 回答，不派发新任务。
5. 第二个任务请求审批：一键切到任务视图，“需要我”显示 1，批准后继续。
6. 第一个任务完成后，继续对它追问，Worker 带上下文继续，而不是从头开始。
7. 故意让一句话归错，用“改归属”纠正，时间线和 Decision 都更新。
8. 重启主控，两个任务的状态正确恢复。

**R2**：同仓三任务并行不冲突；任务按项目/类型自动分组；主会话压缩后能召回旧任务。

**R3**：Watchdog 发现卡死任务；外部事件进入并遵守信任边界；一条主动规则在影子模式下运行。

### 8.3 交接规则（实现 agent 必读）

- 代码风格沿用现有 CommonJS / ESM 混合、`node:sqlite`、`node --test`，注释用中文。默认不加新依赖，确需时先说明理由。
- 工具只通过宿主 `ctx.tools` 注册，不得在 profile 内安装第二份 DSH core（`docs/design.md` 第 5 节）。
- 新行为全部挂在 `alpha-router` preset 下，旧 `alpha` preset 的测试不得改动语义。
- `dispatch_task` 的幂等、审批 fail-closed、allowed roots 校验一律不得削弱。
- 每个工作包独立分支、独立 PR，带测试。改第 7 节契约要先改本文。
- 不要提前做 R3 的抽象：R1 的 Trigger 只需支持用户消息和 Worker 报告。

## 9. 测试与评估

**归属评测**（WP3 必须交付）：`test/fixtures/attribution/*.jsonl` 按真实使用风格标注 100 段以上多任务对话，覆盖省略句、同项目多任务、话题切换、闲聊、叫停。`scripts/eval-attribution.mjs` 回放并输出混淆矩阵。线上 Decision 的用户更正持续补充此集合。

初始目标（待实测调整）：

| 指标 | 目标 |
|---|---|
| 错误归属率（attach 错） | ≤ 2% |
| 归属总准确率 | ≥ 90% |
| T1 覆盖率（不必走 LLM 的 work 消息占比） | ≥ 70% |
| 确认延迟 p95（快路径） | ≤ 4 秒 |
| Jev 不可用时对话可用性 | 100%，全部降级到 T2 |

**系统回放**：参照论文 7.1 做一个缩小版，用 mock runtime 回放约 100 条混合消息，对比旧模式与新模式的完成时间，并记录 Router LLM 调用次数和 token。目的是验证快路径确实省下了模型调用。

## 10. 风险与未验证项

**已验证**：论文全文；原型文档、提示词、`sessions.ts`、`delivery.ts`；本仓库第 3 节所列代码；npm 版本信息。

**未验证（WP0 / WP3 必须先证实，未证实前不要依赖）**

| 项 | 为什么重要 | 若不成立 |
|---|---|---|
| `agent.inbox` 和自定义消息来源在目标版本可用 | 全双工报告回流的基础；目前只从原型代码读到，未实际运行 | 退化为前端轮询展示结果，报告不进主会话 |
| `agent/pre-step`、`llm/stream` 接缝在 0.2.x 仍兼容 | 现有快路径依赖它们 | 需要改用宿主异步工具 |
| Step 中途到达的消息能否被快路径拦截并标记已处理 | 否则 Router 会重复处理 | Router 提示词约定忽略已标记消息 |
| 可用的 UI 插槽（会话头部、消息级标签） | 决定切换按钮和归属标签的位置 | 按 6.6 的 portal 方案和确认行兜底 |
| 主控线上实际运行的 DSH 版本 | 仓库未锁定部署版本，升级影响面未知 | 需要在 WP0 查明后再定升级路径 |
| Jev 能否在 `state` 中使用对话上下文、候选较多时的准确率 | 决定 T1 覆盖率；仓库里只有 `state.request` 这一种用法，且 README 注明阈值是临时值 | 收窄 T1，更多走 T2，成本上升 |
| 各 runtime 的 resume 在目标机真实可用 | 代码有参数，但从未被主控调用过 | 对应 provider 走“摘要重建上下文” |

**主要风险**

- **错误归属污染 Worker**：严格阈值、改归属、Decision 回放三重控制。
- **主会话膨胀**：依赖宿主压缩和链式召回，快路径的确认行要短。
- **DSH 仍在快速变化**：`0.2.x` 尚是 rc/alpha，所有宿主接触点收敛到 `direct-dispatch.mjs` 和新的投递模块，便于跟随升级。
- **单用户假设**：一个主控一个主会话，多用户需要重新设计。

## 11. 待你决策

| # | 决策 | 建议 |
|---|---|---|
| 1 | 是否升级 DSH 到 0.2.x 作为前置 | **同意升级**。否则全双工只能靠前端轮询，体验打折 |
| 2 | 主会话粒度 | **每个主控一个**，最符合“感觉只有一个 Agent”。按项目切分会重新引入“选会话” |
| 3 | 高置信归属是否直接送达运行中的 Worker | **直接送达并允许改归属**。若想更稳，可加 5 到 8 秒撤销窗口，代价是响应变慢 |
| 4 | R3 首批接入哪个 IM | 需你指定。飞书有原型可参考，成本最低 |
| 5 | 对话内容继续发送给 Jev 是否可接受 | 现状已在发送单条消息，新方案会增加最近 3 条上下文和任务摘要，请确认 |
