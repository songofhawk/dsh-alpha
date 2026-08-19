# vendored from agent-anywhere

阶段 0 复用的 agent runtime 与共享数据模块，来自相邻仓库 `agent-anywhere`
（`/Users/helix/gitrepo/agent-anywhere`），按设计文档「数据模型复用 agent-anywhere 已验证结构」直接搬运。

## 出处与版本

- 来源仓库：`agent-anywhere`（本机 `../agent-anywhere`，Control Server / Agent Gateway 项目）
- 对应文件：`src/runtimes/*` 与 `src/shared/*`
- 本目录 `runtimes/` ↔ 上游 `src/runtimes/`，`shared/` ↔ 上游 `src/shared/`，**保持原样**（含相对 require），便于日后 `diff` 同步

## 文件清单

### runtimes/（agent 执行适配层）

| 文件 | 对应 agent | 说明 |
|---|---|---|
| `codex-app-server-runtime.js` + `codex-app-server-client.js` | codex | spawn `codex app-server`，JSON-RPC stdio |
| `codex-runtime.js` | codex-sdk | SDK 封装（`@openai/codex-sdk` 惰性 import，未启用时不加载）；同时导出 `resolveCodexExecutable` 供 app-server client 使用 |
| `claude-code-headless-runtime.js` | claude-code | spawn `claude -p --output-format stream-json` headless |
| `claude-approval-mcp-server.js` | claude-code | 审批桥 MCP server（unix socket 转发到 runtime 的 `requestApproval`） |
| `agent-dispatch-mcp-server.js` | claude-code | 派发工具 MCP server（阶段 1 起在 `AGENT_ANYWHERE_CONTROL_URL` 存在时注入） |
| `kimi-code-runtime.js` + `kimi-acp-client.js` | kimi-code | `kimi acp` JSON-RPC (ACP) |
| `mock-runtime.js` | mock | 测试/缺省 runtime |

### shared/（数据模型与校验）

| 文件 | 说明 |
|---|---|
| `capabilities.js` | `buildCapabilities` / `normalizeAgentSettings` / `codexPolicyForMode` |
| `path-policy.js` | `AGENT_ANYWHERE_ALLOWED_ROOTS` 双层 realpath 校验 |
| `providers.js` | provider 别名归一（`claude` → `claude-code`） |
| `repo-identity.js` | canonical repo URL（阶段 3 用） |
| `scheduling.js` | 心跳 load/repos 压缩 + `selectMachine` 排序（阶段 1/3 用） |

## 未搬运

- `claude-code-remote-control-runtime.js`：依赖 `node-pty`，暂不用
- `remote-runtime.js` / `gateway-agent-adapter.js`：legacy HTTP worker / 跨机 adapter，阶段 1 起按需搬
- `websocket.js` / `gateway-protocol.js` / `image-attachments.js` / `project-files.js` / `runtime-environment.js`：阶段 1 起按需

## 同步办法

阶段 0 不做自动化同步；上游改动影响本仓库时手动 `diff` 后复制（`runtimes/*` 与 `shared/*` 分别对应上游 `src/runtimes/*`、`src/shared/*`）。