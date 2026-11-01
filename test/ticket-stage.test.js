// stageOf 纯函数测试：覆盖 docs/superagent-design.md 第 6.5 节状态表的每一行，
// 以及同时满足多条规则时"从上到下取第一个命中"的优先级。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stageOf } = require("../src/lib/ticket-engine.js");

function baseTicket(patch = {}) {
  return {
    id: "tkt_1",
    seq: 1,
    status: "open",
    outcome: null,
    attention: null,
    pendingApproval: false,
    latestReport: null,
    lastHumanInputAt: null,
    pendingInputs: 0,
    machineOnline: true,
    hasActiveRun: false,
    waitingSlot: false,
    ...patch
  };
}

test("person/approval：有待决审批", () => {
  assert.equal(stageOf(baseTicket({ pendingApproval: true })), "person/approval");
});

test("person/answer：有 attention", () => {
  assert.equal(
    stageOf(baseTicket({ attention: { question: "用哪个方案？" } })),
    "person/answer"
  );
});

test("person/blocked：最新报告 blocked 且之后没有新的人类输入", () => {
  assert.equal(
    stageOf(baseTicket({ latestReport: { kind: "blocked", at: 100 } })),
    "person/blocked"
  );
  // failed 同样算 blocked
  assert.equal(
    stageOf(baseTicket({ latestReport: { kind: "failed", at: 100 } })),
    "person/blocked"
  );
  // 报告之后有新的人类输入则不再是 blocked
  assert.equal(
    stageOf(baseTicket({
      latestReport: { kind: "blocked", at: 100 },
      lastHumanInputAt: 200
    })),
    "idle"
  );
});

test("person/review：最新报告 ready，待验收", () => {
  assert.equal(
    stageOf(baseTicket({ latestReport: { kind: "ready", at: 100 } })),
    "person/review"
  );
});

test("waiting/machine：有待送达输入但目标机离线", () => {
  assert.equal(
    stageOf(baseTicket({ pendingInputs: 1, machineOnline: false })),
    "waiting/machine"
  );
});

test("working/queued：无活动 Run，但有待送达输入或等待槽位", () => {
  assert.equal(stageOf(baseTicket({ pendingInputs: 2 })), "working/queued");
  assert.equal(stageOf(baseTicket({ waitingSlot: true })), "working/queued");
});

test("working/running：有活动 Run", () => {
  assert.equal(stageOf(baseTicket({ hasActiveRun: true })), "working/running");
});

test("idle：其它 open 任务", () => {
  assert.equal(stageOf(baseTicket()), "idle");
  // 人类输入本身不改变 idle
  assert.equal(stageOf(baseTicket({ lastHumanInputAt: 100 })), "idle");
  // done_no_action 类报告不占用任何"需要我/待验收"状态
  assert.equal(
    stageOf(baseTicket({ latestReport: { kind: "done_no_action", at: 100 } })),
    "idle"
  );
});

test("ended/*：四种结局", () => {
  for (const outcome of ["done", "dropped", "stopped", "merged"]) {
    assert.equal(
      stageOf(baseTicket({ status: "ended", outcome })),
      `ended/${outcome}`
    );
  }
});

test("优先级：approval > answer > blocked > review", () => {
  // approval 压过一切
  assert.equal(
    stageOf(baseTicket({
      pendingApproval: true,
      attention: { question: "q" },
      latestReport: { kind: "ready", at: 1 },
      hasActiveRun: true
    })),
    "person/approval"
  );
  // answer 压过 blocked / review / running
  assert.equal(
    stageOf(baseTicket({
      attention: { question: "q" },
      latestReport: { kind: "ready", at: 1 },
      hasActiveRun: true
    })),
    "person/answer"
  );
  // blocked 压过 waiting/machine
  assert.equal(
    stageOf(baseTicket({
      latestReport: { kind: "blocked", at: 1 },
      pendingInputs: 1,
      machineOnline: false
    })),
    "person/blocked"
  );
  // review 压过 waiting/machine 和 working/running
  assert.equal(
    stageOf(baseTicket({
      latestReport: { kind: "ready", at: 1 },
      pendingInputs: 1,
      machineOnline: false,
      hasActiveRun: true
    })),
    "person/review"
  );
});

test("优先级：waiting/machine > working/queued > working/running", () => {
  // 离线时不是 queued 而是 waiting/machine
  assert.equal(
    stageOf(baseTicket({ pendingInputs: 1, machineOnline: false })),
    "waiting/machine"
  );
  // 有活动 Run 时即使有排队输入也是 running（queued 的前提是无活动 Run）
  assert.equal(
    stageOf(baseTicket({ pendingInputs: 1, hasActiveRun: true })),
    "working/running"
  );
});
