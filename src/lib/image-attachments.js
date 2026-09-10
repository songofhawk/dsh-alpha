const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const IMAGE_TRANSFER = "base64-v1";
// Gateway 单帧上限为 8 MiB；为 base64、任务正文与协议字段预留空间。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 20;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function checkImageBatch(images) {
  if (images.length > MAX_IMAGES) throw new Error(`每次最多直派 ${MAX_IMAGES} 张图片`);
  let total = 0;
  for (const image of images) {
    if (!image || !Object.hasOwn(EXTENSIONS, image.mediaType) || !Number.isSafeInteger(image.bytes) || image.bytes <= 0) throw new Error("图片格式或大小无效");
    total += image.bytes;
  }
  if (total > MAX_IMAGE_BYTES) throw new Error("直派图片总大小不能超过 5 MiB");
}

// 持久化只保留宿主引用；由宿主附件服务验证原始元数据与内容摘要。
async function encodeImages(attachments, readImage, signal) {
  checkImageBatch(attachments.filter((item) => item.image).map((item) => item.image));
  const result = [];
  for (const item of attachments) {
    signal?.throwIfAborted();
    if (!item.image) { result.push(item); continue; }
    if (!readImage) throw new Error("宿主图片存储服务不可用");
    const stored = await readImage(item.image, signal);
    signal?.throwIfAborted();
    const data = Buffer.from(stored.data);
    if (data.length !== item.image.bytes) throw new Error("图片大小与宿主引用不一致");
    result.push({
      mediaType: item.image.mediaType,
      bytes: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      data: data.toString("base64")
    });
  }
  return result;
}

// 只在执行机器生成短期文件，文件名不使用上传名称或网络传入路径。
function materializeImages(attachments = []) {
  const images = attachments.filter((item) => item.data !== undefined);
  checkImageBatch(images);
  let directory;
  const dispose = () => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); };
  try {
    const paths = attachments.map((item, index) => {
      if (item.data === undefined) {
        if (item.image) throw new Error("宿主图片引用尚未转换为传输内容");
        return item;
      }
      if (typeof item.data !== "string" || item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("图片编码无效或过大");
      const data = Buffer.from(item.data, "base64");
      const hash = crypto.createHash("sha256").update(data).digest("hex");
      if (data.toString("base64") !== item.data || data.length !== item.bytes || hash !== item.sha256) throw new Error("图片传输校验失败");
      directory ||= fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-images-"));
      const file = path.join(directory, `${index}-${hash}.${EXTENSIONS[item.mediaType]}`);
      fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
      return { path: file };
    });
    return { attachments: paths, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = { IMAGE_TRANSFER, MAX_IMAGE_BYTES, MAX_IMAGES, checkImageBatch, encodeImages, materializeImages };
