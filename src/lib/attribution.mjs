// 三级归属（docs/superagent-design.md 第 6.2 节）：
//   T0 确定性规则，不调模型
//   T1 Decision model（Jev），一次请求同时问完归属和目标
//   T2 Router LLM：其它一切，包括 Jev 不可用时的全部消息
//
// attribute 绝不抛错阻断对话：失败、超时都返回 action:"router"。
// 模型判断只决定路由和展示，不产生任何授权。

import { randomUUID } from "node:crypto";
import { acceptedChoice } from "./jev-client.mjs";
import ticketEngine from "./ticket-engine.js";

const { stageOf } = ticketEngine;

// 初始阈值，须用 scripts/eval-attribution.mjs 校准。attach 更严：错误新建只多一个
// 可合并的任务，错误归属会污染运行中的 Worker。
export const THRESHOLDS = Object.freeze({
  attach: { confidence: 0.75, probability: 0.8, margin: 0.25 },
  create: { confidence: 0.6, probability: 0.7 }
});

const MAX_CANDIDATES = 30;
const RECENT_ENDED_MS = 14 * 24 * 3600 * 1000;
const CONSTRAINT_KEYS = ["agentId", "machineId", "workspaceId", "model", "reasoningEffort", "mode"];

const INTENT_OPTIONS = {
  work: "提出新工作，或继续、补充已有工作",
  stop: "要求叫停、取消某项工作",
  status: "询问进度或状态，不要求做新事情",
  chat: "闲聊、致谢，或与工作无关",
  unsure: "无法判断"
};

// `#12`、`#ticket/12` 指任务；`issue #12`、`PR #12`、`foo#12` 指别的东西。
const TICKET_REF = /(?<![\w/#])#(?:ticket\/)?(\d{1,6})\b/g;
const FOREIGN_REF_PREFIX = /(?:issue|issues|pr|prs|pull|mr|bug|commit|github|gitlab|工单)\s*$/i;

export function ticketRefs(text) {
  const source = String(text || "");
  const refs = new Set();
  for (const match of source.matchAll(TICKET_REF)) {
    if (FOREIGN_REF_PREFIX.test(source.slice(0, match.index))) continue;
    refs.add(Number(match[1]));
  }
  return [...refs];
}

function pickConstraints(ui) {
  const constraints = {};
  for (const key of CONSTRAINT_KEYS) {
    if (ui?.constraints?.[key]) constraints[key] = ui.constraints[key];
  }
  if (!Object.keys(constraints).length) return null;
  // 输入框选定的是用户钉死的目标；source 供 Ticket 绑定分级使用。
  return { ...constraints, source: "user" };
}

export function firstLine(text) {
  const line = String(text || "").split("\n").map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, 50) : "未命名任务";
}

// 候选预筛：优先 open，其次 14 天内结束的；叫停和已合并的不能再接收输入。
export function selectCandidates({ tickets, contextOf, text = "", workspaceName = () => null, now = Date.now(), limit = MAX_CANDIDATES }) {
  const lowered = String(text).toLowerCase();
  const eligible = tickets.filter((ticket) => {
    if (ticket.status === "open") return true;
    if (ticket.outcome === "stopped" || ticket.outcome === "merged") return false;
    return now - (ticket.endedAt || ticket.updatedAt) <= RECENT_ENDED_MS;
  });
  const rankOf = (ticket) => {
    const project = workspaceName(ticket.workspaceId);
    return [
      ticket.status === "open" ? 1 : 0,
      project && lowered.includes(project.toLowerCase()) ? 1 : 0,
      ticket.lastActivityAt
    ];
  };
  return eligible
    .map((ticket) => ({ ticket, rank: rankOf(ticket) }))
    .sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2])
    .slice(0, limit)
    .map(({ ticket }) => ({
      ticket,
      option: {
        title: ticket.title,
        summary: ticket.summary || "",
        stage: stageOf(contextOf(ticket)),
        project: workspaceName(ticket.workspaceId) || "",
        lastUserMessage: ""
      }
    }));
}

function ticketQuestion(candidates) {
  const criteria = {};
  const values = {};
  candidates.forEach(({ ticket, option }, index) => {
    criteria[`t${index}`] = option;
    values[`t${index}`] = ticket;
  });
  criteria.new = "这是一件新工作，不属于任何候选任务";
  criteria.multiple = "同时涉及多个任务";
  criteria.unsure = "无法确定属于哪个任务";
  return { criteria, values };
}

function marginOf(answer) {
  const probabilities = Object.values(answer?.probabilities || {}).filter(Number.isFinite).sort((a, b) => b - a);
  return probabilities.length ? probabilities[0] - (probabilities[1] || 0) : 0;
}

