const mockOcr = require("../../services/mock-ocr");
const cloudOcr = require("../../services/cloud-ocr");
const parser = require("../../services/pickup-parser");
const MAX_BYTES = 5 * 1024 * 1024;

Page({
  data: { images: [], loading: false, choosing: false, error: "", completed: false,
    groups: [], records: [], results: [], progress: "", mock: true, remaining: 0, editing: null },
  async chooseImage() {
    if (this.data.loading || this.data.choosing) return;
    this.setData({ choosing: true, error: "" });
    try {
      const result = await wx.chooseImage({ count: 9, sizeType: ["original"], sourceType: ["album"] });
      const files = result.tempFiles || [];
      if (!files.length || files.some(f => !f.path || !Number.isFinite(f.size) || f.size <= 0)) throw new Error("无法读取图片，请重新选择。");
      if (files.some(f => f.size > MAX_BYTES)) throw new Error("有图片超过 5 MB，请先裁剪或压缩。");
      this.setData({ images: files.slice(0, 9).map(f => f.path), results: [], records: [], groups: [], completed: false, remaining: 0, editing: null });
    } catch (err) {
      if (!/cancel/i.test(err && err.errMsg || "")) this.setData({ error: err.message || "无法打开相册，请重试。" });
    } finally { this.setData({ choosing: false }); }
  },
  previewImage(e) {
    const index = Number(e && e.currentTarget.dataset.index || 0);
    if (this.data.images[index]) wx.previewImage({ current: this.data.images[index], urls: this.data.images });
  },
  recognize() { return this.runRecognition(false); },
  recognizeCloud() { return this.runRecognition(true); },
  async runRecognition(useCloud) {
    if (!this.data.images.length || this.data.loading || this.data.choosing) return;
    this.setData({ loading: true, error: "", completed: false, results: [], records: [], groups: [], editing: null, remaining: 0, mock: !useCloud });
    const results = [], records = [];
    try {
      for (let i = 0; i < this.data.images.length; i++) {
        this.setData({ progress: `正在识别 ${i + 1}/${this.data.images.length}` });
        try {
          const result = await (useCloud ? cloudOcr.recognize(this.data.images[i]) : mockOcr.recognize());
          if (!result || typeof result.mock !== "boolean" || !Array.isArray(result.lines) || !result.lines.every(s => typeof s === "string")) throw new Error("识别结果格式异常。");
          const parsed = parser.parse(result.lines, i).map((r, j) => ({ ...r, id: `p${i}-${j}`, taken: false }));
          records.push(...parsed);
          results.push({ index: i + 1, lines: result.lines, mock: result.mock, error: "", count: parsed.length });
        } catch (err) {
          results.push({ index: i + 1, lines: [], error: err.message || "识别失败，请重试。", count: 0 });
        }
        this.setData({ results: results.slice(), records: records.slice(), groups: parser.group(records), remaining: records.length });
      }
      this.setData({ completed: true, mock: results.some(r => r.mock), progress: "", error: results.some(r => r.error) ? "部分截图识别失败，成功结果已保留。重新识别会重新处理全部截图。" : "" });
    } finally { this.setData({ loading: false }); }
  },
  toggleTaken(e) {
    const records = this.data.records.map(r => r.id === e.currentTarget.dataset.id ? { ...r, taken: !r.taken } : r);
    this.updateRecords(records);
  },
  updateRecords(records) {
    this.setData({ records, groups: parser.group(records), remaining: records.filter(r => !r.taken).length });
  },
  editRecord(e) {
    const record = this.data.records.find(r => r.id === e.currentTarget.dataset.id);
    if (record) this.setData({ editing: { ...record } });
  },
  editStation(e) { this.setData({ "editing.station": e.detail.value }); },
  editCode(e) { this.setData({ "editing.code": e.detail.value }); },
  cancelEdit() { this.setData({ editing: null }); },
  saveEdit() {
    const edit = this.data.editing;
    if (!edit || !edit.station.trim() || !edit.code.trim()) return;
    this.updateRecords(this.data.records.map(r => r.id === edit.id ? { ...r, station: edit.station.trim(), code: edit.code.trim(), needsReview: false } : r));
    this.setData({ editing: null });
  },
});
