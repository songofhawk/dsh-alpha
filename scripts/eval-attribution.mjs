#!/usr/bin/env node
// 归属评测（docs/superagent-design.md 第 9 节）：回放 test/fixtures/attribution/*.jsonl，
// 输出混淆矩阵和指标。每段对话按标注的正确结果推进状态，一句判错不影响后面的句子。
//
//   node scripts/eval-attribution.mjs                 不调模型，看 T0 覆盖了多少
//   node --env-file=.env scripts/eval-attribution.mjs --jev   用真实 Jev（会把标注集发给 Jev）
//   --strict  指标未达标时以非零退出，可接入 CI

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createAttribution } from "../src/lib/attribution.mjs";
import { createJevClient } from "../src/lib/jev-client.mjs";
import ticketStoreModule from "../src/lib/ticket-store.js";
import ticketEngineModule from "../src/lib/ticket-engine.js";

const { createTicketStore } = ticketStoreModule;
const { createTicketEngine } = ticketEngineModule;

const FIXTURE_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "test", "fixtures", "attribution");

export const TARGETS = Object.freeze({ misattachRate: 0.02, accuracy: 0.9, coverage: 0.7 });

export function loadDialogs(dir = FIXTURE_DIR) {
  const dialogs = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (line.trim()) dialogs.push(JSON.parse(line));
    }
  }
  return dialogs;
}

function emptyMatrix() {
  const labels = ["attach", "new", "router"];
  return Object.fromEntries(labels.map((gold) => [gold, Object.fromEntries(labels.map((actual) => [actual, 0]))]));
}

export async function evaluate({ dialogs, jev = null, router = null }) {
  const matrix = emptyMatrix();
  const errors = [];
  let attachDecided = 0;
  let attachWrong = 0;
  let judged = 0;
  let correct = 0;
  let workTotal = 0;
  let workDecided = 0;

  for (const dialog of dialogs) {
    const store = createTicketStore({ database: new DatabaseSync(":memory:") });
    const tickets = createTicketEngine({ store });
    const attribution = createAttribution({ store, tickets, jev, router });
    const opened = [];
    let n = 0;
    for (const message of dialog.messages) {
      const { trigger } = store.insertTrigger({
        id: `trg_${dialog.id}_${++n}`, source: "eval", sourceEventId: `${dialog.id}:${n}`,
        kind: "user_message", trust: "user", text: message.text, payload: {}, createdAt: n
      });
      const [gold, goldIndex] = message.expect.split(":");
      const decision = await attribution.attribute({ trigger });
      matrix[gold][decision.action] += 1;

      const attachRight = gold === "attach" && decision.ticketId === opened[Number(goldIndex)]?.id;
      const right = decision.action === gold && (gold !== "attach" || attachRight);
      if (decision.action === "attach") {
        attachDecided += 1;
        if (!attachRight) attachWrong += 1;
      }
      // 交给 Router 不算判错：只是这句话要多花一次 LLM，由覆盖率体现。
      if (decision.action !== "router" || gold === "router") {
        judged += 1;
        if (right) correct += 1;
        else errors.push({ dialog: dialog.id, text: message.text, expect: message.expect, actual: decision.action, reason: decision.reason });
      }
      if (gold !== "router") {
        workTotal += 1;
        if (decision.action !== "router") workDecided += 1;
      }

      if (gold === "new") {
        const ticket = tickets.openTicket({ trigger: trigger.id, title: message.text.slice(0, 50), via: "t0" });
        opened.push(ticket);
        if (message.ended) tickets.closeTicket(ticket.id, { outcome: "done" });
      } else if (gold === "attach") {
        store.linkTrigger(opened[Number(goldIndex)].id, trigger.id, "t0");
      }
    }
  }

  const ratio = (top, bottom) => (bottom ? top / bottom : 0);
  return {
    dialogs: dialogs.length,
    messages: dialogs.reduce((sum, dialog) => sum + dialog.messages.length, 0),
    matrix,
    misattachRate: ratio(attachWrong, attachDecided),
    accuracy: ratio(correct, judged),
    coverage: ratio(workDecided, workTotal),
    errors
  };
}

export function meetsTargets(result) {
  return result.misattachRate <= TARGETS.misattachRate && result.accuracy >= TARGETS.accuracy && result.coverage >= TARGETS.coverage;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(argv) {
  const useJev = argv.includes("--jev");
  const jev = useJev ? createJevClient() : null;
  if (useJev && !jev) throw new Error("--jev 需要 TYPESAFE_API_KEY");
  const dialogs = loadDialogs();
  const result = await evaluate({ dialogs, jev });
  console.log(`模式：${useJev ? "真实 Jev" : "仅 T0（不调模型）"}；${result.dialogs} 段对话，${result.messages} 句`);
  console.log("混淆矩阵（行=标注，列=判定）：");
  for (const [gold, row] of Object.entries(result.matrix)) {
    console.log(`  ${gold.padEnd(7)} ${Object.entries(row).map(([key, value]) => `${key}=${value}`).join("  ")}`);
  }
  console.log(`错误归属率 ${percent(result.misattachRate)}（目标 ≤ ${percent(TARGETS.misattachRate)}）`);
  console.log(`归属准确率 ${percent(result.accuracy)}（目标 ≥ ${percent(TARGETS.accuracy)}）`);
  console.log(`T0/T1 覆盖率 ${percent(result.coverage)}（目标 ≥ ${percent(TARGETS.coverage)}）`);
  for (const error of result.errors) console.log(`  ✗ [${error.dialog}] ${error.text} → ${error.actual}（应为 ${error.expect}，${error.reason || ""}）`);
  if (argv.includes("--strict") && !meetsTargets(result)) process.exitCode = 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
