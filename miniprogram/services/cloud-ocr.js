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
  const timing = (stage, started, code, metrics = {}) => log(stage, started, code, { ...metrics, traceId: control.traceId });
  async function measure(stage, work) {
    control.check();
    if (control.stage) control.stage(stage);
    const started = Date.now();
    try { const value = await work(); timing(stage, started); control.check(); return value; }
    catch (err) { timing(stage, started, err && err.code || "OCR_FAILED"); throw err; }
  }
  const prepareStarted = Date.now();
  control.check();
  // Inspect size without materializing the original image as a large JS string.
  const info = await measure("image_stat", () => new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({ filePath: imagePath,
      success: resolve, fail: () => reject(error("IMAGE_READ")) });
  }));
  timing("image_size", prepareStarted, "OK", { imageBytes: info.size });
  let preparedPath = imagePath;
  if (info.size > MAX_BYTES) {
    const compressed = await measure("image_compress", () => new Promise((resolve, reject) => {
      wx.compressImage({
        src: imagePath, quality: 70,
        success: resolve,
        fail: () => reject(error("IMAGE_COMPRESS")),
      });
    }));
    control.check();
    preparedPath = compressed.tempFilePath;
  }
  const imageBase64 = await measure(preparedPath === imagePath ? "image_read" : "compressed_read", () => readImage(preparedPath));
  if (byteLength(imageBase64) > MAX_BYTES) {
    throw error("IMAGE_TOO_LARGE");
  }
  if (!/^(iVBORw0KGgo|\/9j\/)/.test(imageBase64)) {
    throw error("UNSUPPORTED_IMAGE");
  }
  timing("image_prepare", prepareStarted, "OK", { imageBytes: byteLength(imageBase64), base64Chars: imageBase64.length,
    requestBytes: imageBase64.length + '{"imageBase64":""}'.length });
  control.check();
  let response;
  const cloudStarted = Date.now();
  if (control.stage) control.stage("cloud_roundtrip");
  try {
    response = await wx.cloud.callFunction({
      name: "recognizePickup", data: { imageBase64 },
    });
  } catch (err) {
    const message = err && err.errMsg || "";
    const code = /timeout|timed out|time.?limit|超时/i.test(message) ? "TIMEOUT"
      : /network|网络/i.test(message) ? "NETWORK_FAILED" : "CLOUD_FAILED";
    timing("cloud_roundtrip", cloudStarted, code);
    throw Object.assign(error(code), { origin: "cloud_call", sdkCode: Number.isInteger(err && err.errCode) ? err.errCode : null });
  }
  const roundtripMs = Date.now() - cloudStarted;
  timing("cloud_roundtrip", cloudStarted);
  const result = response && response.result;
  const ocrMs = result && result.timings && result.timings.ocrMs;
  if (Number.isFinite(ocrMs) && ocrMs >= 0 && ocrMs <= roundtripMs) {
    // Residual includes cold start / serialization / dispatch, not pure network latency.
    timing("cloud_breakdown", cloudStarted, "OK", { ocrMs, overheadMs: roundtripMs - ocrMs });
  }
  try { control.check(); }
  catch (err) { timing("cloud_late_result", cloudStarted, "CANCELLED"); throw err; }
  if (result && result.ok === false) {
    throw Object.assign(error(result.error && result.error.code), { origin: "cloud_result" });
  }
  if (!result || result.ok !== true || typeof result.mock !== "boolean" ||
      !Array.isArray(result.lines) || !result.lines.every(line => typeof line === "string")) {
    throw error("BAD_RESPONSE");
  }
  return result;
}

module.exports = { recognize };
