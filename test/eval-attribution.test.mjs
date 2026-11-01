import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, loadDialogs, meetsTargets } from "../scripts/eval-attribution.mjs";

const choice = (value) => ({ type: "choice", choice: value, confidence: 0.95, probabilities: { [value]: 0.95 } });

test("标注集格式有效：attach 只指向已出现的任务", () => {
  const dialogs = loadDialogs();
  assert.ok(dialogs.length >= 20);
  for (const dialog of dialogs) {
    let opened = 0;
    for (const message of dialog.messages) {
      const [gold, index] = message.expect.split(":");
      assert.ok(["attach", "new", "router"].includes(gold), dialog.id);
      if (gold === "attach") assert.ok(Number(index) < opened, `${dialog.id}: ${message.text}`);
      if (gold === "new") opened += 1;
    }
  }
});

test("不调模型时显式引用由 T0 判定，其余全部交给 Router，错误归属为零", async () => {
  const result = await evaluate({ dialogs: loadDialogs() });
  assert.equal(result.misattachRate, 0);
  assert.equal(result.errors.length, 0);
  assert.ok(result.coverage > 0 && result.coverage < 0.2);
  assert.equal(meetsTargets(result), false, "没有 Jev 时覆盖率达不到目标");
});

test("错误归属被计入，交给 Router 的句子只影响覆盖率", async () => {
  const dialogs = [{ id: "d", messages: [
    { text: "任务一", expect: "new" },
    { text: "任务二", expect: "new" },
    { text: "归错的话", expect: "attach:0" },
    { text: "拿不准的话", expect: "attach:0" }
  ] }];
  const jev = {
    ask: async ({ state, questions }) => {
      const { criteria } = questions.ticket;
      const wrong = Object.keys(criteria).find((key) => criteria[key]?.title === "任务二");
      const ticket = state.request === "归错的话" ? choice(wrong) : state.request === "拿不准的话" ? choice("unsure") : choice("new");
      return { intent: choice("work"), ticket, selfContained: { type: "noul", noul: 1 } };
    }
  };
  const result = await evaluate({ dialogs, jev, router: { prepare: () => ({ immediate: { agentId: "a" } }) } });
  assert.equal(result.matrix.attach.attach, 1);
  assert.equal(result.misattachRate, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.coverage, 3 / 4);
});
