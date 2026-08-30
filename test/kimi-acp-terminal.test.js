const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KimiAcpClient } = require("../src/adapters/vendor/runtimes/kimi-acp-client");

function terminalMessage(method, id, params) {
  return { jsonrpc: "2.0", method, id, params };
}

function withTimeout(promise, timeoutMs = 2000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待 ACP terminal 超时：${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

test("Kimi ACP initialize 明确广告 terminal capability", async () => {
  const client = new KimiAcpClient({ kimiPathOverride: process.execPath });
  let request;
  client.start = () => {};
  client.request = async (method, params) => {
    request = { method, params };
    return {};
  };

  await client.initialize();
  assert.equal(request.method, "initialize");
  assert.deepEqual(request.params.clientCapabilities, { terminal: true });
});

test("Kimi ACP terminal 完成 create/output/wait/release 全生命周期", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kimi-terminal-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const client = new KimiAcpClient({ terminalCwd: cwd });

  const created = await client.handleTerminalRequest(terminalMessage("terminal/create", "1", {
    sessionId: "session-1",
    command: process.execPath,
    args: ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"],
    cwd,
    env: [{ name: "ACP_TEST_ENV", value: "enabled" }],
    outputByteLimit: 1024
  }));
  assert.match(created.terminalId, /^kimi-terminal-/);

  const exitStatus = await client.handleTerminalRequest(terminalMessage("terminal/wait_for_exit", "2", {
    sessionId: "session-1",
    terminalId: created.terminalId
  }));
  assert.deepEqual(exitStatus, { exitCode: 0, signal: null });

  const output = await client.handleTerminalRequest(terminalMessage("terminal/output", "3", {
    sessionId: "session-1",
    terminalId: created.terminalId
  }));
  assert.match(output.output, /stdout/);
  assert.match(output.output, /stderr/);
  assert.equal(output.truncated, false);
  assert.deepEqual(output.exitStatus, exitStatus);

  assert.deepEqual(await client.handleTerminalRequest(terminalMessage("terminal/release", "4", {
    sessionId: "session-1",
    terminalId: created.terminalId
  })), {});
  await assert.rejects(
    client.handleTerminalRequest(terminalMessage("terminal/output", "5", {
      sessionId: "session-1",
      terminalId: created.terminalId
    })),
    /terminal 不存在/
  );
});

test("Kimi ACP terminal 按 UTF-8 边界截断最旧输出", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kimi-terminal-output-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const client = new KimiAcpClient({ terminalCwd: cwd });
  const created = await client.handleTerminalRequest(terminalMessage("terminal/create", "1", {
    sessionId: "session-output",
    command: process.execPath,
    args: ["-e", "process.stdout.write('前缀🙂tail')"],
    cwd,
    outputByteLimit: 8
  }));
  await client.handleTerminalRequest(terminalMessage("terminal/wait_for_exit", "2", {
    sessionId: "session-output",
    terminalId: created.terminalId
  }));
  const output = await client.handleTerminalRequest(terminalMessage("terminal/output", "3", {
    sessionId: "session-output",
    terminalId: created.terminalId
  }));

  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.output) <= 8);
  assert.doesNotMatch(output.output, /�/);
  assert.match(output.output, /tail$/);
  client.close();
});

test("Kimi ACP terminal 拒绝越过任务工作目录及跨会话访问", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kimi-terminal-boundary-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const client = new KimiAcpClient({ terminalCwd: cwd });

  await assert.rejects(
    client.handleTerminalRequest(terminalMessage("terminal/create", "1", {
      sessionId: "session-boundary",
      command: process.execPath,
      args: ["-v"],
      cwd: path.dirname(cwd)
    })),
    /越过工作区边界/
  );

  const created = await client.handleTerminalRequest(terminalMessage("terminal/create", "2", {
    sessionId: "session-owner",
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    cwd
  }));
  await assert.rejects(
    client.handleTerminalRequest(terminalMessage("terminal/output", "3", {
      sessionId: "session-other",
      terminalId: created.terminalId
    })),
    /不属于当前会话/
  );
  client.close();
});

test("Kimi ACP terminal 支持 kill 后等待退出并释放", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kimi-terminal-kill-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const client = new KimiAcpClient({ terminalCwd: cwd });
  t.after(() => client.close());
  const created = await client.handleTerminalRequest(terminalMessage("terminal/create", "1", {
    sessionId: "session-kill",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd
  }));

  assert.deepEqual(await client.handleTerminalRequest(terminalMessage("terminal/kill", "2", {
    sessionId: "session-kill",
    terminalId: created.terminalId
  })), {});
  const exitStatus = await withTimeout(client.handleTerminalRequest(terminalMessage("terminal/wait_for_exit", "3", {
    sessionId: "session-kill",
    terminalId: created.terminalId
  })));
  assert.equal(exitStatus.exitCode, null);
  assert.equal(typeof exitStatus.signal, "string");
  assert.deepEqual(await client.handleTerminalRequest(terminalMessage("terminal/release", "4", {
    sessionId: "session-kill",
    terminalId: created.terminalId
  })), {});
});

test("Kimi ACP 反向 JSON-RPC 请求由 client 内部响应，不泄漏给权限处理器", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-kimi-terminal-routing-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const client = new KimiAcpClient({ terminalCwd: cwd });
  t.after(() => client.close());
  let leaked = false;
  client.on("request", () => { leaked = true; });

  const response = withTimeout(new Promise((resolve, reject) => {
    client.respond = (id, result) => resolve({ id, result });
    client.respondError = (_id, error) => reject(error);
  }));
  client.handleLine(JSON.stringify(terminalMessage("terminal/create", "request-1", {
    sessionId: "session-routing",
    command: process.execPath,
    args: ["-e", "process.stdout.write('routed')"],
    cwd
  })));
  const created = await response;
  assert.equal(created.id, "request-1");
  assert.match(created.result.terminalId, /^kimi-terminal-/);
  assert.equal(leaked, false);
});
