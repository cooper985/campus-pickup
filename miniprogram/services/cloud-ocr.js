const MAX_BYTES = 512 * 1024;

function readImage(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath, encoding: "base64",
      success: result => resolve(result.data),
      fail: () => reject(new Error("无法读取图片，请重新选择。")),
    });
  });
}

function byteLength(base64) {
  return base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

async function recognize(imagePath) {
  let imageBase64 = await readImage(imagePath);
  if (byteLength(imageBase64) > MAX_BYTES) {
    const compressed = await new Promise((resolve, reject) => {
      wx.compressImage({
        src: imagePath, quality: 70,
        success: resolve,
        fail: () => reject(new Error("图片压缩失败，请裁剪后重新选择。")),
      });
    });
    imageBase64 = await readImage(compressed.tempFilePath);
  }
  if (byteLength(imageBase64) > MAX_BYTES) {
    throw new Error("图片压缩后仍超过 512 KB，请裁剪到取件信息区域后重试。");
  }
  if (!/^(iVBORw0KGgo|\/9j\/)/.test(imageBase64)) {
    throw new Error("仅支持 JPEG 或 PNG 图片，请转换格式后重试。");
  }
  let response;
  try {
    response = await wx.cloud.callFunction({
      name: "recognizePickup", data: { imageBase64 }, config: { timeout: 20000 },
    });
  } catch (_) {
    throw new Error("云服务连接失败，请检查网络及云函数部署状态。");
  }
  const result = response && response.result;
  if (result && result.ok === false) {
    throw new Error(result.error && result.error.message || "识别失败，请稍后重试。");
  }
  if (!result || result.ok !== true || typeof result.mock !== "boolean" ||
      !Array.isArray(result.lines) || !result.lines.every(line => typeof line === "string")) {
    throw new Error("云服务返回结果异常，请稍后重试。");
  }
  return result;
}

module.exports = { recognize };
