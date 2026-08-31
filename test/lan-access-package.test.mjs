import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { apply, randomUuidPolyfillInjection } from "../packages/dsh-lan-access/lib/index.mjs";

test("LAN access bundle is independently installable", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../packages/dsh-lan-access/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "dsh-lan-access");
  assert.equal(manifest.main, "./lib/index.mjs");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dependencies, undefined);

  const patch = fs.readFileSync(new URL("../packages/dsh-lan-access/cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /id: webserver/);
  assert.match(patch, /host: "0\.0\.0\.0"/);
  assert.match(patch, /port: !!js ctx\.webStartup\.port \?\? 3080/);
  assert.match(patch, /id: dsh-lan-access/);
  assert.match(patch, /name: 'dsh-lan-access'/);
});

test("polyfill is injected before DSH client bootstrap rows", () => {
  let listener;
  apply({
    on(event, callback) {
      assert.equal(event, "webserver/index-inject");
      listener = callback;
    }
  });
  const table = [{ kind: "script", placement: "head", text: "boot" }];
  listener(table);
  assert.deepEqual(table[0], randomUuidPolyfillInjection());
  assert.equal(table[1].text, "boot");
});

test("polyfill mints RFC 4122 version 4 UUIDs from getRandomValues", () => {
  const webCrypto = {
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    }
  };
  vm.runInNewContext(randomUuidPolyfillInjection().text, { crypto: webCrypto, Uint8Array });
  assert.equal(typeof webCrypto.randomUUID, "function");
  assert.equal(webCrypto.randomUUID(), "abababab-abab-4bab-abab-abababababab");
});

test("polyfill preserves native implementations and does not invent weak crypto", () => {
  const native = () => "native";
  const webCrypto = { randomUUID: native };
  vm.runInNewContext(randomUuidPolyfillInjection().text, { crypto: webCrypto, Uint8Array });
  assert.equal(webCrypto.randomUUID, native);

  const context = { Uint8Array };
  vm.runInNewContext(randomUuidPolyfillInjection().text, context);
  assert.equal(context.crypto, undefined);
});
