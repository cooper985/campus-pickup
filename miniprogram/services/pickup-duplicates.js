const { validWaybill, newRecord, updateRecord } = require("./pickup-store");
const normalize = value => String(value || "").normalize("NFKC")
  .replace(/[—–－﹣]/g, "-").replace(/\s/g, "").toUpperCase();

const unknownStation = value => /^(?:待确认|待确认地点|地点待确认)?$/.test(normalize(value));
function findMatches(candidate, records) {
  const waybill = normalize(candidate.waybillNumber);
  const exact = validWaybill(waybill) ? records.filter(r => normalize(r.waybillNumber) === waybill) : [];
  if (exact.length) return exact.map(record => ({ kind: "waybill", record }));
  return records.filter(r => {
    if (validWaybill(waybill) && validWaybill(normalize(r.waybillNumber)) && normalize(r.waybillNumber) !== waybill) return false;
    return normalize(r.code) === normalize(candidate.code);
  }).map(record => ({ kind: record.taken ? "reused-code"
    : !unknownStation(record.station) && !unknownStation(candidate.station) && normalize(record.station) !== normalize(candidate.station)
      ? "location-conflict" : "pending-code", record }));
}
function findDuplicate(candidate, records) {
  const matches = findMatches(candidate, records);
  return matches.find(m => !m.record.taken) || matches[0] || null;
}
function assess(candidate, match) {
  const old = match.record;
  const locked = old.confirmedFields || [];
  const patch = {};
  const reliableStation = !unknownStation(candidate.station) && !candidate.needsReview;
  if (unknownStation(old.station) && reliableStation && locked.indexOf("station") < 0) patch.station = candidate.station.trim();
  if (!old.carrier && candidate.carrier && locked.indexOf("carrier") < 0) patch.carrier = candidate.carrier.trim();
  if (!old.waybillNumber && validWaybill(normalize(candidate.waybillNumber))) patch.waybillNumber = normalize(candidate.waybillNumber);
  // Existing meaningful values are never overwritten, including legacy records with no provenance.
  const conflict = (!unknownStation(old.station) && reliableStation && normalize(old.station) !== normalize(candidate.station)) ||
    (old.carrier && candidate.carrier && normalize(old.carrier) !== normalize(candidate.carrier)) ||
    normalize(old.code) !== normalize(candidate.code);
  const canUpdate = Object.keys(patch).length > 0 && !conflict && (!old.taken || match.kind === "waybill");
  return { ...match, patch, canUpdate, conflict: !!conflict };
}

// Rebuild against the whole batch after each choice; no storage is written until final confirmation.
function planImport(original, drafts, choices = {}, newRecords = new Map()) {
  let records = original.slice();
  const reviews = [], changedIds = new Set(), addedIds = new Set();
  for (const draft of drafts) {
    const matches = findMatches(draft, records).map(m => assess(draft, m));
    const directSkip = matches.length === 1 && !matches[0].conflict && !Object.keys(matches[0].patch).length &&
      (!matches[0].record.taken || matches[0].kind === "waybill");
    let action = "new", target;
    if (matches.length) {
      if (directSkip) continue;
      const recommended = matches.length === 1 && matches[0].canUpdate;
      const choice = choices[draft.id];
      target = choice && matches.find(m => m.record.id === choice.targetId && m.canUpdate);
      action = choice ? choice.action : recommended ? "update" : "skip";
      if (action === "update" && !target) target = !choice && recommended ? matches[0] : null;
      if (action === "update" && !target) action = "skip";
      const allowNew = !matches.some(m => m.kind === "waybill");
      if (action === "new" && !allowNew) action = "skip";
      reviews.push({ id: draft.id, code: draft.code, station: draft.station, carrier: draft.carrier || "",
        action, targetId: target ? target.record.id : "", recommended, allowNew,
        reason: matches.length > 1 ? "有多条可能匹配的记录，请核对后选择"
          : matches[0].record.taken && matches[0].kind !== "waybill" ? "历史记录已取件，同码可能是新包裹"
            : matches[0].conflict ? "已有信息不同，保留原信息；如需纠错请手动修改"
              : recommended ? "发现可补全的信息，推荐更新原记录" : "已有字段受保护或没有可靠的新信息，推荐跳过",
        matches: matches.map(m => ({ id: m.record.id, station: m.record.station, code: m.record.code,
          carrier: m.record.carrier, taken: m.record.taken, canUpdate: m.canUpdate,
          additions: Object.keys(m.patch).map(k => ({ station: "地点", carrier: "快递公司", waybillNumber: "运单号" })[k]).join("、") })) });
    }
    if (action === "update") {
      const next = updateRecord(target.record, target.patch);
      records = records.map(r => r.id === next.id ? next : r);
      if (!addedIds.has(next.id)) changedIds.add(next.id);
    } else if (action === "new") {
      if (!newRecords.has(draft.id)) newRecords.set(draft.id, newRecord(draft, records));
      const next = newRecords.get(draft.id);
      records.push(next); addedIds.add(next.id);
    }
  }
  return { records, reviews, added: addedIds.size, updated: changedIds.size,
    skipped: drafts.length - addedIds.size - changedIds.size,
    updates: original.filter(r => changedIds.has(r.id)).map(before => ({ before, after: records.find(r => r.id === before.id) })) };
}

// Only attach metadata where the screenshot contains one parcel and one explicit number.
// Multi-parcel layout association is deliberately left to a future parser upgrade.
function metadata(lines, recordCount) {
  if (recordCount !== 1) return { carrier: "", waybillNumber: "" };
  const text = lines.join("\n").normalize("NFKC");
  const carriers = [...new Set(text.match(/顺丰速运|顺丰快递|中通快递|圆通速递|申通快递|韵达快递|极兔速递|邮政快递包裹|京东物流|德邦快递/g) || [])];
  const numbers = [];
  const pattern = /(?:运单号|快递单号|物流单号)\s*[:：]?\s*([A-Za-z0-9]{10,30})(?![A-Za-z0-9])/g;
  let match;
  while ((match = pattern.exec(text))) {
    const value = normalize(match[1]);
    if (validWaybill(value)) numbers.push(value);
  }
  const unique = [...new Set(numbers)];
  return { carrier: carriers.length === 1 ? carriers[0] : "", waybillNumber: unique.length === 1 ? unique[0] : "" };
}
module.exports = { findDuplicate, findMatches, planImport, metadata };
