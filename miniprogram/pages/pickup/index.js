const mockOcr = require("../../services/mock-ocr");
const cloudOcr = require("../../services/cloud-ocr");
const parser = require("../../services/pickup-parser");
const storage = require("../../services/pickup-store");
const duplicates = require("../../services/pickup-duplicates");
const task = require("../../services/recognition-task");
const { createQueue } = require("../../services/recognition-queue");
const MAX_BYTES = 5 * 1024 * 1024;

Page({
  data: { images: [], loading: false, choosing: false, error: "", completed: false,
    groups: [], records: [], drafts: [], draftGroups: [], results: [], progress: "", mock: false,
    remaining: 0, editing: null, importing: false, storageError: "", storageBlocked: false, openDeleteId: "", deleting: false, undoAvailable: false },
  onLoad() {
    this.unloaded = false;
    this.ocrQueue = createQueue();
    this.imageJobs = new Map();
    this.taskSequence = 0;
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
  retryImage(e) {
    const result = this.data.results.find(r => r.taskId === e.currentTarget.dataset.taskId ||
      r.index === Number(e.currentTarget.dataset.index));
    if (result && result.retryable && !this.data.importing && !this.data.choosing) {
      return this.startImage(result.index - 1, this.recognitionRun);
    }
  },
  skipImage(e) {
    const job = this.imageJobs.get(e.currentTarget.dataset.taskId);
    if (job) job.cancel("SKIPPED");
  },
  cancelImage(e) {
    const job = this.imageJobs.get(e.currentTarget.dataset.taskId);
    if (job) job.cancel();
  },
  cancelRecognition() { this.imageJobs.forEach(job => job.cancel()); },
  onUnload() {
    this.unloaded = true;
    this.recognitionRun = null;
    this.cancelRecognition();
    clearTimeout(this.undoTimer);
    this.undoRecord = null;
  },
  refreshRecognition() {
    const results = this.data.results;
    const pending = results.filter(r => r.state === "queued" || r.state === "running").length;
    this.setData({ loading: pending > 0, completed: pending === 0,
      progress: `已完成 ${results.length - pending}/${results.length}`,
      mock: results.some(r => r.mock),
      error: "" });
  },
  runRecognition(useCloud) {
    if (!this.data.images.length || this.data.loading || this.data.choosing || this.data.importing) return;
    const changedMode = this.recognitionRun && this.recognitionRun.useCloud !== useCloud;
    const run = { startedAt: Date.now(), useCloud };
    this.recognitionRun = run;
    this.setData({ results: [], loading: true, error: "", completed: false, editing: null,
      ...(changedMode ? { drafts: [], draftGroups: [] } : {}) });
    return Promise.all(this.data.images.map((_, i) => this.startImage(i, run)));
  },
  async startImage(i, run) {
    if (!run || this.recognitionRun !== run) return;
    const taskId = `image-${++this.taskSequence}`;
    const queuedAt = Date.now();
    const imagePath = this.data.images[i];
    let startedAt = 0;
    const current = () => this.recognitionRun === run && this.data.results.some(r => r.taskId === taskId);
    const update = changes => {
      if (!current()) return;
      this.setData({ results: this.data.results.map(r => r.taskId === taskId ? { ...r, ...changes } : r) });
    };
    const entry = { taskId, index: i + 1, state: "queued", status: "queued", message: "排队中", error: "",
      count: 0, uncertainCount: 0, retryable: false, mock: !run.useCloud };
    this.setData({ results: [...this.data.results.filter(r => r.index !== i + 1), entry].sort((a, b) => a.index - b.index) });
    this.refreshRecognition();
    const phases = { image_read: "识别中", image_compress: "识别中", compressed_read: "识别中", cloud_roundtrip: "识别中" };
    const traceId = this.taskSequence;
    const job = this.ocrQueue.add(control => {
      control.traceId = traceId;
      return run.useCloud ? cloudOcr.recognize(imagePath, control) : mockOcr.recognize();
    }, {
      timeoutMs: this.recognitionTimeoutMs,
      onStart: () => { startedAt = Date.now(); task.log("queue_wait", queuedAt, "OK", { traceId }); update({ state: "running", message: "识别中" }); },
      onStage: stage => update({ message: phases[stage] || "正在识别" }),
      onSlow: () => update({ message: "还在识别中，可先导入已完成的快递" }),
    });
    this.imageJobs.set(taskId, job);
    try {
      const result = await job.promise;
      if (!current()) return;
      if (!result || typeof result.mock !== "boolean" || !Array.isArray(result.lines) || !result.lines.every(s => typeof s === "string")) throw task.error("BAD_RESPONSE");
      const parseStarted = Date.now();
      const analysis = parser.analyze(result.lines, i, result.boxes);
      const labels = result.lines.join("\n").match(/取件码|取货码|提货码|领取码/g) || [];
      const metadata = duplicates.metadata(result.lines, Math.max(analysis.records.length, labels.length));
      const parsed = analysis.records.map((r, j) => ({ ...r, ...metadata, id: `draft-${taskId}-${j}`, taken: false }));
      // A valid no-code response must also replace old drafts from this image.
      const drafts = [...this.data.drafts.filter(r => r.sourceIndex !== i), ...parsed];
      task.log("text_parse", parseStarted, "OK", { traceId });
      this.setData({ drafts, draftGroups: parser.group(drafts) });
      update({ state: "done", mock: result.mock, count: parsed.length, uncertainCount: analysis.uncertainCount,
        status: analysis.status, message: analysis.message, retryable: analysis.status === "unrecognized" });
    } catch (err) {
      if (!current()) return;
      const safe = task.error(err && err.code);
      const cancelled = safe.code === "SKIPPED" || safe.code === "CANCELLED";
      const retryMessage = /^(WAIT_TIMEOUT|TIMEOUT)$/.test(safe.code) ? "识别超时，请重试"
        : safe.code === "NETWORK_FAILED" ? "网络异常，请重试"
          : safe.code === "CLOUD_FAILED" ? "连接失败，请重试"
            : /^(OCR_FAILED|OCR_AUTH|OCR_UNAVAILABLE|BAD_RESPONSE|FORBIDDEN|UNAUTHORIZED|CONFIG_ERROR)$/.test(safe.code)
              ? "识别服务暂不可用，请重试" : "识别不出来";
      update({ state: "failed", status: safe.code, error: cancelled ? "" : retryMessage,
        message: cancelled ? "已跳过" : "", retryable: true,
        retained: this.data.drafts.some(r => r.sourceIndex === i) });
      task.log("image_total", startedAt || queuedAt, safe.code);
      if (task.isDevelopment()) console.info("[pickup-failure]", { taskId, type: safe.code,
        origin: ["client_wait", "cloud_call", "cloud_result"].includes(err && err.origin) ? err.origin : "client",
        sdkCode: Number.isInteger(err && err.sdkCode) ? err.sdkCode : null });
    } finally {
      this.imageJobs.delete(taskId);
      if (current()) {
        const finishedAt = Date.now();
        update({ elapsedMs: startedAt ? finishedAt - startedAt : 0, queueMs: (startedAt || finishedAt) - queuedAt });
        const status = this.data.results.find(r => r.taskId === taskId).status;
        this.setData({ results: this.data.results.slice() }, () => {
          if (!current()) return;
          const appearedMs = Date.now() - run.startedAt;
          update({ appearedMs });
          const response = this.data.results.find(r => r.taskId === taskId);
          if (task.isDevelopment()) console.info("[pickup-batch]", { taskId, status, appearedMs, elapsedMs: startedAt ? finishedAt - startedAt : 0,
            queueMs: (startedAt || finishedAt) - queuedAt, records: response.count });
        });
        this.refreshRecognition();
      }
    }
  },
  async confirmImport() {
    if (this.data.choosing || this.data.importing || this.data.deleting || this.data.storageBlocked || !this.data.drafts.length) return;
    const importingDrafts = this.data.drafts.slice();
    if (importingDrafts.some(r => !r.station.trim() || r.station.trim().length > 100 ||
      !r.code.trim() || r.code.trim().length > 32)) {
      this.setData({ error: "请先修改异常记录：地点需为 1–100 字，取件码需为 1–32 字。" });
      return;
    }
    this.setData({ importing: true, error: "", editing: null });
    try {
      const confirmation = await wx.showModal({ title: "确认导入",
        content: `请核对地点和取件码。将检查并保存 ${importingDrafts.length} 条${this.data.mock ? "模拟示例" : "取件"}记录到本机。`,
        confirmText: "开始导入" });
      if (!confirmation.confirm) return;
      const records = this.data.records.slice();
      let added = 0, skipped = 0;
      for (const draft of importingDrafts) {
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
      const drafts = this.data.drafts.filter(r => !importingDrafts.some(imported => imported.id === r.id));
      this.setData({ drafts, draftGroups: parser.group(drafts),
        ...(!this.data.loading && !drafts.length ? { images: [], results: [], completed: false } : {}),
        error: `已保存 ${added} 条，跳过 ${skipped} 条。` });
    } catch (_) {
      this.setData({ error: "导入未完成，待导入内容已保留，请重试。" });
    } finally { this.setData({ importing: false }); }
  },
  toggleTaken(e) {
    if (this.data.loading || this.data.importing || this.data.deleting || this.data.storageBlocked || Date.now() < (this.suppressTapUntil || 0)) return;
    this.closeDelete();
    const records = this.data.records.map(r => r.id === e.currentTarget.dataset.id ? storage.updateRecord(r, { taken: !r.taken }) : r);
    this.persistRecords(records);
  },
  closeDelete() { if (this.data.openDeleteId) this.setData({ openDeleteId: "" }); },
  onPageScroll() { this.closeDelete(); },
  onHide() { this.closeDelete(); this.swipe = null; },
  recordTap() { if (Date.now() >= (this.suppressTapUntil || 0)) this.closeDelete(); },
  touchStart(e) {
    this.swipe = null;
    const id = e.currentTarget.dataset.id;
    if (this.data.deleting || this.data.storageBlocked || e.touches.length !== 1 ||
      !this.data.records.some(r => r.id === id && r.taken)) return;
    const t = e.touches[0];
    this.swipe = { id, x: t.clientX, y: t.clientY, axis: "" };
    if (this.data.openDeleteId !== id) this.closeDelete();
  },
  touchMove(e) {
    const swipe = this.swipe;
    if (!swipe) return;
    if (e.touches.length !== 1) { this.swipe = null; return; }
    const dx = Math.abs(e.touches[0].clientX - swipe.x), dy = Math.abs(e.touches[0].clientY - swipe.y);
    if (!swipe.axis && Math.max(dx, dy) >= 12) swipe.axis = dx > dy * 1.5 ? "x" : "y";
    if (swipe.axis === "y") this.closeDelete();
  },
  touchEnd(e) {
    const swipe = this.swipe;
    this.swipe = null;
    if (!swipe || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - swipe.x, dy = Math.abs(e.changedTouches[0].clientY - swipe.y);
    if (swipe.axis !== "y" && Math.abs(dx) >= 56 && Math.abs(dx) > dy * 1.5) {
      this.suppressTapUntil = Date.now() + 350;
      this.setData({ openDeleteId: dx < 0 ? swipe.id : "" });
    }
  },
  touchCancel() { this.swipe = null; this.closeDelete(); },
  revealDelete(e) {
    if (this.data.deleting || this.data.storageBlocked || Date.now() < (this.suppressTapUntil || 0)) return;
    const id = e.currentTarget.dataset.id;
    if (this.data.records.some(r => r.id === id && r.taken)) this.setData({ openDeleteId: id });
  },
  async recordLongPress(e) {
    const id = e.currentTarget.dataset.id;
    if (this.menuOpen || this.data.deleting || this.data.importing || this.data.storageBlocked ||
      !this.data.records.some(r => r.id === id && r.taken)) return;
    this.menuOpen = true;
    try {
      const answer = await wx.showActionSheet({ itemList: ["删除已取记录"] });
      if (answer.tapIndex === 0 && !this.unloaded) { this.revealDelete(e); await this.deleteRecord(e); }
    } catch (_) { /* Closing the action sheet keeps the record. */ }
    finally { this.menuOpen = false; }
  },
  clearUndo() {
    clearTimeout(this.undoTimer);
    this.undoRecord = null;
    this.setData({ undoAvailable: false });
  },
  async deleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.deleting || this.data.importing || this.data.storageBlocked ||
      this.data.openDeleteId !== id || Date.now() < (this.suppressTapUntil || 0)) return;
    const record = this.data.records.find(r => r.id === id && r.taken);
    if (!record) return;
    this.setData({ deleting: true });
    try {
      const answer = await wx.showModal({ title: "删除已取记录？", content: `${record.station} · ${record.code}。删除后可在 5 秒内撤销，之后无法从页面恢复。${this.data.undoAvailable ? "继续删除将结束上次撤销机会。" : ""}`,
        confirmText: "删除", confirmColor: "#c43d35" });
      if (!answer.confirm || this.data.storageBlocked || this.unloaded) return;
      const index = this.data.records.findIndex(r => r.id === id && r.taken);
      if (index < 0) return;
      if (!this.persistRecords(this.data.records.filter(r => r.id !== id))) return;
      this.clearUndo();
      this.undoRecord = { record, index, until: Date.now() + 5000 };
      this.setData({ openDeleteId: "", undoAvailable: true, editing: this.data.editing && this.data.editing.id === id ? null : this.data.editing });
      this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
    } catch (_) {
      this.setData({ error: "删除未完成，请重试。" });
    } finally { if (!this.unloaded) this.setData({ deleting: false }); }
  },
  undoDelete() {
    const undo = this.undoRecord;
    if (!undo || Date.now() >= undo.until) { this.clearUndo(); return; }
    if (this.data.deleting || this.data.importing || this.data.storageBlocked) return;
    const records = this.data.records.slice();
    if (records.some(r => r.id === undo.record.id)) return;
    records.splice(Math.min(undo.index, records.length), 0, undo.record);
    if (this.persistRecords(records)) this.clearUndo();
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
    if (this.data.loading || this.data.importing || this.data.deleting || Date.now() < (this.suppressTapUntil || 0)) return;
    this.closeDelete();
    const record = [...this.data.records, ...this.data.drafts].find(r => r.id === e.currentTarget.dataset.id);
    if (record) this.setData({ editing: { ...record } });
  },
  editStation(e) { this.setData({ "editing.station": e.detail.value }); },
  editCode(e) { this.setData({ "editing.code": e.detail.value }); },
  cancelEdit() { this.setData({ editing: null }); },
  saveEdit() {
    if (this.data.loading || this.data.importing || this.data.deleting) return;
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
