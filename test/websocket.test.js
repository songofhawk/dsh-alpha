const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeFrames, DEFAULT_MAX_PAYLOAD_BYTES } = require("../src/adapters/vendor/shared/websocket");

test("decodeFrames 在分配 payload 前拒绝超大 WebSocket frame", () => {
  const declared = DEFAULT_MAX_PAYLOAD_BYTES + 1;
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(declared, 6);
  assert.throws(
    () => decodeFrames(header),
    (error) => error.code === "WS_PAYLOAD_TOO_LARGE" && /超过限制/.test(error.message)
  );
});

test("decodeFrames 仍接受正常文本帧", () => {
  const payload = Buffer.from("hello");
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const decoded = decodeFrames(frame);
  assert.deepEqual(decoded.messages, ["hello"]);
  assert.equal(decoded.remaining.length, 0);
});
