const mockOcr = require("../../services/mock-ocr");
const parser = require("../../services/pickup-parser");
const storage = require("../../services/pickup-store");
const duplicates = require("../../services/pickup-duplicates");
const task = require("../../services/recognition-task");
const { createQueue } = require("../../services/recognition-queue");
const fileidOcr = require("../../services/fileid-ocr");
const MAX_BYTES = 5 * 1024 * 1024;

Page({
  data: { reviewOpen: false, reviewItems: [], reviewSummary: "", importFeedback: "", activeTab: "home", pendingGroups: [], history: [], collapsedStations: [], locationCount: 0, unknownCount: 0, undoMessage: "", editError: "", images: [], loading: false, choosing: false, error: "", completed: false,
    groups: [], records: [], drafts: [], draftGroups: [], results: [], progress: "", mock: false,
    remaining: 0, editing: null, importing: false, storageError: "", storageBlocked: false, openDeleteId: "", deleting: false, undoAvailable: false },
  onLoad() {
    this.unloaded = false;
    this.ocrQueue = createQueue();
    this.imageJobs = new Map();
    this.taskSequence = 0;
    this.setData({ diagnosticEnabled: task.isDevelopment() });
    this.store = storage.createStore(wx);
    const loaded = this.store.load();
    this.updateRecords(loaded.records);
    this.setData({ storageError: loaded.error, storageBlocked: loaded.blocked });
  },
  async chooseImage() {
    if (this.data.loading || this.data.choosing || this.data.importing) return;
    this.setData({ choosing: true, error: "" });
    let selected = false;
    try {
      if (this.data.drafts.length) {
        const answer = await wx.showModal({ title: "重新选择截图？", content: "当前尚未导入的结果会被替换。", confirmText: "重新选择" });
        if (!answer.confirm) return;
      }
      const result = await wx.chooseImage({ count: 9, sizeType: ["original"], sourceType: ["album"] });
      const files = result.tempFiles || [];
      if (!files.length || files.some(f => !f.path || !Number.isFinite(f.size) || f.size <= 0)) throw new Error("无法读取图片，请重新选择。");
      if (files.some(f => f.size > MAX_BYTES)) throw new Error("有图片超过 5 MB，请先裁剪或压缩。");
      selected = true;
      this.imagesSelectedAt = Date.now();
      this.setData({ images: files.slice(0, 9).map(f => f.path), results: [], drafts: [], draftGroups: [], completed: false, editing: null });
    } catch (err) {
      if (!/cancel/i.test(err && err.errMsg || "")) this.setData({ error: err.message || "无法打开相册，请重试。" });
    } finally { this.setData({ choosing: false }); }
    if (selected) return this.recognizeCloud();
  },
  previewImage(e) {
    const index = Number(e && e.currentTarget.dataset.index || 0);
    if (this.data.images[index]) wx.previewImage({ current: this.data.images[index], urls: this.data.images });
  },
  recognize() { return this.runRecognition(false); },
  recognizeCloud() { return this.runRecognition(true); },
  copyRecognitionDiagnostic(e) {
    if (!task.isDevelopment()) return;
    const result = this.data.results.find(r => r.taskId === e.currentTarget.dataset.taskId);
    if (!result || !["done", "failed"].includes(result.state) || /^(SKIPPED|CANCELLED)$/.test(result.status)) return;
    const report = result.transport === "fileid"
      ? this.data.results.filter(r => r.transport === "fileid").map(r => task.diagnostic(r.traceId))
      : task.diagnostic(result.traceId);
    wx.setClipboardData({ data: JSON.stringify(report),
      success: () => wx.showToast({ title: "诊断信息已复制", icon: "none" }),
      fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" }) });
  },
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
    this.cancelImportReview();
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
    const transport = useCloud ? "fileid" : "mock";
    if (!this.data.images.length || this.data.loading || this.data.choosing || this.data.importing) return;
    const changedMode = this.recognitionRun && (this.recognitionRun.useCloud !== useCloud || this.recognitionRun.transport !== transport);
    const run = { startedAt: Date.now(), selectedAt: this.imagesSelectedAt || Date.now(), useCloud, transport };
    this.recognitionRun = run;
    this.setData({ results: [], loading: true, error: "", completed: false, editing: null,
      ...(changedMode ? { drafts: [], draftGroups: [] } : {}) });
    return Promise.all(this.data.images.map((_, i) => this.startImage(i, run)));
  },
  async startImage(i, run) {
    if (!run || this.recognitionRun !== run) return;
    const taskId = `image-${++this.taskSequence}`;
    const traceId = Date.now() * 100 + this.taskSequence;
    const queuedAt = Date.now();
    const imagePath = this.data.images[i];
    let startedAt = 0;
    const current = () => this.recognitionRun === run && this.data.results.some(r => r.taskId === taskId);
    const update = changes => {
      if (!current()) return;
      this.setData({ results: this.data.results.map(r => r.taskId === taskId ? { ...r, ...changes } : r) });
    };
    const entry = { taskId, traceId, index: i + 1, transport: run.transport, state: "queued", status: "queued", message: "排队中", error: "",
      count: 0, uncertainCount: 0, retryable: false, mock: !run.useCloud };
    this.setData({ results: [...this.data.results.filter(r => r.index !== i + 1), entry].sort((a, b) => a.index - b.index) });
    this.refreshRecognition();
    const phases = { image_read: "识别中", image_compress: "识别中", compressed_read: "识别中", cloud_roundtrip: "识别中" };
    let phase = "image_prepare";
    const job = this.ocrQueue.add(control => {
      control.traceId = traceId;
      return run.useCloud ? fileidOcr.recognize(imagePath, control) : mockOcr.recognize();
    }, {
      timeoutMs: this.recognitionTimeoutMs,
      onStart: () => { startedAt = Date.now(); task.log("queue_wait", queuedAt, "OK", { traceId }); update({ state: "running", message: "识别中" }); },
      onStage: stage => { phase = stage; update({ message: phases[stage] || "正在识别" }); },
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
      task.log("text_parse", parseStarted, "OK", { traceId, parseReason: analysis.reason, recordCount: parsed.length, uncertainCount: analysis.uncertainCount });
      this.setData({ drafts, draftGroups: parser.group(drafts) });
      update({ state: "done", mock: result.mock, count: parsed.length, uncertainCount: analysis.uncertainCount,
        status: analysis.status, parseReason: analysis.reason, message: analysis.message, retryable: analysis.status === "unrecognized" });
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
      task.log("image_total", startedAt || queuedAt, safe.code, { traceId, phase, origin: err && err.origin, sdkCode: err && err.sdkCode });
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
          task.log("selection_total", run.selectedAt, "OK", { traceId, selectedToResultMs: Date.now() - run.selectedAt });
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
    if (this.unloaded || this.data.choosing || this.data.importing || this.data.deleting || this.data.storageBlocked || !this.data.drafts.length) return;
    const importingDrafts = this.data.drafts.slice();
    if (importingDrafts.some(r => !r.station.trim() || r.station.trim().length > 100 ||
      !r.code.trim() || r.code.trim().length > 32)) {
      this.setData({ error: "请先修改异常记录：地点需为 1–100 字，取件码需为 1–32 字。" });
      return;
    }
    this.setData({ importing: true, error: "", importFeedback: "", editing: null });
    try {
      const session = { original: this.data.records.slice(), drafts: importingDrafts, choices: {}, newRecords: new Map() };
      let plan = duplicates.planImport(session.original, session.drafts, session.choices, session.newRecords);
      if (plan.reviews.length) {
        plan = await new Promise(resolve => {
          this.importSession = { ...session, resolve };
          this.refreshImportReview();
        });
        if (!plan) return;
      } else if (plan.added || plan.updated) {
        const confirmation = await wx.showModal({ title: "确认导入",
          content: `将新增 ${plan.added} 件，更新 ${plan.updated} 件，跳过重复 ${plan.skipped} 件${this.data.mock ? "（模拟示例）" : ""}。取件记录仅保存在本机。`,
          confirmText: "确认导入" });
        if (!confirmation.confirm) return;
      }
      if (this.unloaded || this.data.storageBlocked) return;
      if ((plan.added || plan.updated) && !this.persistRecords(plan.records)) return;
      const { added, updated, skipped } = plan;
      if (updated) {
        this.clearUndo();
        this.undoRecord = { kind: "merge", updates: plan.updates, until: Date.now() + 5000 };
        this.setData({ undoAvailable: true, undoMessage: `已更新 ${updated} 件信息` });
        this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
      }
      const drafts = this.data.drafts.filter(r => !importingDrafts.some(imported => imported.id === r.id));
      this.setData({ drafts, draftGroups: parser.group(drafts),
        ...(!this.data.loading && !drafts.length ? { images: [], results: [], completed: false } : {}),
        error: "", activeTab: "home", importFeedback: `已新增 ${added} 件，更新 ${updated} 件，跳过重复 ${skipped} 件`,
        collapsedStations: this.data.collapsedStations.filter(station => !importingDrafts.some(r => r.station === station)) });
      this.updateRecords(this.data.records);
      if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
      if (wx.showToast) wx.showToast({ title: added || updated ? "导入完成" : "该快递已存在", icon: "none" });
    } catch (_) {
      this.setData({ error: "导入未完成，待导入内容已保留，请重试。" });
    } finally { if (!this.unloaded) this.setData({ importing: false }); }
  },
  refreshImportReview() {
    const session = this.importSession;
    if (!session || this.unloaded) return;
    const plan = duplicates.planImport(session.original, session.drafts, session.choices, session.newRecords);
    session.plan = plan;
    this.setData({ reviewOpen: true, reviewItems: plan.reviews,
      reviewSummary: `新增 ${plan.added} 件 · 更新 ${plan.updated} 件 · 跳过重复 ${plan.skipped} 件` });
  },
  chooseImportAction(e) {
    if (!this.importSession) return;
    const { id, action, targetId } = e.currentTarget.dataset;
    if (!["update", "skip", "new"].includes(action)) return;
    this.importSession.choices[id] = { action, targetId };
    this.refreshImportReview();
  },
  finishImportReview() {
    const session = this.importSession;
    if (!session || this.data.storageBlocked || this.unloaded) return;
    this.refreshImportReview();
    this.importSession = null;
    this.setData({ reviewOpen: false });
    session.resolve(session.plan);
  },
  cancelImportReview() {
    const session = this.importSession;
    if (!session) return;
    this.importSession = null;
    if (!this.unloaded) this.setData({ reviewOpen: false });
    session.resolve(null);
  },
  copyCode(e) {
    const record = this.data.records.find(r => r.id === e.currentTarget.dataset.id && !r.taken);
    if (!record) return;
    wx.setClipboardData({ data: record.code,
      success: () => wx.showToast({ title: "取件码已复制", icon: "none" }),
      fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" }) });
  },
  noop() {},
  switchTab(e) {
    const activeTab = e.currentTarget.dataset.tab;
    if (!["home", "import", "history"].includes(activeTab) || this.data.importing || this.data.deleting) return;
    this.closeDelete();
    this.setData({ activeTab, editing: null, editError: "" });
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  toggleGroup(e) {
    const station = e.currentTarget.dataset.station;
    const collapsed = this.data.collapsedStations;
    this.setData({ collapsedStations: collapsed.includes(station) ? collapsed.filter(s => s !== station) : [...collapsed, station] });
    this.updateRecords(this.data.records);
  },
  toggleTaken(e) {
    if (this.data.importing || this.data.deleting || this.data.storageBlocked || Date.now() < (this.suppressTapUntil || 0)) return;
    const record = this.data.records.find(r => r.id === e.currentTarget.dataset.id);
    if (!record) return;
    this.closeDelete();
    const records = this.data.records.map(r => r.id === record.id ? storage.updateRecord(r, { taken: !r.taken }) : r);
    if (!this.persistRecords(records)) return;
    this.clearUndo();
    if (!record.taken) {
      this.undoRecord = { record, kind: "taken", until: Date.now() + 5000 };
      this.setData({ undoAvailable: true, undoMessage: "已取件" });
      this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
    } else if (wx.showToast) wx.showToast({ title: "已恢复待取", icon: "none" });
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
      this.setData({ openDeleteId: "", undoAvailable: true, undoMessage: "已删除", editing: this.data.editing && this.data.editing.id === id ? null : this.data.editing });
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
    if (undo.kind === "merge") {
      if (undo.updates.some(u => !records.some(r => r.id === u.after.id && JSON.stringify(r) === JSON.stringify(u.after)))) {
        this.clearUndo();
        if (wx.showToast) wx.showToast({ title: "记录已变化，请手动修改", icon: "none" });
        return;
      }
      const restored = records.map(r => {
        const update = undo.updates.find(u => u.before.id === r.id);
        return update ? storage.updateRecord(r, { station: update.before.station, carrier: update.before.carrier, waybillNumber: update.before.waybillNumber }) : r;
      });
      if (this.persistRecords(restored)) { this.clearUndo(); this.setData({ importFeedback: "已撤销信息更新" }); }
      return;
    }
    if (undo.kind === "taken") {
      if (this.persistRecords(records.map(r => r.id === undo.record.id ? storage.updateRecord(r, { taken: false }) : r))) this.clearUndo();
      return;
    }
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
    const pending = records.filter(r => !r.taken);
    const pendingGroups = parser.group(pending).map(g => ({ ...g,
      collapsed: this.data.collapsedStations.includes(g.station),
      items: g.items.slice().sort((a, b) => {
        const x = a.code.match(/\d+|\D+/g) || [], y = b.code.match(/\d+|\D+/g) || [];
        for (let i = 0; i < Math.min(x.length, y.length); i++) {
          const diff = /^\d+$/.test(x[i]) && /^\d+$/.test(y[i]) ? Number(x[i]) - Number(y[i]) : x[i].localeCompare(y[i]);
          if (diff) return diff;
        }
        return x.length - y.length;
      })
    }));
    this.setData({ records, groups: parser.group(records), pendingGroups,
      locationCount: pendingGroups.filter(g => g.station !== parser.UNKNOWN).length,
      unknownCount: pending.filter(r => r.station === parser.UNKNOWN).length,
      history: records.filter(r => r.taken).sort((a, b) => b.takenAt - a.takenAt), remaining: pending.length });
  },
  editRecord(e) {
    if (this.data.importing || this.data.deleting || Date.now() < (this.suppressTapUntil || 0)) return;
    this.closeDelete();
    const record = [...this.data.records, ...this.data.drafts].find(r => r.id === e.currentTarget.dataset.id);
    if (record) this.setData({ editing: { ...record }, editError: "" });
  },
  editStation(e) { this.setData({ "editing.station": e.detail.value }); },
  editCarrier(e) { this.setData({ "editing.carrier": e.detail.value }); },
  editCode(e) { this.setData({ "editing.code": e.detail.value }); },
  cancelEdit() { this.setData({ editing: null }); },
  saveEdit() {
    if (this.data.importing || this.data.deleting) return;
    const edit = this.data.editing;
    if (!edit || !edit.station.trim() || !edit.code.trim() || edit.station.trim().length > 100 || edit.code.trim().length > 32 || (edit.carrier || "").trim().length > 40) {
      this.setData({ editError: "请填写地点和取件码，并检查内容长度。" }); return;
    }
    const changes = { station: edit.station.trim(), code: edit.code.trim(), carrier: (edit.carrier || "").trim() };
    const original = [...this.data.records, ...this.data.drafts].find(r => r.id === edit.id);
    if (!original) return;
    changes.confirmedFields = [...new Set([...(original.confirmedFields || []), ...Object.keys(changes).filter(key =>
      changes[key] !== (original[key] || "") || (changes[key] && changes[key] !== parser.UNKNOWN))])];
    if (this.data.drafts.some(r => r.id === edit.id)) {
      const drafts = this.data.drafts.map(r => r.id === edit.id ? { ...r, ...changes, needsReview: false } : r);
      this.setData({ drafts, draftGroups: parser.group(drafts) });
    } else {
      if (this.data.storageBlocked || !this.persistRecords(this.data.records.map(r => r.id === edit.id ? storage.updateRecord(r, changes) : r))) return;
    }
    this.setData({ editing: null });
  },
});
