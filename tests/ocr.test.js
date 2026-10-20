const { test } = require("node:test");
const assert = require("node:assert/strict");
const { handle } = require("../cloudfunctions/recognizePickup/handler");
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const identity = { OPENID: "test-user" };
const event = { imageBase64 };
const real = { mode: "real", allowedOpenids: ["test-user"] };
test("默认模拟结果，不接受客户端切换真实模式", async () => {
  const result = await handle({ ...event, mode: "real" }, identity);
  assert.equal(result.ok, true); assert.equal(result.mock, true); assert.equal(result.lines.length, 3);
});
test("身份来自服务端；拒绝未登录、无效图片、超限图片", async () => {
  assert.equal((await handle({ ...event, OPENID: "forged" }, {})).error.code, "UNAUTHORIZED");
  for (const value of [null, "", "%%%!", "dGV4dA==", "A".repeat(800000)]) {
    assert.equal((await handle({ imageBase64: value }, identity)).error.code, "INVALID_IMAGE");
  }
});
test("真实识别需服务端白名单，未授权时不调用供应商", async () => {
  const result = await handle(event, identity, { mode: "real", recognize: () => assert.fail("must not call") });
  assert.equal(result.error.code, "FORBIDDEN");
});
test("模拟供应商成功、空结果与损坏结果", async () => {
  const success = await handle(event, identity, { ...real, recognize: async image => {
    assert.equal(image, imageBase64); return { TextDetections: [{ DetectedText: "取件码 123" }] };
  } });
  assert.deepEqual(success, { ok: true, mock: false, lines: ["取件码 123"] });
  assert.deepEqual((await handle(event, identity, { ...real, recognize: async () => ({ TextDetections: [] }) })).lines, []);
  assert.equal((await handle(event, identity, { ...real, recognize: async () => ({}) })).error.code, "BAD_RESPONSE");
});
test("超时、授权、额度与未知错误脱敏且不自动重试", async () => {
  for (const [code, expected] of [["AuthFailure.SignatureFailure","OCR_AUTH"], ["ResourceUnavailable.ResourcePackageRunOut","OCR_UNAVAILABLE"], ["unknown","OCR_FAILED"]]) {
    let calls = 0;
    const result = await handle(event, identity, { ...real, recognize: async () => { calls++; throw { code, message: "secret-value" }; } });
    assert.equal(result.error.code, expected); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes("secret-value"));
  }
  const result = await handle(event, identity, { ...real, timeoutMs: 10, recognize: () => new Promise(() => {}) });
  assert.equal(result.error.code, "TIMEOUT");
});
