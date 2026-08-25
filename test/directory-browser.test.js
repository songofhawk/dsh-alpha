const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDirectory, listDirectories } = require("../src/lib/directory-browser");

test("目录浏览只暴露 allowed roots 内的目录，并支持新建目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-alpha-directory-"));
  const child = path.join(root, "existing");
  fs.mkdirSync(child);
  try {
    const roots = listDirectories({ allowedRoots: [root] });
    assert.equal(roots.entries[0].path, root);
    assert.deepEqual(listDirectories({ allowedRoots: [root], currentPath: root }).entries.map((entry) => entry.name), ["existing"]);

    const created = createDirectory({ allowedRoots: [root], parentPath: root, name: "new-project" });
    assert.equal(created.path, path.join(root, "new-project"));
    assert.equal(fs.statSync(created.path).isDirectory(), true);
    assert.throws(() => listDirectories({ allowedRoots: [root], currentPath: path.dirname(root) }), /不在允许根目录内/);
    assert.throws(() => createDirectory({ allowedRoots: [root], parentPath: root, name: "../escape" }), /安全的目录名/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
