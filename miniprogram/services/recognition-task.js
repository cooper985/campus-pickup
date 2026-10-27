// Waiting is cancellable; wx.cloud.callFunction itself is not aborted.
const PREPARE_TIMEOUT_MS = 15000;
// Roundtrip includes upload, cold start and download, not just the function's 20s execution.
const WAIT_TIMEOUT_MS = 60000;
const SLOW_AFTER_MS = 8000;
const CLOUD_ENV = "cloud1-d8g3dicam66594fcf";
const DIAGNOSTIC_BUILD = "20261027-v303-detail";
// Enable locally for device measurements; release builds never log timings.
const PERFORMANCE_TIMING = false;
// Memory only; one batch plus retries, never persist screenshot or OCR content.
const events = [];
const stages = new Set(["image_prepare", "image_stat", "image_size", "image_read", "image_compress", "compressed_read",
  "fileid_preflight", "fileid_upload", "fileid_call", "fileid_cleanup", "fileid_read", "fileid_delete", "fileid_ocr", "selection_total", "cloud_submit", "cloud_roundtrip", "cloud_return", "cloud_result", "cloud_breakdown", "cloud_late_result", "text_parse", "image_total", "queue_wait", "batch_hash", "batch_finalize", "batch_total"]);
const messages = {
  IMAGE_READ: "无法读取图片，请重新选择。",
  IMAGE_COMPRESS: "图片压缩失败，请裁剪后重新选择。",
  IMAGE_TOO_LARGE: "图片压缩后仍超过 512 KB，请裁剪到取件信息区域后重试。",
  UNSUPPORTED_IMAGE: "仅支持 JPEG 或 PNG 图片，请转换格式后重试。",
  WAIT_TIMEOUT: "识别超时，点击重试",
  SKIPPED: "已跳过此图",
  CANCELLED: "已取消此图",
  CLOUD_FAILED: "云服务连接失败，请检查网络及云函数部署状态。",
  NETWORK_FAILED: "网络异常，请检查网络后手动重试。",
  OCR_FAILED: "OCR 调用失败，请稍后手动重试。",
  TIMEOUT: "OCR 服务处理超时，请手动重试。",
  OCR_AUTH: "OCR 运行身份尚未授权，请联系管理员。",
  OCR_UNAVAILABLE: "识别额度或服务暂不可用，请稍后再试。",
  BAD_RESPONSE: "识别服务返回数据异常，请手动重试。",
  INVALID_IMAGE: "图片格式或大小不符合要求，请裁剪后重试。",
  FORBIDDEN: "真实识别暂仅对授权测试用户开放。",
  UNAUTHORIZED: "请从微信小程序发起请求。",
  CONFIG_ERROR: "识别服务配置异常。",
};
const known = code => typeof code === "string" && Object.prototype.hasOwnProperty.call(messages, code);
function error(code) { return Object.assign(new Error(known(code) ? messages[code] : messages.OCR_FAILED), { code: known(code) ? code : "OCR_FAILED" }); }
function isDevelopment() {
  try { return wx.getAccountInfoSync().miniProgram.envVersion === "develop"; }
  catch (_) { return false; }
}
function log(stage, started, code = "OK", metrics = {}) {
  if (!isDevelopment()) return;
  if (!stages.has(stage)) return;
  if (!PERFORMANCE_TIMING && ["batch_hash", "batch_finalize", "batch_total"].includes(stage)) return;
  const safe = {};
  for (const key of ["traceId", "imageBytes", "imageCount", "base64Chars", "requestBytes", "ocrMs", "overheadMs", "selectedToResultMs", "recordCount", "uncertainCount"]) {
    if (Number.isFinite(metrics[key]) && metrics[key] >= 0) safe[key] = metrics[key];
  }
  for (const key of ["serverDeleted", "clientDeleted", "cleanupPending"]) if (typeof metrics[key] === "boolean") safe[key] = metrics[key];
  if (["ocr_empty", "no_valid_code", "candidate_unparsed", "code_found"].includes(metrics.parseReason)) safe.parseReason = metrics.parseReason;
  if (Number.isInteger(metrics.sdkCode)) safe.sdkCode = metrics.sdkCode;
  if (["client", "client_wait", "cloud_call", "cloud_result"].includes(metrics.origin)) safe.origin = metrics.origin;
  if (stages.has(metrics.phase)) safe.phase = metrics.phase;
  if (["polling_timeout", "function_timeout", "request_timeout", "network", "other"].includes(metrics.errorKind)) safe.errorKind = metrics.errorKind;
  if (typeof metrics.requestId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(metrics.requestId)) safe.requestId = metrics.requestId;
  const event = { stage, ms: Math.max(0, Date.now() - started), type: code === "OK" || known(code) ? code : "OCR_FAILED", ...safe };
  events.push({ atMs: Date.now(), ...event });
  if (events.length > 256) events.shift();
  console.info("[pickup-timing]", event);
}
function diagnostic(traceId) {
  if (!isDevelopment()) return null;
  let platform = "unknown", SDKVersion = "unknown", wechatVersion = "unknown";
  try {
    const device = wx.getDeviceInfo(), base = wx.getAppBaseInfo();
    if (["android", "ios", "devtools", "windows", "mac", "ohos"].includes(device.platform)) platform = device.platform;
    if (/^\d+(?:\.\d+){1,3}$/.test(base.SDKVersion)) SDKVersion = base.SDKVersion;
    if (/^\d+(?:\.\d+){1,3}$/.test(base.version)) wechatVersion = base.version;
  } catch (_) { /* Older base libraries may not expose these APIs. */ }
  return { build: DIAGNOSTIC_BUILD, env: CLOUD_ENV, function: "recognizePickup", envVersion: "develop", platform, SDKVersion, wechatVersion,
    prepareTimeoutMs: PREPARE_TIMEOUT_MS, waitTimeoutMs: WAIT_TIMEOUT_MS,
    readIncludesBase64Encoding: !events.some(event => event.traceId === traceId && event.stage === "fileid_preflight"), requestBytesScope: "data_json_without_sdk_envelope",
    events: events.filter(event => event.traceId === traceId).map(event => ({ ...event })) };
}
function start(work, timeoutMs, onStage = () => {}, onSlow = () => {}) {
  let active = true, timer, slowTimer, rejectWait, phase = "image_prepare", phaseStarted = Date.now();
  const stage = value => {
    check(); phase = value; phaseStarted = Date.now(); onStage(value);
    if (value === "cloud_roundtrip" && timeoutMs === undefined) {
      clearTimeout(timer); timer = setTimeout(() => stop("WAIT_TIMEOUT"), WAIT_TIMEOUT_MS);
    }
  };
  const check = () => { if (!active) throw error("CANCELLED"); };
  const stopped = new Promise((_, reject) => { rejectWait = reject; });
  const stop = code => {
    if (!active) return;
    active = false;
    for (const listener of stopListeners) {
      try { Promise.resolve(listener()).catch(() => {}); } catch (_) {}
    }
    log(phase, phaseStarted, code, { traceId: control.traceId, origin: "client_wait", phase });
    rejectWait(Object.assign(error(code), { origin: "client_wait", phase }));
  };
  timer = setTimeout(() => stop("WAIT_TIMEOUT"), timeoutMs === undefined ? PREPARE_TIMEOUT_MS : timeoutMs);
  slowTimer = setTimeout(() => { if (active) onSlow(); }, SLOW_AFTER_MS);
  const stopListeners = new Set();
  let result;
  const control = { check, stage, onStop(callback) { stopListeners.add(callback); return () => stopListeners.delete(callback); } };
  try { result = work(control); } catch (err) { result = Promise.reject(err); }
  const promise = Promise.race([result, stopped]).then(value => { check(); return value; }).finally(() => { active = false; stopListeners.clear(); clearTimeout(timer); clearTimeout(slowTimer); });
  // Keep the physical request slot until the underlying call settles, even after a UI timeout.
  const settled = Promise.resolve(result).then(() => {}, () => {});
  return { promise, settled, cancel: (code = "CANCELLED") => stop(code) };
}
module.exports = { start, error, log, diagnostic, isDevelopment, CLOUD_ENV, WAIT_TIMEOUT_MS, PREPARE_TIMEOUT_MS, SLOW_AFTER_MS, PERFORMANCE_TIMING };
