const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MIN_CONFIDENCE = 0.6;
const MIN_PROBABILITY = 0.7;

function safeEndpoint(raw) {
  const url = new URL(raw);
  if (url.protocol === "https:") return url.href;
  throw new Error("Jev endpoint 必须使用 HTTPS");
}

function accepted(answer, options, { preference = false } = {}) {
  return answer?.type === "choice" && Object.hasOwn(options, answer.choice)
    && Number.isFinite(answer.confidence) && (preference || answer.confidence >= MIN_CONFIDENCE)
    && Number.isFinite(answer.probabilities?.[answer.choice])
    && answer.probabilities[answer.choice] > 0
    && (preference || answer.probabilities[answer.choice] >= MIN_PROBABILITY);
}

function namedWorkspace(prompt, rows) {
  const text = prompt.toLowerCase();
  const matches = rows.filter(({ name }) => {
    if (!name || name.length < 3) return false;
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`).test(text);
  });
  return matches.length === 1 ? matches[0] : null;
}

function agentOptions(agents, { allowUnsure = true } = {}) {
  const options = {};
  const values = {};
  for (const agent of agents) {
    const key = `a${Object.keys(options).length}`;
    if (Object.keys(options).length >= 254) return null;
    values[key] = agent;
    options[key] = {
      agent: agent.agentId,
      provider: agent.provider,
      agentDescription: agent.description || "",
      machineDescription: agent.machine?.description || "",
      platform: agent.machine?.platform || "",
      activeTurns: Number(agent.machine?.load?.active_turns) || 0,
      machineId: agent.machineId
    };
  }
  if (allowUnsure) options.unsure = "没有适合执行此请求的 Agent，交给主控 LLM";
  return { options, values };
}

function modelQuestions(agents, selected) {
  const questions = {};
  const values = {};
  if (selected.model || agents.length > 12) return { questions, values };
  agents.forEach((agent, index) => {
    const defaultModel = agent.capabilities?.default_model || agent.model || null;
    const alternatives = [...new Set((agent.capabilities?.models || []).filter((model) => model !== defaultModel))];
    if (!alternatives.length || alternatives.length > 253) return;
    const key = `model_${index}`;
    const criteria = { default: `使用 ${agent.agentId} 的默认模型 ${defaultModel || "（未公布）"}；没有明确理由切换时选此项` };
    values[key] = {};
    alternatives.forEach((model, modelIndex) => {
      const option = `m${modelIndex}`;
      criteria[option] = `使用 ${agent.agentId} 的模型 ${model}`;
      values[key][option] = model;
    });
    questions[key] = {
      type: "choice",
      instructions: `假设请求交给 ${agent.agentId}，应该使用哪个模型？只根据已知模型名称和任务需求判断，差异不明确时选 default。`,
      criteria
    };
  });
  return { questions, values };
}

function workspaceOptions(rows) {
  if (rows.length > 253) return null;
  const options = {
    none: "请求与任何项目无关，不需要工作区",
    unsure: "项目不明确或多个项目都可能匹配，交给主控 LLM"
  };
  const values = {};
  rows.forEach((workspace, index) => {
    const key = `w${index}`;
    values[key] = workspace;
    options[key] = {
      name: workspace.name,
      repoUrl: workspace.repoUrl || null,
      description: workspace.description || "",
      machines: (workspace.locations || []).filter((location) => location.online).map((location) => location.machineId)
    };
  });
  return { options, values };
}

export function createJevRouter({ catalog, workspaces, fetchImpl = globalThis.fetch,
  enabled = process.env.DSH_ALPHA_JEV_ROUTING === "1",
  apiKey = process.env.TYPESAFE_API_KEY,
  endpoint = process.env.DSH_ALPHA_JEV_ENDPOINT || DEFAULT_ENDPOINT,
  timeoutMs = 3000 } = {}) {
  if (!enabled || !apiKey) return null;
  const url = safeEndpoint(endpoint);
  return async function route({ prompt, selected = {}, signal }) {
    if (!prompt?.trim()) return null;
    if (selected.workspaceId && !selected.workspace) return null;
    const workspaceRows = selected.workspaceId ? [] : workspaces.list({ machineId: selected.machineId || null, includeOffline: false });
    const named = selected.workspace || namedWorkspace(prompt, workspaceRows);
    const eligibleMachines = named && new Set((named.locations || []).filter((location) => location.online).map((location) => location.machineId));
    const agents = catalog.listAgents().filter((agent) => agent.available && agent.provider !== "dsh-master"
      && (!selected.machineId || agent.machineId === selected.machineId)
      && (!eligibleMachines || eligibleMachines.has(agent.machineId))
      && (!selected.model || !agent.capabilities?.models?.length || agent.capabilities.models.includes(selected.model)));
    if (!agents.length) return null;
    const candidateAgents = agentOptions(agents, { allowUnsure: !named });
    if (!candidateAgents) return null;
    const models = modelQuestions(agents, selected);
    if (selected.workspaceId && agents.length === 1 && Object.keys(models.questions).length === 0) {
      return { agentId: agents[0].agentId, workspaceId: selected.workspaceId,
        ...(selected.model ? { model: selected.model } : {}) };
    }
    const candidateWorkspaces = named
      ? null
      : workspaceOptions(workspaceRows);
    if (!named && !candidateWorkspaces) return null;
    const questions = {
      target: {
        type: "choice",
        instructions: "为用户请求选择最合适的可用 Agent。候选已由代码按项目所在机器和能力过滤；多个 Agent 都能完成时，选择最合适的一个，不因偏好接近而选 unsure。只有候选都不合适时选 unsure。不要判断权限或改写请求。",
        criteria: candidateAgents.options
      }
    };
    Object.assign(questions, models.questions);
    if (candidateWorkspaces) {
      questions.workspace = {
        type: "choice",
        instructions: "用户请求属于哪个已知项目？只有明确属于某个项目时才选择它；与项目无关选 none；项目含糊选 unsure。",
        criteria: candidateWorkspaces.options
      };
    }
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ model: "jev-latest", state: { request: prompt }, questions }),
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)])
      });
      if (!response.ok) {
        console.info(`[alpha-jev] fallback: HTTP ${response.status}`);
        return null;
      }
      const answers = (await response.json()).answers || {};
      if (!accepted(answers.target, candidateAgents.options, { preference: true }) || answers.target.choice === "unsure") {
        console.info("[alpha-jev] fallback: Agent choice unavailable");
        return null;
      }
      const agent = candidateAgents.values[answers.target.choice];
      let workspace = named || null;
      if (candidateWorkspaces) {
        if (!accepted(answers.workspace, candidateWorkspaces.options) || answers.workspace.choice === "unsure") {
          console.info("[alpha-jev] fallback: workspace uncertain");
          return null;
        }
        workspace = candidateWorkspaces.values[answers.workspace.choice] || null;
      }
      if (selected.workspaceId && !workspace) return null;
      // 普通目录不能跨机。界面选择的 Git 工作区也是硬范围；自动选择的
      // Git 项目只允许远端 Worker 按需 clone，不复制主控绝对路径。
      if (workspace && !(workspace.locations || []).some((location) => location.online && location.machineId === agent.machineId)) {
        if (!workspace.repoUrl || selected.workspaceId || agent.machineId === catalog.machineId) return null;
      }
      const modelKey = `model_${agents.indexOf(agent)}`;
      const modelAnswer = answers[modelKey];
      const model = selected.model || (accepted(modelAnswer, models.questions[modelKey]?.criteria || {})
        ? models.values[modelKey]?.[modelAnswer.choice] : null);
      console.info(`[alpha-jev] route: ${agent.agentId} workspace=${workspace?.workspaceId || "none"}`);
      return { agentId: agent.agentId, ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
        ...(model ? { model } : {}) };
    } catch (error) {
      if (signal?.aborted) throw error;
      console.info(`[alpha-jev] fallback: ${error?.name || "request failed"}`);
      return null;
    }
  };
}
