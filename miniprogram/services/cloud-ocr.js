const { error, log } = require("./recognition-task");
const MAX_BYTES = 512 * 1024;

function readImage(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath, encoding: "base64",
      success: result => resolve(result.data),
      fail: () => reject(error("IMAGE_READ")),
    });
  });
}

function byteLength(base64) {
  return base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

async function recognize(imagePath, control = { check() {}, stage() {} }) {
  async function measure(stage, work) {
    control.check();
    if (control.stage) control.stage(stage);
    const started = Date.now();
    try { const value = await work(); log(stage, started); control.check(); return value; }
    catch (err) { log(stage, started, err && err.code || "OCR_FAILED"); throw err; }
  }
  const prepareStarted = Date.now();
  control.check();
  let imageBase64 = await measure("image_read", () => readImage(imagePath));
  control.check();
  if (byteLength(imageBase64) > MAX_BYTES) {
    const compressed = await measure("image_compress", () => new Promise((resolve, reject) => {
      wx.compressImage({
        src: imagePath, quality: 70,
        success: resolve,
        fail: () => reject(error("IMAGE_COMPRESS")),
      });
    }));
    control.check();
    imageBase64 = await measure("compressed_read", () => readImage(compressed.tempFilePath));
    control.check();
  }
  if (byteLength(imageBase64) > MAX_BYTES) {
    throw error("IMAGE_TOO_LARGE");
  }
  if (!/^(iVBORw0KGgo|\/9j\/)/.test(imageBase64)) {
    throw error("UNSUPPORTED_IMAGE");
  }
  log("image_prepare", prepareStarted);
  control.check();
  let response;
  const cloudStarted = Date.now();
  if (control.stage) control.stage("cloud_roundtrip");
  try {
    response = await wx.cloud.callFunction({
      name: "recognizePickup", data: { imageBase64 }, config: { timeout: 20000 },
    });
  } catch (err) {
    const message = err && err.errMsg || "";
    const code = /timeout|timed out|time.?limit|超时/i.test(message) ? "TIMEOUT"
      : /network|网络/i.test(message) ? "NETWORK_FAILED" : "CLOUD_FAILED";
    log("cloud_roundtrip", cloudStarted, code);
    throw error(code);
  }
  log("cloud_roundtrip", cloudStarted);
  control.check();
  const result = response && response.result;
  if (result && result.ok === false) {
    throw error(result.error && result.error.code);
  }
  if (!result || result.ok !== true || typeof result.mock !== "boolean" ||
      !Array.isArray(result.lines) || !result.lines.every(line => typeof line === "string")) {
    throw error("BAD_RESPONSE");
  }
  return result;
}

module.exports = { recognize };
