# WP0 宿主接缝验证结论（DSH 0.1.0-rc.8 → 0.2.1-rc.5）

> 状态：2026-11-01 实测。对应 `docs/superagent-design.md` 第 10 节"未验证"表。
> 探针脚本（一次性，未入库）：`tmp-repro/probe-agent-loop.mjs`、`tmp-repro/probe-direct.mjs`、
> `tmp-repro/probe-inbox.mjs`、`tmp-repro/probe-wake.mjs`、`tmp-repro/probe-swallow.mjs`。
> 证据基线：`npm test`（node --test）602/602 通过。

## 0. 升级版本

| 包 | 旧 | 新 |
|---|---|---|
| `@deepseek-ai/dsh` 及 dsh-agent / dsh-headless / dsh-llm / dsh-session / dsh-subagent(-acp/-claude-code/-codex) / dsh-tools | 0.1.0-rc.8 | **^0.2.1-rc.5**（未用 0.2.2-alpha.2） |
| `@deepseek-ai/dsh-agent-presets` | 0.1.0-rc.8 | **移除**，由 `@deepseek-ai/dsh-agent-preset` ^0.2.1-rc.5 取代（声明式 preset，见 §5） |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | 0.1.0-rc.8 | **移除**，0.2.x 无后继包（见 §5） |
| `@deepseek-ai/cordis` | ^4.0.1 | ^4.0.5（dsh 0.2.1-rc.5 要求 ~4.0.5） |
| `dsh.client.inject`（package.json） | dsh-client-connection / **dsh-client-runtime** / dsh-client-ui-conversation / dsh-client-ui-sidebar | dsh-client-connection / **dsh-client-ui-slots** / dsh-client-ui-conversation / dsh-client-ui-sidebar（见 §4） |

## 1. `agent.inbox` 与自定义消息来源 —— 可用（已实测）

0.2.1-rc.5 中 inbox 是一等能力：`dsh-agent-loop` 的 `ReactLoopInbox` 实现 `dsh-agent` 的
`Inbox` 契约，状态经 `agent/inbox/spliced` 会话事件持久化（`dsh-session-projection` 的
`inbox` projection 重建），崩溃后可恢复。

关键 API（`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`）：

```ts
agent.inbox: Inbox                      // nextTurn / nextStep / hasPending
inbox.append(target, message)           // target: 'next-turn' | 'next-step'
inbox.prepend(target, message)
inbox.remove(messageId): boolean        // claim 前移除，实测生效
inbox.replace(messageId, newMessage): boolean
inbox.splice(target, start, deleteCount, inserted)
inbox.clear()
agent.send(message, target, wakeup)     // 通用投递原语
agent.followup(message)                 // = queue：独占一个 turn 并唤醒
agent.steer(message)                    // = steer：下一 step 边界消费；空闲时开新 turn
agent.inject(message)                   // = inject：排队模型上下文，不唤醒
agent.cancel(cause, { keepInbox })
```

事件：`agent/inbox/inserted`、`agent/inbox/claimed`、`agent/inbox/discarded`（live）+
`agent/inbox/spliced`（durable 会话事件，审计留痕）。

自定义消息来源（实测 `probe-inbox.mjs` 场景 1、`probe-wake.mjs`）：

- `MessageSourceMap` 是 **merge-extensible** 的（`dsh-llm/lib/types/message.d.ts`：
  "each producer declares its own `kind` in its own module; there is no shared catch-all
  `plugin` kind"）。`source: { kind: 'dsh-alpha', role: 'worker-report' }` 的消息可以
  正常投递、被 `agent/pre-step` 看到、以原 source 落库为 `user/message`——**不冒充
  `kind: 'user'`**，满足设计 6.3 "不得冒充用户消息"。
- `inbox.append()` **不唤醒**空闲 agent（实测：append 后 status 保持 idle，模型调用 0 次）。
  唤醒路径是 `agent.send(msg, 'next-turn', true)` 或 `agent.followup(msg)`。

