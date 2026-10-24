const mockOcr = require("../../services/mock-ocr");
const parser = require("../../services/pickup-parser");
const storage = require("../../services/pickup-store");
const duplicates = require("../../services/pickup-duplicates");
const task = require("../../services/recognition-task");
const { createQueue } = require("../../services/recognition-queue");
const fileidOcr = require("../../services/fileid-ocr");
const stations = require("../../services/stations");
const notifications = require("../../services/notification-parser");
const { validCode } = require("../../services/pickup-code");
const { fuse } = require("../../services/candidate-fusion");
const stationDrag = require("../../services/station-drag");
const imageDedup = require("../../services/image-dedup");
const decision = require("../../services/import-decision");
const batches = require("../../services/import-batches");
const importResults = require("../../services/import-results");
const evidence = require("../../services/import-evidence");
const identity = require("../../services/parcel-identity");
const MAX_BYTES = 5 * 1024 * 1024;

Page({
  data: { resultCategory: "", categoryItems: [], failureCount: 0, currentException: null, exceptionProgress: "", keyboardHeight: 0, recentImport: null, exceptionCount: 0, exceptionOpen: false, exceptionItems: [], batchError: "", newStations: [], swipeId: "", swipeStyle: "", reduceMotion: false, visiblePendingGroups: [], visibleDraftGroups: [], visibleHistory: [], notificationOpen: false, notificationText: "", validDraftCount: 0, dragId: "", errorScope: "", stationList: [], stationSelection: [], stationSuggestions: [], stationEditor: null, stationError: "", stationBlocked: false, stationBusy: false, reviewOpen: false, reviewItems: [], reviewSummary: "", importFeedback: "", activeTab: "home", pendingGroups: [], history: [], collapsedStations: [], locationCount: 0, unknownCount: 0, undoMessage: "", editError: "", images: [], loading: false, choosing: false, error: "", completed: false,
    groups: [], records: [], drafts: [], draftGroups: [], results: [], progress: "", mock: false,
    remaining: 0, editing: null, importing: false, storageError: "", storageBlocked: false, openDeleteId: "", deleting: false, undoAvailable: false },
  onLoad() {
    this.unloaded = false;
    this.importEpoch = 0;
    this.batchImagePaths = new Map();
    this.ocrQueue = createQueue();
    this.imageJobs = new Map();
    this.taskSequence = 0;
    this.setData({ diagnosticEnabled: task.isDevelopment() });
    this.keyboardListener = e => this.setData({ keyboardHeight: e.height || 0 });
    if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this.keyboardListener);
    this.store = storage.createStore(wx);
    const loaded = this.store.load();
    this.stationStore = stations.createStore(wx);
    const settings = this.stationStore.load();
    this.stationState = settings.state;
    this.setData({ stationError: settings.error, stationBlocked: !!settings.error });
    this.setData({ storageError: loaded.error, storageBlocked: loaded.blocked });
    this.importState = loaded.imports || batches.empty();
    this.updateRecords(loaded.records);
    this.refreshBatchSummary();
    if (!loaded.blocked) { this.recoverInterrupted(); this.reconcileExceptions(); }
  },
  toggleMotion() {
    this.setData({ reduceMotion: !this.data.reduceMotion });
    this.presentRows("visiblePendingGroups", this.data.pendingGroups, true);
    this.presentRows("visibleDraftGroups", this.data.draftGroups, true);
    this.presentRows("visibleHistory", this.data.history);
  },
  // Exit snapshots are view-only; saves and the five-second undo never wait for animation.
  presentRows(field, next, grouped = false) {
    this.presentationTimers = this.presentationTimers || {};
    clearTimeout(this.presentationTimers[field]);
    const retain = (before, after) => {
      const rows = after.slice();
      before.forEach((row, index) => {
        if (!rows.some(r => r.id === row.id)) rows.splice(Math.min(index, rows.length), 0, { ...row, leaving: true });
      });
      return rows;
    };
    const previous = this.data[field] || [];
    let visible = next;
    if (!this.data.reduceMotion) {
      if (grouped) {
        visible = next.map(g => ({ ...g, items: retain((previous.find(old => (old.id || old.station) === (g.id || g.station)) || { items: [] }).items, g.items) }));
        previous.forEach((g, index) => {
          if (!next.some(n => (n.id || n.station) === (g.id || g.station))) visible.splice(Math.min(index, visible.length), 0, { ...g, leaving: true, items: g.items.map(r => ({ ...r, leaving: true })) });
        });
      } else visible = retain(previous, next);
    }
    this.setData({ [field]: visible });
    const hasExit = grouped ? visible.some(g => g.items.some(r => r.leaving)) : visible.some(r => r.leaving);
    if (hasExit) this.presentationTimers[field] = setTimeout(() => {
      if (!this.unloaded) this.setData({ [field]: next });
    }, 200);
  },
  openNotification() {
    if (this.data.loading || this.data.choosing || this.data.importing) return;
    this.setData({ notificationOpen: true, error: "", errorScope: "import", editing: null });
  },
  notificationInput(e) { this.setData({ notificationText: e.detail.value, error: "" }); },
  clearNotificationText() {
    if (this.data.choosing || this.data.importing) return;
    this.setDrafts(this.data.drafts.filter(r => r.sourceType !== "text"), { notificationText: "", error: "" });
  },
  cancelNotification() {
    if (this.data.choosing || this.data.importing) return;
    this.importEpoch++;
    this.setDrafts(this.data.drafts.filter(r => r.sourceType !== "text"), { notificationOpen: false, notificationText: "",
      error: "", completed: this.data.results.length > 0 });
  },
  async recognizeNotification({ shadow = false } = {}) {
    if (!this.data.notificationOpen || this.data.loading || this.data.choosing || this.data.importing) return;
    const text = this.data.notificationText.trim(), epoch = this.importEpoch;
    if (!text) { this.setData({ error: "请先粘贴通知", errorScope: "import" }); return; }
    if (text.length > 20000) { this.setData({ error: "通知过长，请保留需要识别的内容", errorScope: "import" }); return; }
    this.setData({ choosing: true, error: "", errorScope: "import" });
    try {
      if (this.data.drafts.some(r => r.sourceType !== "text")) {
        const answer = await wx.showModal({ title: "替换待导入结果？", content: "本次通知的识别结果将替换当前草稿。已保存的快递不受影响。", confirmText: "识别通知" });
        if (!answer.confirm || this.unloaded || epoch !== this.importEpoch) return;
      }
      const parsed = notifications.parse(text);
      this.recognitionRun = null;
      const batchId = ++this.taskSequence;
      const drafts = parsed.map((r, i) => ({ ...r, id: `text-${Date.now()}-${batchId}-${i}`, taken: false }));
      this.setDrafts(drafts, { images: [], results: [], mock: false, completed: true, editing: null,
        notificationOpen: !parsed.length, errorScope: "import", error: parsed.length ? "" : "未找到取件码" });
      if (parsed.length && !shadow) {
        const id = `text-import-${Date.now().toString(36)}-${batchId}`;
        if (this.persistBatch(batches.begin(id, 0))) this.completeAutoBatch({ batchId: id },
          fuse(drafts, name => stations.resolve(this.stationState, name).id).map(c => stations.assist(this.stationState, c)));
      }
    } catch (_) {
      if (!this.unloaded && epoch === this.importEpoch) this.setData({ errorScope: "import", error: "无法识别，请修改文字后重试" });
    } finally { if (!this.unloaded && epoch === this.importEpoch) this.setData({ choosing: false }); }
  },
  showImportPrivacy() {
    wx.showModal({ title: "隐私说明", content: "截图发送腾讯云识别；通知文字仅在本机解析，不上传。取件记录只保存在本机，清理小程序数据会丢失记录。", showCancel: false, confirmText: "知道了" });
  },
  setDrafts(drafts, extra = {}) {
    this.setData({ drafts, draftGroups: parser.group(drafts).map(g => ({ ...g, validCount: g.items.filter(r => validCode(r.code)).length })), validDraftCount: drafts.filter(r => validCode(r.code)).length, ...extra });
    this.presentRows("visibleDraftGroups", this.data.draftGroups, true);
  },
  removeDraft(e) {
    if (this.data.loading || this.data.importing) return;
    const id = e.currentTarget.dataset.id;
    const removed = this.data.drafts.find(r => r.id === id);
    if (this.recognitionRun && removed) (removed.sourceIds || [removed.id]).forEach(key => this.recognitionRun.dismissed.add(key));
    this.setDrafts(this.data.drafts.filter(r => r.id !== id), { error: "", editing: this.data.editing && this.data.editing.id === id ? null : this.data.editing });
  },
  resetImport() {
    this.reviewResume = null;
    this.importEpoch++;
    this.recognitionRun = null;
    this.cancelRecognition();
    this.setDrafts([], { images: [], results: [], loading: false, choosing: false, completed: false,
      mock: false, editing: null, editError: "", resultCategory: "", notificationOpen: false, notificationText: "", error: "", progress: "" });
  },
  clearImportResults() {
    if (this.data.importing) return;
    this.resetImport();
    if (wx.showToast) wx.showToast({ title: "已清空本次结果", icon: "none" });
  },
  cancelImport() {
    if (this.data.importing) return;
    this.resetImport();
    this.setData({ activeTab: "import", importFeedback: "", errorScope: "" });
  },
  showImportFeedback(message) {
    clearTimeout(this.feedbackTimer);
    this.setData({ importFeedback: message });
    this.feedbackTimer = setTimeout(() => { if (!this.unloaded) this.setData({ importFeedback: "" }); }, 4000);
  },
  openStations() {
    if (this.data.importing || this.data.deleting || this.data.stationBusy) return;
    this.closeDelete();
    this.cancelStationDrag();
    this.setData({ activeTab: "stations", stationSelection: [], error: "", errorScope: "", importFeedback: "" });
  },
  saveStations(state) {
    if (this.data.stationBlocked || this.data.storageBlocked) return false;
    try {
      this.stationState = this.stationStore.save(state);
      this.setData({ stationError: "" });
      this.updateRecords(this.data.records);
      return true;
    } catch (err) { this.setData({ stationError: err.message, stationBlocked: true }); return false; }
  },
  stationTouchStart(e) {
    if (this.data.dragId) { this.cancelStationDrag(); return; }
    if (!e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    clearTimeout(this.stationHoldTimer);
    this.stationHoldTimer = setTimeout(() => this.beginStationDrag(), 350);
    this.stationTouch = { id: e.currentTarget.dataset.id, startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY, moved: false };
  },
  beginStationDrag() {
    clearTimeout(this.stationHoldTimer);
    if (this.stationDragging) return;
    clearTimeout((this.presentationTimers || {}).visiblePendingGroups);
    const touch = this.stationTouch;
    if (!touch || touch.moved || this.data.stationBusy || this.data.importing || this.data.deleting || this.data.storageBlocked || this.data.stationBlocked) return;
    const dragField = this.data.activeTab === "stations" ? "stationList" : "visiblePendingGroups";
    const ids = (dragField === "stationList" ? this.data.stationList : this.data.pendingGroups).filter(g => this.stationState.groups.some(s => s.id === g.id)).map(g => g.id);
    if (ids.length < 2 || !ids.includes(touch.id)) return;
    const query = wx.createSelectorQuery().in(this);
    query.selectAll(".sortable-station").boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(results => {
      if (this.unloaded || this.stationTouch !== touch || touch.moved || !results || !results[0] || results[0].length !== ids.length) return;
      const scrollTop = results[1] && results[1].scrollTop || 0;
      const rects = results[0].map(r => ({ top: r.top + scrollTop, bottom: r.bottom + scrollTop }));
      if (rects.some(r => !Number.isFinite(r.top) || !Number.isFinite(r.bottom) || r.bottom <= r.top)) return;
      this.pageScrollTop = scrollTop;
      const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.stationDragging = { ids, rects, field: dragField, from: ids.indexOf(touch.id), startPageY: touch.startY + scrollTop,
        clientY: touch.lastY, height: windowInfo.windowHeight };
      this.setData({ dragId: touch.id });
      this.renderStationDrag();
      this.scrollStationDrag();
      if (wx.vibrateShort) wx.vibrateShort({ type: "light", fail() {} });
    });
  },
  moveStationDrag(e) {
    if (!e.touches || e.touches.length !== 1) { this.cancelStationDrag(); return; }
    const touch = e.touches[0];
    if (this.stationDragging && this.stationDragging.settling) return;
    if (!this.stationDragging) {
      if (this.stationTouch && Math.max(Math.abs(touch.clientX - this.stationTouch.startX), Math.abs(touch.clientY - this.stationTouch.startY)) > 8) this.stationTouch.moved = true;
      return;
    }
    this.stationDragging.clientY = touch.clientY;
    if (Date.now() - (this.lastDragFrame || 0) >= 16) this.renderStationDrag();
  },
  renderStationDrag() {
    const drag = this.stationDragging;
    if (!drag || drag.settling) return;
    this.lastDragFrame = Date.now();
    const preview = stationDrag.preview(drag.rects, drag.from, drag.clientY + (this.pageScrollTop || 0) - drag.startPageY);
    drag.target = preview.target;
    const patch = {};
    this.data[drag.field || "visiblePendingGroups"].forEach((g, index) => {
      const i = drag.ids.indexOf(g.id);
      const style = i < 0 ? "" : `transform: translateY(${preview.offsets[i]}px)${g.id === this.data.dragId ? " scale(1.02)" : ""};`;
      if (g.dragStyle !== style) patch[`${drag.field || "visiblePendingGroups"}[${index}].dragStyle`] = style;
    });
    if (Object.keys(patch).length) this.setData(patch);
  },
  scrollStationDrag() {
    const drag = this.stationDragging;
    if (!drag) return;
    const step = drag.clientY < 110 ? -14 : drag.clientY > drag.height - 100 ? 14 : 0;
    if (step && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: Math.max(0, (this.pageScrollTop || 0) + step), duration: 0 });
    this.dragScrollTimer = setTimeout(() => this.scrollStationDrag(), 32);
  },
  finishStationDrag(e) {
    clearTimeout(this.stationHoldTimer);
    const drag = this.stationDragging;
    if (!drag) { this.stationTouch = null; return; }
    if (e && e.changedTouches && e.changedTouches[0]) drag.clientY = e.changedTouches[0].clientY;
    this.renderStationDrag();
    if (drag.settling) return;
    this.suppressGroupTapUntil = Date.now() + 350;
    try {
      if (drag.target !== drag.from) {
        const next = stationDrag.reorder(this.stationState, drag.ids, drag.from, drag.target);
        this.stationState = this.stationStore.save(next);
      }
    } catch (err) {
      this.cancelStationDrag();
      this.setData({ stationError: err.message, stationBlocked: true });
      return;
    }
    // Persist first, then settle the view without delaying or guessing save success.
    clearTimeout(this.dragScrollTimer);
    drag.settling = true;
    const offset = drag.target > drag.from
      ? drag.rects[drag.target].bottom - drag.rects[drag.from].bottom
      : drag.rects[drag.target].top - drag.rects[drag.from].top;
    const index = this.data[drag.field || "visiblePendingGroups"].findIndex(g => g.id === this.data.dragId);
    this.setData({ [`${drag.field || "visiblePendingGroups"}[${index}].dragStyle`]: `transform: translateY(${offset}px) scale(1); transition: transform ${this.data.reduceMotion ? 0 : 180}ms ease-out;` });
    if (this.data.reduceMotion) this.cancelStationDrag();
    else this.dragSettleTimer = setTimeout(() => this.cancelStationDrag(), 180);
  },
  cancelStationDrag() {
    clearTimeout(this.stationHoldTimer);
    clearTimeout(this.dragScrollTimer);
    clearTimeout(this.dragSettleTimer);
    const settled = this.stationDragging && this.stationDragging.settling;
    this.stationTouch = null;
    this.stationDragging = null;
    if (!this.unloaded && this.data.dragId) this.setData({ dragId: "", stationList: this.data.stationList.map(g => ({ ...g, dragStyle: "" })), ...(settled ? {} : { visiblePendingGroups: this.data.pendingGroups.map(g => ({ ...g, dragStyle: "" })) }) });
    if (!this.unloaded && settled) this.updateRecords(this.data.records);
  },
  openStationDetail(e) {
    if (Date.now() < (this.suppressGroupTapUntil || 0) || this.data.dragId) return;
    const group = this.stationState.groups.find(g => g.id === e.currentTarget.dataset.id);
    const others = this.stationState.groups.filter(g => g.id !== e.currentTarget.dataset.id);
    if (group) this.setData({ stationEditor: { ...group, mergeIds: others.map(g => g.id), mergeNames: others.map(g => g.name), mode: 'detail', suspicious: stations.suspicious(group.name) } });
  },
  mergeStationFromDetail(e) {
    const edit = this.data.stationEditor;
    const id = edit && edit.mergeIds[Number(e.detail.value)];
    if (!id || this.data.stationBusy) return;
    this.setData({ stationSelection: [edit.id, id] }); this.beginStationMerge();
  },
  async deleteStation() {
    const edit = this.data.stationEditor;
    if (!edit || this.data.stationBusy || this.data.stationBlocked || this.data.storageBlocked) return;
    this.setData({ stationBusy: true });
    try {
      const answer = await wx.showModal({ title: '删除驿站配置？', content: `删除「${edit.name}」及其别名和常用记忆。待取、历史包裹与原取件地点全部保留，可在 5 秒内撤销。`, confirmText: '删除驿站', confirmColor: '#b43b35' });
      if (!answer.confirm || this.unloaded) return;
      const before = JSON.parse(JSON.stringify(this.stationState));
      if (!this.saveStations(stations.remove(before, edit.id))) return;
      this.clearUndo();
      this.undoRecord = { kind: 'station-delete', before, after: JSON.stringify(this.stationState), until: Date.now() + 5000 };
      this.setData({ stationEditor: null, undoAvailable: true, undoMessage: '已删除驿站配置，包裹已保留' });
      this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
    } catch (_) { if (!this.unloaded) this.setData({ stationError: '删除未完成，请重试' }); }
    finally { if (!this.unloaded) this.setData({ stationBusy: false }); }
  },
  editStationName(e) {
    const id = e.currentTarget.dataset.id;
    const group = this.stationState.groups.find(g => g.id === id);
    if (group) this.setData({ stationEditor: { id, name: group.name, mode: "rename" } });
  },
  beginStationMerge() {
    const ids = this.data.stationSelection.slice();
    if (ids.length !== 2) return;
    this.setData({ stationEditor: { ids, name: this.stationState.groups.find(g => g.id === ids[0]).name, mode: "merge" } });
  },
  stationNameInput(e) { this.setData({ "stationEditor.name": e.detail.value }); },
  cancelStationEdit() { if (!this.data.stationBusy) this.setData({ stationEditor: null }); },
  async confirmStationEdit() {
    const edit = this.data.stationEditor;
    if (!edit || this.data.stationBusy || this.data.stationBlocked || this.data.storageBlocked) return;
    this.setData({ stationBusy: true });
    try {
      let state;
      if (edit.mode === "merge") {
        state = stations.merge(this.stationState, edit.ids, edit.name);
        const answer = await wx.showModal({ title: "确认属于同一驿站？", content: `将所选两个地点统一显示为「${edit.name.trim()}」，以后识别到这些别名也会归入此处。原记录地点保留。`, confirmText: "确认合并" });
        if (!answer.confirm || this.unloaded) return;
      } else {
        const name = edit.name.trim();
        if (!stations.known(name) || name.length > 100) throw Error("请填写有效驿站名称（1–100 字）。");
        if (this.stationState.groups.some(g => g.id !== edit.id && [g.name, ...g.aliases].some(a => stations.normalize(a) === stations.normalize(name)))) throw Error("名称已属于其他驿站，请选择两个驿站合并。");
        state = { ...this.stationState, groups: this.stationState.groups.map(g => g.id === edit.id ? { ...g, name,
          aliases: g.aliases.some(a => stations.normalize(a) === stations.normalize(g.name)) ? g.aliases : [...g.aliases, g.name] } : g) };
      }
      if (this.saveStations(state)) this.setData({ stationEditor: null, stationSelection: [] });
    } catch (err) { this.setData({ stationError: err.message }); }
    finally { if (!this.unloaded) this.setData({ stationBusy: false }); }
  },
  async unlinkStation(e) {
    if (this.data.stationBusy || this.data.stationBlocked || this.data.storageBlocked) return;
    const { id, alias } = e.currentTarget.dataset;
    const group = this.stationState.groups.find(g => g.id === id);
    if (!group || group.aliases.length < 2 || !group.aliases.includes(alias)) return;
    this.setData({ stationBusy: true });
    try {
      const answer = await wx.showModal({ title: "取消别名关联？", content: `「${alias}」将独立显示，原记录会重新分组；如它是当前统一名称，剩余驿站将使用其第一个别名。`, confirmText: "取消关联" });
      if (!answer.confirm || this.unloaded) return;
      const aliases = group.aliases.filter(a => a !== alias);
      const groups = this.stationState.groups.map(g => g.id === id ? { ...g, aliases,
        name: stations.normalize(g.name) === stations.normalize(alias) ? aliases[0] : g.name } : g);
      let newId = stations.normalize(alias);
      while (groups.some(g => g.id === newId)) newId += "-split";
      groups.push({ id: newId, name: alias, aliases: [alias] });
      this.saveStations({ ...this.stationState, groups });
      this.setData({ stationSelection: [], stationEditor: null });
    } catch (_) { this.setData({ stationError: "取消关联未完成，请重试。" }); }
    finally { if (!this.unloaded) this.setData({ stationBusy: false }); }
  },
  async takeStation(e) {
    if (this.data.deleting || this.data.importing || this.data.storageBlocked) return;
    const group = this.data.pendingGroups.find(g => g.id === e.currentTarget.dataset.id);
    if (!group || !group.items.length) return;
    const ids = group.items.map(r => r.id);
    this.setData({ deleting: true });
    try {
      const answer = await wx.showModal({ title: "全部已取", content: `确认将「${group.station}」的 ${ids.length} 件快递全部标记为已取？`, confirmText: "全部已取" });
      if (!answer.confirm || this.unloaded || this.data.storageBlocked) return;
      const before = this.data.records.filter(r => ids.includes(r.id) && !r.taken);
      const records = this.data.records.map(r => before.some(b => b.id === r.id) ? storage.updateRecord(r, { taken: true }) : r);
      if (!before.length || !this.persistRecords(records)) return;
      this.clearUndo();
      this.undoRecord = { kind: "batch-taken", updates: before.map(b => ({ before: b, after: records.find(r => r.id === b.id) })), until: Date.now() + 5000 };
      this.setData({ undoAvailable: true, undoMessage: `已取 ${before.length} 件` });
      this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
    } catch (_) { if (!this.unloaded) this.setData({ error: "批量核销未完成，请重试。" }); }
    finally { if (!this.unloaded) this.setData({ deleting: false }); }
  },
  async chooseImage() {
    if (this.data.loading || this.data.choosing || this.data.importing) return;
    const epoch = this.importEpoch;
    this.setData({ choosing: true, error: "", errorScope: "import" });
    let selected = false;
    try {
      if (this.data.drafts.length && !(this.recognitionRun && this.recognitionRun.auto)) {
        const answer = await wx.showModal({ title: "重新选择截图？", content: "当前尚未导入的结果会被替换。", confirmText: "重新选择" });
        if (!answer.confirm || this.unloaded || epoch !== this.importEpoch) return;
      }
      const result = await wx.chooseImage({ count: 9, sizeType: ["original"], sourceType: ["album"] });
      if (this.unloaded || epoch !== this.importEpoch) return;
      const files = result.tempFiles || [];
      if (!files.length || files.some(f => !f.path || !Number.isFinite(f.size) || f.size <= 0)) throw new Error("无法读取图片，请重新选择。");
      if (files.some(f => f.size > MAX_BYTES)) throw new Error("有图片超过 5 MB，请先裁剪或压缩。");
      selected = true;
      this.imagesSelectedAt = Date.now();
      this.recognitionRun = null;
      this.setData({ activeTab: "import", resultCategory: "", batchError: "", images: files.slice(0, 9).map(f => f.path), results: [], drafts: [], draftGroups: [], validDraftCount: 0, notificationOpen: false, notificationText: "", completed: false, editing: null });
    } catch (err) {
      if (!this.unloaded && epoch === this.importEpoch && !/cancel/i.test(err && err.errMsg || "")) this.setData({ errorScope: "import", error: err.message || "无法打开相册，请重试。" });
    } finally { if (!this.unloaded && epoch === this.importEpoch) this.setData({ choosing: false }); }
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
  async retryImage(e) {
    if (this.retryBusy || this.data.importing || this.data.choosing || this.data.storageBlocked) return;
    const data = e.currentTarget.dataset;
    const result = this.data.results.find(r => r.taskId === data.taskId || r.index === Number(data.index));
    const batchId = data.batchId || this.recognitionRun && this.recognitionRun.batchId;
    const batch = this.importState.batches.find(b => b.id === batchId && b.status !== 'undone');
    const index = data.imageIndex !== undefined ? Number(data.imageIndex) : result ? result.index - 1 : -1;
    if (result && ['queued', 'running'].includes(result.state)) return;
    if (index < 0 || !batch) {
      if (result && result.retryable && this.recognitionRun) return this.startImage(result.index - 1, this.recognitionRun);
      return;
    }
    this.retryBusy = true;
    try {
      let paths = this.batchImagePaths.get(batchId) || batch.images.map(() => '');
      if (!this.availableImage(batchId, index)) {
        this.setData({ choosing: true });
        try {
          const selected = await wx.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album'] });
          const file = (selected.tempFiles || [])[0];
          if (!file || !file.path || !(file.size > 0) || file.size > MAX_BYTES) throw Error('请选择 5 MB 内的截图');
          paths[index] = file.path;
        } catch (_) { if (!this.unloaded) this.setData({ error: '请重新选择这张截图', errorScope: 'import' }); return; }
        finally { if (!this.unloaded) this.setData({ choosing: false }); }
      }
      if (this.unloaded) return;
      this.batchImagePaths.set(batchId, paths);
      let run = this.recognitionRun;
      if (!run || run.batchId !== batchId) {
        run = { auto: true, batchId, imagePaths: paths, sources: new Map(batch.images.filter(i => i.candidates.length).map(i => [i.index, i.candidates])),
          identities: batch.images.map(i => ({ hash: i.hash, duplicateOf: -1 })), edits: new Map(), dismissed: new Set(),
          startedAt: Date.now(), selectedAt: Date.now(), useCloud: true, transport: 'fileid' };
        this.recognitionRun = run;
        this.setData({ images: paths, results: batch.images.map(i => ({ taskId: `saved-${batchId}-${i.index}`, index: i.index + 1,
          state: i.state === 'failed' || i.state === 'queued' ? 'failed' : 'done', status: i.status, retryable: i.state === 'failed' })) });
      }
      run.retrying = true;
      run.imagePaths = paths;
      // A replacement selected after restart must get its own fingerprint.
      const identities = await imageDedup.inspect(wx, [paths[index]]);
      if (this.unloaded || this.recognitionRun !== run) return;
      run.identities[index] = identities[0];
      this.setData({ images: paths });
      return await this.startImage(index, run);
    } finally { this.retryBusy = false; }
  },
  dismissFailedImage(e) {
    if (this.data.loading || this.data.storageBlocked) return;
    const result = this.data.results.find(r => r.taskId === e.currentTarget.dataset.taskId);
    const run = this.recognitionRun;
    const original = run && run.auto && this.importState.batches.find(b => b.id === run.batchId);
    if (!result || !original) return;
    const batch = JSON.parse(JSON.stringify(original));
    batch.images[result.index - 1].status = 'SKIPPED_BY_USER';
    if (this.persistBatch(batch)) this.setData({ results: this.data.results.map(r => r.taskId === result.taskId ? { ...r, error: '', message: '已由你跳过，未判断其中的快递', retryable: false } : r) });
  },
  skipImage(e) {
    const job = this.imageJobs.get(e.currentTarget.dataset.taskId);
    if (job) job.cancel("SKIPPED");
  },
  cancelImage(e) {
    const job = this.imageJobs.get(e.currentTarget.dataset.taskId);
    if (job) job.cancel();
  },
  cancelRecognition() {
    if (this.recognitionRun && this.recognitionRun.preparing) this.recognitionRun.cancelled = true;
    this.imageJobs.forEach(job => job.cancel());
  },
  onUnload() {
    this.unloaded = true;
    this.batchImagePaths.clear();
    Object.values(this.presentationTimers || {}).forEach(clearTimeout);
    this.data.notificationText = "";
    this.recognitionRun = null;
    this.cancelImportReview();
    this.reviewResume = null;
    this.cancelRecognition();
    clearTimeout(this.undoTimer);
    clearTimeout(this.feedbackTimer);
    this.cancelStationDrag();
    this.undoRecord = null;
    if (wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this.keyboardListener);
  },
  refreshRecognition() {
    const results = this.data.results;
    const pending = results.filter(r => r.state === "queued" || r.state === "running").length;
    this.setData({ loading: pending > 0, completed: pending === 0,
      progress: `正在识别 ${results.length - pending}/${this.recognitionRun ? this.recognitionRun.imagePaths.length : results.length}`,
      mock: results.some(r => r.mock),
      error: "" });
    if (!pending && this.recognitionRun && results.length === this.recognitionRun.imagePaths.length && !this.recognitionRun.preparing) {
      const run = this.recognitionRun;
      const raw = [...run.sources.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, records]) => records)
        .filter(r => !run.dismissed.has(r.id)).map(r => ({ ...r, ...(run.edits.get(r.id) || {}) }));
      const candidates = fuse(raw, name => stations.resolve(this.stationState, name).id).map(c => stations.assist(this.stationState, c));
      if (run.auto) this.completeAutoBatch(run, candidates);
      else this.setDrafts(candidates);
    }
  },
  async runRecognition(useCloud, { shadow = false } = {}) {
    const transport = useCloud ? "fileid" : "mock";
    if (!this.data.images.length || this.data.loading || this.data.choosing || this.data.importing) return;
    const changedMode = this.recognitionRun && (this.recognitionRun.useCloud !== useCloud || this.recognitionRun.transport !== transport);
    const previous = !(useCloud && !shadow) && !changedMode && this.recognitionRun && JSON.stringify(this.recognitionRun.imagePaths) === JSON.stringify(this.data.images) && this.recognitionRun;
    const run = { auto: useCloud && !shadow, preparing: true, imagePaths: this.data.images.slice(), id: previous ? previous.id : ++this.taskSequence, sources: previous ? previous.sources : new Map(),
      edits: previous ? previous.edits : new Map(), dismissed: previous ? previous.dismissed : new Set(), startedAt: Date.now(), selectedAt: this.imagesSelectedAt || Date.now(), useCloud, transport };
    this.recognitionRun = run;
    if (run.auto) {
      run.imageTasks = new Map();
      run.batchId = `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      if (!this.persistBatch(batches.begin(run.batchId, run.imagePaths.length))) return;
      this.batchImagePaths.set(run.batchId, run.imagePaths);
    }
    this.setData({ activeTab: "import", resultCategory: "", results: [], loading: true, progress: `正在识别 0/${run.imagePaths.length}`, error: "", completed: false, editing: null,
      ...(changedMode ? { drafts: [], draftGroups: [], validDraftCount: 0 } : {}) });
    run.identities = useCloud && !shadow ? await imageDedup.inspect(wx, run.imagePaths) : run.imagePaths.map(() => ({ hash: '', duplicateOf: -1 }));
    if (this.recognitionRun !== run || this.unloaded) return;
    run.preparing = false;
    if (run.cancelled) {
      const batch = this.importState.batches.find(b => b.id === run.batchId);
      if (batch) this.persistBatch({ ...batch, images: batch.images.map(i => ({ ...i, state: 'failed', status: 'CANCELLED' })) });
      this.setData({ loading: false, results: run.imagePaths.map((_, i) => ({ taskId: `cancelled-${i}`, index: i + 1, state: 'failed', status: 'CANCELLED', message: '已停止，尚未识别', retryable: true })) });
      this.completeAutoBatch(run, []);
      return;
    }
    return Promise.all(run.imagePaths.map((_, i) => {
      const promise = this.startImage(i, run);
      if (run.imageTasks) run.imageTasks.set(i, promise);
      return promise;
    }));
  },
  async startImage(i, run) {
    if (!run || this.recognitionRun !== run || run.auto && this.importState.batches.find(b => b.id === run.batchId && b.status === "undone")) return;
    this.setData({ editing: null });
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
    const identity = (run.identities || [])[i] || { hash: '', duplicateOf: -1 };
    const entry = { taskId, traceId, index: i + 1, transport: run.transport, state: "queued", status: "queued", message: "排队中", error: "",
      count: 0, uncertainCount: 0, retryable: false, mock: !run.useCloud };
    this.setData({ results: [...this.data.results.filter(r => r.index !== i + 1), entry].sort((a, b) => a.index - b.index) });
    if (run.auto && run.retrying) this.checkpointImage(run, i, { hash: identity.hash, state: 'queued', status: 'queued', candidates: (run.sources.get(i) || []).map(batches.cleanCandidate) });
    this.refreshRecognition();
    const phases = { image_read: "识别中", image_compress: "识别中", compressed_read: "识别中", cloud_roundtrip: "识别中" };
    let phase = "image_prepare";
    if (identity.duplicateOf >= 0 && !run.retrying) {
      await run.imageTasks.get(identity.duplicateOf);
      if (!current()) return;
      const original = this.importState.batches.find(b => b.id === run.batchId);
      const source = original && original.images[identity.duplicateOf];
      if (source && source.state === 'done') {
        update({ state: 'done', status: 'duplicate', message: '本批相同截图', count: 0 });
        this.checkpointImage(run, i, { state: 'duplicate', status: 'duplicate', hash: identity.hash, candidates: [], duplicateOf: identity.duplicateOf });
      } else {
        update({ state: 'failed', status: 'OCR_FAILED', message: '', error: '识别失败，可重试', retryable: true });
        this.checkpointImage(run, i, { state: 'failed', status: 'OCR_FAILED', hash: identity.hash, candidates: [] });
      }
      this.refreshRecognition();
      return;
    }
    const cache = run.auto && !run.retrying && batches.cachedImage(this.importState, identity.hash, run.batchId);
    const cached = cache && !cache.candidates.some(c => (!validCode(c.code) || c.parcelStatus === 'conflict' || c.timeConflict) && !(c.sourceRegions || []).length) && cache;
    if (cached) {
      const parsed = cached.candidates.map((c, j) => {
        const { sourceIds, sourceIndices, fieldSources, ...evidence } = c;
        return { ...evidence, id: c.code ? `draft-${run.batchId}-${i}-${c.code}-${j}` : `issue-${run.batchId}-${i}`, sourceIndex: i, sourceRegions: (c.sourceRegions || []).map(r => ({ ...r, imageIndex: i })) };
      });
      run.sources.set(i, parsed);
      this.checkpointImage(run, i, { hash: identity.hash, state: 'done', status: cached.status, candidates: parsed });
      update({ state: 'done', status: cached.status, count: parsed.length, cached: true, message: '已识别' });
      this.refreshRecognition();
      return;
    }
    const job = this.ocrQueue.add(control => {
      control.traceId = traceId;
      return run.useCloud ? fileidOcr.recognize(imagePath, control) : mockOcr.recognize();
    }, {
      timeoutMs: this.recognitionTimeoutMs,
      onStart: () => { startedAt = Date.now(); task.log("queue_wait", queuedAt, "OK", { traceId }); update({ state: "running", message: "识别中" }); },
      onStage: stage => { phase = stage; update({ message: phases[stage] || "正在识别" }); },
      onSlow: () => update({ message: "正在识别" }),
    });
    this.imageJobs.set(taskId, job);
    try {
      const result = await job.promise;
      if (!current()) return;
      if (!result || typeof result.mock !== "boolean" || !Array.isArray(result.lines) || !result.lines.every(s => typeof s === "string")) throw task.error("BAD_RESPONSE");
      const parseStarted = Date.now();
      const analysis = parser.analyze(result.lines, i, result.boxes);
      const parsed = analysis.records.map((r, j) => ({ ...r, id: `draft-${run.auto ? run.batchId : run.id}-${i}-${r.code}-${j}`, taken: false }));
      if (run.auto) {
        const issues = analysis.issues.slice();
        if (!parsed.length && !issues.length && (analysis.status !== 'in_transit' && /快递|包裹|取件|驿站/.test(result.lines.join('')) || analysis.status === 'unrecognized' || analysis.status === 'in_transit')) {
          const scope = evidence.withoutNavigation(result.lines, result.boxes);
          const item = { code: '', station: parser.UNKNOWN, sourceIndex: i, needsReview: true,
            ...duplicates.metadata(scope, (result.lines.join('').match(/取件码|取货码|提货码|领取码/g) || []).length > 1 ? 2 : 1), ...evidence.inspect(scope.join('\n')) };
          item.sourceRegions = [parser.region(i, 0, Math.max(0, result.lines.length - 1), result.boxes || [], item)];
          if (analysis.status !== 'in_transit' || item.waybillNumber) issues.push(item);
        }
        issues.forEach((item, j) => parsed.push({ ...item, id: `issue-${run.batchId}-${i}-${j}`, unresolvedRegion: !!analysis.records.length || analysis.issues.length > 1 }));
      }
      // A valid no-code response must also replace old drafts from this image.
      run.sources.set(i, parsed);
      if (run.auto) this.checkpointImage(run, i, { hash: identity.hash, state: 'done', status: analysis.status, candidates: parsed.map(batches.cleanCandidate) });
      task.log("text_parse", parseStarted, "OK", { traceId, parseReason: analysis.reason, recordCount: parsed.length, uncertainCount: analysis.uncertainCount });
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
        retained: !!(run.sources.get(i) || []).length });
      if (run.auto) this.checkpointImage(run, i, { hash: identity.hash, state: 'failed', status: safe.code, candidates: (run.sources.get(i) || []).map(batches.cleanCandidate) });
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
  persistBatch(batch, records = this.data.records) {
    return this.persistRecords(records, batches.replace(this.importState, batch));
  },
  checkpointImage(run, index, image) {
    const original = this.importState.batches.find(b => b.id === run.batchId);
    if (!original || this.data.storageBlocked || original.status === 'undone') return;
    const batch = JSON.parse(JSON.stringify(original));
    batch.status = 'processing';
    batch.images[index] = { index, ...image };
    this.persistBatch(batch);
  },
  completeAutoBatch(run, candidates) {
    if (this.unloaded || this.data.storageBlocked || run.committing) return;
    const original = this.importState.batches.find(b => b.id === run.batchId);
    if (!original || original.status === 'undone') return;
    const signature = JSON.stringify([candidates, original.images]);
    if (run.committedSignature === signature) return;
    run.committing = true;
    try {
      const resolved = new Set(original.resolved || []);
      const eligible = candidates.filter(c => !resolved.has(c.id)).map(c => {
        const handled = original.outcomes.some(o => o.id === c.id && o.decision !== decision.NEEDS_REVIEW);
        // A retry must not resurrect a source after its saved record was edited or removed.
        return handled && decision.classify(c, this.data.records, this.stationState).decision === decision.AUTO_IMPORT ? { ...c, batchConflict: true } : c;
      });
      const plan = decision.evaluate(eligible, this.data.records, this.stationState);
      const batch = batches.apply(original, plan, original.images);
      const owned = new Set(original.additions.map(r => r.id));
      batch.skipped = plan.decisions.filter(d => d.decision === decision.AUTO_SKIP && !(d.matches || []).some(m => owned.has(m.id))).length;
      batch.duplicateImages = original.images.filter(i => i.state === 'duplicate').length;
      batch.unrelatedImages = original.images.filter(i => i.state === 'done' && !i.candidates.length).length;
      batch.fusedSources = candidates.reduce((sum, c) => sum + Math.max(0, (c.sourceIds || []).length - 1), 0);
      const newStations = [...new Set(plan.additions.filter(r => stations.known(r.station) && !this.stationState.groups.some(g => g.id === stations.resolve(this.stationState, r.station).id)).map(r => r.station))];
      if (!this.persistBatch(batch, plan.records)) return;
      run.committedSignature = signature;
      this.setDrafts([], { activeTab: 'import', notificationOpen: false, notificationText: '', completed: true, batchError: '', newStations });
      if (batch.reviews.length) this.openExceptions();
      if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    } catch (_) {
      this.setData({ batchError: '整理未完成，请重进导入页继续' });
    } finally { run.committing = false; }
  },
  refreshBatchSummary() {
    const all = this.importState.batches;
    const recent = all[all.length - 1];
    const exceptionCount = all.reduce((sum, b) => sum + b.reviews.length, 0);
    const details = recent ? importResults.details(recent) : [];
    const failures = recent && recent.status !== 'undone' ? details.filter(i => i.failure.length).length : 0;
    const failureCount = all.filter(b => b.status !== 'undone').reduce((n, b) => n + importResults.details(b).filter(i => i.failure.length).length, 0);
    this.setData({ exceptionCount, failureCount, recentImport: recent ? { id: recent.id, added: recent.additions.length, updated: new Set(recent.updates.map(u => u.after.id)).size,
      skipped: (recent.skipped || 0) + (recent.duplicateImages || 0) + (recent.unrelatedImages || 0) + (recent.fusedSources || 0),
      imageCount: recent.images.length, duplicate: details.filter(i => i.duplicate.length).length, unrelated: details.filter(i => i.unrelated.length).length,
      reviewCount: recent.reviews.length, failures, interrupted: recent.status === 'processing' || recent.status === 'interrupted',
      undone: recent.status === 'undone', canUndo: recent.status === 'completed' && !!(recent.additions.length || recent.updates.length || recent.reviews.length),
      conflicts: (recent.undoConflicts || []).length } : null });
    if (this.data.resultCategory) this.showResultCategory({ currentTarget: { dataset: { category: this.data.resultCategory } } });
  },
  recoverInterrupted() {
    for (const batch of this.importState.batches.slice()) {
      if (batch.status !== 'processing' && batch.status !== 'interrupted') continue;
      const next = JSON.parse(JSON.stringify(batch));
      next.images = next.images.map(i => i.state === 'queued' ? { ...i, state: 'failed', status: 'INTERRUPTED' } : i);
      next.status = 'interrupted';
      const candidates = next.images.flatMap(i => i.candidates);
      const plan = decision.evaluate(fuse(candidates, name => stations.resolve(this.stationState, name).id).map(c => stations.assist(this.stationState, c)).filter(c => !(next.resolved || []).includes(c.id)), this.data.records, this.stationState);
      const completed = batches.apply(next, plan, next.images);
      if (!this.persistBatch(completed, plan.records)) break;
    }
  },
  showImportFailures() {
    this.setData({ activeTab: 'import', batchError: '' });
    this.showResultCategory({ currentTarget: { dataset: { category: 'allFailure' } } });
  },
  retryFailures(e) {
    const batchId = e.currentTarget.dataset.batchId;
    const failed = this.importState.batches.filter(b => b.status !== 'undone' && (!batchId || b.id === batchId))
      .flatMap(b => importResults.details(b).filter(i => i.failure.length));
    if (failed.length === 1) return this.retryImage({ currentTarget: { dataset: { batchId: failed[0].batchId, imageIndex: failed[0].index } } });
    this.setData({ activeTab: 'import' });
    this.showResultCategory({ currentTarget: { dataset: { category: batchId ? 'failure' : 'allFailure' } } });
  },
  showResultCategory(e) {
    const category = e.currentTarget.dataset.category;
    if (!['duplicate', 'unrelated', 'failure', 'allFailure'].includes(category)) return;
    const all = category === 'allFailure';
    const key = all ? 'failure' : category;
    const selected = this.importState.batches.filter(b => b.status !== 'undone' && (all || b.id === this.data.recentImport.id));
    const items = selected.flatMap(b => importResults.details(b).filter(i => i[key].length).map(i => ({
      ...i, key: `${b.id}-${i.index}`, reason: i[key].join('；'), path: (this.batchImagePaths.get(b.id) || [])[i.index] || '', retryable: key === 'failure',
    })));
    this.setData({ resultCategory: category, categoryItems: items, categoryTitle: { duplicate: '重复', unrelated: '无关', failure: '失败' }[key] });
  },
  closeResultCategory() { this.setData({ resultCategory: '', categoryItems: [] }); },
  availableImage(batchId, index) {
    const paths = this.batchImagePaths.get(batchId) || [];
    const path = paths[index];
    if (!path) return '';
    try {
      if (wx.getFileSystemManager && wx.getFileSystemManager().accessSync) wx.getFileSystemManager().accessSync(path);
      return path;
    } catch (_) { paths[index] = ''; return ''; }
  },
  sourceImageError(e) {
    const { batchId, imageIndex } = e.currentTarget.dataset;
    const paths = this.batchImagePaths.get(batchId) || []; paths[Number(imageIndex)] = '';
    if (this.data.exceptionOpen) this.openExceptions({ keepSession: true });
  },
  async selectSourceImage(e) {
    if (this.data.choosing || this.data.loading) return;
    const { batchId, imageIndex } = e.currentTarget.dataset, index = Number(imageIndex);
    const batch = this.importState.batches.find(b => b.id === batchId);
    if (!batch || !batch.images[index]) return;
    this.setData({ choosing: true });
    try {
      const selected = await wx.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album'] });
      const file = (selected.tempFiles || [])[0];
      if (!file || !file.path || !(file.size > 0) || file.size > MAX_BYTES) return;
      const [identity] = await imageDedup.inspect(wx, [file.path]);
      if (this.unloaded) return;
      if (batch.images[index].hash && identity.hash !== batch.images[index].hash) {
        if (wx.showToast) wx.showToast({ title: '请选择同一张原图', icon: 'none' }); return;
      }
      const paths = this.batchImagePaths.get(batchId) || batch.images.map(() => '');
      paths[index] = file.path; this.batchImagePaths.set(batchId, paths);
      if (!batch.images[index].hash || batch.images[index].candidates.some(c => !(c.sourceRegions || []).length)) {
        this.setData({ choosing: false });
        return await this.retryImage(e);
      }
      this.openExceptions({ keepSession: true });
    } catch (_) { /* Selection cancellation leaves the exception intact. */ }
    finally { if (!this.unloaded) this.setData({ choosing: false }); }
  },
  toggleExceptionEvidence() { this.setData({ 'currentException.evidenceOpen': !this.data.currentException.evidenceOpen }); },
  previewResultImage(e) {
    const { batchId, imageIndex } = e.currentTarget.dataset;
    const path = this.availableImage(batchId, Number(imageIndex));
    if (path) wx.previewImage({ current: path, urls: [path], fail: () => this.sourceImageError(e) });
    else if (this.data.exceptionOpen) this.openExceptions({ keepSession: true });
  },
  viewPending() { this.setData({ activeTab: 'home', resultCategory: '' }); },
  undoImport() {
    if (this.data.loading || this.data.importing || this.data.deleting || this.data.storageBlocked) return;
    const recent = this.data.recentImport;
    const batch = recent && this.importState.batches.find(b => b.id === recent.id && b.status === 'completed');
    if (!batch) return;
    const undone = batches.undo(batch, this.data.records);
    if (this.persistBatch(undone.batch, undone.records)) {
      this.setData({ batchError: '', newStations: [], resultCategory: '', exceptionOpen: false });
      if (wx.showToast) wx.showToast({ title: undone.conflicts.length ? `已撤销，保留 ${undone.conflicts.length} 件后续修改` : '已撤销本次导入', icon: 'none' });
      if (this.recognitionRun && this.recognitionRun.batchId === batch.id) this.recognitionRun = null;
    }
  },
  reconcileExceptions() {
    if (this.data.storageBlocked || this.data.loading) return;
    let changed = false;
    const next = { ...this.importState, batches: this.importState.batches.map(batch => {
      const completed = [], reviews = [];
      for (const r of batch.reviews) {
        const d = decision.classify(r.candidate, this.data.records, this.stationState);
        if (d.decision === decision.AUTO_SKIP && !d.update) { completed.push({ ...r, finalReason: d.reason }); changed = true; continue; }
        const matches = d.matches || [], conflictFields = d.conflictFields || [];
        if (JSON.stringify([r.matches, r.conflictFields || [], r.allowNew]) !== JSON.stringify([matches, conflictFields, d.allowNew !== false])) {
          const updated = { ...r, matches, conflictFields, allowNew: d.allowNew !== false };
          delete updated.choice; reviews.push(updated); changed = true;
        } else reviews.push(r);
      }
      const completedReasons = new Map(completed.map(r => [r.id, r.finalReason]));
      return { ...batch, reviews,
        resolved: [...new Set([...(batch.resolved || []), ...completed.flatMap(r => r.candidate.sourceIds || [r.id])])],
        outcomes: batch.outcomes.map(o => completedReasons.has(o.id) ? { ...o, decision: decision.AUTO_SKIP, reason: completedReasons.get(o.id) } : o) };
    }) };
    if (changed) this.persistRecords(this.data.records, next);
  },
  openExceptions({ keepSession = false } = {}) {
    this.reconcileExceptions();
    const entries = this.importState.batches.flatMap(b => b.reviews.map(r => {
      const indices = [...new Set([...(r.candidate.sourceIndices || [r.candidate.sourceIndex]), ...(r.candidate.relatedSourceIndices || [])])].filter(i => i >= 0);
      const index = indices[0];
      const statusNames = { unknown: '未知', transit: '运输中', pending: '待取件', signed: '物流签收', collected: '已领取', cancelled: '取消或退回', terminal: '已取或退回', conflict: '状态矛盾' };
      const sources = indices.map(imageIndex => {
        const raw = b.images[imageIndex] ? b.images[imageIndex].candidates : [];
        const candidates = raw.filter(c => (r.candidate.sourceIds || [r.id]).includes(c.id) || identity.sameWaybill(c, r.candidate) || c.code && c.code === r.candidate.code);
        const values = candidates.flatMap(c => ['code', 'station', 'pickupAddress', 'carrier', 'waybillNumber', 'parcelStatus', 'noticeAt'].filter(f => c[f]).map(f => {
          const value = f === 'noticeAt' ? new Date(c[f]).toLocaleString() : f === 'parcelStatus' ? statusNames[c[f]] : c[f];
          return `${identity.labels[f]}：${value}`;
        }));
        const regions = (r.candidate.sourceRegions || []).filter(s => s.imageIndex === imageIndex);
        return { imageIndex, imageId: `${b.id}:${imageIndex}`, batchId: b.id, label: `本次截图 ${imageIndex + 1}`,
          path: this.availableImage(b.id, imageIndex), needsRecognition: !b.images[imageIndex].hash || b.images[imageIndex].candidates.some(c => !(c.sourceRegions || []).length), values: [...new Set(values)], regions,
          fields: [...new Set(regions.flatMap(s => s.fields))].map(f => identity.labels[f] || f).join('、') };
      });
      const conflicts = r.conflictFields && r.conflictFields.length ? r.conflictFields : r.candidate.conflictFields || (r.reason === 'status_conflict' ? ['parcelStatus'] : []);
      return { ...r.candidate, id: r.id, batchId: b.id, reason: r.reason,
        message: decision.reasonText[r.reason], sources, conflictText: conflicts.map(f => identity.labels[f] || f).join('、'), evidenceOpen: false, matches: r.matches, allowNew: r.allowNew,
        action: r.choice && r.choice.action || '', selectedStation: r.choice ? r.choice.station : stations.known(r.candidate.station) ? r.candidate.station : '',
        locationOnly: r.reason === 'missing_location', needsCode: !validCode(r.candidate.code),
        imageIndex: index, failed: b.images[index] && b.images[index].state === 'failed', path: this.availableImage(b.id, index), options: r.candidate.locationOptions || [] };
    }));
    if (!keepSession || !this.exceptionSession) this.exceptionSession = { total: entries.length, deferred: new Set() };
    const available = entries.filter(r => !this.exceptionSession.deferred.has(r.id));
    const current = available[0] || null;
    this.setData({ activeTab: 'import', exceptionOpen: !!current, exceptionItems: entries, currentException: current,
      exceptionProgress: current ? `${this.exceptionSession.total - available.length + 1}/${this.exceptionSession.total}` : '', editing: null });
  },
  closeExceptions() { this.setData({ exceptionOpen: false, editing: null, activeTab: 'import' }); this.exceptionSession = null; },
  deferException() {
    if (!this.data.currentException || this.data.storageBlocked) return;
    this.exceptionSession.deferred.add(this.data.currentException.id);
    this.openExceptions({ keepSession: true });
  },
  async chooseExceptionStation(e) {
    const entry = this.data.currentException;
    if (!entry || entry.id !== e.currentTarget.dataset.id || this.data.choosing || this.data.storageBlocked) return;
    const names = [...new Set([...entry.options, ...this.data.stationList.map(s => s.name)])];
    const options = names.slice(0, 5);
    this.setData({ choosing: true });
    try {
      const answer = await wx.showActionSheet({ itemList: [...options, '手动填写'] });
      if (this.unloaded || !this.data.currentException || this.data.currentException.id !== entry.id) return;
      if (answer.tapIndex === options.length) this.editException(e);
      else if (options[answer.tapIndex]) this.chooseException({ currentTarget: { dataset: { id: entry.id, action: 'new', station: options[answer.tapIndex] } } });
    } catch (_) { /* Dismiss keeps this issue. */ }
    finally { if (!this.unloaded) this.setData({ choosing: false }); }
  },
  exceptionStationInput(e) { this.updateException(e.currentTarget.dataset.id, { station: e.detail.value }); },
  chooseException(e) {
    const { id, action, station } = e.currentTarget.dataset;
    if (!['new', 'skip'].includes(action) || !this.data.currentException || this.data.currentException.id !== id) return;
    if (this.updateException(id, { action, ...(station ? { station } : {}) })) this.applyExceptions(id);
  },
  updateException(id, changes) {
    if (this.data.storageBlocked || this.data.loading) return false;
    const batch = this.importState.batches.find(b => b.reviews.some(r => r.id === id));
    if (!batch) return false;
    const next = JSON.parse(JSON.stringify(batch)), entry = next.reviews.find(r => r.id === id);
    entry.choice = { action: 'new', station: stations.known(entry.candidate.station) ? entry.candidate.station : '', ...(entry.choice || {}), ...changes };
    if (entry.choice.station.length > 100) return false;
    const saved = this.persistBatch(next);
    if (saved) this.openExceptions({ keepSession: true });
    return saved;
  },
  applyExceptions(id) {
    if (this.data.loading || this.data.importing || this.data.storageBlocked || this.data.deleting) return;
    id = typeof id === 'string' ? id : this.data.currentException && this.data.currentException.id;
    const original = this.importState.batches.find(b => b.reviews.some(r => r.id === id));
    if (!original) return;
    const batch = JSON.parse(JSON.stringify(original)), review = batch.reviews.find(r => r.id === id);
    if (!review.choice) return;
    const { action, station } = review.choice;
    let records = this.data.records.slice(), added;
    if (action === 'new') {
      const c = review.candidate;
      if (!validCode(c.code) || !review.allowNew) return;
      const current = decision.classify({ ...c, station: station.trim() || parser.UNKNOWN }, records, this.stationState);
      const owned = new Set(batch.additions.map(r => r.id));
      const matchKey = matches => JSON.stringify((matches || []).filter(m => !owned.has(m.id)).map(m => [m.id, m.taken, m.code, m.station, m.carrier || '', m.pickupAddress || '', m.waybillNumber || '']).sort());
      if (matchKey(current.matches) !== matchKey(review.matches)) {
        review.matches = current.matches || []; review.allowNew = current.allowNew !== false;
        review.reason = current.reason === 'missing_location' ? 'missing_location' : 'record_conflict'; delete review.choice;
        if (this.persistBatch(batch)) this.openExceptions({ keepSession: true });
        if (wx.showToast) wx.showToast({ title: '记录已变化，请重新选择', icon: 'none' });
        return;
      }
      if (current.decision === decision.AUTO_SKIP && current.reason === 'pending_duplicate') {
        batch.resolved = [...(batch.resolved || []), ...(c.sourceIds || [id])];
        batch.reviews = batch.reviews.filter(r => r.id !== id);
        batch.outcomes = batch.outcomes.map(o => o.id === id ? { id, decision: decision.AUTO_SKIP, reason: 'pending_duplicate' } : o);
        if (this.persistBatch(batch, records)) this.openExceptions({ keepSession: true });
        return;
      }
      if (c.waybillNumber && records.some(r => identity.sameWaybill(r, c))) return;
      added = storage.newRecord({ ...c, parcelStatus: 'pending', station: station.trim() || parser.UNKNOWN,
        confirmedFields: [...new Set([...(c.confirmedFields || []), 'code', ...(station.trim() ? ['station'] : [])])] }, records);
      records.push(added); batch.additions.push(added);
    }
    batch.resolved = [...new Set([...(batch.resolved || []), id, ...(review.candidate.sourceIds || [])])];
    batch.reviews = batch.reviews.filter(r => r.id !== id);
    batch.outcomes = batch.outcomes.map(o => o.id === id ? { id, decision: action === 'new' ? decision.AUTO_IMPORT : decision.AUTO_SKIP, reason: action === 'new' ? 'manual_new' : 'user_skip' } : o);
    if (!this.persistBatch(batch, records)) return;
    if (added && station.trim() && !stations.suspicious(station)) this.saveStations(stations.remember(this.stationState, added));
    this.setData({ batchError: '' });
    this.openExceptions({ keepSession: true });
  },
  retryException(e) { return this.retryImage(e); },
  editException(e) {
    const entry = this.data.exceptionItems.find(r => r.id === e.currentTarget.dataset.id);
    if (entry) this.setData({ editing: { ...entry, station: entry.selectedStation || parser.UNKNOWN, exception: true }, editError: '' });
  },
  markStationCommon(e) {
    const group = this.stationState.groups.find(g => g.id === e.currentTarget.dataset.id);
    if (group) {
      try { if (this.saveStations(stations.remember(this.stationState, { station: group.name }))) this.setData({ stationEditor: null }); }
      catch (err) { this.setData({ stationError: err.message }); }
    }
  },
  addNewStations() {
    const names = this.data.newStations;
    let state = this.stationState;
    names.forEach(station => { state = stations.remember(state, { station }); });
    if (this.saveStations(state)) this.setData({ newStations: [] });
  },
  async confirmImport() {
    if (this.unloaded || this.data.loading || this.data.choosing || this.data.importing || this.data.deleting || this.data.stationBusy || this.data.storageBlocked || !this.data.drafts.length) return;
    const batchDrafts = this.data.drafts.slice();
    const importingDrafts = batchDrafts.filter(r => validCode(r.code));
    if (!importingDrafts.length) {
      this.setDrafts(this.data.drafts, { errorScope: "import", error: "未找到取件码，请填写有效号码后导入。" }); return;
    }
    if (importingDrafts.some(r => !r.station.trim() || r.station.trim().length > 100 ||
      !r.code.trim() || r.code.trim().length > 32)) {
      this.setData({ error: "请先修改异常记录：地点需为 1–100 字，取件码需为 1–32 字。" });
      return;
    }
    this.setData({ importing: true, error: "", errorScope: "import", importFeedback: "", editing: null });
    try {
      const original = this.data.records.slice(), choices = {};
      const resume = this.reviewResume;
      // Reuse explicit choices only while the history and the individual draft are unchanged.
      if (resume && JSON.stringify(resume.original) === JSON.stringify(original)) {
        importingDrafts.forEach(draft => {
          const previous = resume.drafts.find(r => r.id === draft.id);
          if (previous && JSON.stringify(previous) === JSON.stringify(draft) && resume.choices[draft.id]) choices[draft.id] = resume.choices[draft.id];
        });
      }
      const session = { original, drafts: importingDrafts, choices, newRecords: new Map() };
      let plan = duplicates.planImport(session.original, session.drafts, session.choices, session.newRecords);
      if (plan.reviews.length) {
        this.reviewResume = session;
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
      if (importingDrafts.some(r => !validCode(r.code))) { this.setData({ error: "取件码无效，请重新核对。" }); return; }
      if ((plan.added || plan.updated) && !this.persistRecords(plan.records)) return;
      this.reviewResume = null;
      this.recognitionRun = null;
      const { added, updated, skipped } = plan;
      if (updated) {
        this.clearUndo();
        this.undoRecord = { kind: "merge", updates: plan.updates, until: Date.now() + 5000 };
        this.setData({ undoAvailable: true, undoMessage: `已更新 ${updated} 件信息` });
        this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
      }
      const drafts = this.data.drafts.filter(r => !batchDrafts.some(imported => imported.id === r.id));
      this.setDrafts(drafts, {
        ...(!this.data.loading && !drafts.length ? { images: [], results: [], completed: false } : {}),
        ...(!drafts.length ? { notificationOpen: false, notificationText: "" } : {}),
        error: "", errorScope: "", activeTab: "import",
        collapsedStations: this.data.collapsedStations.filter(station => !importingDrafts.some(r => r.station === station)) });
      this.showImportFeedback(`已新增 ${added} 件，更新 ${updated} 件，跳过重复 ${skipped} 件`);
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
    if (this.data.dragId) return;
    const record = this.data.records.find(r => r.id === e.currentTarget.dataset.id && !r.taken);
    if (!record) return;
    wx.setClipboardData({ data: record.code,
      success: () => wx.showToast({ title: "取件码已复制", icon: "none" }),
      fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" }) });
  },
  noop() {},
  switchTab(e) {
    const activeTab = e.currentTarget.dataset.tab;
    if (!["home", "import", "history"].includes(activeTab) || this.data.importing || this.data.deleting || this.data.stationBusy) return;
    this.closeDelete();
    if (this.data.notificationOpen && activeTab !== "import") this.cancelNotification();
    this.cancelStationDrag();
    clearTimeout(this.feedbackTimer);
    this.setData({ activeTab, editing: null, editError: "", error: "", errorScope: "", importFeedback: "" });
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  toggleGroup(e) {
    if (this.data.dragId || Date.now() < (this.suppressGroupTapUntil || 0)) return;
    const station = e.currentTarget.dataset.station;
    const collapsed = this.data.collapsedStations;
    this.setData({ collapsedStations: collapsed.includes(station) ? collapsed.filter(s => s !== station) : [...collapsed, station] });
    const patch = {};
    ["pendingGroups", "visiblePendingGroups"].forEach(field => this.data[field].forEach((g, index) => {
      if (g.station === station) patch[`${field}[${index}].collapsed`] = !collapsed.includes(station);
    }));
    this.setData(patch);
  },
  toggleTaken(e) {
    if (this.data.dragId || this.data.importing || this.data.deleting || this.data.stationBusy || this.data.storageBlocked || Date.now() < (this.suppressTapUntil || 0)) return;
    const record = this.data.records.find(r => r.id === e.currentTarget.dataset.id);
    if (!record || this.lastTakenId === record.id && Date.now() - this.lastTakenAt < 350) return;
    this.lastTakenId = record.id; this.lastTakenAt = Date.now();
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
  closeDelete() { if (this.data.openDeleteId || this.data.swipeId) this.setData({ openDeleteId: "", swipeId: "", swipeStyle: "" }); },
  onPageScroll(e) { this.closeDelete(); this.pageScrollTop = e && e.scrollTop || 0; if (this.stationDragging) this.renderStationDrag(); },
  onHide() { this.closeDelete(); this.swipe = null; this.cancelStationDrag(); },
  recordTap() { if (Date.now() >= (this.suppressTapUntil || 0)) this.closeDelete(); },
  touchStart(e) {
    this.swipe = null;
    const id = e.currentTarget.dataset.id;
    if (this.data.deleting || this.data.storageBlocked || e.touches.length !== 1 ||
      !this.data.records.some(r => r.id === id && r.taken)) return;
    const t = e.touches[0];
    this.swipe = { id, x: t.clientX, y: t.clientY, axis: "", offset: this.data.openDeleteId === id ? -80 : 0 };
    if (this.data.openDeleteId !== id) this.closeDelete();
  },
  touchMove(e) {
    const swipe = this.swipe;
    if (!swipe) return;
    if (e.touches.length !== 1) { this.touchCancel(); return; }
    const dx = Math.abs(e.touches[0].clientX - swipe.x), dy = Math.abs(e.touches[0].clientY - swipe.y);
    if (!swipe.axis && Math.max(dx, dy) >= 12) swipe.axis = dx > dy * 1.5 ? "x" : "y";
    if (swipe.axis === "y") this.closeDelete();
    if (swipe.axis === "x" && Date.now() - (swipe.frame || 0) >= 16) {
      swipe.frame = Date.now();
      const offset = Math.max(-80, Math.min(0, swipe.offset + e.touches[0].clientX - swipe.x));
      this.setData({ swipeId: swipe.id, swipeStyle: `transform: translateX(${offset}px); transition: none;` });
    }
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
    this.setData({ swipeId: "", swipeStyle: "" });
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
  async openHistoryMenu() {
    if (this.menuOpen || this.data.loading || this.data.deleting || this.data.importing || this.data.storageBlocked || !this.data.history.length) return;
    this.menuOpen = true;
    try {
      const answer = await wx.showActionSheet({ itemList: ['清空历史'] });
      if (answer.tapIndex === 0 && !this.unloaded) await this.clearHistory();
    } catch (_) { /* Dismiss keeps history. */ }
    finally { this.menuOpen = false; }
  },
  async clearHistory() {
    if (this.data.deleting || this.data.importing || this.data.loading || this.data.storageBlocked || !this.data.history.length) return;
    this.setData({ deleting: true });
    try {
      const answer = await wx.showModal({ title: '清空已取历史？', content: '仅删除已取件记录，待取件和驿站保留。5 秒内可撤销。', confirmText: '清空历史', confirmColor: '#FF453A' });
      if (!answer.confirm || this.unloaded || this.data.storageBlocked) return;
      const before = this.data.records.slice(), after = before.filter(r => !r.taken);
      if (!this.persistRecords(after)) return;
      this.clearUndo();
      this.undoRecord = { kind: 'clear-history', records: before, after: JSON.stringify(after), until: Date.now() + 5000 };
      this.setData({ openDeleteId: '', undoAvailable: true, undoMessage: '已清空历史' });
      this.undoTimer = setTimeout(() => this.clearUndo(), 5000);
    } catch (_) { if (!this.unloaded) this.setData({ error: '清空未完成，请重试' }); }
    finally { if (!this.unloaded) this.setData({ deleting: false }); }
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
        confirmText: "删除", confirmColor: "#FF453A" });
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
    if (undo.kind === 'station-delete') {
      if (this.data.stationBlocked || JSON.stringify(this.stationState) !== undo.after) {
        this.clearUndo(); if (wx.showToast) wx.showToast({ title: '设置已变化，无法撤销', icon: 'none' }); return;
      }
      if (this.saveStations(undo.before)) this.clearUndo();
      return;
    }
    if (undo.kind === 'clear-history') {
      if (JSON.stringify(records) !== undo.after) {
        this.clearUndo();
        if (wx.showToast) wx.showToast({ title: '记录已变化，无法撤销清空', icon: 'none' });
        return;
      }
      if (this.persistRecords(undo.records)) this.clearUndo();
      return;
    }
    if (undo.kind === "batch-taken") {
      if (undo.updates.some(u => !records.some(r => r.id === u.after.id && JSON.stringify(r) === JSON.stringify(u.after)))) {
        this.clearUndo(); wx.showToast({ title: "记录已变化，请在历史中恢复", icon: "none" }); return;
      }
      if (this.persistRecords(records.map(r => {
        const update = undo.updates.find(u => u.before.id === r.id);
        return update ? update.before : r;
      }))) this.clearUndo();
      return;
    }
    if (undo.kind === "merge") {
      if (undo.updates.some(u => !records.some(r => r.id === u.after.id && JSON.stringify(r) === JSON.stringify(u.after)))) {
        this.clearUndo();
        if (wx.showToast) wx.showToast({ title: "记录已变化，请手动修改", icon: "none" });
        return;
      }
      const restored = records.map(r => {
        const update = undo.updates.find(u => u.before.id === r.id);
        return update ? storage.updateRecord(r, { station: update.before.station, carrier: update.before.carrier, waybillNumber: update.before.waybillNumber, pickupAddress: update.before.pickupAddress }) : r;
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
  persistRecords(records, imports) {
    try {
      this.updateRecords(this.store.save(records, imports));
      if (imports) { this.importState = imports; this.refreshBatchSummary(); }
      return true;
    } catch (err) {
      this.setData({ storageError: err.message, storageBlocked: true });
      return false;
    }
  },
  updateRecords(records) {
    if (this.stationDragging) this.cancelStationDrag();
    const pending = records.filter(r => !r.taken);
    const next = stations.sync(this.stationState, records);
    if (!this.data.stationBlocked && !this.data.storageBlocked && JSON.stringify(next) !== JSON.stringify(this.stationState)) {
      try { this.stationState = this.stationStore.save(next); }
      catch (err) { this.setData({ stationError: err.message, stationBlocked: true }); }
    }
    const pendingGroups = stations.group(this.stationState, pending).map(g => ({ ...g,
      sortable: this.stationState.groups.some(s => s.id === g.id),
      tone: g.id === "__unknown" ? "orange" : ["blue", "purple", "cyan", "orange"][Array.from(g.id).reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 0) % 4],
      collapsed: this.data.collapsedStations.includes(g.station) }));
    const stationList = this.stationState.groups.map(g => ({ ...g,
      count: (pendingGroups.find(p => p.id === g.id) || { items: [] }).items.length }));
    this.setData({ records, groups: parser.group(records), pendingGroups, stationList, stationSuggestions: stations.suggestions(this.stationState),
      locationCount: pendingGroups.filter(g => g.station !== parser.UNKNOWN).length,
      unknownCount: pendingGroups.filter(g => g.id === "__unknown").reduce((sum, g) => sum + g.items.length, 0),
      history: records.filter(r => r.taken).sort((a, b) => b.takenAt - a.takenAt).map(r => {
        const date = new Date(r.takenAt);
        const pad = n => String(n).padStart(2, "0");
        return { ...r, takenTimeLabel: r.takenAt && Number.isFinite(date.getTime()) ? `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : "取件时间未记录" };
      }), remaining: pending.length });
    this.presentRows("visiblePendingGroups", pendingGroups, true);
    this.presentRows("visibleHistory", this.data.history);
  },
  editRecord(e) {
    if (this.data.loading) return;
    if (this.data.dragId || this.data.importing || this.data.deleting || Date.now() < (this.suppressTapUntil || 0)) return;
    this.closeDelete();
    const record = [...this.data.records, ...this.data.drafts].find(r => r.id === e.currentTarget.dataset.id);
    if (record) this.setData({ editing: { ...record }, editError: "" });
  },
  editStation(e) { this.setData({ "editing.station": e.detail.value }); },
  editPickupAddress(e) { this.setData({ "editing.pickupAddress": e.detail.value }); },
  editCarrier(e) { this.setData({ "editing.carrier": e.detail.value }); },
  editCode(e) { this.setData({ "editing.code": e.detail.value }); },
  cancelEdit() { this.setData({ editing: null }); },
  saveEdit() {
    if (this.data.loading || this.data.importing || this.data.deleting || this.data.stationBusy) return;
    const edit = this.data.editing;
    if (!edit || !edit.station.trim() || !validCode(edit.code) || edit.station.trim().length > 100 || edit.code.trim().length > 32 || (edit.carrier || "").trim().length > 40 || (edit.pickupAddress || "").trim().length > 100) {
      this.setData({ editError: "请填写真实有效的取件码和地点，不能使用占位文字、电话或日期。" }); return;
    }
    const changes = { station: edit.station.trim(), code: edit.code.trim(), carrier: (edit.carrier || "").trim() };
    if (edit.pickupAddress !== undefined) changes.pickupAddress = edit.pickupAddress.trim();
    if (edit.exception) {
      const batch = this.importState.batches.find(b => b.reviews.some(r => r.id === edit.id));
      if (!batch) return;
      const next = JSON.parse(JSON.stringify(batch));
      const entry = next.reviews.find(r => r.id === edit.id);
      entry.candidate = batches.cleanCandidate({ ...entry.candidate, ...changes, memoryAddress: false, confirmedFields: ['code', 'station', 'carrier', 'pickupAddress'] });
      entry.choice = { action: 'new', station: changes.station };
      if (this.persistBatch(next)) { this.setData({ editing: null }); this.applyExceptions(edit.id); }
      return;
    }
    const original = [...this.data.records, ...this.data.drafts].find(r => r.id === edit.id);
    if (!original) return;
    changes.confirmedFields = [...new Set([...(original.confirmedFields || []), ...Object.keys(changes).filter(key =>
      changes[key] !== (original[key] || "") || (changes[key] && changes[key] !== parser.UNKNOWN))])];
    if (this.data.drafts.some(r => r.id === edit.id)) {
      const drafts = this.data.drafts.map(r => r.id === edit.id ? { ...r, ...changes, needsReview: false } : r);
      if (this.recognitionRun) (original.sourceIds || [original.id]).forEach(id => this.recognitionRun.edits.set(id, changes));
      this.setDrafts(drafts);
    } else {
      if (this.data.storageBlocked || !this.persistRecords(this.data.records.map(r => r.id === edit.id ? storage.updateRecord(r, changes) : r))) return;
    }
    if (this.data.records.some(r => r.id === edit.id) && stations.known(changes.station) && !stations.suspicious(changes.station)) this.saveStations(stations.remember(this.stationState, changes));
    this.setData({ editing: null });
  },
});
