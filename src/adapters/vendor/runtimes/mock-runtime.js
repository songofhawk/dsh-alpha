function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockRuntime {
  constructor({ delayMs = 10 } = {}) {
    this.provider = "mock";
    this.delayMs = delayMs;
  }

  async *run({ session, project, message, attachments = [], settings, requestApproval }) {
    yield {
      type: "activity",
      payload: {
        message: `Mock agent 已连接 ${project.path}`,
        kind: "status"
      }
    };
    await wait(this.delayMs);

    yield {
      type: "tool_use",
      payload: {
        tool_name: "inspect_project",
        tool_input: {
          path: project.path,
          mode: settings.mode
        }
      }
    };
    await wait(this.delayMs);

    yield {
      type: "tool_result",
      payload: {
        tool_name: "inspect_project",
        content: "项目结构已读取，准备执行用户任务。",
        is_error: false
      }
    };
    await wait(this.delayMs);

    if (
      /approval|权限确认|需要权限/i.test(message) &&
      requestApproval &&
      settings.mode !== "auto-review" &&
      settings.approval_policy !== "never"
    ) {
      const decision = await requestApproval({
        runtime_request_id: `mock-${Date.now()}`,
        kind: "command_execution",
        command: "mock dangerous command",
        cwd: project.path,
        reason: "Mock runtime 请求权限确认",
        available_decisions: ["approved", "rejected"]
      });
      if (decision.status === "cancelled" || decision.decision === "cancel") {
        yield {
          type: "cancelled",
          payload: {
            message: "Mock runtime 权限请求已取消。"
          }
        };
        return;
      }
      if (decision.status !== "approved" && decision.decision !== "approved") {
        const error = new Error("Mock runtime 权限请求被拒绝。");
        error.statusCode = 403;
        throw error;
      }
    }

    if (/browser|浏览器|页面/i.test(message)) {
      yield {
        type: "browser_output",
        payload: {
          title: "Agent Anywhere",
          url: "http://localhost:8787",
          summary: "浏览器输出区域可展示 URL、标题、截图摘要或检查结果。"
        }
      };
      await wait(this.delayMs);
    }

    const summary = [
      `已在 ${session.provider} 会话中接收任务：${message}`,
      attachments.length ? `已接收 ${attachments.length} 张图片。` : "",
      `模型 ${settings.model}，思考强度 ${settings.reasoning_effort}，模式 ${settings.mode}。`
    ].filter(Boolean).join("\n");

    for (const chunk of summary.match(/.{1,18}/g) || [summary]) {
      yield {
        type: "delta",
        payload: {
          text: chunk
        }
      };
      await wait(this.delayMs);
    }

    yield {
      type: "complete",
      payload: {
        message: summary
      }
    };
  }

  async cancelTurn() {
    return {};
  }

  async steerTurn({ message, attachments = [] }) {
    return { accepted: true, message, image_count: attachments.length };
  }

  async listRuntimeSessions({ project, limit = 50 } = {}) {
    return [{
      id: "mock-thread",
      runtime_session_id: "mock-thread",
      title: "Mock runtime session",
      cwd: project?.path || "",
      provider: this.provider
    }].slice(0, limit);
  }

  async readRuntimeSession({ runtimeSessionId, includeTurns = true } = {}) {
    return {
      thread: {
        id: runtimeSessionId || "mock-thread",
        title: "Mock runtime session"
      },
      turns: includeTurns ? [] : undefined
    };
  }
}

module.exports = {
  MockRuntime
};
