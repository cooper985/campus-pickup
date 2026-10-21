const MAX_BYTES = 512 * 1024;
function failure(code, message) { return { ok: false, error: { code, message } }; }

async function handle(event, identity, options = {}) {
  if (!identity || !identity.OPENID) return failure("UNAUTHORIZED", "请从微信小程序发起请求。");
  const image = event && event.imageBase64;
  if (typeof image !== "string" || !image || image.length > Math.ceil(MAX_BYTES / 3) * 4) {
    return failure("INVALID_IMAGE", "请传入不超过 512 KB 的 JPEG 或 PNG 图片。");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)) {
    return failure("INVALID_IMAGE", "图片编码不正确。");
  }
  const bytes = Buffer.from(image, "base64");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (bytes.length > MAX_BYTES || (!png && !jpeg)) return failure("INVALID_IMAGE", "仅支持 JPEG 或 PNG 图片。");
  const mode = options.mode || "mock";
  if (mode !== "mock" && mode !== "real") return failure("CONFIG_ERROR", "识别服务配置异常。");
  if (mode === "real" && !(options.allowedOpenids || []).includes(identity.OPENID)) {
    return failure("FORBIDDEN", "真实识别暂仅对授权测试用户开放。");
  }
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => mode === "mock" ? {
        TextDetections: [
          { DetectedText: "菜鸟驿站（校园北门店）", Confidence: 99 },
          { DetectedText: "取件码：3-2-1024", Confidence: 99 },
          { DetectedText: "请凭取件码到店领取", Confidence: 99 },
        ],
      } : options.recognize(image)),
      new Promise((_, reject) => { timer = setTimeout(() => reject({ code: "TIMEOUT" }), options.timeoutMs || 12000); }),
    ]);
    if (!response || !Array.isArray(response.TextDetections) ||
        !response.TextDetections.every(item => item && typeof item.DetectedText === "string")) {
      return failure("BAD_RESPONSE", "识别服务返回了异常数据。");
    }
    return {
      ok: true, mock: mode === "mock",
      lines: response.TextDetections.map(item => item.DetectedText),
    };
  } catch (err) {
    const code = typeof (err && err.code) === "string" ? err.code : "";
    if (code === "TIMEOUT" || /Timeout/.test(code)) return failure("TIMEOUT", "识别超时，请稍后手动重试。");
    if (/AuthFailure|UnauthorizedOperation|MISSING_CREDENTIALS/.test(code)) return failure("OCR_AUTH", "OCR 运行身份尚未授权，请联系管理员。");
    if (/LimitExceeded|RequestLimitExceeded|ResourceUnavailable/.test(code)) return failure("OCR_UNAVAILABLE", "识别额度或服务暂不可用，请稍后再试。");
    return failure("OCR_FAILED", "识别失败，请稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { handle };
