# Stop Memorizing Machines: dsh-alpha Turns Multi-Agent Work into One Control Plane

> One master, one global inventory, and one recoverable task path. dsh-alpha lets DSH route coding work across Codex, Claude Code, Kimi Code, ZCode, OpenCode, Qoder, and WorkBuddy—with the machine, workspace, and permissions kept visible.

When there is one coding agent and one copy of a repository, the workflow is easy: open a terminal, change into the directory, and ask for the work.

Real projects rarely stay that simple. Product code lives on a laptop, the complete toolchain lives on a build host, a GPU machine is better for visual work, and an internal environment may be the only place that can reach a test service. Meanwhile, different agents have different strengths, models, approval flows, and usage limits.

The hard part is no longer starting another agent. It is answering four operational questions: Which machine should receive the task? Which runtime should execute it? Which directory is safe on that machine? If the connection breaks, how does the work continue?

dsh-alpha provides a lightweight control plane for those decisions.

## From machine paths to a global workspace

dsh-alpha does not treat the master's absolute path as project truth. Each Worker reports only the workspaces inside its configured allowed roots. The master then groups locations by canonical Git repository identity, so the same repository can appear as one logical project even when every machine stores it at a different path.

That separation removes one of the most common cross-machine failures: sending Machine A's local path to Machine B. The user selects a project; the Worker resolves that project to its own safe path. If the selected Worker does not have the repository yet, an on-demand clone can land only inside the Worker's allowed root.

## Keep routing decisions visible

The Alpha control directory brings machines, projects, and Agent guidance into one view. You can record what a machine is good for, document project-specific constraints, and describe the best use cases for each Agent type. Those notes become visible decision context, not hidden scheduler magic.

Every turn can also choose a Worker Agent, model, reasoning effort, and permission mode. Leave routing automatic when flexibility matters; pin it when determinism matters. The decision stays inside the current conversation instead of being scattered across terminals and remote sessions.

## A task path that can actually recover

Dispatch is not a fire-and-forget RPC. `dispatch_task` returns a durable task ID, while `wait_task` follows progress and results through an event stream. Interrupting the wait does not cancel the Worker. The same task ID can resume observation later; only an explicit stop propagates cancellation.

Approvals travel back through the same path. When a Worker needs permission, Alpha surfaces the unresolved request in the active session so the user can approve or reject it. A remote process no longer has to hang forever somewhere invisible. Workers reconnect after transient failures and replay missing events.

## Safety is part of the architecture

dsh-alpha fails closed by default. A Gateway cannot start without authentication tokens. Local and remote paths must pass explicit allowed-root checks. Health endpoints reveal liveness and Worker counts, not machine identities or secrets. Worker doctor performs read-only validation and never prints the token.

The project also preserves each provider's own security model. Codex, Claude Code, Kimi Code, and other runtimes still need to be installed, authenticated, and governed on the machine that runs them. dsh-alpha connects selection, routing, events, approval, and recovery; it does not bypass existing controls.

## Who is it for?

- teams or individuals using several coding agents for different kinds of work;
- environments spread across laptops, remote hosts, and dedicated build machines;
- repositories checked out at different paths on different systems;
- workflows that need approval, cancellation, and reconnect behavior in one conversation;
- users who want visual control in DSH Web and a path toward headless automation.

## Start with one Worker

You do not need to build a fleet on day one. Install dsh-alpha in DSH Web, configure one remote Worker with a narrow allowed root, and run Worker doctor for a read-only check. Verify inventory discovery, Agent capabilities, and result delivery before adding the next machine.

dsh-alpha is still evolving quickly, but its core loop is already in place: discover, choose, dispatch, approve, and recover. It is not trying to declare one coding agent the winner. It asks a more practical engineering question: how can different agents collaborate on the right machine, in the right project, inside explicit permission boundaries?

Project site: https://songofhawk.github.io/dsh-alpha/en/

GitHub: https://github.com/songofhawk/dsh-alpha
