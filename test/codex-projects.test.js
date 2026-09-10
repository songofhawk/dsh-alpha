const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CodexAppServerRuntime,
  ensureCodexProject
} = require("../src/adapters/vendor/runtimes/codex-app-server-runtime");

const project = (id, directory) => ({ id, roots: [{ path: directory }] });

test("按目标机目录跨分页匹配，支持多根项目，不按项目名或父目录误匹配", async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      assert.equal(method, "project/list");
      if (!params.cursor) return {
        data: [project("parent", "/worker"), { ...project("same-name", "/elsewhere/caict"), name: "caict" }],
        nextCursor: "page-2"
      };
      return { data: [{ id: "target-project", roots: [{ path: "/other" }, { path: "/worker/caict/" }] }] };
    }
  };
  assert.equal(await ensureCodexProject(client, "/worker/caict"), "target-project");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.cursor, "page-2");
});

test("路径别名复用已有项目", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "caict");
  const alias = path.join(root, "alias");
  fs.mkdirSync(directory);
  fs.symlinkSync(directory, alias, "dir");
  const client = { async request(method) {
    assert.equal(method, "project/list");
    return { data: [project("existing", alias)] };
  } };
  assert.equal(await ensureCodexProject(client, directory), "existing");
});

test("缺失项目以目标目录创建，并发调用使用相同幂等键，不同目录分离", async () => {
  const creates = [];
  const client = { async request(method, params) {
    if (method === "project/list") return { data: [] };
    assert.equal(method, "project/create");
    creates.push(params);
    return { project: project(params.idempotencyKey, params.roots[0].path) };
  } };
  const [a, b, c] = await Promise.all([
    ensureCodexProject(client, "/worker/caict"),
    ensureCodexProject(client, "/worker/caict/"),
    ensureCodexProject(client, "/other/caict")
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(creates[0].name, "caict");
  assert.deepEqual(creates[0].roots, [{ path: "/worker/caict" }]);
});

class RuntimeClient extends EventEmitter {
  constructor({ resumeProjectId, failMethod } = {}) {
    super();
    this.calls = [];
    this.resumeProjectId = resumeProjectId;
    this.failMethod = failMethod;
  }
  async initialize() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === this.failMethod) throw new Error("unsupported or unavailable");
    switch (method) {
      case "project/list": return { data: [project("target-project", "/worker/caict")] };
      case "thread/start": return { thread: { id: "new-thread", projectId: params.projectId } };
      case "thread/resume": return { thread: { id: params.threadId, projectId: this.resumeProjectId } };
      case "thread/metadata/update": return {};
      case "turn/start":
        setImmediate(() => this.emit("notification", { method: "turn/completed", params: { turn: { status: "completed" } } }));
        return { turn: { id: "turn-1" } };
      case "thread/read": return {};
      default: throw new Error(`Unexpected method: ${method}`);
    }
  }
  close() { this.closed = true; }
}

async function run(client, runtimeSessionId) {
  const runtime = new CodexAppServerRuntime({ clientFactory: () => client });
  const events = [];
  for await (const event of runtime.run({
    session: { id: "task", runtime_session_id: runtimeSessionId },
    project: { id: "master-workspace-id", projectId: "master-project-id", path: "/worker/caict" },
    message: "test",
    settings: { mode: "read-only", model: "test-model" }
  })) events.push(event);
  return events;
}

test("新会话传递目标机 projectId，忽略主控侧 ID", async () => {
  const client = new RuntimeClient();
  const events = await run(client);
  const start = client.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.projectId, "target-project");
  assert.equal(start.params.cwd, "/worker/caict");
  assert.equal(events.at(-1).type, "complete");
  assert.equal(client.closed, true);
});

test("续接未归属或其他项目的旧会话，在执行 turn 前修正归属", async () => {
  for (const resumeProjectId of [undefined, null, "old-project"]) {
    const client = new RuntimeClient({ resumeProjectId });
    await run(client, "old-thread");
    assert.deepEqual(client.calls.map((call) => call.method), [
      "project/list", "thread/resume", "thread/metadata/update", "turn/start", "thread/read"
    ]);
    assert.deepEqual(client.calls[2].params, { threadId: "old-thread", projectId: "target-project" });
    assert.equal(Object.hasOwn(client.calls[1].params, "projectId"), false);
  }
});

test("续接已正确归属的会话不重复写入", async () => {
  const client = new RuntimeClient({ resumeProjectId: "target-project" });
  await run(client, "old-thread");
  assert.equal(client.calls.some((call) => call.method === "thread/metadata/update"), false);
});

test("项目接口或归属更新失败时不启动任务，并关闭 client", async () => {
  for (const failMethod of ["project/list", "thread/metadata/update"]) {
    const client = new RuntimeClient({ failMethod });
    await assert.rejects(run(client, "old-thread"), /unsupported or unavailable/);
    assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
    assert.equal(client.closed, true);
  }
});

test("异常列表、重复游标和创建失败不会静默产生无归属会话", async () => {
  for (const result of [{}, { data: [], nextCursor: "same" }]) {
    await assert.rejects(ensureCodexProject({ async request(method) {
      assert.equal(method, "project/list");
      return result;
    } }, "/worker/caict"), /未返回项目列表|重复的分页游标/);
  }
  for (const createResult of [{}, { project: project("wrong", "/wrong/path") }]) {
    await assert.rejects(ensureCodexProject({ async request(method) {
      return method === "project/list" ? { data: [] } : createResult;
    } }, "/worker/caict"), /未返回对应目录的项目 ID/);
  }
  await assert.rejects(ensureCodexProject({ async request(method) {
    if (method === "project/list") return { data: [] };
    throw new Error("create denied");
  } }, "/worker/caict"), /create denied/);
});
