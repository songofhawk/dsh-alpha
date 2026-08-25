// DSH Web client bundle：Alpha 会话的目标选择与 Worker turn 控制。
// 使用宿主 ModuleLoader/React，避免在 profile 安装第二份 DSH client runtime。

window.__ModuleLoader__.load({
  id: "dsh-alpha",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const ReactDOM = require("react-dom");

    const RPC_CHANNEL = "/dsh-alpha";

    function useOutsideClose(open, rootRef, close) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          if (!rootRef.current?.contains(event.target)) close();
        };
        const onKey = (event) => {
          if (event.key === "Escape") close();
        };
        document.addEventListener("pointerdown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("pointerdown", onPointer);
          document.removeEventListener("keydown", onKey);
        };
      }, [open, rootRef, close]);
    }

    function WorkspaceLocation({ location }) {
      return React.createElement("div", { className: "alpha-ws-location" },
        React.createElement("span", { className: `alpha-ws-dot ${location.online ? "is-online" : ""}` }),
        React.createElement("span", null, location.machineId),
        React.createElement("code", null, location.path),
        location.branch ? React.createElement("small", null, location.branch) : null
      );
    }

    function WorkspaceChoice({ workspace, selected, onSelect }) {
      return React.createElement("button", {
        type: "button",
        role: "option",
        "aria-selected": selected,
        className: `alpha-ws-choice${selected ? " is-selected" : ""}`,
        onClick: () => onSelect(workspace.workspaceId)
      },
      React.createElement("span", { className: "alpha-ws-choice-title" },
        React.createElement("strong", null, workspace.name),
        React.createElement("small", null, workspace.repoUrl || "仅限已登记机器")
      ),
      React.createElement("span", { className: "alpha-ws-locations" },
        ...workspace.locations.map((location) => React.createElement(WorkspaceLocation, {
          key: `${location.machineId}:${location.path}`,
          location
        }))
      ));
    }

    function WorkspaceMachineFilter({ machines, selectedMachineId, onChange, disabled = false }) {
      return React.createElement("label", { className: "alpha-ws-filter" },
        React.createElement("span", null, "工作机"),
        React.createElement("select", {
          value: selectedMachineId || "",
          disabled,
          "aria-label": "选择工作机",
          onChange: (event) => onChange(event.target.value || null)
        },
        React.createElement("option", { value: "" }, "自动选择工作机"),
        ...machines.map((machine) => React.createElement("option", {
          key: machine.machineId,
          value: machine.machineId,
          disabled: machine.online === false
        }, `${machine.machineId}${machine.online === false ? "（离线）" : ""}`))));
    }

    function AgentLabel({ agent }) {
      return `${agent.machineId} · ${agent.provider}${agent.model ? ` · ${agent.model}` : ""}`;
    }

    function WorkspaceAgentFilter({ agents, selectedAgentId, onChange, disabled = false }) {
      return React.createElement("label", { className: "alpha-ws-filter" },
        React.createElement("span", null, "Worker Agent"),
        React.createElement("select", {
          value: selectedAgentId || "",
          disabled,
          "aria-label": "选择 Worker Agent",
          onChange: (event) => onChange(event.target.value || null)
        },
        React.createElement("option", { value: "" }, "自动选择 Agent"),
        ...agents.map((agent) => React.createElement("option", {
          key: agent.agentId,
          value: agent.agentId,
          disabled: agent.available === false
        }, `${AgentLabel({ agent })}${agent.available === false ? "（离线）" : ""}`))));
    }

    function modeLabel(mode) {
      return ({
        "": "自动（跟随 Worker 默认）",
        "default": "默认",
        "auto-review": "Workspace Write",
        "full-access": "Full access"
      })[mode || ""] || mode;
    }

    function sessionSelectionPayload(sessionId, state, overrides = {}) {
      return {
        sessionId,
        workspaceId: overrides.workspaceId === undefined ? state.selectedWorkspaceId || null : overrides.workspaceId,
        machineId: overrides.machineId === undefined ? state.selectedMachineId || null : overrides.machineId,
        agentId: overrides.agentId === undefined ? state.selectedAgentId || null : overrides.agentId,
        mode: overrides.mode === undefined ? state.mode || null : overrides.mode,
        model: overrides.model === undefined ? state.model || null : overrides.model,
        reasoningEffort: overrides.reasoningEffort === undefined ? state.reasoningEffort || null : overrides.reasoningEffort
      };
    }

    function alphaSessionTitle({ baseTitle = null, machineId = null, workspace = null } = {}) {
      const base = String(baseTitle || "Alpha 主控").trim();
      if (!machineId && !workspace?.name) return base;
      const location = workspace?.locations?.find((item) => item.machineId === machineId) || workspace?.locations?.[0];
      const suffix = `${machineId || location?.machineId || "自动"}:${location?.path || workspace?.name || "自动工作区"}`;
      let normalTitle = base.replace(/\s*·\s*[^·]+:[^·]+$/, "").trim();
      if (!normalTitle || /^[^:]+:[^:]+$/.test(normalTitle) || normalTitle === "新会话" || normalTitle === "Alpha 主控") return null;
      return `${normalTitle} · ${suffix}`.slice(0, 180);
    }

    function AlphaLauncher({ controller }) {
      const [state, setState] = React.useState({ creating: false, error: "" });
      const rootRef = React.useRef(null);
      const creatingRef = React.useRef(false);
      const startBlank = React.useCallback(async () => {
        if (creatingRef.current) return;
        creatingRef.current = true;
        setState((current) => ({ ...current, creating: true, error: "" }));
        try {
          const value = await controller.call("workspace/list", { query: "" });
          if (!value.controlCwd) throw new Error("主控控制目录尚未就绪");
          const sessionId = await controller.createAlphaSession({ cwd: value.controlCwd, title: "Alpha 主控" });
          await controller.openSession(sessionId);
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        } finally {
          creatingRef.current = false;
          setState((current) => ({ ...current, creating: false }));
        }
      }, [controller]);

      React.useEffect(() => {
        const onNativeNewSession = (event) => {
          const button = event.target?.closest?.("button[aria-label]");
          if (!button || rootRef.current?.contains(button)) return;
          const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
          if (!/^(?:新建会话|New Session)(?:\s|$)/i.test(label.trim())) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          startBlank();
        };
        document.addEventListener("click", onNativeNewSession, true);
        return () => document.removeEventListener("click", onNativeNewSession, true);
      }, [startBlank]);

      return React.createElement("div", { className: "alpha-launcher", ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: "alpha-launcher-button",
          disabled: state.creating,
          onClick: startBlank
        }, React.createElement("span", { className: "alpha-launcher-mark", "aria-hidden": true }, "α"), state.creating ? "正在打开 Alpha" : "Alpha 主控"),
        state.error ? React.createElement("span", { className: "alpha-launcher-error", role: "alert" }, state.error) : null
      );
    }

    function AlphaTurnControls({ controller, sessionId, useSessions }) {
      const preset = useSessions((snapshot) => snapshot.byId?.[sessionId]?.agentPreset);
      const [state, setState] = React.useState({ loading: false, agents: [], selectedAgentId: null, selectedWorkspaceId: null, selectedMachineId: null, mode: null, model: null, reasoningEffort: null, error: "" });
      const rootRef = React.useRef(null);
      const requestRef = React.useRef(0);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const enabled = preset === "alpha";

      const load = React.useCallback(async () => {
        if (!enabled) return;
        const request = ++requestRef.current;
        setState((current) => ({ ...current, loading: true, error: "" }));
        try {
          const value = await controller.call("workspace/list", { sessionId, query: "" });
          if (request !== requestRef.current) return;
          setState({
            loading: false,
            agents: value.agents || [],
            selectedAgentId: value.selectedAgentId || null,
            selectedWorkspaceId: value.selectedWorkspaceId || null,
            selectedMachineId: value.selectedMachineId || null,
            mode: value.mode || null,
            model: value.model || null,
            reasoningEffort: value.reasoningEffort || null,
            error: ""
          });
        } catch (error) {
          if (request !== requestRef.current) return;
          setState((current) => ({ ...current, loading: false, error: error.message || String(error) }));
        }
      }, [controller, enabled, sessionId]);

      React.useEffect(() => {
        if (!enabled) return undefined;
        load();
        return undefined;
      }, [enabled, load]);

      React.useEffect(() => {
        if (!enabled) return undefined;
        const card = rootRef.current?.closest?.("[data-composer-card]");
        if (!card) return undefined;
        const hideNativePermission = () => {
          const buttons = [...card.querySelectorAll("button")].filter((item) => !rootRef.current?.contains(item));
          const button = buttons.find((item) => {
            const text = `${item.getAttribute("aria-label") || ""} ${item.textContent || ""}`;
            return /Read Only|Workspace Write|Full access|Standard mode|标准模式|只读|工作区写入|完全访问|权限|permission/i.test(text);
          });
          button?.classList.add("alpha-native-permission-hidden");
          const modelButton = buttons.find((item) => {
            const text = `${item.getAttribute("aria-label") || ""} ${item.textContent || ""}`;
            return /选择模型|Select model|推理等级|reasoning level/i.test(text);
          });
          modelButton?.classList.add("alpha-native-model-hidden");
        };
        hideNativePermission();
        const observer = new MutationObserver(hideNativePermission);
        observer.observe(card, { childList: true, subtree: true, characterData: true });
        return () => {
          observer.disconnect();
          card.querySelectorAll(".alpha-native-permission-hidden,.alpha-native-model-hidden").forEach((item) => {
            item.classList.remove("alpha-native-permission-hidden", "alpha-native-model-hidden");
          });
        };
      }, [enabled]);

      const closeSettings = React.useCallback(() => setSettingsOpen(false), []);
      useOutsideClose(settingsOpen, rootRef, closeSettings);

      if (!enabled) return null;
      const selectedAgent = state.agents.find((agent) => agent.agentId === state.selectedAgentId);
      const modelOptions = selectedAgent?.capabilities?.models || [];
      const modeOptions = selectedAgent?.capabilities?.modes?.length
        ? selectedAgent.capabilities.modes
        : ["default", "auto-review", "full-access"];
      const effortOptions = selectedAgent?.capabilities?.reasoning_efforts?.length
        ? selectedAgent.capabilities.reasoning_efforts
        : ["low", "medium", "high", "xhigh"];
      const update = async (overrides) => {
        try {
          const value = await controller.call("workspace/select", sessionSelectionPayload(sessionId, state, overrides));
          setState((current) => ({
            ...current,
            selectedAgentId: value.agentId || null,
            mode: value.mode || null,
            model: value.model || null,
            reasoningEffort: value.reasoningEffort || null,
            error: ""
          }));
          if (overrides.agentId !== undefined) await load();
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        }
      };

      return React.createElement("div", { className: "alpha-turn-controls", ref: rootRef, title: "本次及后续 turn 使用的 Worker 设置" },
        React.createElement("span", { className: "alpha-turn-label" }, "Worker"),
        React.createElement("select", {
          value: state.selectedAgentId || "",
          disabled: state.loading,
          "aria-label": "本次 turn 的 Worker Agent",
          onChange: (event) => update({ agentId: event.target.value || null, model: null, mode: null, reasoningEffort: null })
        },
        React.createElement("option", { value: "" }, "Agent 自动"),
        ...state.agents.map((agent) => React.createElement("option", {
          key: agent.agentId,
          value: agent.agentId,
          disabled: agent.available === false
        }, `${AgentLabel({ agent })}${agent.available === false ? "（离线）" : ""}`))),
        React.createElement("button", {
          type: "button",
          className: "alpha-turn-settings-trigger",
          "aria-haspopup": "dialog",
          "aria-expanded": settingsOpen,
          "aria-label": "Worker 模型和强度设置",
          onClick: () => setSettingsOpen((open) => !open)
        }, state.model || "模型自动", " · ", state.reasoningEffort || "强度自动", "⌄"),
        settingsOpen ? React.createElement("section", { className: "alpha-turn-settings-panel", role: "dialog", "aria-label": "Worker 设置" },
          React.createElement("header", null,
            React.createElement("strong", null, "Worker 设置"),
            React.createElement("button", { type: "button", "aria-label": "关闭 Worker 设置", onClick: closeSettings }, "×")
          ),
          React.createElement("small", { className: "alpha-turn-settings-hint" }, "仅影响后续 Worker turn；主机和项目保持当前会话选择"),
          React.createElement("label", null,
            React.createElement("span", null, "模型"),
            React.createElement("select", {
              value: state.model || "",
              disabled: state.loading || !selectedAgent,
              "aria-label": "Worker 模型",
              onChange: (event) => update({ model: event.target.value || null })
            },
            React.createElement("option", { value: "" }, selectedAgent ? "模型自动" : "先选择 Agent"),
            ...modelOptions.map((model) => React.createElement("option", { key: model, value: model }, model)))
          ),
          React.createElement("label", null,
            React.createElement("span", null, "强度"),
            React.createElement("select", {
              value: state.reasoningEffort || "",
              disabled: state.loading || !selectedAgent,
              "aria-label": "Worker 推理强度",
              onChange: (event) => update({ reasoningEffort: event.target.value || null })
            },
            React.createElement("option", { value: "" }, selectedAgent ? "强度自动" : "先选择 Agent"),
            ...effortOptions.map((effort) => React.createElement("option", { key: effort, value: effort }, effort)))
          ),
          React.createElement("label", null,
            React.createElement("span", null, "权限模式"),
            React.createElement("select", {
              value: state.mode || "",
              disabled: state.loading,
              "aria-label": "Worker 权限模式",
              onChange: (event) => update({ mode: event.target.value || null })
            },
            React.createElement("option", { value: "" }, modeLabel("")),
            ...modeOptions.map((mode) => React.createElement("option", { key: mode, value: mode }, modeLabel(mode))))
          )
        ) : null,
        state.error ? React.createElement("span", { className: "alpha-turn-error", role: "alert" }, state.error) : null
      );
    }

    function GlobalWorkspaceControl({ controller, sessionId, useSessions }) {
      const preset = useSessions((snapshot) => snapshot.byId?.[sessionId]?.agentPreset);
      const sessionTitle = useSessions((snapshot) => snapshot.byId?.[sessionId]?.title);
      const sessionBlank = useSessions((snapshot) => snapshot.byId?.[sessionId]?.blank === true);
      const [state, setState] = React.useState({ loading: false, machines: [], agents: [], selectedMachineId: null, selectedAgentId: null, workspaces: [], selectedWorkspaceId: null, mode: null, model: null, reasoningEffort: null, error: "" });
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState("");
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const requestRef = React.useRef(0);
      const [heroTarget, setHeroTarget] = React.useState(null);
      const [panelPlacement, setPanelPlacement] = React.useState(null);
      const enabled = preset === "alpha";

      React.useEffect(() => {
        let current = null;
        let originalTrigger = null;
        let originalPreset = null;
        const sync = () => {
          const next = enabled ? document.querySelector('[data-slot="conversation.hero.workspace"]') : null;
          const nextPreset = enabled
            ? [...document.querySelectorAll("button")].find((button) => /即将开始的这个会话所用的 Agent 预设|agent preset for this session/i.test(button.getAttribute("title") || ""))
            : null;
          if (next === current && nextPreset === originalPreset) return;
          current?.classList.remove("alpha-workspace-takeover");
          originalTrigger?.classList.remove("alpha-local-workspace-hidden");
          originalPreset?.classList.remove("alpha-native-preset-hidden");
          current = next;
          originalTrigger = current?.previousElementSibling?.tagName === "BUTTON" ? current.previousElementSibling : null;
          originalPreset = nextPreset;
          current?.classList.add("alpha-workspace-takeover");
          originalTrigger?.classList.add("alpha-local-workspace-hidden");
          originalPreset?.classList.add("alpha-native-preset-hidden");
          setHeroTarget(current);
        };
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          current?.classList.remove("alpha-workspace-takeover");
          originalTrigger?.classList.remove("alpha-local-workspace-hidden");
          originalPreset?.classList.remove("alpha-native-preset-hidden");
        };
      }, [enabled]);

      const load = React.useCallback(async (search = "", machineId = undefined) => {
        if (!enabled) return;
        const request = ++requestRef.current;
        setState((current) => ({ ...current, loading: true, error: "" }));
        try {
          const payload = { sessionId, query: search };
          if (machineId !== undefined) payload.machineId = machineId;
          const value = await controller.call("workspace/list", payload);
          if (request !== requestRef.current) return;
          setState({
            loading: false,
            machines: value.machines || [],
            agents: value.agents || [],
            selectedMachineId: value.selectedMachineId ?? machineId ?? null,
            selectedAgentId: value.selectedAgentId || null,
            workspaces: value.workspaces || [],
            selectedWorkspaceId: value.selectedWorkspaceId || null,
            mode: value.mode || null,
            model: value.model || null,
            reasoningEffort: value.reasoningEffort || null,
            error: ""
          });
        } catch (error) {
          if (request !== requestRef.current) return;
          setState((current) => ({ ...current, loading: false, error: error.message || String(error) }));
        }
      }, [controller, enabled, sessionId]);

      React.useEffect(() => {
        if (!enabled) {
          setOpen(false);
          return;
        }
        load("");
      }, [enabled, load]);

      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => load(query), 180);
        return () => clearTimeout(timer);
      }, [open, query, load]);

      const close = React.useCallback(() => setOpen(false), []);
      useOutsideClose(open, rootRef, close);

      React.useLayoutEffect(() => {
        if (!open || !triggerRef.current) return undefined;
        const place = () => {
          const rect = triggerRef.current.getBoundingClientRect();
          const margin = 12;
          const gap = 6;
          const width = Math.min(560, window.innerWidth - margin * 2);
          const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
          const below = window.innerHeight - rect.bottom - gap - margin;
          const above = rect.top - gap - margin;
          const placeBelow = below >= 280 || below >= above;
          const height = Math.min(520, Math.max(220, placeBelow ? below : above));
          setPanelPlacement({
            position: "fixed",
            left,
            top: placeBelow ? rect.bottom + gap : rect.top - gap - height,
            width,
            height,
            maxHeight: height,
            bottom: "auto"
          });
        };
        place();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
      }, [open, heroTarget]);

      const selectedWorkspaceForTitle = state.workspaces.find((workspace) => workspace.workspaceId === state.selectedWorkspaceId);
      React.useEffect(() => {
        if (!enabled || !sessionTitle || sessionTitle === "新会话" || sessionTitle === "Alpha 主控") return;
        if (!state.selectedMachineId && !state.selectedWorkspaceId) return;
        const nextTitle = alphaSessionTitle({
          baseTitle: sessionTitle,
          machineId: state.selectedMachineId,
          workspace: selectedWorkspaceForTitle
        });
        if (!nextTitle || nextTitle === sessionTitle) return;
        controller.renameSession(sessionId, nextTitle).catch(() => {});
      }, [controller, enabled, sessionId, sessionTitle, state.selectedMachineId, state.selectedWorkspaceId, selectedWorkspaceForTitle?.name]);

      if (!enabled) return null;
      const selected = selectedWorkspaceForTitle;
      const selectedMachine = state.machines.find((machine) => machine.machineId === state.selectedMachineId);
      const selectValues = (overrides = {}) => sessionSelectionPayload(sessionId, state, overrides);
      const chooseMachine = async (machineId) => {
        try {
          const value = await controller.call("workspace/select", {
            ...selectValues({ workspaceId: null, machineId: machineId || null, agentId: null })
          });
          setState((current) => ({
            ...current,
            selectedMachineId: value.machineId || null,
            selectedAgentId: value.agentId || null,
            selectedWorkspaceId: null,
            reasoningEffort: value.reasoningEffort || null,
            error: ""
          }));
          await load(query, machineId || null);
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        }
      };
      const choose = async (workspaceId) => {
        try {
          if (sessionBlank && workspaceId) {
            const nextSessionId = await controller.createTargetAlphaSession({
              workspaceId,
              machineId: state.selectedMachineId || null
            });
            await controller.openSession(nextSessionId);
            await controller.archiveSession(sessionId).catch(() => {});
            setOpen(false);
            return;
          }
          const value = await controller.call("workspace/select", {
            ...selectValues({ workspaceId, agentId: null })
          });
          setState((current) => ({
            ...current,
            selectedWorkspaceId: value.workspace?.workspaceId || null,
            selectedMachineId: value.machineId || null,
            selectedAgentId: value.agentId || null,
            reasoningEffort: value.reasoningEffort || null,
            error: ""
          }));
          await load(query, state.selectedMachineId || null);
          setOpen(false);
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        }
      };

      const chooseAgent = async (agentId) => {
        try {
          const value = await controller.call("workspace/select", {
            ...selectValues({ agentId: agentId || null })
          });
          setState((current) => ({
            ...current,
            selectedAgentId: value.agentId || null,
            error: ""
          }));
          await load(query, state.selectedMachineId || null);
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        }
      };

      const control = React.createElement("div", { className: "alpha-ws-control alpha-hero-workspace-control", ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: "alpha-ws-trigger",
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          ref: triggerRef,
          title: "从所有在线机器汇总出的工作区中选择",
          onClick: () => setOpen((value) => !value)
        },
        React.createElement("span", { className: `alpha-ws-dot ${(selectedMachine?.online ?? selected?.available) ? "is-online" : ""}` }),
        React.createElement("strong", null, `${selectedMachine?.machineId || "自动选机"} · ${selected?.name || "自动选区"}`),
        React.createElement("span", { "aria-hidden": true }, "⌄")),
        open ? React.createElement("section", { className: "alpha-ws-panel", style: panelPlacement || undefined, role: "dialog", "aria-label": "全局工作区" },
          React.createElement("header", null,
            React.createElement("div", null,
              React.createElement("strong", null, "全局工作区"),
              React.createElement("small", null, "同一项目的多台机器路径已合并")
            ),
            React.createElement("button", { type: "button", "aria-label": "关闭", onClick: close }, "×")
          ),
          React.createElement("input", {
            type: "search",
            value: query,
            placeholder: "搜索项目、仓库或 workspace ID",
            "aria-label": "搜索全局工作区",
            onChange: (event) => setQuery(event.target.value)
          }),
          React.createElement(WorkspaceMachineFilter, {
            machines: state.machines,
            selectedMachineId: state.selectedMachineId,
            onChange: chooseMachine,
            disabled: state.loading
          }),
          React.createElement(WorkspaceAgentFilter, {
            agents: state.agents,
            selectedAgentId: state.selectedAgentId,
            onChange: chooseAgent,
            disabled: state.loading
          }),
          React.createElement("div", { className: "alpha-ws-options", role: "listbox", "aria-label": "全局工作区列表" },
            React.createElement("button", {
              type: "button",
              role: "option",
              "aria-selected": state.selectedWorkspaceId === null,
              className: `alpha-ws-auto${state.selectedWorkspaceId === null ? " is-selected" : ""}`,
              onClick: () => choose(null)
            },
            React.createElement("strong", null, "根据任务自动选择"),
            React.createElement("small", null, selectedMachine ? `限定在 ${selectedMachine.machineId} 上，根据任务自动匹配` : "Alpha 根据用户表述匹配；歧义时会先询问")),
            state.loading ? React.createElement("p", { className: "alpha-ws-empty" }, "正在汇总机器目录…") : null,
            !state.loading && state.workspaces.length === 0 ? React.createElement("p", { className: "alpha-ws-empty" }, "没有匹配的工作区") : null,
            ...state.workspaces.map((workspace) => React.createElement(WorkspaceChoice, {
              key: workspace.workspaceId,
              workspace,
              selected: workspace.workspaceId === state.selectedWorkspaceId,
              onSelect: choose
            }))
          ),
          state.error ? React.createElement("p", { className: "alpha-ws-error", role: "alert" }, state.error) : null
        ) : null
      );
      return heroTarget ? ReactDOM.createPortal(control, heroTarget) : null;
    }

    const STYLES = `
.alpha-ws-control,.alpha-ws-control *{box-sizing:border-box}.alpha-ws-control{position:relative;pointer-events:auto;font-family:var(--dsw-font-family)}
.alpha-ws-trigger{display:flex;align-items:center;gap:6px;max-width:220px;height:28px;padding:0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:550 12px var(--dsw-font-family);cursor:pointer}
.alpha-ws-trigger:hover,.alpha-ws-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-ws-trigger strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.alpha-ws-dot{display:block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}.alpha-ws-dot.is-online{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.alpha-ws-panel{position:absolute;z-index:110;left:0;bottom:34px;display:grid;grid-template-rows:auto auto auto auto minmax(0,1fr) auto;width:min(520px,calc(100vw - 24px));height:min(560px,calc(100dvh - 130px));max-height:560px;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 36px color-mix(in srgb,#000 18%,transparent);overflow:hidden}
.alpha-ws-panel>header{display:flex;align-items:flex-start;justify-content:space-between}.alpha-ws-panel>header>div{display:grid;gap:2px}.alpha-ws-panel>header strong{font-size:13px}.alpha-ws-panel>header small{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-ws-panel>header>button{width:28px;height:28px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.alpha-ws-panel>header>button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.alpha-ws-panel>input{height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px var(--dsw-font-family)}.alpha-ws-panel>input:focus{border-color:#3898ec;box-shadow:0 0 0 2px color-mix(in srgb,#3898ec 20%,transparent)}
.alpha-ws-filters{display:grid;grid-template-columns:minmax(0,1fr);gap:6px}.alpha-ws-filter{display:grid;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:10px}.alpha-ws-filter select{width:100%;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px var(--dsw-font-family)}.alpha-ws-filter select:focus{border-color:#3898ec;box-shadow:0 0 0 2px color-mix(in srgb,#3898ec 20%,transparent)}
.alpha-turn-controls{position:relative;display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;font:11px var(--dsw-font-family)}.alpha-turn-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap}.alpha-turn-controls select{height:28px;min-width:0;max-width:180px;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:11px var(--dsw-font-family)}.alpha-turn-controls select:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}.alpha-turn-settings-trigger{height:28px;min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:11px var(--dsw-font-family);cursor:pointer}.alpha-turn-settings-trigger:hover,.alpha-turn-settings-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-turn-settings-panel{position:absolute;z-index:130;left:0;bottom:34px;display:grid;gap:9px;width:260px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 36px color-mix(in srgb,#000 18%,transparent);text-align:left}.alpha-turn-settings-panel>header{display:flex;align-items:center;justify-content:space-between}.alpha-turn-settings-panel>header strong{font-size:13px}.alpha-turn-settings-panel>header>button{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.alpha-turn-settings-panel>header>button:hover{background:var(--dsw-alias-interactive-bg-hover)}.alpha-turn-settings-panel>label{display:grid;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:10px}.alpha-turn-settings-panel>label select{width:100%;max-width:none}.alpha-turn-settings-hint{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}.alpha-turn-error{display:none}.alpha-native-permission-hidden,.alpha-native-model-hidden{display:none!important}
.alpha-ws-options{display:grid;align-content:start;gap:5px;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}.alpha-ws-options::before{content:"工作区";padding:2px 2px 0;color:var(--dsw-alias-label-tertiary);font-size:10px}.alpha-ws-auto,.alpha-ws-choice{display:grid;width:100%;gap:4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}.alpha-ws-auto:hover,.alpha-ws-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}.alpha-ws-auto.is-selected,.alpha-ws-choice.is-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}
.alpha-ws-auto strong,.alpha-ws-choice strong{font-size:12px}.alpha-ws-auto small,.alpha-ws-choice small{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-ws-choice-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.alpha-ws-choice-title small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alpha-ws-locations{display:grid;gap:3px}.alpha-ws-location{display:grid;grid-template-columns:8px minmax(58px,auto) minmax(0,1fr) auto;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}.alpha-ws-location code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:10.5px var(--dsw-font-family-mono,monospace)}.alpha-ws-location small{font-size:10px}
.alpha-ws-empty{margin:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}.alpha-ws-error{margin:0;padding:7px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11px}
.alpha-ws-control button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-slot="conversation.hero.workspace"].alpha-workspace-takeover>:not(.alpha-hero-workspace-control){display:none!important}.alpha-hero-workspace-control>.alpha-ws-trigger{max-width:320px;height:36px;padding:0 10px 0 8px;border-radius:10px;font-size:16px}.alpha-hero-workspace-control>.alpha-ws-panel{position:fixed;bottom:auto}.alpha-ws-control:not(.alpha-hero-workspace-control)>.alpha-ws-panel{bottom:34px}
.alpha-local-workspace-hidden,.alpha-native-preset-hidden{display:none!important}
@media(max-width:760px){.alpha-turn-controls{max-width:calc(100vw - 36px);overflow-x:auto}.alpha-turn-controls select{max-width:150px}.alpha-turn-label{display:none}}
@media(max-width:560px){.alpha-ws-panel,.alpha-hero-workspace-control>.alpha-ws-panel{position:fixed;inset:auto 12px 12px;width:auto;height:min(540px,calc(100dvh - 24px))}.alpha-ws-choice-title{display:grid;gap:2px}.alpha-ws-location{grid-template-columns:8px minmax(50px,auto) minmax(0,1fr)}.alpha-ws-location small{display:none}}`;

    const LAUNCHER_STYLES = `
.alpha-launcher{position:relative;pointer-events:auto;font-family:var(--dsw-font-family)}.alpha-launcher-button{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 9px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:550 12px var(--dsw-font-family);cursor:pointer}.alpha-launcher-button:hover{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-launcher-button:disabled{color:var(--dsw-alias-label-tertiary);cursor:wait}.alpha-launcher-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);font:600 14px Georgia,serif}.alpha-launcher-error{display:block;margin:4px 8px;color:var(--dsw-alias-state-error-primary);font-size:10px}`;

    const inject = ["slots", "connection", "sessions"];

    function apply(ctx) {
      const connection = ctx.get("connection");
      const sessions = ctx.get("sessions");
      const controller = {
        call: async (endpoint, payload, signal) => {
          const result = await connection.rpc.call(RPC_CHANNEL, endpoint, payload, signal);
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
          return result.value;
        },
        createAlphaSession: async ({ cwd, title = "Alpha 主控" }) => {
          const sessionId = `session-${crypto.randomUUID()}`;
          const listed = await connection.api.workspace.list({});
          if (!listed.result.ok) throw new Error(`${listed.result.error.code}: ${listed.result.error.message}`);
          let controlWorkspace = listed.result.value.items.find((workspace) => workspace.path === cwd);
          if (!controlWorkspace) {
            const created = await connection.api.workspace.create({ path: cwd });
            if (!created.result.ok) throw new Error(`${created.result.error.code}: ${created.result.error.message}`);
            controlWorkspace = created.result.value.workspace;
          }
          if (title && controlWorkspace.title !== title) {
            const renamed = await connection.api.workspace.rename({ workspaceId: controlWorkspace.workspaceId, title });
            if (!renamed.result.ok) throw new Error(`${renamed.result.error.code}: ${renamed.result.error.message}`);
            controlWorkspace = renamed.result.value.workspace;
          }
          const response = await connection.api.sessions.create({ sessionId, workspaceId: controlWorkspace.workspaceId, agentPreset: "alpha" });
          if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`);
          return response.result.value.sessionId;
        },
        createTargetAlphaSession: async ({ workspaceId, machineId }) => {
          const target = await controller.call("workspace/session-target", {
            workspaceId: workspaceId || null,
            machineId: machineId || null
          });
          const sessionId = await controller.createAlphaSession({
            cwd: target.cwd,
            title: target.title || "Alpha 主控"
          });
          await controller.call("workspace/select", {
            sessionId,
            workspaceId: workspaceId || null,
            machineId: machineId || null,
            agentId: null,
            mode: null,
            model: null,
            reasoningEffort: null
          });
          return sessionId;
        },
        archiveSession: async (sessionId) => {
          const response = await connection.api.workspace.archiveSession({ sessionId });
          if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`);
        },
        renameSession: async (sessionId, title) => {
          const response = await connection.api.sessions.rename({ sessionId, title });
          if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`);
          return response.result.value;
        },
        openSession: async (sessionId) => {
          if (!sessions.list.getSnapshot().byId?.[sessionId]) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                dispose();
                reject(new Error("Alpha 会话创建后未进入会话目录"));
              }, 5_000);
              const dispose = sessions.list.subscribe(() => {
                if (!sessions.list.getSnapshot().byId?.[sessionId]) return;
                clearTimeout(timer);
                dispose();
                resolve();
              });
            });
          }
          sessions.open(sessionId);
        }
      };
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.dshAlpha = "true";
        style.textContent = `${STYLES}\n${LAUNCHER_STYLES}`;
        document.head.append(style);
        return () => style.remove();
      }, "dsh-alpha:workspace-styles");
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-alpha-workspace",
        order: 45,
        inject: () => ({ controller })
      }, GlobalWorkspaceControl));
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-alpha-turn-controls",
        order: 40,
        inject: () => ({ controller })
      }, AlphaTurnControls));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-alpha-launcher",
        order: 35,
        inject: () => ({ controller })
      }, AlphaLauncher));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.RPC_CHANNEL = RPC_CHANNEL;
    return module.exports;
  }
});
