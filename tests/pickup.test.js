const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("miniprogram/pages/pickup/index.js", "utf8");
function page(wx, recognize = async () => ({ mock: true, lines: ["示例"] })) {
  let result;
  vm.runInNewContext(source, { require: () => ({ recognize }), wx, Page: p => { result = p; } });
  result.setData = function (data) { Object.assign(this.data, data); };
  return result;
}
test("选择一张图片、预览、展示模拟结果", async () => {
  let preview;
  const p = page({
    chooseImage: async options => { assert.equal(options.count, 1); return { tempFiles: [{ path: "local.png", size: 128 }] }; },
    previewImage: options => { preview = options.current; },
  });
  await p.chooseImage(); p.previewImage(); await p.recognize();
  assert.equal(preview, "local.png");
  assert.equal(p.data.completed, true);
  assert.equal(p.data.lines[0], "示例");
  assert.equal(p.data.loading, false);
});
test("取消选图保留原图，超限文件不替换", async () => {
  const wx = { chooseImage: async () => { throw { errMsg: "chooseImage:fail cancel" }; } };
  const p = page(wx); p.data.imagePath = "old.png";
  await p.chooseImage(); assert.equal(p.data.error, ""); assert.equal(p.data.imagePath, "old.png");
  wx.chooseImage = async () => ({ tempFiles: [{ path: "big.png", size: 6 * 1024 * 1024 }] });
  await p.chooseImage(); assert.match(p.data.error, /5 MB/); assert.equal(p.data.imagePath, "old.png");
});
test("未选择图片不调用；重复点击只调用一次；失败可重试", async () => {
  let calls = 0, reject;
  const p = page({}, () => { calls++; return new Promise((_, fail) => { reject = fail; }); });
  await p.recognize(); assert.equal(calls, 0);
  p.data.imagePath = "local.png";
  const pending = p.recognize(); await p.recognize(); assert.equal(calls, 1);
  reject(new Error("network")); await pending;
  assert.equal(p.data.loading, false); assert.equal(p.data.completed, false); assert.ok(p.data.error);
});
test("云端结果明确区分真实识别与模拟模式", async () => {
  const p = page({}, async path => {
    assert.equal(path, "local.png");
    return { mock: false, lines: ["真实文字"] };
  });
  p.data.imagePath = "local.png";
  await p.recognizeCloud();
  assert.equal(p.data.mock, false);
  assert.equal(p.data.cloudResult, true);
  assert.equal(p.data.completed, true);
});
