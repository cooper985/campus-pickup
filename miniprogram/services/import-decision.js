const { validCode } = require('./pickup-code');
const { validWaybill, newRecord, updateRecord } = require('./pickup-store');
const stations = require('./stations');
const identity = require('./parcel-identity');
const evidence = require('./import-evidence');
const { UNKNOWN } = require('./pickup-parser');
const norm = stations.normalize;
const AUTO_IMPORT = 'AUTO_IMPORT', AUTO_SKIP = 'AUTO_SKIP', NEEDS_REVIEW = 'NEEDS_REVIEW';
const reasonText = {
  missing_location: '这件快递缺少驿站', uncertain_code: '请核对取件码',
  batch_conflict: '这些通知可能是不同包裹',
  status_conflict: '这件快递的取件状态不明确', signed: '截图显示已签收，是否还需取件？',
  old_notice: '这是一条旧通知，还需取件吗？', historical_code: '这件快递以前取过',
  record_conflict: '与已有包裹信息不同', missing_code: '未找到可靠取件码',
};
function classify(candidate, records, state, now = Date.now()) {
  const c = { ...candidate };
  const result = (decision, reason, extra = {}) => ({ candidate: c, decision, reason, message: reasonText[reason] || '', ...extra });
  const sameCode = records.filter(r => c.code && norm(r.code) === norm(c.code) && !identity.differentWaybill(c, r));
  const exact = validWaybill(c.waybillNumber) ? records.filter(r => norm(r.waybillNumber) === norm(c.waybillNumber)) : [];
  const matches = exact.length ? exact : sameCode;
  const pending = matches.filter(r => !r.taken);
  const sameStation = (a, b) => stations.resolve(state, a).id === stations.resolve(state, b).id;
  const conflicts = r => identity.conflicts(r, { ...c, ...(c.memoryAddress ? { pickupAddress: '' } : {}) }, name => stations.resolve(state, name).id);
  const conflictFields = [...new Set([...(c.conflictFields || []), ...matches.flatMap(conflicts)])];
  const extra = { matches: matches.map(r => ({ id: r.id, code: r.code, station: r.station, taken: r.taken, carrier: r.carrier || '', pickupAddress: r.pickupAddress || '', waybillNumber: r.waybillNumber || '' })), allowNew: !exact.length, conflictFields };
  if (!validCode(c.code)) {
    if (exact.length === 1 && !c.unresolvedRegion) { c.code = exact[0].code; if (!stations.known(c.station)) c.station = exact[0].station; }
    else return c.parcelStatus === 'transit' && !c.unresolvedRegion ? result(AUTO_SKIP, 'in_transit', extra) : result(NEEDS_REVIEW, 'missing_code', extra);
  }
  if (c.uncertainCode) return result(NEEDS_REVIEW, 'uncertain_code', extra);
  if (c.batchConflict) return result(NEEDS_REVIEW, 'batch_conflict', extra);
  if (c.locationOptions && c.locationOptions.length > 1) return result(NEEDS_REVIEW, 'record_conflict', extra);
  if (c.parcelStatus === 'conflict' || c.timeConflict) return result(NEEDS_REVIEW, 'status_conflict', extra);
  if (['terminal', 'collected', 'cancelled'].includes(c.parcelStatus)) return pending.length ? result(NEEDS_REVIEW, 'status_conflict', extra) : result(AUTO_SKIP, 'terminal');
  if (c.parcelStatus === 'transit') {
    if (!exact.length) return result(AUTO_SKIP, 'in_transit', extra);
    const status = evidence.reconcile([c, exact[0]], true);
    if (status.parcelStatus !== 'pending') return result(NEEDS_REVIEW, 'status_conflict', { ...extra, conflictFields: ['parcelStatus'] });
  }
  if (c.parcelStatus === 'signed') return result(NEEDS_REVIEW, 'signed', extra);
  if (matches.length > 1 || matches.some(r => conflicts(r).length)) return result(NEEDS_REVIEW, 'record_conflict', extra);
  if (exact.length && exact[0].taken) return result(AUTO_SKIP, 'same_waybill');
  if (!exact.length && sameCode.some(r => r.taken)) return result(NEEDS_REVIEW, 'historical_code', extra);
  if (pending.length === 1) {
    const old = pending[0], patch = {}, locked = old.confirmedFields || [];
    if (exact.length && old.parcelStatus && old.parcelStatus !== 'unknown' && c.parcelStatus && c.parcelStatus !== 'unknown' && evidence.reconcile([old, c], true).parcelStatus === 'conflict') return result(NEEDS_REVIEW, 'status_conflict', { ...extra, conflictFields: ['parcelStatus'] });
    if (!exact.length && (!stations.known(old.station) || !stations.known(c.station) || c.noticeAt && c.noticeAt !== old.noticeAt)) return result(NEEDS_REVIEW, 'record_conflict', extra);
    // Code alone cannot justify changing an existing parcel's fields.
    const canEnrich = exact.length === 1 || stations.known(c.station) && stations.known(old.station) && sameStation(c.station, old.station);
    if (!canEnrich && !stations.known(old.station) && stations.known(c.station)) return result(NEEDS_REVIEW, 'record_conflict', extra);
    if (stations.known(c.station) && !stations.known(old.station) && locked.indexOf('station') < 0) patch.station = c.station;
    for (const field of ['pickupAddress', 'carrier', 'waybillNumber']) {
      if (!old[field] && c[field] && locked.indexOf(field) < 0 && (field !== 'waybillNumber' || validWaybill(c[field]))) patch[field] = c[field];
    }
    if (exact.length && c.noticeAt && (!old.noticeAt || c.noticeAt > old.noticeAt)) { patch.noticeAt = c.noticeAt; if (c.parcelStatus && c.parcelStatus !== 'unknown') patch.parcelStatus = c.parcelStatus; }
    return result(AUTO_SKIP, 'pending_duplicate', { ...extra, ...(canEnrich && Object.keys(patch).length ? { update: { before: old, after: updateRecord(old, patch, now) } } : {}) });
  }
  if (c.noticeAt && new Date(c.noticeAt).toDateString() !== new Date(now).toDateString()) return result(NEEDS_REVIEW, 'old_notice', extra);
  if (!stations.known(c.station)) return result(NEEDS_REVIEW, 'missing_location', extra);
  if (stations.suspicious(c.station)) return result(NEEDS_REVIEW, 'missing_location', extra);
  return result(AUTO_IMPORT, 'reliable');
}
// Pure shadow evaluation: callers decide whether to commit this plan.
function evaluate(candidates, records, state = { version: 1, groups: [] }, now = Date.now()) {
  const decisions = [];
  let next = records.slice();
  const additions = [], updates = [];
  for (const c of candidates) {
    const d = classify(c, next, state, now);
    decisions.push(d);
    if (d.decision === AUTO_IMPORT) {
      const record = newRecord(d.candidate, next, now); additions.push(record); next.push(record);
    } else if (d.update) {
      updates.push(d.update); next = next.map(r => r.id === d.update.before.id ? d.update.after : r);
    }
  }
  // Recheck unresolved candidates against every addition in the completed batch.
  for (let i = 0; i < decisions.length; i++) {
    if (decisions[i].decision !== NEEDS_REVIEW) continue;
    const final = classify(decisions[i].candidate, next, state, now);
    if (final.decision === AUTO_SKIP) {
      decisions[i] = final;
      if (final.update) { updates.push(final.update); next = next.map(r => r.id === final.update.before.id ? final.update.after : r); }
    }
  }
  return { records: next, decisions, additions, updates, reviews: decisions.filter(d => d.decision === NEEDS_REVIEW),
    skipped: decisions.filter(d => d.decision === AUTO_SKIP).length };
}
module.exports = { evaluate, classify, reasonText, AUTO_IMPORT, AUTO_SKIP, NEEDS_REVIEW, UNKNOWN };
