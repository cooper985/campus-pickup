const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createHash } = require("node:crypto");
const task = require("../miniprogram/services/recognition-task");
const { probe } = require("../cloudfunctions/recognizePickup/storage-probe");
const { handle } = require("../cloudfunctions/recognizePickup/handler");
const { page } = require("./helpers/page");
const cases = require("./fixtures/real-ocr-20261021.json");
const privateDir = path.resolve("test-data/private/ocr-regression-20261021");
function load(file, require, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports, require,
    setTimeout, clearTimeout, console: { info() {} }, ...extra });
  return module.exports;
}

test("真实截图字节经 fileID 完整本地回放，原 OCR 返回及解析不退化（不调用云服务）", {
  skip: !fs.existsSync(path.join(privateDir, "prepared-01.jpg")),
}, async () => {
  const files = new Map(), responses = new Map(), logs = [];
  let reads = 0, deletes = 0, ocr = 0, uploads = 0;
  const sdk = { DYNAMIC_CURRENT_ENV: "dynamic", init(config) { assert.equal(config.env, "dynamic"); },
    getWXContext: () => ({ OPENID: "test-user" }),
    downloadFile: async ({ fileID }) => { reads++; return { fileContent: files.get(fileID) }; },
    deleteFile: async ({ fileList }) => { deletes++; files.delete(fileList[0]); return { fileList: [{ status: 0 }] }; } };
  const env = { OCR_MODE: "real", OCR_ALLOWED_OPENIDS: "test-user", OCR_TEMP_BUCKET: "test-bucket", TCB_ENV: task.CLOUD_ENV, TENCENTCLOUD_REGION: "ap-shanghai", TENCENTCLOUD_SECRETID: "fake-id",
    TENCENTCLOUD_SECRETKEY: "fake-key", TENCENTCLOUD_SESSIONTOKEN: "fake-token" };
  for (const c of cases) {
    const bytes = fs.readFileSync(path.join(privateDir, `prepared-0${c.case}.jpg`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), c.preparedImageSha256);
    assert.ok(bytes.length > 50000 && bytes.length <= 512 * 1024);
    responses.set(bytes.toString("base64"), c.result);
  }
  const entry = load("cloudfunctions/recognizePickup/index.js", name => {
    if (name === "wx-server-sdk") return sdk;
    if (name === "./handler") return { handle };
    if (name === "./storage-probe") return { probe };
    assert.equal(name, "tencentcloud-sdk-nodejs-ocr");
    return { ocr: { v20181119: { Client: class {
      async GeneralBasicOCR({ ImageBase64 }) {
        ocr++; const r = responses.get(ImageBase64); assert.ok(r);
        return { TextDetections: r.lines.map((DetectedText, i) => {
          const b = r.boxes[i];
          return { DetectedText, ItemPolygon: b && { X: b.x, Y: b.y, Width: b.width, Height: b.height } };
        }) };
      }
    } } } };
  }, { process: { env } });
  assert.equal((await entry.main({ action: "recognizeFile", check: true })).error.code, "CONFIG_ERROR");
  assert.equal(reads, 0); assert.equal(ocr, 0);
  env.OCR_FILEID_READY = "1";
  env.TENCENTCLOUD_REGION = "ap-guangzhou";
  assert.equal((await entry.main({ action: "recognizeFile", check: true })).error.code, "CONFIG_ERROR");
  env.TENCENTCLOUD_REGION = "ap-shanghai";
  assert.equal((await entry.main({ action: "recognizeFile", check: true })).ok, true);
  const wx = { getFileSystemManager: () => ({ getFileInfo: ({ filePath, success }) => success({ size: fs.statSync(filePath).size }) }),
    compressImage: ({ src, success }) => success({ tempFilePath: path.join(path.dirname(src), `prepared-${path.basename(src)}`) }),
    cloud: {
      uploadFile: async ({ cloudPath, filePath }) => {
        uploads++; const fileID = `cloud://${task.CLOUD_ENV}.test-bucket/${cloudPath}`;
        files.set(fileID, fs.readFileSync(filePath)); return { fileID };
      },
      callFunction: async ({ data }) => {
        assert.ok(!Object.hasOwn(data, "imageBase64")); assert.ok(JSON.stringify(data).length < 300);
        return { result: await entry.main(data) };
      },
      deleteFile: async () => { throw Error("server deletion should suffice"); },
    } };
  const t = { ...task, isDevelopment: () => false, log: (...args) => logs.push(args) };
  const storage = load("miniprogram/services/storage-probe.js", () => t, { wx });
  const fileid = load("miniprogram/services/fileid-ocr.js", name => name === "./storage-probe" ? storage : t);
  const p = page(undefined, undefined, undefined, { "fileid-ocr": fileid, "recognition-task": t });
  p.data.images = cases.map(c => path.join(privateDir, `0${c.case}.jpg`));
  p.imagesSelectedAt = Date.now() - 200;
  await p.runRecognition(true, { shadow: true });
  assert.equal(uploads, cases.length); assert.equal(ocr, cases.length);
  assert.equal(reads, cases.length); assert.equal(deletes, cases.length); assert.equal(files.size, 0);
  for (let i = 0; i < cases.length; i++) {
    for (const [code, station] of cases[i].expected) {
      const record = p.data.drafts.find(r => r.sourceIndices.includes(i) && r.code === code);
      assert.ok(record);
      assert.equal(record.station, station); // Insufficient identity evidence keeps separate source candidates.
    }
  }
  assert.ok(p.data.drafts.some(r => r.code === "603402"));
  assert.ok(p.data.drafts.some(r => r.code === "B3-4-7401"));
  assert.ok(p.data.results.some(r => r.message === "还在运输" && r.state === "done"));
  assert.ok(logs.some(([stage, , , m]) => stage === "selection_total" && m.selectedToResultMs >= 200));
  assert.ok(logs.some(([stage, , , m]) => stage === "image_total" && m.serverDeleted && !m.cleanupPending));
  let failOnce = true;
  const download = sdk.downloadFile;
  sdk.downloadFile = async args => { if (failOnce) { failOnce = false; throw Error("read failed"); } return download(args); };
  await p.runRecognition(true, { shadow: true });
  assert.equal(p.data.results[0].state, "failed");
  assert.equal(p.data.results[0].retained, true);
  assert.ok(p.data.results.slice(1).every(r => r.state === "done"));
  assert.equal(files.size, 0);
  assert.equal(p.data.diagnosticEnabled, false);
});

