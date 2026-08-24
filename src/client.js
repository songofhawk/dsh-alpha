// DSH Web client bundle：仅在 alpha preset 会话的输入栏显示全局工作区选择器。
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

    function AlphaLauncher({ controller }) {
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState("");
      const [state, setState] = React.useState({ loading: false, creating: false, controlCwd: null, workspaces: [], error: "" });
      const rootRef = React.useRef(null);
      const close = React.useCallback(() => setOpen(false), []);
      useOutsideClose(open, rootRef, close);

      const load = React.useCallback(async (search = "") => {
        setState((current) => ({ ...current, loading: true, error: "" }));
        try {
          const value = await controller.call("workspace/list", { query: search });
          setState((current) => ({ ...current, loading: false, controlCwd: value.controlCwd || null, workspaces: value.workspaces || [], error: "" }));
        } catch (error) {
          setState((current) => ({ ...current, loading: false, error: error.message || String(error) }));
        }
      }, [controller]);

      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => load(query), 180);
        return () => clearTimeout(timer);
      }, [open, query, load]);

      const start = async (workspaceId) => {
        setState((current) => ({ ...current, creating: true, error: "" }));
        try {
          if (!state.controlCwd) throw new Error("主控控制目录尚未就绪");
          const sessionId = await controller.createAlphaSession(state.controlCwd);
          if (workspaceId) await controller.call("workspace/select", { sessionId, workspaceId });
          await controller.openSession(sessionId);
          setOpen(false);
        } catch (error) {
          setState((current) => ({ ...current, creating: false, error: error.message || String(error) }));
        }
      };

      return React.createElement("div", { className: "alpha-launcher", ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: "alpha-launcher-button",
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          onClick: () => setOpen((value) => !value)
        }, React.createElement("span", { className: "alpha-launcher-mark", "aria-hidden": true }, "α"), "Alpha 主控"),
        open ? React.createElement("section", { className: "alpha-launcher-panel", role: "dialog", "aria-label": "启动 Alpha 主控" },
          React.createElement("header", null,
            React.createElement("div", null,
              React.createElement("strong", null, "启动 Alpha 主控"),
              React.createElement("small", null, "可直接选择任意机器上的逻辑工作区")
            ),
            React.createElement("button", { type: "button", "aria-label": "关闭", onClick: close }, "×")
          ),
          React.createElement("input", {
            type: "search",
            value: query,
            placeholder: "搜索所有机器的工作区",
            "aria-label": "搜索 Alpha 全局工作区",
            onChange: (event) => setQuery(event.target.value)
          }),
          React.createElement("div", { className: "alpha-ws-options", role: "listbox", "aria-label": "启动 Alpha 的全局工作区" },
            React.createElement("button", {
              type: "button",
              role: "option",
              "aria-selected": false,
              className: "alpha-ws-auto",
              disabled: state.creating,
              onClick: () => start(null)
            }, React.createElement("strong", null, "不预选，根据任务自动判断"), React.createElement("small", null, "创建不绑定主控机目录的 Alpha 会话")),
            state.loading ? React.createElement("p", { className: "alpha-ws-empty" }, "正在汇总机器目录…") : null,
            ...state.workspaces.map((workspace) => React.createElement(WorkspaceChoice, {
              key: workspace.workspaceId,
              workspace,
              selected: false,
              onSelect: start
            }))
          ),
          state.creating ? React.createElement("p", { className: "alpha-ws-empty" }, "正在创建 Alpha 会话…") : null,
          state.error ? React.createElement("p", { className: "alpha-ws-error", role: "alert" }, state.error) : null
        ) : null
      );
    }

    function GlobalWorkspaceControl({ controller, sessionId, useSessions }) {
      const preset = useSessions((snapshot) => snapshot.byId?.[sessionId]?.agentPreset);
      const [state, setState] = React.useState({ loading: false, workspaces: [], selectedWorkspaceId: null, error: "" });
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
        const sync = () => {
          const next = enabled ? document.querySelector('[data-slot="conversation.hero.workspace"]') : null;
          if (next === current) return;
          current?.classList.remove("alpha-workspace-takeover");
          originalTrigger?.classList.remove("alpha-local-workspace-hidden");
          current = next;
          originalTrigger = current?.previousElementSibling?.tagName === "BUTTON" ? current.previousElementSibling : null;
          current?.classList.add("alpha-workspace-takeover");
          originalTrigger?.classList.add("alpha-local-workspace-hidden");
          setHeroTarget(current);
        };
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          current?.classList.remove("alpha-workspace-takeover");
          originalTrigger?.classList.remove("alpha-local-workspace-hidden");
        };
      }, [enabled]);

      const load = React.useCallback(async (search = "") => {
        if (!enabled) return;
        const request = ++requestRef.current;
        setState((current) => ({ ...current, loading: true, error: "" }));
        try {
          const value = await controller.call("workspace/list", { sessionId, query: search });
          if (request !== requestRef.current) return;
          setState({
            loading: false,
            workspaces: value.workspaces || [],
            selectedWorkspaceId: value.selectedWorkspaceId || null,
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

      if (!enabled) return null;
      const selected = state.workspaces.find((workspace) => workspace.workspaceId === state.selectedWorkspaceId);
      const choose = async (workspaceId) => {
        try {
          const value = await controller.call("workspace/select", { sessionId, workspaceId });
          setState((current) => ({
            ...current,
            selectedWorkspaceId: value.workspace?.workspaceId || null,
            error: ""
          }));
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
        React.createElement("span", { className: `alpha-ws-dot ${selected?.available ? "is-online" : ""}` }),
        React.createElement("strong", null, selected?.name || "自动选择工作区"),
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
          React.createElement("div", { className: "alpha-ws-options", role: "listbox", "aria-label": "全局工作区列表" },
            React.createElement("button", {
              type: "button",
              role: "option",
              "aria-selected": state.selectedWorkspaceId === null,
              className: `alpha-ws-auto${state.selectedWorkspaceId === null ? " is-selected" : ""}`,
              onClick: () => choose(null)
            },
            React.createElement("strong", null, "根据任务自动选择"),
            React.createElement("small", null, "Alpha 根据用户表述匹配；歧义时会先询问")),
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
.alpha-ws-panel{position:absolute;z-index:110;left:0;bottom:34px;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;width:min(520px,calc(100vw - 24px));height:min(540px,calc(100dvh - 130px));max-height:540px;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 36px color-mix(in srgb,#000 18%,transparent);overflow:hidden}
.alpha-ws-panel>header{display:flex;align-items:flex-start;justify-content:space-between}.alpha-ws-panel>header>div{display:grid;gap:2px}.alpha-ws-panel>header strong{font-size:13px}.alpha-ws-panel>header small{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-ws-panel>header>button{width:28px;height:28px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.alpha-ws-panel>header>button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.alpha-ws-panel>input{height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px var(--dsw-font-family)}.alpha-ws-panel>input:focus{border-color:#3898ec;box-shadow:0 0 0 2px color-mix(in srgb,#3898ec 20%,transparent)}
.alpha-ws-options{display:grid;align-content:start;gap:5px;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}.alpha-ws-auto,.alpha-ws-choice{display:grid;width:100%;gap:4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}.alpha-ws-auto:hover,.alpha-ws-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}.alpha-ws-auto.is-selected,.alpha-ws-choice.is-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}
.alpha-ws-auto strong,.alpha-ws-choice strong{font-size:12px}.alpha-ws-auto small,.alpha-ws-choice small{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-ws-choice-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.alpha-ws-choice-title small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alpha-ws-locations{display:grid;gap:3px}.alpha-ws-location{display:grid;grid-template-columns:8px minmax(58px,auto) minmax(0,1fr) auto;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}.alpha-ws-location code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font:10.5px var(--dsw-font-family-mono,monospace)}.alpha-ws-location small{font-size:10px}
.alpha-ws-empty{margin:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}.alpha-ws-error{margin:0;padding:7px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11px}
.alpha-ws-control button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-slot="conversation.hero.workspace"].alpha-workspace-takeover>:not(.alpha-hero-workspace-control){display:none!important}.alpha-hero-workspace-control>.alpha-ws-trigger{max-width:320px;height:36px;padding:0 10px 0 8px;border-radius:10px;font-size:16px}.alpha-hero-workspace-control>.alpha-ws-panel{position:fixed;bottom:auto}
.alpha-local-workspace-hidden{display:none!important}
@media(max-width:560px){.alpha-ws-panel,.alpha-hero-workspace-control>.alpha-ws-panel{position:fixed;inset:auto 12px 12px;width:auto;height:min(520px,calc(100dvh - 24px))}.alpha-ws-choice-title{display:grid;gap:2px}.alpha-ws-location{grid-template-columns:8px minmax(50px,auto) minmax(0,1fr)}.alpha-ws-location small{display:none}}`;

    const LAUNCHER_STYLES = `
.alpha-launcher{position:relative;pointer-events:auto;font-family:var(--dsw-font-family)}.alpha-launcher-button{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 9px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:550 12px var(--dsw-font-family);cursor:pointer}.alpha-launcher-button:hover,.alpha-launcher-button[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}.alpha-launcher-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);font:600 14px Georgia,serif}
.alpha-launcher-panel{position:fixed;z-index:140;left:248px;bottom:18px;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;width:min(520px,calc(100vw - 280px));height:min(560px,calc(100dvh - 36px));gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 36px color-mix(in srgb,#000 18%,transparent);overflow:hidden}.alpha-launcher-panel>header{display:flex;justify-content:space-between}.alpha-launcher-panel>header>div{display:grid;gap:2px}.alpha-launcher-panel>header strong{font-size:13px}.alpha-launcher-panel>header small{color:var(--dsw-alias-label-tertiary);font-size:11px}.alpha-launcher-panel>header>button{width:28px;height:28px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.alpha-launcher-panel>input{height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px var(--dsw-font-family)}.alpha-launcher-panel>input:focus{border-color:#3898ec;box-shadow:0 0 0 2px color-mix(in srgb,#3898ec 20%,transparent)}
@media(max-width:760px){.alpha-launcher-panel{left:12px;right:12px;bottom:12px;width:auto}}`;

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
        createAlphaSession: async (controlCwd) => {
          const sessionId = `session-${crypto.randomUUID()}`;
          const listed = await connection.api.workspace.list({});
          if (!listed.result.ok) throw new Error(`${listed.result.error.code}: ${listed.result.error.message}`);
          let controlWorkspace = listed.result.value.items.find((workspace) => workspace.path === controlCwd);
          if (!controlWorkspace) {
            const created = await connection.api.workspace.create({ path: controlCwd });
            if (!created.result.ok) throw new Error(`${created.result.error.code}: ${created.result.error.message}`);
            controlWorkspace = created.result.value.workspace;
          }
          const response = await connection.api.sessions.create({ sessionId, workspaceId: controlWorkspace.workspaceId, agentPreset: "alpha" });
          if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`);
          return response.result.value.sessionId;
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
