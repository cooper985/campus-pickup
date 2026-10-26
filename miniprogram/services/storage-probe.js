const { CLOUD_ENV, isDevelopment } = require("./recognition-task");
const MAX_BYTES = 512 * 1024;
const WAIT_MS = 60000;

async function run(imagePath, onStage = () => {}, options = {}) {
  const control = options.control || { check() {} };
  const startedAt = Date.now();
  const action = options.ocr ? "recognizeFile" : "storageProbe";
  if (!options.ocr && !isDevelopment()) throw new Error("仅开发版可验证");
  const report = { build: "20261022-fileid-default-v1", env: CLOUD_ENV, ocrCalls: 0,
    uploadSucceeded: false, fileIdValid: false, functionReturned: false, readSucceeded: false,
    serverDeleted: false, clientDeleted: false, cleanupPending: false, timings: {} };
  let fileID, expectedPrefix, cloudPath;
  const owns = id => typeof id === "string" && id === expectedPrefix + cloudPath.split("/").pop();
  let cleanupPromise;
  function cleanup(id) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = performCleanup(id);
    return cleanupPromise;
  }
  async function performCleanup(id) {
    try {
      const result = await wx.cloud.deleteFile({ fileList: [id], config: { env: CLOUD_ENV } });
      report.clientDeleted = !!(result && result.fileList && result.fileList.length === 1 && result.fileList[0].status === 0);
    } catch (_) { /* Prefix lifecycle is required before enabling the server probe. */ }
    report.cleanupPending = !report.clientDeleted && !report.serverDeleted;
  }
  const unsubscribe = control.onStop && control.onStop(() => fileID ? cleanup(fileID) : undefined);
  async function step(stage, work, onLate) {
    if (stage !== "cleanupMs") control.check();
    let timer, expired = false;
    const started = Date.now();
    report.phase = stage;
    onStage(stage);
    const physical = Promise.resolve().then(work).then(value => {
      if (expired && onLate) Promise.resolve(onLate(value)).catch(() => {});
      return value;
    });
    try {
      return await Promise.race([physical, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject({ code: "PROBE_WAIT_TIMEOUT" }); }, WAIT_MS);
      })]);
    } finally { clearTimeout(timer); report.timings[stage] = Date.now() - started; }
  }
  try {
    // Share readiness only within this batch; the server still authorizes every OCR request.
    const session = options.ocr && options.preflightSession;
    const ready = await step("preflightMs", () => {
      if (session && session.ready) return session.ready;
      const request = wx.cloud.callFunction({ name: "recognizePickup",
        config: { env: CLOUD_ENV }, data: { action, check: true } }).then(preflight => {
        const value = preflight && preflight.result;
        if (!value || value.protocol !== 1 || value.ok !== true) throw { code: options.ocr ? value && value.error && value.error.code || "CONFIG_ERROR" : "PROBE_NOT_READY" };
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.openid) || typeof value.filePrefix !== "string" ||
            !new RegExp(`^cloud://${CLOUD_ENV}\\.[a-z0-9-]+/ocr-probe/${value.openid}/$`).test(value.filePrefix)) throw { code: "PROBE_BAD_RESPONSE" };
        return value;
      });
      if (session) session.ready = request;
      return request;
    });
    report.runtime = {};
    for (const key of ["credentialsComplete", "tokenPresent", "envMatches", "regionMatches"]) {
      if (typeof (ready.runtime && ready.runtime[key]) === "boolean") report.runtime[key] = ready.runtime[key];
    }
    expectedPrefix = ready.filePrefix;
    const preparedPath = await step("prepareMs", async () => {
      const stat = path => new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: path, success: resolve, fail: () => reject({ code: "IMAGE_READ" }) }));
      let prepared = imagePath;
      let info = await stat(imagePath);
      control.check();
      if (info.size > MAX_BYTES) {
        const result = await new Promise((resolve, reject) => wx.compressImage({ src: imagePath, quality: 70, success: resolve, fail: () => reject({ code: "IMAGE_COMPRESS" }) }));
        control.check();
        prepared = result.tempFilePath;
        info = await stat(prepared);
      }
      report.imageBytes = info.size;
      if (!Number.isFinite(report.imageBytes) || report.imageBytes <= 0 || report.imageBytes > MAX_BYTES) throw { code: options.ocr ? "IMAGE_TOO_LARGE" : "INVALID_IMAGE" };
      return prepared;
    });
    const random = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
    cloudPath = `ocr-probe/${ready.openid}/${Date.now()}-${random()}${random()}.img`;
    report.cleanupPending = true;
    report.uploadAtMs = Date.now();
    const uploaded = await step("uploadMs", () => wx.cloud.uploadFile({ cloudPath, filePath: preparedPath, config: { env: CLOUD_ENV } }),
      value => owns(value && value.fileID) ? cleanup(value.fileID) : undefined);
    report.fileIdValid = owns(uploaded && uploaded.fileID);
    if (!report.fileIdValid) throw { code: "PROBE_INVALID_FILE_ID" };
    fileID = uploaded.fileID;
    report.uploadSucceeded = true;
    control.check();
    const data = { action, fileID };
    report.requestBytes = JSON.stringify(data).length;
    report.callAtMs = Date.now();
    const response = await step("callMs", () => wx.cloud.callFunction({ name: "recognizePickup", data, config: { env: CLOUD_ENV } }));
    const result = response && response.result;
    if (!result || result.protocol !== 1) throw { code: "PROBE_BAD_RESPONSE" };
    report.functionReturned = true;
    report.readSucceeded = result.readSucceeded === true && result.imageBytes === report.imageBytes;
    report.serverDeleted = result.serverDeleted === true;
    for (const key of ["readFailure", "deleteFailure"]) {
      const failure = result[key];
      if (failure && ["permission", "credentials", "not_found", "sdk_response", "timeout", "other"].includes(failure.kind)) {
        report[key] = { deniedAction: ["tcb:GetFileDownloadUrl", "tcb:GetDownloadUrl", "tcb:DeleteFile", "tcb:GetFileAuthority"].includes(failure.deniedAction) ? failure.deniedAction : null, serviceCode: typeof failure.serviceCode === "string" && /^[A-Z][A-Z_]{1,63}$/.test(failure.serviceCode) ? failure.serviceCode : null, kind: failure.kind, sdkCode: Number.isInteger(failure.sdkCode) ? failure.sdkCode : null };
      }
    }
    for (const key of ["readMs", "deleteMs"]) if (Number.isFinite(result[key]) && result[key] >= 0) report.timings[key] = result[key];
    if (!report.readSucceeded) throw { code: "PROBE_READ_FAILED" };
    if (options.ocr) {
      control.check();
      report.ocrCalls = result.ocr ? 1 : 0;
      if (!result.ocr || result.ocr.ok !== true) throw { code: result.ocr && result.ocr.error && result.ocr.error.code || result.error && result.error.code || "BAD_RESPONSE" };
      if (Number.isFinite(result.ocr.timings && result.ocr.timings.ocrMs)) report.timings.ocrMs = result.ocr.timings.ocrMs;
      options.onResult(result.ocr);
    }
  } catch (err) {
    report.failedPhase = report.phase;
    const codes = ["PROBE_NOT_READY", "PROBE_BAD_RESPONSE", "PROBE_WAIT_TIMEOUT", "INVALID_IMAGE", "PROBE_INVALID_FILE_ID", "PROBE_READ_FAILED", "CANCELLED", "SKIPPED", "OCR_FAILED", "OCR_AUTH", "OCR_UNAVAILABLE", "TIMEOUT", "BAD_RESPONSE", "FORBIDDEN", "UNAUTHORIZED", "CONFIG_ERROR", "IMAGE_READ", "IMAGE_COMPRESS", "IMAGE_TOO_LARGE", "NETWORK_FAILED", "CLOUD_FAILED"];
    const message = String(err && (err.errMsg || err.message) || "");
    report.error = codes.includes(err && err.code) ? err.code : !options.ocr ? "PROBE_FAILED"
      : /timeout|timed out|time.?limit|超时/i.test(message) ? "TIMEOUT"
        : /network|网络/i.test(message) ? "NETWORK_FAILED" : "CLOUD_FAILED";
    if (Number.isInteger(err && err.errCode)) report.sdkCode = err.errCode;
  } finally {
    if (unsubscribe) unsubscribe();
    if (fileID && !report.serverDeleted) await step("cleanupMs", () => cleanup(fileID)).catch(() => {});
    report.cleanupPending = report.cleanupPending && !report.serverDeleted && !report.clientDeleted;
  }
  report.timings.totalMs = Date.now() - startedAt;
  return report;
}

module.exports = { run };
