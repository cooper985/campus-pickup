const KEY = "campus-pickup.records";
const BACKUP_KEY = `${KEY}.backup`;
const VERSION = 1;
const batches = require('./import-batches');
const CONFIRMABLE = ["station", "code", "carrier", "pickupAddress"];
const FIELDS = ["id", "station", "code", "carrier", "waybillNumber", "taken", "createdAt", "updatedAt", "takenAt"];
const copy = value => JSON.parse(JSON.stringify(value));
const time = value => Number.isSafeInteger(value) && value > 0;
const text = (value, max, required = false) =>
  typeof value === "string" && value.length <= max && (!required || !!value.trim());
function validWaybill(value) {
  return typeof value === "string" && /^(?=[A-Z0-9]{10,30}$)(?=.*\d)[A-Z0-9]+$/.test(value);
}
function validate(value) {
  if (!value || value.version !== VERSION || !time(value.savedAt) || !Array.isArray(value.records)) {
    throw new Error("本地数据格式异常或版本不兼容");
  }
  const ids = new Set();
  if (value.imports !== undefined) {
    batches.validate(value.imports).forEach(r => validate({ version: VERSION, savedAt: value.savedAt, records: [r] }));
  }
  for (const r of value.records) {
    if (!r || !text(r.id, 120, true) || ids.has(r.id) || !text(r.station, 100, true) ||
      (r.pickupAddress !== undefined && !text(r.pickupAddress, 100)) || !text(r.code, 32, true) || !text(r.carrier, 40) ||
      !(r.waybillNumber === "" || validWaybill(r.waybillNumber)) ||
      (r.noticeAt !== undefined && !time(r.noticeAt)) || typeof r.taken !== "boolean" || !time(r.createdAt) || !time(r.updatedAt) ||
      r.updatedAt < r.createdAt || (r.taken ? !time(r.takenAt) ||
        r.takenAt < r.createdAt || r.takenAt > r.updatedAt : r.takenAt !== null)) {
      throw new Error("本地记录字段异常");
    }
    if (r.parcelStatus !== undefined && !require('./import-evidence').statuses.includes(r.parcelStatus)) throw new Error('物流状态异常');
    if (r.confirmedFields !== undefined && (!Array.isArray(r.confirmedFields) ||
      r.confirmedFields.length > CONFIRMABLE.length || r.confirmedFields.some(f => CONFIRMABLE.indexOf(f) < 0))) {
      throw new Error("本地字段确认信息异常");
    }
    ids.add(r.id);
  }
  return value;
}
function storedRecord(record) {
  const result = {};
  FIELDS.forEach(key => { result[key] = record[key]; });
  if (record.pickupAddress !== undefined) result.pickupAddress = record.pickupAddress;
  if (record.confirmedFields !== undefined) result.confirmedFields = record.confirmedFields.slice();
  if (record.parcelStatus !== undefined) result.parcelStatus = record.parcelStatus;
  if (record.noticeAt !== undefined) result.noticeAt = record.noticeAt;
  return result;
}

// No OCR text, image paths or screenshot bytes cross this persistence boundary.
function createStore(api) {
  let loaded = false, blocked = false, baseline = undefined;
  function read(key) {
    const info = api.getStorageInfoSync();
    if (!info || !Array.isArray(info.keys)) throw new Error("无法读取本地存储");
    return info.keys.includes(key) ? api.getStorageSync(key) : undefined;
  }
  function load() {
    loaded = true;
    blocked = false;
    try {
      baseline = read(KEY);
      if (baseline !== undefined) {
        validate(baseline);
        return { records: baseline.records.map(storedRecord), ...(baseline.imports ? { imports: copy(baseline.imports) } : {}), blocked: false, error: "" };
      }
      if (read(BACKUP_KEY) === undefined) return { records: [], blocked: false, error: "" };
      throw new Error("主数据缺失");
    } catch (err) {
      blocked = true;
      let records = [];
      try {
        const backup = validate(read(BACKUP_KEY));
        records = backup.records.map(storedRecord);
      } catch (_) { /* Preserve every key for manual recovery. */ }
      return { records, blocked: true, error: records.length
        ? "本地数据读取异常，正在显示上一版备份（可能不是最新）。已暂停保存，请重启重试；请勿清理缓存。"
        : "本地数据读取异常或版本不兼容，已暂停保存以保护原数据。请重启重试；请勿清理缓存。" };
    }
  }
  function save(records, imports = baseline && baseline.imports) {
    if (!loaded || blocked) throw new Error("存储处于保护状态，请重启小程序重试；请勿清理缓存。");
    const next = validate({ version: VERSION, savedAt: Date.now(), records: records.map(storedRecord), ...(imports ? { imports: copy(imports) } : {}) });
    try {
      if (JSON.stringify(read(KEY)) !== JSON.stringify(baseline)) throw new Error("数据已改变");
      // Keep the previous valid snapshot before touching the primary key.
      if (baseline !== undefined) {
        api.setStorageSync(BACKUP_KEY, baseline);
        if (JSON.stringify(read(BACKUP_KEY)) !== JSON.stringify(baseline)) throw new Error("备份校验失败");
      }
      api.setStorageSync(KEY, next);
      if (JSON.stringify(read(KEY)) !== JSON.stringify(next)) throw new Error("保存校验失败");
      baseline = copy(next);
      return copy(next.records);
    } catch (_) {
      blocked = true;
      throw new Error("保存未能确认成功，界面保留上次记录，待导入内容仍保留。已暂停写入，请重启核对；请勿清理缓存。");
    }
  }
  return { load, save };
}

let sequence = 0;
function newRecord(draft, existing = [], now = Date.now()) {
  let id;
  do {
    id = `parcel-${now.toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  } while (existing.some(r => r.id === id));
  return storedRecord({ id, station: draft.station.trim(), code: draft.code.trim(),
    ...(draft.pickupAddress !== undefined ? { pickupAddress: draft.pickupAddress.trim() } : {}),
    carrier: draft.carrier || "", waybillNumber: draft.waybillNumber || "",
    taken: false, createdAt: now, updatedAt: now, takenAt: null,
    ...(draft.parcelStatus ? { parcelStatus: draft.parcelStatus } : {}),
    ...(draft.noticeAt ? { noticeAt: draft.noticeAt } : {}),
    ...(draft.confirmedFields ? { confirmedFields: draft.confirmedFields } : {}) });
}
function updateRecord(record, changes, now = Date.now()) {
  const updatedAt = Math.max(now, record.updatedAt + 1);
  const next = { ...record, ...changes, id: record.id, createdAt: record.createdAt, updatedAt };
  next.takenAt = next.taken ? (record.taken ? record.takenAt : updatedAt) : null;
  return storedRecord(next);
}
module.exports = { createStore, newRecord, updateRecord, validWaybill, KEY, BACKUP_KEY, VERSION };
