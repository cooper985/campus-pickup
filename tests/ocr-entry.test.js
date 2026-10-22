const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { handle } = require("../cloudfunctions/recognizePickup/handler");
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("真实适配器每次读取临时凭证，调用固定接口和区域", async () => {
  const env = { OCR_MODE: "real", OCR_ALLOWED_OPENIDS: "test-user",
    TENCENTCLOUD_SECRETID: "fake-id", TENCENTCLOUD_SECRETKEY: "fake-key", TENCENTCLOUD_SESSIONTOKEN: "fake-token" };
  const seen = [];
  const exports = {};
  vm.runInNewContext(fs.readFileSync("cloudfunctions/recognizePickup/index.js", "utf8"), {
    exports, process: { env }, require(name) {
      if (name === "./handler") return { handle };
      if (name === "./storage-probe") return require("../cloudfunctions/recognizePickup/storage-probe");
      if (name === "wx-server-sdk") return { DYNAMIC_CURRENT_ENV: "test", init() {}, getWXContext: () => ({ OPENID: "test-user" }) };
      assert.equal(name, "tencentcloud-sdk-nodejs-ocr");
      return { ocr: { v20181119: { Client: class {
        constructor(config) { seen.push(config); }
        async GeneralBasicOCR(params) { assert.equal(params.ImageBase64, imageBase64); return { TextDetections: [] }; }
      } } } };
    },
  });
  assert.equal((await exports.main({ action: "identity", openid: "forged" })).openid, "test-user");
  assert.equal(seen.length, 0);
  assert.equal((await exports.main({ action: "storageProbe", check: true })).error.code, "CONFIG_ERROR");
  assert.equal(seen.length, 0);
  env.OCR_STORAGE_PROBE_READY = "1"; env.OCR_STORAGE_PROBE_BUCKET = "test-bucket";
  assert.equal((await exports.main({ action: "storageProbe", check: true })).error.code, "CONFIG_ERROR");
  assert.equal(seen.length, 0);
  assert.equal((await exports.main({ imageBase64 })).ok, true);
  env.TENCENTCLOUD_SESSIONTOKEN = "rotated-token";
  assert.equal((await exports.main({ imageBase64 })).ok, true);
  assert.equal(seen[0].credential.token, "fake-token");
  assert.equal(seen[1].credential.token, "rotated-token");
  assert.equal(seen[0].region, "ap-shanghai");
  assert.equal(seen[0].profile.httpProfile.reqTimeout, 10);
  delete env.TENCENTCLOUD_SESSIONTOKEN;
  assert.equal((await exports.main({ imageBase64 })).error.code, "OCR_AUTH");
  assert.equal(seen.length, 2);
});
