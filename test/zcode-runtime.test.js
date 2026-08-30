const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ZCodeRuntime,
  assertZCodeNodeVersion,
  buildZCodeArgs,
  parseZCodeJson,
  zcodeModeForSettings,
  zcodeResultEvents,
  zcodeStreamRecordEvents,
  zcodeSpawnCommand
} = require("../src/adapters/vendor/runtimes/zcode-runtime.js");

function fakeChild(result, { code = 0, signal = null, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = (killSignal = "SIGTERM") => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", null, killSignal));
    return true;
  };
  queueMicrotask(() => {
    if (result !== undefined) child.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = code;
    child.emit("close", code, signal);
  });
  return child;
}

function controlledChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = (killSignal = "SIGTERM") => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", null, killSignal));
    return true;
  };
  return child;
}

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

test("ZCode 模式映射保持 DSH 权限语义", () => {
  assert.equal(zcodeModeForSettings({ mode: "full-access" }), "yolo");
  assert.equal(zcodeModeForSettings({ mode: "auto-review" }), "edit");
  assert.equal(zcodeModeForSettings({ mode: "default", approval_policy: "never" }), "plan");
  assert.equal(zcodeModeForSettings({ mode: "default", approval_policy: "on-request" }), "build");
});

test("ZCode bundled runtime 提前拒绝过旧 Node", () => {
  assert.doesNotThrow(() => assertZCodeNodeVersion("22.19.0"));
  assert.doesNotThrow(() => assertZCodeNodeVersion("23.0.0"));
  assert.throws(() => assertZCodeNodeVersion("22.18.9"), /Node.js >= 22\.19\.0/);
  assert.throws(() => assertZCodeNodeVersion("20.20.0"), /Node.js >= 22\.19\.0/);
});

test("ZCode 参数包含工作区、恢复会话和全部附件", () => {
  const args = buildZCodeArgs({
    runtimeSessionId: "sess_1",
    projectPath: "/work/repo",
    message: "修复测试",
    attachments: [{ path: "/tmp/a.png" }, {}, { path: "/tmp/b.md" }],
    settings: { mode: "auto-review" }
  });
  assert.deepEqual(args, [
    "--prompt", "修复测试", "--output-format", "stream-json", "--no-color", "--mode", "edit",
    "--cwd", "/work/repo", "--resume", "sess_1",
    "--attach", "/tmp/a.png", "--attach", "/tmp/b.md"
  ]);
});

test("zcode.cjs 通过当前 Node 启动，包装命令保持直接执行", () => {
  assert.deepEqual(zcodeSpawnCommand("/opt/ZCode/resources/glm/zcode.cjs", ["--output-format", "stream-json"]), {
    command: process.execPath,
    args: ["/opt/ZCode/resources/glm/zcode.cjs", "--output-format", "stream-json"]
  });
  assert.deepEqual(zcodeSpawnCommand("zcode", ["--output-format", "stream-json"]), {
    command: "zcode",
    args: ["--output-format", "stream-json"]
  });
});

test("ZCode JSON 兼容前置诊断行和多行对象，并归一会话、用量和回复", () => {
  const result = parseZCodeJson('diagnostic\n{\n  "sessionId":"sess_2",\n  "response":"完成",\n  "usage":{"outputTokens":2}\n}\n');
  const events = zcodeResultEvents(result, { workingDirectory: "/work/repo" });
  assert.deepEqual(events.map((event) => event.type), ["runtime_session", "usage", "delta", "complete"]);
  assert.equal(events[0].payload.runtime_session_id, "sess_2");
  assert.equal(events[2].payload.text, "完成");
});

test("ZCode stream-json 把文本增量和工具进度转为统一事件", () => {
  assert.deepEqual(zcodeStreamRecordEvents({
    type: "model.streaming",
    payload: { kind: "text_delta", delta: "正在检查" }
  }), [{ type: "delta", payload: { text: "正在检查" } }]);

  const toolEvents = zcodeStreamRecordEvents({
    type: "tool.updated",
    payload: { kind: "started", toolCallId: "tool-1", toolName: "Bash", input: { command: "git status" } }
  });
  assert.deepEqual(toolEvents, [{
    type: "tool_use",
    payload: { tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: "tool-1" }
  }]);
});

test("ZCode runtime 在进程退出前转发 headless stream-json 事件", async () => {
  let invocation;
  let child;
  const runtime = new ZCodeRuntime({
    pathOverride: __filename,
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      child = controlledChild();
      return child;
    }
  });
  const iterator = runtime.run({
    session: { id: "task-1" },
    project: { path: "/tmp" },
    message: "执行任务",
    settings: { mode: "full-access" }
  })[Symbol.asyncIterator]();

  const activity = await iterator.next();
  assert.equal(activity.value.type, "activity");
  child.stdout.write(`${JSON.stringify({
    type: "model.streaming",
    sessionId: "sess_live",
    payload: { kind: "text_delta", delta: "处理中" }
  })}\n`);
  const runtimeSession = await iterator.next();
  const streamedDelta = await iterator.next();
  assert.equal(runtimeSession.value.type, "runtime_session");
  assert.deepEqual(streamedDelta.value, { type: "delta", payload: { text: "处理中" } });
  assert.equal(child.exitCode, null, "文本必须在 ZCode 进程退出前转发");

  child.stdout.write(`${JSON.stringify({
    type: "result",
    sessionId: "sess_live",
    response: "处理中任务完成",
    usage: { inputTokens: 8 }
  })}\n`);
  child.stdout.end();
  child.stderr.end();
  child.exitCode = 0;
  child.emit("close", 0, null);
  const tail = [];
  while (true) {
    const item = await iterator.next();
    if (item.done) break;
    tail.push(item.value);
  }

  assert.equal(invocation.options.cwd, "/tmp");
  assert.ok(invocation.args.includes("yolo"));
  assert.deepEqual(tail.map((event) => event.type), ["usage", "complete"]);
  assert.equal(tail.at(-1).payload.message, "处理中任务完成");
});

test("ZCode runtime 对非零退出和畸形 JSON fail loud", async () => {
  const failed = new ZCodeRuntime({
    pathOverride: __filename,
    spawnImpl: () => fakeChild("", { code: 2, stderr: "认证失败" })
  });
  const failedEvents = await collect(failed.run({ session: { id: "t1" }, project: { path: "/tmp" }, message: "x" }));
  assert.equal(failedEvents.at(-1).type, "error");
  assert.match(failedEvents.at(-1).payload.message, /认证失败/);

  const malformed = new ZCodeRuntime({
    pathOverride: __filename,
    spawnImpl: () => fakeChild("not-json")
  });
  const malformedEvents = await collect(malformed.run({ session: { id: "t2" }, project: { path: "/tmp" }, message: "x" }));
  assert.equal(malformedEvents.at(-1).type, "error");
  assert.match(malformedEvents.at(-1).payload.message, /未返回 result/);
});
