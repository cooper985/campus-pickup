const { validCode } = require('./pickup-code');
const identity = require('./parcel-identity');
const evidence = require('./import-evidence');
const { normalize, known } = identity;
const fields = ['code', 'station', 'pickupAddress', 'carrier', 'waybillNumber'];
function fuse(candidates, stationKey = normalize) {
  const groups = [];
  // Prefer complete waybills, so an incomplete candidate cannot bridge two parcels.
  const ordered = candidates.slice().sort((a, b) => Number(identity.validWaybill(b.waybillNumber)) - Number(identity.validWaybill(a.waybillNumber)));
  for (const c of ordered) {
    const compatible = groups.filter(group => !c.unresolvedRegion && !group.some(p => p.unresolvedRegion) && group.some(p => identity.same(c, p, stationKey)) && !group.some(p => identity.differentWaybill(c, p)));
    if (compatible.length === 1) compatible[0].push(c);
    else groups.push([c]);
  }
  const result = [];
  for (const group of groups) {
    const members = group.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
    const conflicts = [...new Set(members.flatMap(a => members.flatMap(b => identity.conflicts(a, b, stationKey))))];
    if (new Set(members.map(r => r.noticeAt).filter(Boolean)).size > 1 && !members.every(r => identity.sameWaybill(r, members[0]))) conflicts.push('noticeAt');
    if (members.some(r => r.uncertainCode)) conflicts.push('code');
    if (members.length > 1 && new Set(members.map(r => r.sourceIndex)).size !== members.length) conflicts.push('identity');
    if (conflicts.length) {
      result.push(...members.map(r => ({ ...r, sourceIds: [r.id], sourceIndices: [r.sourceIndex],
        conflictFields: [...new Set(conflicts)], relatedSourceIndices: [...new Set(members.map(r => r.sourceIndex))], batchConflict: true, needsReview: true })));
      continue;
    }
    const merged = { ...members[0], sourceIds: members.map(r => r.id), sourceIndices: [...new Set(members.map(r => r.sourceIndex))],
      sourceRegions: members.flatMap(r => r.sourceRegions || []), fieldSources: {} };
    for (const field of fields) {
      const providers = members.filter(r => field === 'station' ? known(r[field]) : !!r[field]);
      const provider = providers.find(r => (r.confirmedFields || []).includes(field)) || providers[0];
      if (provider) { merged[field] = provider[field]; merged.fieldSources[field] = provider.sourceIndex; }
    }
    const status = evidence.reconcile(members, members.every(r => identity.sameWaybill(r, members[0])));
    merged.parcelStatus = status.parcelStatus;
    merged.timeConflict = members.some(r => r.timeConflict) && status.parcelStatus === 'conflict';
    const times = members.map(r => r.noticeAt).filter(Boolean);
    if (times.length) merged.noticeAt = Math.max(...times);
    if (new Set(times).size > 1 && !members.every(r => identity.sameWaybill(r, members[0]))) { merged.batchConflict = true; merged.conflictFields = ['noticeAt']; }
    if (status.parcelStatus === 'conflict' || merged.timeConflict) merged.conflictFields = [...new Set([...(merged.conflictFields || []), 'parcelStatus'])];
    merged.statusEvents = members.flatMap(r => r.statusEvents || (r.noticeAt && r.parcelStatus ? [{ noticeAt: r.noticeAt, parcelStatus: r.parcelStatus }] : []));
    merged.confirmedFields = [...new Set(members.flatMap(r => r.confirmedFields || []))];
    merged.needsReview = !validCode(merged.code) || !known(merged.station) || status.parcelStatus === 'conflict' || !!merged.batchConflict;
    if (known(merged.station)) delete merged.locationOptions;
    result.push(merged);
  }
  const shape = code => normalize(code).replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  return result.sort((a, b) => candidates.findIndex(c => (a.sourceIds || [a.id]).includes(c.id)) - candidates.findIndex(c => (b.sourceIds || [b.id]).includes(c.id))).map(r => {
    const peers = result.filter(other => other !== r && !identity.differentWaybill(r, other));
    const sameBillConflict = peers.some(other => identity.sameWaybill(r, other) && r.code && other.code && normalize(other.code) !== normalize(r.code));
    const sameCodeConflict = peers.some(other => r.code && normalize(other.code) === normalize(r.code) && !identity.same(r, other, stationKey));
    if (sameBillConflict || sameCodeConflict) return { ...r, relatedSourceIndices: [...new Set([...(r.sourceIndices || []), ...peers.filter(p => identity.sameWaybill(r, p) || r.code && normalize(r.code) === normalize(p.code)).flatMap(p => p.sourceIndices || [p.sourceIndex])])], batchConflict: true, conflictFields: [sameBillConflict ? 'code' : 'identity'], needsReview: true };
    return peers.some(other => r.code && other.code && normalize(other.code) !== normalize(r.code) && shape(other.code) === shape(r.code))
      ? { ...r, uncertainCode: true, needsReview: true } : r;
  });
}
module.exports = { fuse };