**对 6.3 报告回流的影响**：outbox 投递用 `agent.send(reportMessage, 'next-turn', true)`；
三种模式与原型一一对应——`queue`→`followup`/`send(..., true)`，`steer`→`steer()`，
`inject`→`inject()`。报告消息的 source 用自有 kind，快路径的
`message.source?.kind === "user"` 过滤天然不会误抢（现有 `direct-dispatch.mjs` 无需改）。

## 2. `agent/pre-step`、`llm/stream` —— 可用，签名基本不变（已实测）

`test/direct-dispatch.test.mjs` 14 个用例（真实 cordis Context + AgentLoop + LlmRuntime +
ToolRuntime 全链路）在 0.2.1-rc.5 全绿，证明现有 `src/lib/direct-dispatch.mjs` 的两个
接缝语义未变：

- `agent/pre-step`：waterfall，payload `{ agent, messages, turn, step, signal }`，返回
  `PreStepDecision = { kind: 'reject' } | { kind: 'enter', messages, startsRequestSeries? }`。
  0.2.x 的 enter 允许**替换进入该 step 的消息数组**（见 §3 的应用）。
- `llm/stream`：waterfall，`(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`，
  `options.sessionId` 仍在（direct-dispatch 靠它做精确会话绑定，测试证实）。

**0.2.x 新增的前置依赖**（已适配，见 WP0 代码改动）：`AgentLoop` 的 inject 新增
`sessionProjections`（`@deepseek-ai/dsh-session-projection`，驱动 inbox/turn-boundary
projection）；直接 `new AgentLoop(ctx, config)` 时 config 必须经过
`AgentLoop.Config(...)` 验证（`maxParallelToolCalls` 是 `.volatile()` cell，未验证时是
`undefined.get()` 崩溃）。宿主正常加载路径由 cordis 自动验证，不受影响。

## 3. Step 中途消息拦截与"标记已处理" —— 可用（已实测）

- `agent.steer()` 在 turn 中途注入 `next-step`，下一 step 边界被 claim（`probe-inbox.mjs`
  场景 4；direct-dispatch 的"直派等待期间的用户补充"用例同样覆盖）。
- pre-step 返回 `{ kind: 'enter', messages: 过滤后的数组 }` 可以吞掉已处理消息
  （`probe-swallow.mjs` 实测）：被吞消息从 inbox 移除、**不进模型上下文、不落
  `user/message`**，只在 durable `agent/inbox/spliced` 留痕。
- **坑（实测）**：把整个批次吞成 `[]` 会**直接结束当前 turn**；队列里其余消息驻留
  inbox，要等下一次唤醒才处理。快路径按"逐句归属、确认即结束 turn"的设计这正好合适，
  但 Router 不能假设吞掉一条后同批其余消息还会在本 turn 继续。
- 兜底：claim 前可用 `inbox.remove(messageId)` 精确撤回。

**对 6.3 快路径的影响**：T0/T1 已归属的消息在 pre-step 直接换成确认行流程，不会重复
进入 Router LLM；设计文档"否则 Router 提示词约定忽略已标记消息"的降级方案不需要启用。

## 4. UI 插槽 —— 可用（静态核实；激活情况需真机验证）

0.2.x 插槽服务来自 `@deepseek-ai/dsh-client-ui-slots`（纯 core：Slots / Component
Factories）；宿主侧 API：`ctx.slots.inject(name, () => ctx.slots.register({...}))`，
渲染侧 `renderSlot(name, props, { entryKey, fallback })`。旧 `dsh-client-runtime`
（SlotRegistry + SessionRuntime）止步 0.1.1-rc.2，职责拆为
`dsh-client-ui-slots` + `dsh-client-modules`（`window.__ModuleLoader__` 仍在）+
`dsh-cordis-client-runner`。`dsh.client.inject` 清单仍是活跃机制
（`dsh-client-modules` 校验 `dsh.client.{platform,inject,external,immediately}`）。

实测 0.2.1-rc.5 渲染点（`dsh-client-ui-conversation` / `-chat` / `-sidebar` 的
`renderSlot(...)` 调用）：

