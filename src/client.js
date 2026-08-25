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

    function installDoubaoKnowledgeBaseToggle() {
      let revealed = false;
      const selector = 'button,[role="button"]';
      const matches = (element) => /配置\s*豆包\s*知识库/.test([
        element.textContent || "",
        element.getAttribute?.("aria-label") || "",
        element.getAttribute?.("title") || ""
      ].join(" "));
      const sync = () => {
        document.querySelectorAll(selector).forEach((element) => {
          if (!matches(element)) return;
          element.classList.toggle("alpha-doubao-config-hidden", !revealed);
        });
      };
      const onKeyDown = (event) => {
        const key = String(event.key || "").toLowerCase();
        if (key !== "k" || !event.altKey || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        event.stopPropagation();
        revealed = !revealed;
        sync();
      };
      if (!document.body) return () => {};
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener("keydown", onKeyDown, true);
      return () => {
        observer.disconnect();
        document.removeEventListener("keydown", onKeyDown, true);
        document.querySelectorAll(`${selector}.alpha-doubao-config-hidden`).forEach((element) => {
          element.classList.remove("alpha-doubao-config-hidden");
        });
      };
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

    function AlphaInventoryPage({ controller, onClose }) {
      const [state, setState] = React.useState({ loading: true, machines: [], workspaces: [], agents: [], agentTypes: [], error: "" });
      const [selectedMachineId, setSelectedMachineId] = React.useState(null);
      const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState(null);
      const [machineDraft, setMachineDraft] = React.useState("");
      const [workspaceDraft, setWorkspaceDraft] = React.useState("");
      const [agentDrafts, setAgentDrafts] = React.useState({});
      const [activeTab, setActiveTab] = React.useState("machines");
      const [busy, setBusy] = React.useState("");
      const [createOpen, setCreateOpen] = React.useState(false);
      const [projectDraft, setProjectDraft] = React.useState({ machineId: "", name: "", path: "", repoUrl: "", branch: "", description: "" });
      const [directoryPickerOpen, setDirectoryPickerOpen] = React.useState(false);
      const [directoryPicker, setDirectoryPicker] = React.useState({ loading: false, currentPath: null, parentPath: null, entries: [], error: "" });
      const [directoryName, setDirectoryName] = React.useState("");

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, loading: true, error: "" }));
        try {
          const value = await controller.call("inventory/overview", {});
          const machines = value.machines || [];
          setState({ loading: false, machines, workspaces: value.workspaces || [], agents: value.agents || [], agentTypes: value.agentTypes || [], error: "" });
          setSelectedMachineId((current) => current && machines.some((machine) => machine.machineId === current)
            ? current
            : machines[0]?.machineId || null);
          setProjectDraft((current) => ({ ...current, machineId: current.machineId || machines[0]?.machineId || "" }));
        } catch (error) {
          setState((current) => ({ ...current, loading: false, error: error.message || String(error) }));
        }
      }, [controller]);

      React.useEffect(() => { load(); }, [load]);

      const selectedMachine = state.machines.find((machine) => machine.machineId === selectedMachineId) || null;
      const projects = selectedMachine?.projects || [];
      const selectedProject = projects.find((project) => project.workspaceId === selectedWorkspaceId) || projects[0] || null;
      const groupedAgentTypes = [...new Map(state.agents
        .filter((agent) => agent.provider !== "dsh-master")
        .map((agent) => [agent.provider, {
          provider: agent.provider,
          description: agent.description || "",
          agents: state.agents.filter((candidate) => candidate.provider === agent.provider)
        }])).values()];
      const agentTypes = state.agentTypes.length ? state.agentTypes : groupedAgentTypes;
      React.useEffect(() => {
        setMachineDraft(selectedMachine?.description || "");
        setSelectedWorkspaceId((current) => current && projects.some((project) => project.workspaceId === current)
          ? current
          : projects[0]?.workspaceId || null);
      }, [selectedMachineId, selectedMachine?.description, projects.map((project) => project.workspaceId).join("|")]);
      React.useEffect(() => setWorkspaceDraft(selectedProject?.description || ""), [selectedProject?.workspaceId, selectedProject?.description]);

      const save = async (kind, payload) => {
        setBusy(kind);
        try {
          await controller.call(`inventory/update-${kind}`, payload);
          await load();
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        } finally {
          setBusy("");
        }
      };

      const createProject = async (event) => {
        event.preventDefault();
        if (!projectDraft.machineId || !projectDraft.path.trim()) return;
        setBusy("project");
        try {
          const project = await controller.call("inventory/create-project", {
            machineId: projectDraft.machineId,
            name: projectDraft.name.trim() || undefined,
            projectPath: projectDraft.path.trim(),
            repoUrl: projectDraft.repoUrl.trim() || undefined,
            branch: projectDraft.branch.trim() || undefined,
            description: projectDraft.description
          });
          setSelectedMachineId(projectDraft.machineId);
          setSelectedWorkspaceId(project.workspaceId);
          setCreateOpen(false);
          setProjectDraft((current) => ({ ...current, name: "", path: "", repoUrl: "", branch: "", description: "" }));
          await load();
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        } finally {
          setBusy("");
        }
      };

      const loadDirectories = React.useCallback(async (machineId, currentPath = null) => {
        setDirectoryPicker((current) => ({ ...current, loading: true, error: "" }));
        try {
          const value = await controller.call("inventory/directories", { machineId, path: currentPath || null });
          setDirectoryPicker({ loading: false, currentPath: value.currentPath || null, parentPath: value.parentPath || null, entries: value.entries || [], error: "" });
        } catch (error) {
          setDirectoryPicker((current) => ({ ...current, loading: false, error: error.message || String(error) }));
        }
      }, [controller]);

      const openDirectoryPicker = () => {
        const machine = state.machines.find((item) => item.machineId === projectDraft.machineId);
        const initialPath = projectDraft.path.trim() || machine?.allowedRoots?.[0] || null;
        setDirectoryPickerOpen(true);
        loadDirectories(projectDraft.machineId, initialPath);
      };

      const chooseDirectory = (directoryPath) => {
        setProjectDraft((current) => ({ ...current, path: directoryPath }));
        setDirectoryPickerOpen(false);
      };

      const createDirectoryFromPicker = async (event) => {
        event?.preventDefault?.();
        if (!directoryPicker.currentPath || !directoryName.trim()) return;
        setBusy("directory");
        try {
          const value = await controller.call("inventory/create-directory", {
            machineId: projectDraft.machineId,
            parentPath: directoryPicker.currentPath,
            name: directoryName.trim()
          });
          setDirectoryName("");
          await loadDirectories(projectDraft.machineId, value.entry.path);
        } catch (error) {
          setDirectoryPicker((current) => ({ ...current, error: error.message || String(error) }));
        } finally {
          setBusy("");
        }
      };

      const openAlpha = async () => {
        setBusy("open");
        try {
          let sessionId;
          if (selectedProject) {
            sessionId = await controller.createTargetAlphaSession({ workspaceId: selectedProject.workspaceId, machineId: selectedMachineId });
          } else {
            const listing = await controller.call("workspace/list", {});
            sessionId = await controller.createAlphaSession({ cwd: listing.controlCwd, title: "Alpha 主控" });
          }
          await controller.openSession(sessionId);
          onClose();
        } catch (error) {
          setState((current) => ({ ...current, error: error.message || String(error) }));
        } finally {
          setBusy("");
        }
      };

      return ReactDOM.createPortal(
        React.createElement("div", { className: "alpha-inventory-backdrop", role: "dialog", "aria-modal": "true", "aria-label": "Alpha 主控机器与项目" },
          React.createElement("main", { className: "alpha-inventory-page" },
            React.createElement("header", { className: "alpha-inventory-header" },
              React.createElement("div", null,
                React.createElement("span", { className: "alpha-inventory-eyebrow" }, "ALPHA CONTROL PLANE"),
                React.createElement("h1", null, "Alpha 主控目录"),
                React.createElement("p", null, "管理受控机器、项目与 Agent 的选择原则，让下一次派发更准确。")
              ),
              React.createElement("div", { className: "alpha-inventory-header-actions" },
                React.createElement("button", { type: "button", className: "alpha-inventory-secondary", onClick: load, disabled: state.loading }, state.loading ? "同步中…" : "刷新目录"),
                React.createElement("button", { type: "button", className: "alpha-inventory-close", "aria-label": "关闭机器与项目", onClick: onClose }, "×")
              )
            ),
            state.error ? React.createElement("p", { className: "alpha-inventory-error", role: "alert" }, state.error) : null,
            React.createElement("div", { className: `alpha-inventory-body${activeTab === "agents" ? " is-agent-tab" : ""}` },
              React.createElement("nav", { className: "alpha-inventory-tabs", "aria-label": "Alpha 主控目录" },
                React.createElement("button", { type: "button", className: activeTab === "machines" ? "is-active" : "", onClick: () => setActiveTab("machines") }, "机器与项目"),
                React.createElement("button", { type: "button", className: activeTab === "agents" ? "is-active" : "", onClick: () => setActiveTab("agents") }, "Agent 说明")
              ),
              activeTab === "machines" ? React.createElement("aside", { className: "alpha-machine-rail" },
                React.createElement("div", { className: "alpha-inventory-section-title" },
                  React.createElement("span", null, "受控机器"),
                  React.createElement("small", null, `${state.machines.length} 台`)
                ),
                state.machines.length === 0 && !state.loading ? React.createElement("p", { className: "alpha-inventory-empty" }, "还没有连接的机器") : null,
                ...state.machines.map((machine) => React.createElement("button", {
                  key: machine.machineId,
                  type: "button",
                  className: `alpha-machine-card${machine.machineId === selectedMachineId ? " is-selected" : ""}`,
                  onClick: () => setSelectedMachineId(machine.machineId)
                },
                React.createElement("span", { className: `alpha-machine-status${machine.online ? " is-online" : ""}` }),
                React.createElement("span", { className: "alpha-machine-card-main" },
                  React.createElement("strong", null, machine.machineId),
                  React.createElement("small", null, `${machine.platform || machine.os || "未知系统"} · ${machine.online ? "在线" : "离线"}`),
                  React.createElement("small", null, `${machine.projects?.length || 0} 个项目 · ${machine.onlineAgentCount || 0}/${machine.agentCount || 0} 个 Agent 可用`)
                ),
                React.createElement("span", { className: "alpha-machine-chevron", "aria-hidden": true }, "›")
                ))
              ) : null,
              React.createElement("section", { className: "alpha-inventory-detail" },
                activeTab === "machines" && (selectedMachine ? React.createElement(React.Fragment, null,
                  React.createElement("div", { className: "alpha-detail-heading" },
                    React.createElement("div", null,
                      React.createElement("span", { className: `alpha-detail-status${selectedMachine.online ? " is-online" : ""}` }, selectedMachine.online ? "在线" : "离线"),
                      React.createElement("h2", null, selectedMachine.machineId),
                      React.createElement("p", null, `${selectedMachine.platform || "未知平台"} · ${selectedMachine.os || "未知系统"} · 当前负载 ${selectedMachine.load?.active_turns || 0}`)
                    ),
                    React.createElement("button", { type: "button", className: "alpha-inventory-primary", onClick: () => { setProjectDraft((current) => ({ ...current, machineId: selectedMachine.machineId })); setCreateOpen(true); } }, "+ 新建工作区")
                  ),
                  React.createElement("section", { className: "alpha-inventory-card alpha-description-card" },
                    React.createElement("div", { className: "alpha-card-heading" },
                      React.createElement("div", null, React.createElement("h3", null, "机器说明"), React.createElement("p", null, "告诉 Alpha 这台机器适合什么任务、有什么限制。")),
                      React.createElement("button", { type: "button", className: "alpha-save-button", disabled: busy === "machine" || machineDraft === (selectedMachine.description || ""), onClick: () => save("machine", { machineId: selectedMachine.machineId, description: machineDraft }) }, busy === "machine" ? "保存中…" : "保存")
                    ),
                    React.createElement("textarea", { value: machineDraft, rows: 3, placeholder: "例如：GPU 机器，适合图像生成和需要大量并行的任务；晚上负载较低。", onChange: (event) => setMachineDraft(event.target.value) }),
                    React.createElement("div", { className: "alpha-detail-meta" }, React.createElement("span", null, `允许目录：${(selectedMachine.allowedRoots || []).join("、") || "未广播"}`), React.createElement("span", null, `心跳：${selectedMachine.lastHeartbeatMs ? new Date(selectedMachine.lastHeartbeatMs).toLocaleString() : "无"}`))
                  ),
                  React.createElement("div", { className: "alpha-projects-heading" }, React.createElement("div", null, React.createElement("h3", null, "这台机器上的项目"), React.createElement("p", null, "点击项目查看路径、仓库和派发原则。")), React.createElement("span", { className: "alpha-project-count" }, `${projects.length} 个`)),
                  projects.length ? React.createElement("div", { className: "alpha-project-list" }, ...projects.map((project) => React.createElement("button", { key: project.workspaceId, type: "button", className: `alpha-project-row${project.workspaceId === selectedProject?.workspaceId ? " is-selected" : ""}`, onClick: () => setSelectedWorkspaceId(project.workspaceId) }, React.createElement("span", { className: `alpha-project-dot${project.available ? " is-online" : ""}` }), React.createElement("span", { className: "alpha-project-row-main" }, React.createElement("strong", null, project.name), React.createElement("small", null, project.repoUrl || project.locations?.[0]?.path || "未填写路径")), React.createElement("span", null, "›")))) : React.createElement("div", { className: "alpha-inventory-empty alpha-inventory-empty-card" }, React.createElement("strong", null, "这台机器还没有登记项目"), React.createElement("span", null, "可以从右上角新建项目，补充路径和选择原则。")),
                  selectedProject ? React.createElement("section", { className: "alpha-inventory-card alpha-project-detail" },
                    React.createElement("div", { className: "alpha-card-heading" }, React.createElement("div", null, React.createElement("span", { className: "alpha-card-kicker" }, "PROJECT"), React.createElement("h3", null, selectedProject.name), React.createElement("p", null, selectedProject.repoUrl || "本地项目")), React.createElement("button", { type: "button", className: "alpha-save-button", disabled: busy === "workspace" || workspaceDraft === (selectedProject.description || ""), onClick: () => save("workspace", { workspaceId: selectedProject.workspaceId, description: workspaceDraft }) }, busy === "workspace" ? "保存中…" : "保存说明")),
                    React.createElement("div", { className: "alpha-project-facts" }, ...selectedProject.locations.map((location) => React.createElement("div", { key: `${location.machineId}:${location.path}` }, React.createElement("span", null, location.online ? "● 在线路径" : "○ 离线路径"), React.createElement("code", null, location.path), location.branch ? React.createElement("small", null, location.branch) : null))),
                    React.createElement("textarea", { value: workspaceDraft, rows: 3, placeholder: "例如：这是支付链路项目，优先交给 Claude 做复杂重构；不要在没有测试的情况下直接改数据库。", onChange: (event) => setWorkspaceDraft(event.target.value) })
                  ) : null
                ) : React.createElement("div", { className: "alpha-inventory-empty alpha-no-machine" }, "选择左侧机器查看详情")),
                activeTab === "agents" ? React.createElement("section", { className: "alpha-inventory-card alpha-agent-guide" },
                  React.createElement("div", { className: "alpha-card-heading" }, React.createElement("div", null, React.createElement("h3", null, "Agent 选择说明"), React.createElement("p", null, "这些说明会随目录一起提供给 Alpha，作为自动选 Agent 的参考。"))),
                  React.createElement("div", { className: "alpha-agent-list" }, ...agentTypes.map((agentType) => React.createElement("div", { className: "alpha-agent-row", key: agentType.provider }, React.createElement("div", { className: "alpha-agent-row-title" }, React.createElement("strong", null, agentType.provider), React.createElement("span", null, `${agentType.agents.length} 个实例 · ${agentType.agents.map((agent) => agent.machineId).join("、") || "未连接"}`)), React.createElement("textarea", { rows: 2, value: agentDrafts[agentType.provider] === undefined ? agentType.description : agentDrafts[agentType.provider], onChange: (event) => setAgentDrafts((current) => ({ ...current, [agentType.provider]: event.target.value })), placeholder: "填写这个 Agent 类型最适合什么任务…" }), React.createElement("button", { type: "button", className: "alpha-save-button alpha-agent-save", disabled: busy === `agent:${agentType.provider}` || (agentDrafts[agentType.provider] ?? agentType.description) === agentType.description, onClick: async () => { setBusy(`agent:${agentType.provider}`); try { await controller.call("inventory/update-agent", { provider: agentType.provider, description: agentDrafts[agentType.provider] || "" }); await load(); } catch (error) { setState((current) => ({ ...current, error: error.message || String(error) })); } finally { setBusy(""); } } }, busy === `agent:${agentType.provider}` ? "保存中…" : "保存"))))
                ) : null,
                React.createElement("footer", { className: "alpha-inventory-footer" }, React.createElement("span", null, selectedProject ? `当前选择：${selectedMachine?.machineId} · ${selectedProject.name}` : "还没有选择项目"), React.createElement("button", { type: "button", className: "alpha-inventory-primary", disabled: busy === "open", onClick: openAlpha }, busy === "open" ? "打开中…" : "打开 Alpha 主控会话"))
              )
            ),
            createOpen ? React.createElement("div", { className: "alpha-create-project-panel" },
              React.createElement("div", { className: "alpha-create-project-dialog" },
                React.createElement("div", { className: "alpha-card-heading" }, React.createElement("div", null, React.createElement("span", { className: "alpha-card-kicker" }, "NEW WORKSPACE"), React.createElement("h3", null, "新建工作区"), React.createElement("p", null, "选择 Worker 的 allowed root 下的目录；本机和远端都可以直接新建目录。")), React.createElement("button", { type: "button", className: "alpha-inventory-close alpha-inventory-close-small", onClick: () => setCreateOpen(false) }, "×")),
                React.createElement("form", { onSubmit: createProject },
                  React.createElement("label", null, React.createElement("span", null, "归属机器"), React.createElement("select", { value: projectDraft.machineId, onChange: (event) => setProjectDraft((current) => ({ ...current, machineId: event.target.value, path: "" })) }, ...state.machines.map((machine) => React.createElement("option", { key: machine.machineId, value: machine.machineId }, `${machine.machineId}${machine.online ? "" : "（离线）"}`)))),
                  React.createElement("label", null, React.createElement("span", null, "项目名称"), React.createElement("input", { value: projectDraft.name, placeholder: "例如 ai-prd", onChange: (event) => setProjectDraft((current) => ({ ...current, name: event.target.value })) })),
                  React.createElement("label", null, React.createElement("span", null, "项目路径"), React.createElement("div", { className: "alpha-path-picker-field" }, React.createElement("input", { required: true, value: projectDraft.path, placeholder: "/work/ai-prd", onChange: (event) => setProjectDraft((current) => ({ ...current, path: event.target.value })) }), React.createElement("button", { type: "button", className: "alpha-inventory-secondary", onClick: openDirectoryPicker, disabled: !projectDraft.machineId }, "选择目录"))),
                  directoryPickerOpen ? React.createElement("section", { className: "alpha-directory-picker", "aria-label": "选择项目目录" },
                    React.createElement("div", { className: "alpha-directory-picker-head" },
                      React.createElement("div", null, React.createElement("strong", null, "选择工作区目录"), React.createElement("code", null, directoryPicker.currentPath || "选择一个 allowed root")),
                      React.createElement("button", { type: "button", className: "alpha-inventory-close alpha-inventory-close-small", onClick: () => setDirectoryPickerOpen(false), "aria-label": "关闭目录选择" }, "×")
                    ),
                    directoryPicker.parentPath ? React.createElement("button", { type: "button", className: "alpha-directory-up", onClick: () => loadDirectories(projectDraft.machineId, directoryPicker.parentPath) }, "‹ 返回上一级") : null,
                    directoryPicker.loading ? React.createElement("p", { className: "alpha-inventory-empty" }, "正在读取目录…") : null,
                    !directoryPicker.loading && directoryPicker.entries.length === 0 ? React.createElement("p", { className: "alpha-inventory-empty" }, "当前目录下没有子目录，可以直接选择当前目录或新建目录。") : null,
                    React.createElement("div", { className: "alpha-directory-list" }, ...directoryPicker.entries.map((entry) => React.createElement("div", { className: "alpha-directory-row", key: entry.path }, React.createElement("button", { type: "button", className: "alpha-directory-name", onClick: () => loadDirectories(projectDraft.machineId, entry.path) }, React.createElement("span", { "aria-hidden": true }, "▰"), entry.name), React.createElement("button", { type: "button", className: "alpha-save-button", onClick: () => chooseDirectory(entry.path) }, "选择")))),
                    directoryPicker.currentPath ? React.createElement("div", { className: "alpha-directory-create" }, React.createElement("input", { value: directoryName, placeholder: "新建目录名称", onChange: (event) => setDirectoryName(event.target.value) }), React.createElement("button", { type: "button", className: "alpha-inventory-secondary", onClick: createDirectoryFromPicker, disabled: busy === "directory" || !directoryName.trim() }, busy === "directory" ? "创建中…" : "新建目录")) : null,
                    directoryPicker.error ? React.createElement("p", { className: "alpha-ws-error", role: "alert" }, directoryPicker.error) : null
                  ) : null,
                  React.createElement("label", null, React.createElement("span", null, "仓库 URL（可选）"), React.createElement("input", { value: projectDraft.repoUrl, placeholder: "https://github.com/org/repo.git", onChange: (event) => setProjectDraft((current) => ({ ...current, repoUrl: event.target.value })) })),
                  React.createElement("label", null, React.createElement("span", null, "分支（可选）"), React.createElement("input", { value: projectDraft.branch, placeholder: "main", onChange: (event) => setProjectDraft((current) => ({ ...current, branch: event.target.value })) })),
                  React.createElement("label", null, React.createElement("span", null, "项目说明"), React.createElement("textarea", { rows: 4, value: projectDraft.description, placeholder: "告诉 Alpha 这个项目是什么、应该遵守什么原则…", onChange: (event) => setProjectDraft((current) => ({ ...current, description: event.target.value })) })),
                  React.createElement("div", { className: "alpha-create-actions" }, React.createElement("button", { type: "button", className: "alpha-inventory-secondary", onClick: () => setCreateOpen(false) }, "取消"), React.createElement("button", { type: "submit", className: "alpha-inventory-primary", disabled: busy === "project" }, busy === "project" ? "创建中…" : "创建项目"))
                )
              )
            ) : null
          )
        ),
        document.body
      );
    }

    function AlphaLauncher({ controller }) {
      const [state, setState] = React.useState({ creating: false, error: "", inventoryOpen: false });
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

      return React.createElement(React.Fragment, null,
      React.createElement("div", { className: "alpha-launcher", ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: "alpha-launcher-button",
          disabled: state.creating,
          onClick: () => setState((current) => ({ ...current, inventoryOpen: true }))
        }, React.createElement("span", { className: "alpha-launcher-mark", "aria-hidden": true }, "α"), state.creating ? "正在打开 Alpha" : "Alpha 主控"),
        state.error ? React.createElement("span", { className: "alpha-launcher-error", role: "alert" }, state.error) : null
      ), state.inventoryOpen ? React.createElement(AlphaInventoryPage, { controller, onClose: () => setState((current) => ({ ...current, inventoryOpen: false })) }) : null);
    }

    function AlphaTurnControls({ controller, sessionId, useSessions }) {
      const preset = useSessions((snapshot) => snapshot.byId?.[sessionId]?.agentPreset);
      const [state, setState] = React.useState({ loading: false, agents: [], selectedAgentId: null, selectedWorkspaceId: null, selectedMachineId: null, mode: null, model: null, reasoningEffort: null, error: "" });
      const rootRef = React.useRef(null);
      const requestRef = React.useRef(0);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [modelDraft, setModelDraft] = React.useState("");
      const enabled = preset === "alpha";

      const load = React.useCallback(async () => {
        if (!enabled) return;
        const request = ++requestRef.current;
        setState((current) => ({ ...current, loading: true, error: "" }));
        try {
          const value = await controller.call("workspace/list", { sessionId, query: "" });
          if (request !== requestRef.current) return;
          let agents = value.agents || [];
          if (value.selectedAgentId) {
            try {
              const live = await controller.call("agent/capabilities", {
                sessionId,
                agentId: value.selectedAgentId
              });
              agents = agents.map((agent) => agent.agentId === live.agentId
                ? { ...agent, capabilities: live.capabilities, model: live.capabilities?.default_model || agent.model }
                : agent);
            } catch {
              // 能力查询失败时保留握手目录，仍允许 Agent 自动选择。
            }
          }
          if (request !== requestRef.current) return;
          setState({
            loading: false,
            agents,
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
      React.useEffect(() => setModelDraft(state.model || ""), [state.model]);

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
            modelOptions.length
              ? React.createElement("select", {
                value: state.model || "",
                disabled: state.loading || !selectedAgent,
                "aria-label": "Worker 模型",
                onChange: (event) => update({ model: event.target.value || null })
              },
              React.createElement("option", { value: "" }, selectedAgent ? "模型自动" : "先选择 Agent"),
              ...modelOptions.map((model) => React.createElement("option", { key: model, value: model }, model)))
              : React.createElement("input", {
                value: modelDraft,
                disabled: state.loading || !selectedAgent,
                "aria-label": "Worker 模型",
                placeholder: selectedAgent ? "Agent 未公开目录，可手动输入" : "先选择 Agent",
                onChange: (event) => setModelDraft(event.target.value),
                onBlur: () => {
                  const next = modelDraft.trim() || null;
                  if (next !== (state.model || null)) update({ model: next });
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }
              })
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
.alpha-turn-controls{position:relative;display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;font:11px var(--dsw-font-family)}.alpha-turn-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap}.alpha-turn-controls select{height:28px;min-width:0;max-width:180px;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:11px var(--dsw-font-family)}.alpha-turn-controls select:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}.alpha-turn-settings-trigger{height:28px;min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:11px var(--dsw-font-family);cursor:pointer}.alpha-turn-settings-trigger:hover,.alpha-turn-settings-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-turn-settings-panel{position:absolute;z-index:130;left:0;bottom:34px;display:grid;gap:9px;width:260px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 36px color-mix(in srgb,#000 18%,transparent);text-align:left}.alpha-turn-settings-panel>header{display:flex;align-items:center;justify-content:space-between}.alpha-turn-settings-panel>header strong{font-size:13px}.alpha-turn-settings-panel>header>button{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.alpha-turn-settings-panel>header>button:hover{background:var(--dsw-alias-interactive-bg-hover)}.alpha-turn-settings-panel>label{display:grid;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:10px}.alpha-turn-settings-panel>label select,.alpha-turn-settings-panel>label input{width:100%;max-width:none;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px var(--dsw-font-family)}.alpha-turn-settings-panel>label select:focus,.alpha-turn-settings-panel>label input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}.alpha-turn-settings-hint{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}.alpha-turn-error{display:none}.alpha-native-permission-hidden,.alpha-native-model-hidden{display:none!important}
.alpha-ws-options{display:grid;align-content:start;gap:5px;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}.alpha-ws-options::before{content:"工作区";padding:2px 2px 0;color:var(--dsw-alias-label-tertiary);font-size:10px}.alpha-ws-auto,.alpha-ws-choice{display:grid;width:100%;gap:4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}.alpha-ws-auto:hover,.alpha-ws-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}.alpha-ws-auto.is-selected,.alpha-ws-choice.is-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}
.alpha-ws-auto strong,.alpha-ws-choice strong{font-size:12px}.alpha-ws-auto small,.alpha-ws-choice small{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-ws-choice-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.alpha-ws-choice-title small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alpha-ws-locations{display:grid;gap:3px}.alpha-ws-location{display:grid;grid-template-columns:8px minmax(58px,auto) minmax(0,1fr) auto;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}.alpha-ws-location code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:10.5px var(--dsw-font-family-mono,monospace)}.alpha-ws-location small{font-size:10px}
.alpha-ws-empty{margin:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}.alpha-ws-error{margin:0;padding:7px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11px}
.alpha-ws-control button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-slot="conversation.hero.workspace"].alpha-workspace-takeover>:not(.alpha-hero-workspace-control){display:none!important}.alpha-hero-workspace-control>.alpha-ws-trigger{max-width:320px;height:36px;padding:0 10px 0 8px;border-radius:10px;font-size:16px}.alpha-hero-workspace-control>.alpha-ws-panel{position:fixed;bottom:auto}.alpha-ws-control:not(.alpha-hero-workspace-control)>.alpha-ws-panel{bottom:34px}
.alpha-local-workspace-hidden,.alpha-native-preset-hidden{display:none!important}
@media(max-width:760px){.alpha-turn-controls{max-width:calc(100vw - 36px);overflow-x:auto}.alpha-turn-controls select{max-width:150px}.alpha-turn-label{display:none}}
@media(max-width:560px){.alpha-ws-panel,.alpha-hero-workspace-control>.alpha-ws-panel{position:fixed;inset:auto 12px 12px;width:auto;height:min(540px,calc(100dvh - 24px))}.alpha-ws-choice-title{display:grid;gap:2px}.alpha-ws-location{grid-template-columns:8px minmax(50px,auto) minmax(0,1fr)}.alpha-ws-location small{display:none}}`;

    const INVENTORY_STYLES = `
.alpha-inventory-backdrop{position:fixed;z-index:10000;inset:0;display:flex;align-items:stretch;justify-content:center;padding:24px;background:rgba(20,20,19,.46);font-family:var(--dsw-font-family,system-ui,sans-serif);color:#141413}.alpha-inventory-page{display:flex;flex-direction:column;width:min(1320px,100%);min-height:0;overflow:hidden;background:#f5f4ed;border:1px solid #e8e6dc;border-radius:24px;box-shadow:0 24px 80px rgba(20,20,19,.24)}.alpha-inventory-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:28px 32px 24px;background:#141413;color:#faf9f5}.alpha-inventory-eyebrow,.alpha-card-kicker{color:#d97757;font-size:10px;letter-spacing:.12em}.alpha-inventory-header h1{margin:8px 0 6px;font:500 34px/1.15 Georgia,serif}.alpha-inventory-header p{max-width:620px;margin:0;color:#b0aea5;font-size:14px;line-height:1.6}.alpha-inventory-header-actions{display:flex;align-items:center;gap:8px}.alpha-inventory-secondary,.alpha-inventory-close,.alpha-save-button{border:1px solid #e8e6dc;border-radius:9px;background:#faf9f5;color:#4d4c48;cursor:pointer;font:500 12px var(--dsw-font-family,system-ui,sans-serif)}.alpha-inventory-secondary{padding:8px 12px}.alpha-inventory-header .alpha-inventory-secondary{border-color:#4b4a45;background:#30302e;color:#faf9f5}.alpha-inventory-secondary:disabled,.alpha-save-button:disabled{cursor:default;opacity:.5}.alpha-inventory-close{display:grid;place-items:center;width:32px;height:32px;padding:0;font-size:22px;line-height:1}.alpha-inventory-header .alpha-inventory-close{border-color:#4b4a45;background:transparent;color:#b0aea5}.alpha-inventory-body{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:0;flex:1}.alpha-machine-rail{min-width:0;overflow:auto;padding:24px 16px 24px 24px;border-right:1px solid #e8e6dc}.alpha-inventory-section-title,.alpha-projects-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.alpha-inventory-section-title span,.alpha-projects-heading h3{font:500 20px/1.2 Georgia,serif}.alpha-inventory-section-title small,.alpha-project-count{color:#87867f;font-size:12px}.alpha-machine-card{display:flex;align-items:center;gap:10px;width:100%;margin:6px 0;padding:13px 10px;border:1px solid transparent;border-radius:12px;background:transparent;color:#141413;text-align:left;cursor:pointer}.alpha-machine-card:hover{background:#faf9f5}.alpha-machine-card.is-selected{border-color:#c96442;background:#faf9f5;box-shadow:0 0 0 1px rgba(201,100,66,.22)}.alpha-machine-status,.alpha-project-dot{display:block;flex:none;width:8px;height:8px;border-radius:50%;background:#b0aea5}.alpha-machine-status.is-online,.alpha-project-dot.is-online{background:#6c8b65;box-shadow:0 0 0 3px rgba(108,139,101,.12)}.alpha-machine-card-main{display:grid;min-width:0;gap:3px;flex:1}.alpha-machine-card-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.alpha-machine-card-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#87867f;font-size:11px;line-height:1.35}.alpha-machine-chevron{color:#87867f;font-size:20px}.alpha-inventory-detail{position:relative;min-width:0;overflow:auto;padding:28px 32px 86px}.alpha-detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}.alpha-detail-status{display:inline-flex;align-items:center;gap:6px;color:#87867f;font-size:11px}.alpha-detail-status:before{content:"";width:7px;height:7px;border-radius:50%;background:#b0aea5}.alpha-detail-status.is-online{color:#6c8b65}.alpha-detail-status.is-online:before{background:#6c8b65}.alpha-detail-heading h2{margin:4px 0 4px;font:500 30px/1.2 Georgia,serif}.alpha-detail-heading p,.alpha-card-heading p,.alpha-projects-heading p{margin:0;color:#5e5d59;font-size:12px;line-height:1.5}.alpha-inventory-primary{border:1px solid #c96442;border-radius:9px;padding:9px 14px;background:#c96442;color:#faf9f5;cursor:pointer;font:500 12px var(--dsw-font-family,system-ui,sans-serif);box-shadow:0 0 0 1px #c96442}.alpha-inventory-primary:disabled{cursor:default;opacity:.55}.alpha-inventory-card{margin-bottom:18px;padding:18px;border:1px solid #f0eee6;border-radius:14px;background:#faf9f5;box-shadow:0 4px 24px rgba(20,20,19,.04)}.alpha-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.alpha-card-heading h3{margin:4px 0 3px;font:500 21px/1.25 Georgia,serif}.alpha-save-button{padding:7px 10px;white-space:nowrap}.alpha-description-card textarea,.alpha-project-detail textarea,.alpha-agent-row textarea,.alpha-create-project-dialog textarea,.alpha-create-project-dialog input,.alpha-create-project-dialog select{width:100%;border:1px solid #e8e6dc;border-radius:9px;outline:none;background:#f5f4ed;color:#141413;font:13px/1.55 var(--dsw-font-family,system-ui,sans-serif)}.alpha-description-card textarea,.alpha-project-detail textarea,.alpha-agent-row textarea,.alpha-create-project-dialog textarea{resize:vertical;padding:9px 10px}.alpha-description-card textarea:focus,.alpha-project-detail textarea:focus,.alpha-agent-row textarea:focus,.alpha-create-project-dialog textarea:focus,.alpha-create-project-dialog input:focus,.alpha-create-project-dialog select:focus{border-color:#3898ec;box-shadow:0 0 0 2px rgba(56,152,236,.18)}.alpha-detail-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:9px;color:#87867f;font-size:11px}.alpha-projects-heading{margin-top:26px}.alpha-project-list{display:grid;gap:7px;margin-bottom:18px}.alpha-project-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:12px;border:1px solid #e8e6dc;border-radius:10px;background:#faf9f5;color:#141413;text-align:left;cursor:pointer}.alpha-project-row:hover,.alpha-project-row.is-selected{border-color:#c96442;box-shadow:0 0 0 1px rgba(201,100,66,.16)}.alpha-project-row-main{display:grid;min-width:0;gap:3px}.alpha-project-row-main strong{font-size:13px}.alpha-project-row-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#87867f;font-size:11px}.alpha-project-row>span:last-child{color:#87867f;font-size:20px}.alpha-inventory-empty{padding:22px 12px;color:#87867f;font-size:12px;text-align:center}.alpha-inventory-empty-card{display:grid;gap:4px;margin-bottom:18px;border:1px dashed #d1cfc5;border-radius:12px}.alpha-inventory-empty-card strong{color:#5e5d59}.alpha-no-machine{display:grid;place-items:center;min-height:240px}.alpha-project-facts{display:grid;gap:7px;margin:0 0 12px}.alpha-project-facts>div{display:grid;grid-template-columns:78px minmax(0,1fr) auto;align-items:center;gap:8px;color:#6c8b65;font-size:11px}.alpha-project-facts code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#5e5d59;font:11px var(--dsw-font-family-mono,monospace)}.alpha-project-facts small{color:#87867f}.alpha-agent-guide{margin-top:24px}.alpha-agent-list{display:grid;gap:14px}.alpha-agent-row{display:grid;grid-template-columns:170px minmax(0,1fr) auto;align-items:start;gap:10px}.alpha-agent-row-title{display:grid;gap:3px;padding-top:8px}.alpha-agent-row-title strong{font-size:13px}.alpha-agent-row-title span{color:#87867f;font-size:11px}.alpha-agent-save{margin-top:6px}.alpha-inventory-footer{position:absolute;right:32px;bottom:0;left:32px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;background:#f5f4ed;border-top:1px solid #e8e6dc;color:#5e5d59;font-size:12px}.alpha-create-project-panel{position:absolute;z-index:2;inset:0;display:grid;place-items:center;padding:24px;background:rgba(20,20,19,.22)}.alpha-create-project-dialog{width:min(520px,100%);max-height:100%;overflow:auto;padding:22px;border:1px solid #e8e6dc;border-radius:16px;background:#faf9f5;box-shadow:0 18px 56px rgba(20,20,19,.2)}.alpha-inventory-close-small{background:transparent}.alpha-create-project-dialog form{display:grid;gap:12px}.alpha-create-project-dialog label{display:grid;gap:5px;color:#5e5d59;font-size:11px}.alpha-create-project-dialog input,.alpha-create-project-dialog select{height:36px;padding:0 9px}.alpha-create-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}.alpha-inventory-backdrop button:focus-visible,.alpha-inventory-backdrop textarea:focus-visible,.alpha-inventory-backdrop input:focus-visible,.alpha-inventory-backdrop select:focus-visible{outline:2px solid #3898ec;outline-offset:2px}
@media(max-width:900px){.alpha-inventory-backdrop{padding:10px}.alpha-inventory-body{grid-template-columns:230px minmax(0,1fr)}.alpha-inventory-header{padding:22px}.alpha-inventory-detail{padding:22px}.alpha-inventory-footer{right:22px;left:22px}.alpha-agent-row{grid-template-columns:130px minmax(0,1fr) auto}}
@media(max-width:680px){.alpha-inventory-backdrop{padding:0}.alpha-inventory-page{border:0;border-radius:0}.alpha-inventory-header{padding:18px}.alpha-inventory-header h1{font-size:28px}.alpha-inventory-header p{font-size:12px}.alpha-inventory-body{display:block;overflow:auto}.alpha-machine-rail{max-height:210px;border-right:0;border-bottom:1px solid #e8e6dc;padding:14px}.alpha-machine-card{display:inline-flex;width:auto;min-width:210px;margin:4px}.alpha-inventory-detail{overflow:visible;padding:20px 16px 84px}.alpha-detail-heading{display:block}.alpha-detail-heading>.alpha-inventory-primary{margin-top:12px}.alpha-agent-row{grid-template-columns:1fr}.alpha-agent-save{justify-self:end}.alpha-inventory-footer{right:16px;left:16px}.alpha-inventory-footer span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.alpha-inventory-header-actions .alpha-inventory-secondary{display:none}}`;

    const DSH_INVENTORY_STYLES = `
.alpha-inventory-backdrop{background:var(--dsw-alias-bg-mask-3);color:var(--dsw-alias-label-primary)}.alpha-inventory-page{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l3);border-radius:16px;box-shadow:var(--dsw-shadow-lv2)}.alpha-inventory-header{background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}.alpha-inventory-eyebrow,.alpha-card-kicker{color:var(--dsw-alias-label-tertiary)}.alpha-inventory-header h1,.alpha-inventory-section-title span,.alpha-projects-heading h3,.alpha-detail-heading h2,.alpha-card-heading h3{font-family:var(--dsw-font-family,system-ui,sans-serif);font-weight:600}.alpha-inventory-header p,.alpha-detail-heading p,.alpha-card-heading p,.alpha-projects-heading p{color:var(--dsw-alias-label-tertiary)}.alpha-inventory-header .alpha-inventory-secondary{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}.alpha-inventory-header .alpha-inventory-close{border-color:transparent;color:var(--dsw-alias-label-secondary)}.alpha-inventory-secondary,.alpha-inventory-close,.alpha-save-button{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}.alpha-inventory-secondary:hover,.alpha-save-button:hover:not(:disabled),.alpha-inventory-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.alpha-inventory-error{margin:12px 32px 0;padding:8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}.alpha-machine-rail{border-color:var(--dsw-alias-border-l2)}.alpha-inventory-section-title small,.alpha-project-count,.alpha-machine-card-main small,.alpha-machine-chevron,.alpha-detail-meta,.alpha-project-row-main small,.alpha-project-facts small,.alpha-agent-row-title span{color:var(--dsw-alias-label-tertiary)}.alpha-machine-card{color:var(--dsw-alias-label-primary)}.alpha-machine-card:hover,.alpha-machine-card.is-selected{background:var(--dsw-alias-interactive-bg-hover)}.alpha-machine-card.is-selected{border-color:var(--dsw-alias-label-dimmed);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-machine-status,.alpha-project-dot{background:var(--dsw-alias-label-dimmed)}.alpha-machine-status.is-online,.alpha-project-dot.is-online{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-success-tertiary)}.alpha-detail-status{color:var(--dsw-alias-label-tertiary)}.alpha-detail-status.is-online{color:var(--dsw-alias-state-success-primary)}.alpha-detail-status:before{background:var(--dsw-alias-label-dimmed)}.alpha-detail-status.is-online:before{background:var(--dsw-alias-state-success-primary)}.alpha-inventory-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground);box-shadow:none}.alpha-inventory-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);border-color:var(--dsw-alias-button-info-hover)}.alpha-inventory-card,.alpha-create-project-dialog{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);box-shadow:none}.alpha-description-card textarea,.alpha-project-detail textarea,.alpha-agent-row textarea,.alpha-create-project-dialog textarea,.alpha-create-project-dialog input,.alpha-create-project-dialog select{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.alpha-description-card textarea::placeholder,.alpha-project-detail textarea::placeholder,.alpha-agent-row textarea::placeholder,.alpha-create-project-dialog textarea::placeholder,.alpha-create-project-dialog input::placeholder{color:var(--dsw-alias-label-caption)}.alpha-description-card textarea:focus,.alpha-project-detail textarea:focus,.alpha-agent-row textarea:focus,.alpha-create-project-dialog textarea:focus,.alpha-create-project-dialog input:focus,.alpha-create-project-dialog select:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:none}.alpha-project-row{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}.alpha-project-row:hover,.alpha-project-row.is-selected{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover);box-shadow:none}.alpha-project-row>span:last-child{color:var(--dsw-alias-label-tertiary)}.alpha-inventory-empty{color:var(--dsw-alias-label-tertiary)}.alpha-inventory-empty-card{border-color:var(--dsw-alias-border-l3)}.alpha-inventory-empty-card strong{color:var(--dsw-alias-label-secondary)}.alpha-project-facts>div{color:var(--dsw-alias-state-success-primary)}.alpha-project-facts code{color:var(--dsw-alias-label-secondary)}.alpha-agent-row-title strong{color:var(--dsw-alias-label-primary)}.alpha-inventory-footer{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}.alpha-create-project-panel{background:var(--dsw-alias-bg-mask-2)}.alpha-inventory-backdrop button:focus-visible,.alpha-inventory-backdrop textarea:focus-visible,.alpha-inventory-backdrop input:focus-visible,.alpha-inventory-backdrop select:focus-visible{outline-color:var(--dsw-alias-brand-primary)}`;

    const DSH_INVENTORY_TAB_STYLES = `.alpha-inventory-body{grid-template-rows:auto minmax(0,1fr)}.alpha-inventory-tabs{grid-column:1/-1;display:flex;align-items:center;gap:4px;padding:10px 24px 0;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.alpha-inventory-tabs button{border:0;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;padding:9px 12px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:500 13px var(--dsw-font-family,system-ui,sans-serif)}.alpha-inventory-tabs button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.alpha-inventory-tabs button.is-active{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}.alpha-inventory-body.is-agent-tab .alpha-inventory-detail{grid-column:1/-1}.alpha-inventory-body.is-agent-tab .alpha-inventory-detail{padding-top:24px}.alpha-inventory-body.is-agent-tab .alpha-agent-guide{max-width:880px;margin:0 auto 18px}.alpha-inventory-body.is-agent-tab .alpha-agent-list{gap:10px}.alpha-inventory-body.is-agent-tab .alpha-agent-row{grid-template-columns:190px minmax(0,1fr) auto;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}.alpha-path-picker-field{display:flex;align-items:center;gap:8px}.alpha-path-picker-field input{min-width:0;flex:1}.alpha-directory-picker{display:grid;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.alpha-directory-picker-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.alpha-directory-picker-head>div{display:grid;min-width:0;gap:4px}.alpha-directory-picker-head strong{font-size:13px}.alpha-directory-picker-head code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:11px var(--dsw-font-mono,ui-monospace,monospace)}.alpha-directory-up{justify-self:start;border:0;border-radius:7px;padding:5px 8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:12px var(--dsw-font-family,system-ui,sans-serif)}.alpha-directory-up:hover,.alpha-directory-name:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.alpha-directory-list{display:grid;max-height:220px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}.alpha-directory-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.alpha-directory-row:last-child{border-bottom:0}.alpha-directory-name{display:flex;align-items:center;gap:8px;min-width:0;flex:1;border:0;border-radius:7px;padding:7px 8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;font:13px var(--dsw-font-family,system-ui,sans-serif)}.alpha-directory-name span{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-directory-create{display:flex;gap:8px}.alpha-directory-create input{min-width:0;flex:1}.alpha-directory-create button{flex:none}@media(max-width:680px){.alpha-inventory-tabs{padding:8px 14px 0}.alpha-inventory-body.is-agent-tab .alpha-agent-row{grid-template-columns:1fr}.alpha-path-picker-field{align-items:stretch;flex-direction:column}.alpha-directory-row{align-items:stretch}.alpha-directory-row>.alpha-save-button{align-self:center}}`;

    const LAUNCHER_STYLES = `
.alpha-launcher{position:relative;pointer-events:auto;font-family:var(--dsw-font-family)}.alpha-launcher-button{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 9px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:550 12px var(--dsw-font-family);cursor:pointer}.alpha-launcher-button:hover{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-launcher-button:disabled{color:var(--dsw-alias-label-tertiary);cursor:wait}.alpha-launcher-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);font:600 14px Georgia,serif}.alpha-launcher-error{display:block;margin:4px 8px;color:var(--dsw-alias-state-error-primary);font-size:10px}.alpha-doubao-config-hidden{display:none!important}`;

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
        style.textContent = `${STYLES}\n${INVENTORY_STYLES}\n${DSH_INVENTORY_STYLES}\n${DSH_INVENTORY_TAB_STYLES}\n${LAUNCHER_STYLES}`;
        document.head.append(style);
        const cleanupDoubaoToggle = installDoubaoKnowledgeBaseToggle();
        return () => {
          cleanupDoubaoToggle();
          style.remove();
        };
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