export function createAttribution({ store, tickets, jev = null, router = null, workspaceName = () => null, now = Date.now }) {
  function candidatesFor(text) {
    return selectCandidates({
      tickets: store.listTickets(),
      contextOf: tickets.contextOf,
      text,
      workspaceName,
      now: now()
    }).map((candidate) => {
      candidate.option.lastUserMessage = store.lastUserTextOfTicket(candidate.ticket.id).slice(0, 50);
      return candidate;
    });
  }

  function recentState(trigger) {
    return store.recentUserTriggers(4)
      .filter((row) => row.id !== trigger.id)
      .slice(0, 3)
      .reverse()
      .map((row) => {
        const link = store.listLinksOfTrigger(row.id)[0];
        return { text: row.text.slice(0, 200), ticket: link ? store.getTicket(link.ticketId)?.title || null : null };
      });
  }

  function hardAttach(trigger, ui) {
    if (ui?.ticketId && store.getTicket(ui.ticketId)) {
      return { tier: 0, intent: "work", action: "attach", ticketId: ui.ticketId, reason: "ui_ticket" };
    }
    if (ui?.replyTo) {
      const link = store.listLinksOfTrigger(ui.replyTo)[0];
      if (link) return { tier: 0, intent: "work", action: "attach", ticketId: link.ticketId, reason: "reply" };
    }
    const refs = ticketRefs(trigger.text).map((seq) => store.getTicketBySeq(seq)).filter(Boolean);
    if (refs.length === 1) return { tier: 0, intent: "work", action: "attach", ticketId: refs[0].id, reason: "explicit_ref" };
    return null;
  }

  async function modelDecision(trigger, ui, signal) {
    if (!jev || trigger.trust === "external") return { tier: 2, action: "router", reason: jev ? "external" : "jev_unavailable" };
    const candidates = candidatesFor(trigger.text);
    const { criteria, values } = ticketQuestion(candidates);
    const plan = router?.prepare({ prompt: trigger.text, selected: ui?.selected || {} }) || null;
    const answers = await jev.ask({
      state: { request: trigger.text, recent: recentState(trigger) },
      questions: {
        intent: {
          type: "choice",
          instructions: "判断用户这句话的意图。不要改写请求。",
          criteria: INTENT_OPTIONS
        },
        ticket: {
          type: "choice",
          instructions: "用户这句话属于哪个已有任务？结合 state.recent 里最近的对话判断省略句。只有明确属于某个任务时才选它；是新工作选 new；涉及多个选 multiple；拿不准选 unsure。",
          criteria
        },
        selfContained: {
          type: "noul",
          instructions: "这句话脱离前文，执行任务的 Agent 能否看懂要做什么？"
        },
        ...(plan?.questions || {})
      },
      signal
    });
    const candidateIds = candidates.map(({ ticket }) => ticket.id);
    if (!answers) return { tier: 2, action: "router", reason: "jev_unavailable", candidates: candidateIds };

    const intent = acceptedChoice(answers.intent, INTENT_OPTIONS) ? answers.intent.choice : "unsure";
    const answer = answers.ticket;
    const choice = answer?.choice;
    const base = {
      tier: 1,
      intent,
      confidence: answer?.confidence,
      probability: answer?.probabilities?.[choice],
      margin: marginOf(answer),
      candidates: candidateIds
    };
    const toRouter = (reason) => ({ ...base, tier: 2, action: "router", reason });
    if (intent !== "work") return toRouter(`intent_${intent}`);
    if (values[choice]) {
      const passes = acceptedChoice(answer, criteria, {
        minConfidence: THRESHOLDS.attach.confidence,
        minProbability: THRESHOLDS.attach.probability
      }) && base.margin >= THRESHOLDS.attach.margin;
      return passes
        ? { ...base, action: "attach", ticketId: values[choice].id, reason: "jev_attach" }
        : toRouter("attach_below_threshold");
    }
    if (choice === "new") {
      const passes = acceptedChoice(answer, criteria, {
        minConfidence: THRESHOLDS.create.confidence,
        minProbability: THRESHOLDS.create.probability
      });
      if (!passes) return toRouter("new_below_threshold");
      const selfContained = answers.selfContained?.type === "noul" && answers.selfContained.noul > 0.5;
      if (!selfContained) return toRouter("new_needs_context");
      const route = plan?.immediate || (plan?.decode ? plan.decode(answers) : null);
      if (!route) return toRouter("new_no_route");
      return { ...base, action: "new", route, title: firstLine(trigger.text), reason: "jev_new" };
    }
    return toRouter(choice === "multiple" ? "multiple" : "unsure");
  }

  async function decide(trigger, ui, signal) {
    const attached = hardAttach(trigger, ui);
    if (attached) return attached;
    const constraints = pickConstraints(ui);
    if (constraints) {
      return { tier: 0, intent: "work", action: "new", constraints, title: firstLine(trigger.text), reason: "ui_constraints" };
    }
    return modelDecision(trigger, ui, signal);
  }

  async function attribute({ trigger, ui = {}, signal }) {
    let decision;
    try {
      decision = await decide(trigger, ui, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.info(`[alpha-attribution] fallback: ${error?.message || "failed"}`);
      decision = { tier: 2, action: "router", reason: "attribution_failed" };
    }
    const id = `dec_${randomUUID()}`;
    store.insertDecision({
      id,
      triggerId: trigger.id,
      tier: decision.tier,
      action: decision.action,
      ticketId: decision.ticketId ?? null,
      confidence: decision.confidence ?? null,
      probability: decision.probability ?? null,
      margin: decision.margin ?? null,
      candidates: decision.candidates ?? null,
      reason: decision.reason ?? null,
      createdAt: now()
    });
    return { ...decision, id };
  }

  return { attribute, candidatesFor };
}