| 用途 | 插槽 |
|---|---|
| 会话头部（对话/任务切换按钮） | `conversation.session.header`、`.header.actions`、`.header.corner`、`.header.utilities`、`.header.views.actions`、`.header.lineage`、`conversation.header(.leading)` |
| 消息级（归属标签） | `conversation.chat.node`（按消息块 `kind` 路由渲染，未知 kind 回退 JsonBlock——自定义 source/report 块可自渲染）、`conversation.user.text.node`、`conversation.chat.turnTail`、`conversation.chat.assistant-actions`、`conversation.chat.flow` |
| 输入框（"本条约束"选择器、待办条） | `conversation.composer.bar`、`.composer.dock`、`conversation.input.left/.right/.model/.permission/.plan/.overlay/.activity/.attachments/.dock` |
| 现有用法仍有效 | `sidebar.footer.action`、`conversation.hero.workspace`（`[data-slot=...]` DOM 标记仍在） |

**对 6.6 的影响**：切换按钮放 `conversation.session.header.actions`；归属标签优先
`conversation.chat.node`/`conversation.user.text.node`，不行再退回确认行兜底（6.6 已定
的策略不变）。client.inject 清单在真实 Web 会话里的激活与版本匹配**需真机验证**。

## 5. Preset 与 profile 机制变化（0.2.x 破坏性，已适配）

- **`dsh-agent-presets`（0.1.x，文件系统发现 `~/.dsh/.agent-presets/*`）已消失**。0.2.x
  改为声明式：`@deepseek-ai/dsh-agent-preset`（Config `{ id, name?, description?,
  order?, plugins: [...] }`，`Service.init` 时注册进 roster）+
  `@deepseek-ai/dsh-agent-preset-registry`（提供 `agentPresets` 服务，Config
  `{ default }`；`mount(ctx, id?)` 签名不变，`src/runner.mjs` 无需改）。Web 出厂 preset
  即 `dsh-web-app/presets/*.patch.yml` 里的同类声明行。
  **已改 `preset/alpha/profile.patch.yml`**：移除旧 `agent-presets` 行，插入
  `agent-preset-registry`（`default: alpha`）与 `preset-alpha`（内联原
  `agent.cordis.yml` 的 `dsh-alpha/tools` 行）。`scripts/install-preset.mjs` 的
  `~/.dsh/.agent-presets` 复制对 0.2.x 是幂等 no-op，仅为旧宿主保留（注释已更新）；
  `alpha-router` preset 在 WP4 同样走声明式，不要恢复文件发现。
- **`dsh-code-runtime-worker-thread` 无 0.2.x 后继**。`run_code` 在 0.2.x 走
  sandbox/terminal flavor（`dsh-tools` 的 `RUN_CODE_FLAVORS`）；alpha profile 的工具面
  只有 `dsh-alpha/tools`，不消费 codeRuntime，该行已从 profile.patch.yml 移除。
  （alpha profile 组合 = `dsh-base` + `dsh-alpha` 两个 bundle，registry 不在 dsh-base
  里，必须自己插入。）

## 6. 其他已适配的 0.2.x API 变化（WP0 代码改动依据）

| 0.1.x | 0.2.x | 影响处 |
|---|---|---|
| `session.events`（数组） | `session.snapshotEvents()` / `ownEvents()` / `eventAt(seq)`（同步读取整体 @deprecated，"existing logic may remain unmigrated"） | `src/runner.mjs`、`src/plugin.mjs`（`sessionAgentPreset` 兼容两种形态）、`test/direct-dispatch.test.mjs` |
| `sessionPersistence.inspect(id)` → `{meta, events}` | `open(id, 'read')` → `handle.read()` + `handle.header` + `close()`（`SessionInspection` 类型仍在） | `src/plugin.mjs` 的 `inspectPersistedSession`（先试旧 `inspect`，再试新 `open`，防 fail-open 丢失冷会话 preset 判定） |
| `serverResponseSchema` from `dsh-host-apiproxy/api`（0.1.1-rc.2 止步） | 同一名从 `@deepseek-ai/dsh-client-connection` 根导出 | `test/plugin.test.mjs` |
| `dispatch_task` 的 `exec` 缺省时无 session 回落 | 补 `ctx.agent` 回落（`src/tools.mjs`，exec 优先的语义不变） | 修复两个既有失败用例（升级前已红，见下） |

## 7. 设计文档第 10 节其余未验证项

