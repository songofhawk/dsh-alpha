const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const tls = require("node:tls");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function acceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}${WS_GUID}`)
    .digest("base64");
}

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header = [];
  header.push(0x81);
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push(
      (payload.length >> 24) & 0xff,
      (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff
    );
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

function decodeFrames(buffer, { maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const messages = [];
  let offset = 0;
  let close = false;
  const controlFrames = [];

  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      payloadLength = high * 2 ** 32 + low;
      headerLength = 10;
    }

    if (!Number.isSafeInteger(payloadLength) || payloadLength > maxPayloadBytes) {
      const error = new Error(`WebSocket frame 超过限制：${payloadLength} > ${maxPayloadBytes}`);
      error.code = "WS_PAYLOAD_TOO_LARGE";
      throw error;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (buffer.length - offset < frameLength) {
      break;
    }

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + payloadLength));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      close = true;
    } else if (opcode === 0x9) {
      controlFrames.push({ opcode: 0x0a, payload });
    }

    offset += frameLength;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
    close,
    controlFrames
  };
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

class WebSocketPeer extends EventEmitter {
  constructor(socket, initialBuffer = Buffer.alloc(0), { maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.maxPayloadBytes = maxPayloadBytes;

    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.closeFromSocket());
    socket.on("error", (error) => this.emit("error", error));
    if (initialBuffer.length > 0) {
      this.handleData(initialBuffer);
    }
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(this.buffer, { maxPayloadBytes: this.maxPayloadBytes });
    } catch (error) {
      this.closed = true;
      this.socket.destroy();
      if (this.listenerCount("error") > 0) this.emit("error", error);
      this.emit("close");
      return;
    }
    this.buffer = decoded.remaining;

    for (const controlFrame of decoded.controlFrames) {
      this.socket.write(encodeControlFrame(controlFrame.opcode, controlFrame.payload));
    }
    for (const message of decoded.messages) {
      this.emit("message", message);
    }
    if (decoded.close) {
      this.close();
    }
  }

  sendJson(payload) {
    this.send(JSON.stringify(payload));
  }

  send(text) {
    if (this.closed || this.socket.destroyed) {
      return;
    }
    this.socket.write(encodeFrame(text));
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.socket.destroyed) {
      this.socket.end(encodeControlFrame(0x8));
    }
    this.emit("close");
  }

  closeFromSocket() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }
}

function upgradeToWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    "\r\n"
  ].join("\r\n"));

  return new WebSocketPeer(socket);
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function connectWebSocket(urlInput, { headers = {} } = {}) {
  const url = new URL(urlInput);
  const secure = url.protocol === "wss:";
  const port = Number(url.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString("base64");
  const extraHeaders = Object.entries(headers).map(([name, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(String(value))) {
      throw new Error(`非法 WebSocket header：${name}`);
    }
    return `${name}: ${value}`;
  });
  const socket = secure
    ? tls.connect({ host: url.hostname, port, servername: url.hostname })
    : net.connect({ host: url.hostname, port });

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("websocket closed before handshake completed"));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const rest = buffer.subarray(headerEnd + 4);
      if (!/^HTTP\/1\.1 101\b/.test(header)) {
        cleanup();
        socket.destroy();
        reject(new Error(`websocket upgrade failed: ${header.split(/\r?\n/)[0]}`));
        return;
      }

      cleanup();
      resolve(new WebSocketPeer(socket, rest));
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on(secure ? "secureConnect" : "connect", () => {
      const path = `${url.pathname}${url.search}`;
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        ...extraHeaders,
        "\r\n"
      ].join("\r\n"));
    });
  });
}

module.exports = {
  DEFAULT_MAX_PAYLOAD_BYTES,
  WebSocketPeer,
  connectWebSocket,
  decodeFrames,
  encodeFrame,
  rejectUpgrade,
  upgradeToWebSocket
};
