const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { checkImageBatch, encodeImages, materializeImages, MAX_IMAGE_BYTES } = require("../src/lib/image-attachments");
const { createLocalAgentAdapter } = require("../src/lib/adapters");

const bytes = Buffer.from("test-image-content");
const image = { attachmentId: "test-image", mediaType: "image/png", bytes: bytes.length };
const readImage = async () => ({ ref: image, data: bytes });

test("图片编码保留顺序和已有目标路径，读取失败明确传播", async () => {
  const files = await encodeImages([{ path: "/worker/existing.png" }, { image }], readImage);
  assert.deepEqual(files[0], { path: "/worker/existing.png" });
  assert.equal(files[1].data, bytes.toString("base64"));
  assert.ok(!files[1].path);
  await assert.rejects(encodeImages([{ image }], null), /存储服务不可用/);
  await assert.rejects(encodeImages([{ image }], async () => { throw new Error("宿主图片已损坏"); }), /已损坏/);
  await assert.rejects(encodeImages([{ image }], async () => ({ data: Buffer.from("wrong") })), /大小.*不一致/);
});

test("图片大小、数量和格式在分配解码缓冲区前受限", () => {
  assert.throws(() => checkImageBatch([{ ...image, bytes: MAX_IMAGE_BYTES + 1 }]), /5 MiB/);
  assert.throws(() => checkImageBatch(Array(21).fill(image)), /20 张/);
  for (const mediaType of ["image/svg+xml", "__proto__", "toString"]) {
    assert.throws(() => checkImageBatch([{ ...image, mediaType }]), /格式/);
  }
});

test("传输损坏、大小不符和非规范 base64 均拒绝落地", async () => {
  const [wire] = await encodeImages([{ image }], readImage);
  for (const changed of [{ sha256: "bad" }, { bytes: image.bytes + 1 }, { data: `${wire.data}\n` }]) {
    assert.throws(() => materializeImages([{ ...wire, ...changed }]), /校验失败/);
  }
});

test("多图中途失败会删除本批已创建的临时文件", async (t) => {
  const files = [];
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => { files.push(file); return write(file, ...args); });
  const [wire] = await encodeImages([{ image }], readImage);
  assert.throws(() => materializeImages([wire, { ...wire, sha256: "bad" }]), /校验失败/);
  assert.equal(files.length, 1);
  assert.equal(fs.existsSync(files[0]), false);
});

test("本机 adapter 在 runtime 抛错或消费方提前停止时清理图片", async () => {
  const attachments = await encodeImages([{ image }], readImage);
  for (const fails of [false, true]) {
    const adapter = createLocalAgentAdapter("mock");
    let file;
    adapter.runtime.run = async function* (context) {
      file = context.attachments[0].path;
      assert.deepEqual(fs.readFileSync(file), bytes);
      if (fails) throw new Error("runtime failed");
      yield { type: "activity", payload: {} };
    };
    const run = async () => { for await (const _event of adapter.runTurn({ attachments })) break; };
    if (fails) await assert.rejects(run(), /runtime failed/);
    else await run();
    assert.equal(fs.existsSync(file), false);
  }
});