- **主控线上实际运行的 DSH 版本**：需真机查明（目标机 `dsh --version` 或 profile
  inventory）。升级影响面已收敛：`direct-dispatch.mjs`、`plugin.mjs` 的会话读取、
  `runner.mjs` 的 summarize、profile.patch.yml 四处接触点。
- **Jev 在 `state` 中使用对话上下文的准确率**：WP3 范围，WP0 未动。
- **各 runtime adapter 的 resume / steer**（静态结论，真实可用性需真机验证）：

| vendor runtime | resume | steer |
|---|---|---|
| codex（`codex-runtime.js`，`client.resumeThread`） | ✓ | ✗ |
| codex-app-server（`thread/resume`） | ✓ | ✓（`steerTurn`） |
| claude-code（`--resume <id>`） | ✓ | ✗ |
| qoder / workbuddy / zcode（`--resume`） | ✓ | ✗ |
| kimi-code（`sessionId` 续接） | ✓ | ✗ |
| opencode（session resume） | ✓ | ✗ |
| dsh-headless | ✗（按 6.4 走"标题+摘要+上次结果+新输入"重建） | ✗ |
| mock | — | ✓（`steerTurn`） |

  主控从未传入过 `runtime_session_id`，WP2 需按 6.4 在 Binding 回写后实测第二条消息
  确实续上上下文。另注：0.2.x 宿主自己的 `dsh-subagent` 也有
  `delivery: 'queue' | 'steer'` 概念（`control-types.d.ts`），与我们的 gateway
  `STEER_TURN` 打通方向一致。

## 8. 人工跟进项（WP0 无法自动完成）

1. **真机跑通一次派发和审批**（WP0 验收项）：升级后的 alpha profile 起真实会话，
   界面选 Agent → 发消息 → `dispatch_task` → 审批 → 完成回显。
2. **client inject 清单真机验证**：0.2.x Web 里 alpha 面板（`sidebar.footer.action`、
   `conversation.hero.workspace`、输入框 `conversation.input.left`）正常渲染；
   若 slots 服务未激活，补 `@deepseek-ai/dsh-client-ui-slots` 到 profile 依赖。
3. **alpha profile 真机加载**：新 profile.patch.yml（`agent-preset-registry` +
   `preset-alpha` 声明行）在 0.2.x 宿主上展开无解析错误，`dsh --profile alpha "<任务>"`
   headless 路径跑通。
4. **各 runtime resume 在目标机实测**（codex / claude-code 优先，对应 WP2 验收）。

## 9. R1 真机结果（隔离 profile + mock Worker，2026-11-01）

用 `dsh --profile web`（bundles：`dsh-base`、`dsh-web-app`、`dsh-alpha`）起真实 Web，在浏览器里走通了主会话、一行确认、Run、报告回流、追问续接、审批和任务视图（含 375px 宽度）。旧 `alpha` 会话也能创建和打开。第 8 节的第 2 项由此完成，第 1、3、4 项仍需在目标机上用真实 Worker 确认。

真机暴露了三处静态核实没发现的 0.2.x 差异，已修：

| 差异 | 影响 | 修复 |
|---|---|---|
| 客户端没有 `connection.api.sessions` | 创建 Alpha 会话直接报错，旧模式同样受影响 | 改用 `sessions.create`，失败时抛错；旧宿主仍走原路径 |
| 会话摘要的 preset 在 `projectionValues.agentPreset` | 所有 Alpha 控件都不启用 | 新增 `sessionPreset`，并记住本次创建时确认的值 |
| 没有 `sessions.open` | 无法跳转到新会话 | 改用 `uiWorkspace.openSession` |

另外，Web profile 在 0.2.x 不再读取 `~/.dsh/.agent-presets`，所以 `preset-alpha` 必须放进 bundle 的 `cordis.patch.yml`，放在 alpha profile patch 里 Web 拿不到。

`conversation.input.left` 插槽已实测可用，切换按钮放在这里；`conversation.session.header.actions` 未使用。自定义来源的消息在对话里显示为可折叠的“收到执行请求”上下文块，这是宿主的通用样式，报告正文由紧随其后的助手消息呈现。
