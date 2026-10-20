const ocr = require("../../services/mock-ocr");
const cloudOcr = require("../../services/cloud-ocr");
const MAX_BYTES = 5 * 1024 * 1024;

Page({
  data: { imagePath: "", loading: false, choosing: false, lines: [], error: "", completed: false, mock: true, cloudResult: false },
  async chooseImage() {
    if (this.data.loading || this.data.choosing) return;
    this.setData({ choosing: true, error: "" });
    try {
      const result = await wx.chooseImage({
        count: 1, sizeType: ["original"], sourceType: ["album"],
      });
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.path || !Number.isFinite(file.size) || file.size <= 0) {
        throw new Error("无法读取图片，请重新选择。");
      }
      if (file.size > MAX_BYTES) throw new Error("图片超过 5 MB，请先裁剪或压缩。");
      this.setData({ imagePath: file.path, lines: [], completed: false });
    } catch (err) {
      if (!/cancel/i.test((err && err.errMsg) || "")) {
        this.setData({ error: err instanceof Error ? err.message : "无法打开相册，请检查相册权限后重试。" });
      }
    } finally {
      this.setData({ choosing: false });
    }
  },
  previewImage() {
    if (this.data.imagePath) {
      wx.previewImage({
        current: this.data.imagePath, urls: [this.data.imagePath],
        fail: () => this.setData({ error: "预览失败，请重新选择图片。" }),
      });
    }
  },
  async recognize() {
    return this.runRecognition(false);
  },
  async recognizeCloud() {
    return this.runRecognition(true);
  },
  async runRecognition(useCloud) {
    if (!this.data.imagePath || this.data.loading || this.data.choosing) return;
    this.setData({ loading: true, error: "", lines: [], completed: false });
    try {
      const result = await (useCloud ? cloudOcr.recognize(this.data.imagePath) : ocr.recognize());
      if (!result || typeof result.mock !== "boolean" || !Array.isArray(result.lines) ||
          !result.lines.every(line => typeof line === "string")) {
        throw new Error("识别结果格式异常，请重试。");
      }
      this.setData({ lines: result.lines, completed: true, mock: result.mock, cloudResult: useCloud });
    } catch (err) {
      this.setData({ error: err && err.message || "识别失败，请重试。" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
