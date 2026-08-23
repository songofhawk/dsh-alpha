# 多设备真实 Agent 验收

这份清单用于区分“loopback 自动化测试通过”和“真实多设备目标已经完成”。只有下列证据全部成立，才可以宣布多设备闭环完成。

## 1. 前置条件

- master 与每台 worker 均安装待验收的同一 `dsh-alpha` 版本。
- 每台 worker 设置唯一且稳定的 `DSH_ALPHA_WORKER_MACHINE_ID`，并使用各自独立 token。
- `DSH_ALPHA_WORKER_ALLOWED_ROOTS` 只包含允许 Agent 操作的目录。
- worker 只配置实际已登录、可执行的 provider；默认探测失败的 provider 不应出现在目录。
- doctor 的 provider 探测只证明 CLI 可执行；仍须通过一条真实任务证明账号认证有效。认证错误会触发目录熔断，修复登录后重启 worker 才会重新注册。
- 跨公网使用 `wss://`；局域网 `ws://` 也必须限制端口来源。

## 2. 启动与目录证据

master：

```bash
DSH_ALPHA_GATEWAY_HOST=0.0.0.0 \
DSH_ALPHA_GATEWAY_PORT=4310 \
DSH_ALPHA_GATEWAY_TOKENS="work1:<token1>,work2:<token2>" \
dsh --profile alpha "调用 list_agents，报告在线机器、provider、roots、repo 与负载，不要派发。"
```

每台 worker：

```bash
DSH_ALPHA_HUB_URL="wss://<master>/" \
DSH_ALPHA_WORKER_TOKEN="<本机独立 token>" \
DSH_ALPHA_WORKER_MACHINE_ID="work1" \
DSH_ALPHA_WORKER_PROVIDERS="codex,claude-code,kimi-code" \
DSH_ALPHA_WORKER_ALLOWED_ROOTS="/work" \
./node_modules/.bin/dsh-alpha-worker
```

必须保存的证据：

- `GET /healthz` 返回预期 `connected_workers`。
- `list_agents` 中每台机器只出现实际可用的 provider。
- 任一 worker 停止后，对应目录项变为不可用；重启后恢复。

## 3. 每个真实 provider 的任务矩阵

在至少两台实体设备上，对 Codex、Claude Code、Kimi Code 各执行一条不会修改业务代码的任务，并逐项记录：

| 项目 | 通过条件 |
| --- | --- |
| 普通任务 | 状态 `completed`，结果来自目标 provider，不是 mock |
| 工作目录 | runtime 实际 cwd 位于该 worker 的 allowed roots 内 |
| 事件流 | master 能看到 activity/delta/complete |
| 取消 | 运行中取消后目标进程停止，任务收敛为 `cancelled` |
| 审批批准 | 权限请求在 master 变为 `blocked`，批准后继续 |
| 审批拒绝 | 拒绝后远端操作未执行，任务失败或取消 |
| 断线 | worker 断线后运行中任务收敛为失败，重连后可再次派发 |

## 4. repo 调度与 clone

- 一台 worker 预先持有目标 repo，另一台不持有；带 `repoUrl` 派发必须优先命中持有者。
- 所有 worker 都不持有时，任务应落到最空闲的远端 worker。
- clone 目标必须位于 `<allowed-root>/.dsh-alpha/repos/`。
- clone 完成后的下一次心跳必须广播该 repo；再次派发不得重复 clone。
- 凭证失败、URL 非法、目标目录冲突和越过 allowed roots 都必须 fail closed。

## 5. 完成判定

以下任一情况都不能标记完成：

- 只有单机 loopback 或 mock 结果。
- 只看到 worker 在线，没有真实 provider 任务结果。
- 只通过单测，没有真实 CLI 登录与工作目录证据。
- 任务完成但取消、审批、断线或 clone 未验收。
- master、worker 或 npm 发布物版本不一致。

## 6. 0.1.1 实体验收结果

已在两台实体 Linux worker 上完成本清单的核心闭环：

- 两台 worker 通过独立 token 和 SSH 反向隧道连接同一本机 master，健康检查返回 `connected_workers=2`。
- Codex、Claude Code、Kimi Code 三个具名远端 Agent 均完成真实只读任务，结果标记来自各自事件流。
- 首次 `repoUrl` 任务触发受 roots 约束的真实 clone；后续心跳广播该 repo，第二次任务复用同一目录且未重复 clone。
- master、两台 worker 的最终安装源码哈希一致；远端 systemd worker 与本机隧道服务均处于运行状态。
