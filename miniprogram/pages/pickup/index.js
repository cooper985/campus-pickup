const mockOcr = require("../../services/mock-ocr");
const cloudOcr = require("../../services/cloud-ocr");
const parser = require("../../services/pickup-parser");
const storage = require("../../services/pickup-store");
const duplicates = require("../../services/pickup-duplicates");
const MAX_BYTES = 5 * 1024 * 1024;

Page({
  data: { images: [], loading: false, choosing: false, error: "", completed: false,
    groups: [], records: [], drafts: [], draftGroups: [], results: [], progress: "", mock: false,
    remaining: 0, editing: null, importing: false, storageError: "", storageBlocked: false },
  onLoad() {
    this.store = storage.createStore(wx);
    const loaded = this.store.load();
    this.updateRecords(loaded.records);
    this.setData({ storageError: loaded.error, storageBlocked: loaded.blocked });
  },
  async chooseImage() {
    if (this.data.loading || this.data.choosing || this.data.importing) return;
    this.setData({ choosing: true, error: "" });
    try {
      const result = await wx.chooseImage({ count: 9, sizeType: ["original"], sourceType: ["album"] });
      const files = result.tempFiles || [];
      if (!files.length || files.some(f => !f.path || !Number.isFinite(f.size) || f.size <= 0)) throw new Error("无法读取图片，请重新选择。");
      if (files.some(f => f.size > MAX_BYTES)) throw new Error("有图片超过 5 MB，请先裁剪或压缩。");
      this.setData({ images: files.slice(0, 9).map(f => f.path), results: [], drafts: [], draftGroups: [], completed: false, editing: null });
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
    if (!this.data.images.length || this.data.loading || this.data.choosing || this.data.importing) return;
    this.setData({ loading: true, error: "", completed: false, results: [], drafts: [], draftGroups: [], editing: null, mock: !useCloud });
    const results = [], records = [];
    try {
      for (let i = 0; i < this.data.images.length; i++) {
        this.setData({ progress: `正在识别 ${i + 1}/${this.data.images.length}` });
        try {
          const result = await (useCloud ? cloudOcr.recognize(this.data.images[i]) : mockOcr.recognize());
          if (!result || typeof result.mock !== "boolean" || !Array.isArray(result.lines) || !result.lines.every(s => typeof s === "string")) throw new Error("识别结果格式异常。");
          const raw = parser.parse(result.lines, i);
          const metadata = duplicates.metadata(result.lines, raw.length);
          const parsed = raw.map((r, j) => ({ ...r, ...metadata, id: `draft-${i}-${j}`, taken: false }));
          records.push(...parsed);
          results.push({ index: i + 1, lines: result.lines, mock: result.mock, error: "", count: parsed.length });
        } catch (err) {
          results.push({ index: i + 1, lines: [], error: err.message || "识别失败，请重试。", count: 0 });
        }
        this.setData({ results: results.slice(), drafts: records.slice(), draftGroups: parser.group(records) });
      }
      this.setData({ completed: true, mock: results.some(r => r.mock), progress: "", error: results.some(r => r.error) ? "部分截图识别失败，成功结果已保留。重新识别会重新处理全部截图。" : "" });
    } finally { this.setData({ loading: false }); }
  },
  async confirmImport() {
    if (this.data.loading || this.data.choosing || this.data.importing || this.data.storageBlocked || !this.data.drafts.length) return;
    if (this.data.drafts.some(r => !r.station.trim() || r.station.trim().length > 100 ||
      !r.code.trim() || r.code.trim().length > 32)) {
      this.setData({ error: "请先修改异常记录：地点需为 1–100 字，取件码需为 1–32 字。" });
      return;
    }
    this.setData({ importing: true, error: "", editing: null });
    try {
      const confirmation = await wx.showModal({ title: "确认导入",
        content: `请核对地点和取件码。将检查并保存 ${this.data.drafts.length} 条${this.data.mock ? "模拟示例" : "取件"}记录到本机。`,
        confirmText: "开始导入" });
      if (!confirmation.confirm) return;
      const records = this.data.records.slice();
      let added = 0, skipped = 0;
      for (const draft of this.data.drafts) {
        const duplicate = duplicates.findDuplicate(draft, records);
        if (duplicate) {
          const old = duplicate.record;
          if (duplicate.kind === "waybill") {
            const answer = await wx.showModal({ title: "运单号重复",
              content: `${draft.station} · ${draft.code} 的运单号已有记录（${old.taken ? "已取" : "待取"}）。将跳过此项，保留原记录。`,
              confirmText: "跳过此项", cancelText: "取消导入" });
            if (!answer.confirm) return;
            skipped++;
            continue;
          }
          const answer = await wx.showModal({ title: "疑似重复，请确认",
            content: `${draft.station} · ${draft.code} 与${old.taken ? "已取" : "待取"}记录相似。${old.taken ? "取件码可能被新包裹复用。" : "可能是重复截图，也可能是不同包裹。"}确认是不同包裹才新增。`,
            confirmText: "仍然新增", cancelText: "跳过此项" });
          if (!answer.confirm) { skipped++; continue; }
        }
        records.push(storage.newRecord(draft, records));
        added++;
      }
      if (added && !this.persistRecords(records)) return;
      this.setData({ drafts: [], draftGroups: [], images: [], results: [], completed: false,
        error: `已保存 ${added} 条，跳过 ${skipped} 条。` });
    } catch (_) {
      this.setData({ error: "导入未完成，待导入内容已保留，请重试。" });
    } finally { this.setData({ importing: false }); }
  },
  toggleTaken(e) {
    if (this.data.loading || this.data.importing || this.data.storageBlocked) return;
    const records = this.data.records.map(r => r.id === e.currentTarget.dataset.id ? storage.updateRecord(r, { taken: !r.taken }) : r);
    this.persistRecords(records);
  },
  persistRecords(records) {
    try {
      this.updateRecords(this.store.save(records));
      return true;
    } catch (err) {
      this.setData({ storageError: err.message, storageBlocked: true });
      return false;
    }
  },
  updateRecords(records) {
    this.setData({ records, groups: parser.group(records), remaining: records.filter(r => !r.taken).length });
  },
  editRecord(e) {
    if (this.data.loading || this.data.importing) return;
    const record = [...this.data.records, ...this.data.drafts].find(r => r.id === e.currentTarget.dataset.id);
    if (record) this.setData({ editing: { ...record } });
  },
  editStation(e) { this.setData({ "editing.station": e.detail.value }); },
  editCode(e) { this.setData({ "editing.code": e.detail.value }); },
  cancelEdit() { this.setData({ editing: null }); },
  saveEdit() {
    if (this.data.loading || this.data.importing) return;
    const edit = this.data.editing;
    if (!edit || !edit.station.trim() || !edit.code.trim() || edit.station.trim().length > 100 || edit.code.trim().length > 32) return;
    const changes = { station: edit.station.trim(), code: edit.code.trim() };
    if (this.data.drafts.some(r => r.id === edit.id)) {
      const drafts = this.data.drafts.map(r => r.id === edit.id ? { ...r, ...changes, needsReview: false } : r);
      this.setData({ drafts, draftGroups: parser.group(drafts) });
    } else {
      if (this.data.storageBlocked || !this.persistRecords(this.data.records.map(r => r.id === edit.id ? storage.updateRecord(r, changes) : r))) return;
    }
    this.setData({ editing: null });
  },
});
