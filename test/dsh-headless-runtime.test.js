const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DshHeadlessRuntime, resolveDshExecutable } = require("../src/adapters/vendor/runtimes/dsh-headless-runtime");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { child.emit("close", null, signal); return true; };
  return child;
}

test("优先使用目标机 PATH 中安装的 DSH", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cli-path-"));
  const command = process.platform === "win32" ? "dsh.cmd" : "dsh";
  const executable = path.join(directory, command);
  const previous = process.env.PATH;
  fs.writeFileSync(executable, "");
  try {
    process.env.PATH = `${directory}${path.delimiter}${previous || ""}`;
    assert.equal(resolveDshExecutable(""), executable);
  } finally {
    process.env.PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("DSH headless 在目标目录执行并返回最终答案", async () => {
  const child = fakeChild();
  let invocation;
  const runtime = new DshHeadlessRuntime({
    pathOverride: process.execPath,
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      queueMicrotask(() => {
        child.stdout.write("任务完成\n");
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  const events = [];
  for await (const event of runtime.run({ session: { id: "task-1" }, project: { path: "/tmp/project" }, message: "处理文件" })) {
    events.push(event);
  }
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, ["--profile", "headless", "处理文件"]);
  assert.equal(invocation.options.cwd, "/tmp/project");
  assert.deepEqual(events.at(-1), { type: "complete", payload: { message: "任务完成" } });
});

test("DSH headless 可取消，失败时返回 stderr", async () => {
  const cancelledChild = fakeChild();
  const runtime = new DshHeadlessRuntime({ pathOverride: process.execPath, spawnImpl: () => cancelledChild });
  const stream = runtime.run({ session: { id: "task-2" }, message: "等待" });
  await stream.next();
  const pending = stream.next();
  await runtime.cancelTurn({ session: { id: "task-2" } });
  assert.equal((await pending).value.type, "cancelled");

  const failedChild = fakeChild();
  const failed = new DshHeadlessRuntime({
    pathOverride: process.execPath,
    spawnImpl: () => {
      queueMicrotask(() => {
        failedChild.stderr.write("认证失败");
        failedChild.emit("close", 1, null);
      });
      return failedChild;
    }
  });
  const events = [];
  for await (const event of failed.run({ session: { id: "task-3" }, message: "处理" })) events.push(event);
  assert.deepEqual(events.at(-1), { type: "error", payload: { message: "认证失败" } });
});
