const { validCode } = require('./pickup-code');
const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[—–－﹣−‐‑‒]/g, '-').replace(/\s/g, '');
const known = value => !!normalize(value) && !/^(待确认|待确认地点|地点待确认)$/.test(normalize(value));
const fields = ['station', 'pickupAddress', 'carrier', 'waybillNumber'];
const carrierKey = value => normalize(value).replace(/^顺丰(?:快递|速运)$/, '顺丰').replace(/^京东(?:快递|物流)$/, '京东');
// Only this batch is compared. A code is never a permanent parcel identity.
function fuse(candidates, stationKey = normalize) {
  const groups = new Map();
  for (const item of candidates) {
    const key = normalize(item.code);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const result = [];
  for (const [code, members] of groups) {
    const valueKey = (field, value) => field === 'station' ? stationKey(value) : field === 'carrier' ? carrierKey(value) : normalize(value);
    const conflict = fields.some(field => new Set(members.filter(r => field === 'station' ? known(r[field]) : !!r[field])
      .map(r => valueKey(field, r[field]))).size > 1);
    const separate = members.length > 1 && (conflict || members.some(r => r.uncertainCode) ||
      new Set(members.map(r => r.sourceIndex)).size !== members.length);
    if (separate || members.length === 1) {
      result.push(...members.map(r => ({ ...r, sourceIds: [r.id], sourceIndices: [r.sourceIndex],
        ...(separate ? { batchConflict: true, needsReview: true } : {}) })));
      continue;
    }
    if (!validCode(code)) { result.push(...members); continue; }
    const merged = { ...members[0], code, sourceIds: members.map(r => r.id), sourceIndices: members.map(r => r.sourceIndex), fieldSources: {} };
    for (const field of fields) {
      const providers = members.filter(r => (r.confirmedFields || []).includes(field) || (field === 'station' ? known(r[field]) : !!r[field]));
      const provider = providers.find(r => (r.confirmedFields || []).includes(field)) || providers[0];
      if (provider) { merged[field] = provider[field]; merged.fieldSources[field] = provider.sourceIndex; }
    }
    merged.confirmedFields = [...new Set(members.flatMap(r => r.confirmedFields || []))];
    merged.needsReview = !known(merged.station);
    result.push(merged);
  }
  // Flag plausible OCR substitutions for review; never rewrite or fuzzy-merge them.
  const shape = code => normalize(code).replace(/[O]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  return result.map(r => result.some(other => other !== r && normalize(other.code) !== normalize(r.code) && shape(other.code) === shape(r.code))
    ? { ...r, uncertainCode: true, needsReview: true } : r);
}
module.exports = { fuse };
