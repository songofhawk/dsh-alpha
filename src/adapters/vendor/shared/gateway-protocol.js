// vendored from agent-anywhere src/shared/gateway-protocol.js（出处见 shared/README.md）。
// dsh-alpha 扩展：HELLO/HELLO_ACK（worker 连接后的机器注册握手）。

const GatewayMessageType = Object.freeze({
  APPROVAL_DECISION: "approval_decision",
  APPROVAL_REQUEST: "approval_request",
  ERROR: "error",
  HEARTBEAT: "heartbeat",
  HELLO: "hello",
  HELLO_ACK: "hello_ack",
  REQUEST: "request",
  RESPONSE: "response",
  RUN_REPLAY: "run_replay",
  STREAM_COMPLETE: "stream_complete",
  STREAM_ERROR: "stream_error",
  STREAM_EVENT: "stream_event"
});

const GatewayRequestMethod = Object.freeze({
  CANCEL_TURN: "cancel_turn",
  DISCOVER_PROJECTS: "discover_projects",
  DISCOVER_CAPABILITIES: "discover_capabilities",
  LIST_RUNTIME_SESSIONS: "list_runtime_sessions",
  PROVISION_PROJECT: "provision_project",
  READ_PROJECT_FILE: "read_project_file",
  READ_RUNTIME_SESSION: "read_runtime_session",
  RUN: "run",
  STEER_TURN: "steer_turn"
});

module.exports = {
  GatewayMessageType,
  GatewayRequestMethod
};
