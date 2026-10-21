// Waiting is cancellable; wx.cloud.callFunction itself is not aborted.
const PREPARE_TIMEOUT_MS = 15000;
// The SDK already bounds the cloud call at 20s; allow its result/error to arrive before the watchdog.
const WAIT_TIMEOUT_MS = 22000;
const SLOW_AFTER_MS = 8000;
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
function log(stage, started, code = "OK") {
  console.info("[pickup-timing]", { stage, ms: Math.max(0, Date.now() - started), type: code === "OK" || known(code) ? code : "OCR_FAILED" });
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
  const stop = code => { if (active) { active = false; log(phase, phaseStarted, code); rejectWait(Object.assign(error(code), { origin: "client_wait" })); } };
  timer = setTimeout(() => stop("WAIT_TIMEOUT"), timeoutMs === undefined ? PREPARE_TIMEOUT_MS : timeoutMs);
  slowTimer = setTimeout(() => { if (active) onSlow(); }, SLOW_AFTER_MS);
  let result;
  try { result = work({ check, stage }); } catch (err) { result = Promise.reject(err); }
  const promise = Promise.race([result, stopped]).then(value => { check(); return value; }).finally(() => { active = false; clearTimeout(timer); clearTimeout(slowTimer); });
  // Keep the physical request slot until the underlying call settles, even after a UI timeout.
  const settled = Promise.resolve(result).then(() => {}, () => {});
  return { promise, settled, cancel: (code = "CANCELLED") => stop(code) };
}
module.exports = { start, error, log, WAIT_TIMEOUT_MS, PREPARE_TIMEOUT_MS, SLOW_AFTER_MS };