test("fileID 在 OCR 错误和 OCR 超时时仍执行服务端删除，不触碰其他用户路径", async () => {
  const bytes = Buffer.from([255, 216, 255, 0]); let deletes = 0, calls = 0;
  const options = { envId: task.CLOUD_ENV, ready: true, bucket: "test-bucket", allowedOpenids: ["test-user"],
    cloud: { downloadFile: async () => ({ fileContent: bytes }), deleteFile: async () => { deletes++; return { fileList: [{ status: 0 }] }; } },
    recognize: imageBase64 => handle({ imageBase64 }, { OPENID: "test-user" }, { mode: "real", allowedOpenids: ["test-user"],
      timeoutMs: 2, recognize: async () => { calls++; throw { code: "AuthFailure" }; } }) };
  const fileID = `cloud://${task.CLOUD_ENV}.test-bucket/ocr-probe/test-user/1792636800000-1122334455667788.img`;
  let r = await probe({ fileID }, { OPENID: "test-user" }, options);
  assert.equal(r.ocr.error.code, "OCR_AUTH"); assert.equal(r.serverDeleted, true);
  options.recognize = imageBase64 => handle({ imageBase64 }, { OPENID: "test-user" }, { mode: "real", allowedOpenids: ["test-user"],
    timeoutMs: 2, recognize: () => { calls++; return new Promise(() => {}); } });
  r = await probe({ fileID }, { OPENID: "test-user" }, options);
  assert.equal(r.ocr.error.code, "TIMEOUT"); assert.equal(r.serverDeleted, true);
  assert.equal((await probe({ fileID: fileID.replace("/test-user/", "/another-user/") }, { OPENID: "test-user" }, options)).error.code, "INVALID_FILE");
  assert.equal(deletes, 2); assert.equal(calls, 2);
});

test("取消期间上传迟到仍清理，取消云调用立即兜底删除且不接受迟到 OCR", async () => {
  for (const phase of ["upload", "call"]) {
    let release, cancelled = false, stop, deletes = 0, calls = 0, accepted = 0;
    const prefix = `cloud://${task.CLOUD_ENV}.test-bucket/ocr-probe/test-user/`;
    const pending = new Promise(resolve => { release = resolve; });
    let id;
    const wx = { getFileSystemManager: () => ({ getFileInfo: ({ success }) => success({ size: 235820 }) }), cloud: {
      uploadFile: async ({ cloudPath }) => { id = prefix + cloudPath.split("/").pop(); if (phase === "upload") await pending; return { fileID: id }; },
      callFunction: async ({ data }) => {
        if (data.check) return { result: { protocol: 1, ok: true, openid: "test-user", filePrefix: prefix } };
        calls++; await pending;
        return { result: { protocol: 1, readSucceeded: true, serverDeleted: true, imageBytes: 235820, ocr: { ok: true, mock: false, lines: [] } } };
      },
      deleteFile: async () => { deletes++; return { fileList: [{ status: 0 }] }; },
    } };
    const storage = load("miniprogram/services/storage-probe.js", () => ({ ...task, isDevelopment: () => false }), { wx });
    const running = storage.run("private-path", () => {}, { ocr: true,
      control: { check() { if (cancelled) throw { code: "CANCELLED" }; }, onStop(fn) { stop = fn; } }, onResult() { accepted++; } });
    await new Promise(resolve => setImmediate(resolve));
    cancelled = true; await stop();
    if (phase === "call") assert.equal(deletes, 1);
    release(); const r = await running;
    assert.equal(r.error, "CANCELLED"); assert.equal(r.cleanupPending, false);
    assert.equal(deletes, 1); assert.equal(accepted, 0); assert.equal(calls, phase === "call" ? 1 : 0);
    assert.ok(!JSON.stringify(r).includes("private-path"));
  }
});
