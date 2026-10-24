const copy = value => JSON.parse(JSON.stringify(value));
const candidateFields = ['id', 'code', 'station', 'pickupAddress', 'carrier', 'waybillNumber', 'sourceIndex', 'sourceIndices', 'sourceIds', 'confirmedFields', 'needsReview', 'batchConflict', 'uncertainCode', 'parcelStatus', 'noticeAt', 'timeConflict', 'locationOptions', 'memoryAddress', 'sourceRegions', 'fieldSources', 'statusEvents', 'conflictFields', 'relatedSourceIndices', 'unresolvedRegion'];
const cleanCandidate = c => candidateFields.reduce((result, key) => { if (c[key] !== undefined) result[key] = copy(c[key]); return result; }, {});
const empty = () => ({ version: 1, batches: [] });
const onlyKeys = (value, keys) => Object.keys(value).every(k => keys.indexOf(k) >= 0);
const string = (value, max = 120) => typeof value === 'string' && value.length <= max;
function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.batches) || !onlyKeys(state, ['version', 'batches'])) throw Error('导入批次格式异常');
  const ids = new Set();
  const snapshots = [];
  for (const b of state.batches) {
    if (!b || typeof b.id !== 'string' || !b.id || ids.has(b.id) || !Number.isSafeInteger(b.createdAt) || b.createdAt <= 0 ||
      !['processing', 'completed', 'interrupted', 'undone'].includes(b.status) ||
      !['additions', 'updates', 'reviews', 'outcomes', 'images'].every(k => Array.isArray(b[k])) || b.images.length > 9 ||
      !onlyKeys(b, ['id', 'createdAt', 'status', 'additions', 'updates', 'reviews', 'outcomes', 'images', 'elapsedMs', 'skipped', 'resolved', 'duplicateImages', 'unrelatedImages', 'fusedSources', 'undoConflicts']) ||
      ['resolved', 'undoConflicts'].some(k => b[k] !== undefined && (!Array.isArray(b[k]) || b[k].some(id => !string(id)))) ||
      ['elapsedMs', 'skipped', 'duplicateImages', 'unrelatedImages', 'fusedSources'].some(k => b[k] !== undefined && (!Number.isSafeInteger(b[k]) || b[k] < 0))) throw Error('导入批次格式异常');
    ids.add(b.id);
    snapshots.push(...b.additions, ...b.updates.flatMap(u => [u.before, u.after]));
    if (b.updates.some(u => !u.before || !u.after || u.before.id !== u.after.id || !onlyKeys(u, ['before', 'after']))) throw Error('撤销快照格式异常');
    for (const image of b.images) {
      if (!Number.isInteger(image.index) || image.index < 0 || image.index > 8 || !Array.isArray(image.candidates) ||
        typeof image.hash !== 'string' || image.hash && !/^[a-f0-9]{40}:\d+$/.test(image.hash) ||
        !['queued', 'done', 'failed', 'duplicate'].includes(image.state) || !string(image.status, 50) ||
        !onlyKeys(image, ['index', 'hash', 'state', 'status', 'candidates', 'duplicateOf']) ||
        image.duplicateOf !== undefined && (!Number.isInteger(image.duplicateOf) || image.duplicateOf < 0 || image.duplicateOf >= image.index)) throw Error('导入图片状态异常');
      image.candidates.forEach(checkCandidate);
    }
    for (const r of b.reviews) {
      checkCandidate(r.candidate);
      if (!string(r.id) || r.id !== r.candidate.id || !string(r.reason, 50) || !Array.isArray(r.matches) || typeof r.allowNew !== 'boolean' ||
        !onlyKeys(r, ['id', 'candidate', 'reason', 'matches', 'allowNew', 'choice', 'conflictFields']) ||
        r.conflictFields !== undefined && (!Array.isArray(r.conflictFields) || r.conflictFields.some(f => !string(f, 30))) ||
        r.matches.some(m => !m || !string(m.id) || !string(m.code, 32) || !string(m.station, 100) || typeof m.taken !== 'boolean' || ['carrier', 'pickupAddress', 'waybillNumber'].some(k => m[k] !== undefined && !string(m[k], k === 'carrier' ? 40 : 100)) || !onlyKeys(m, ['id', 'code', 'station', 'taken', 'carrier', 'pickupAddress', 'waybillNumber']))) throw Error('异常记录格式异常');
      if (r.choice && (!['new', 'skip'].includes(r.choice.action) || !string(r.choice.station, 100) || !onlyKeys(r.choice, ['action', 'station']))) throw Error('异常选择格式异常');
    }
    if (b.outcomes.some(o => !o || !string(o.id) || !['AUTO_IMPORT', 'AUTO_SKIP', 'NEEDS_REVIEW'].includes(o.decision) || !string(o.reason, 50) || !onlyKeys(o, ['id', 'decision', 'reason']))) throw Error('导入决策格式异常');
  }
  return snapshots;
}
function checkCandidate(c) {
  if (!c || !string(c.id) || typeof c.code !== 'string' || c.code.length > 32 ||
    typeof c.station !== 'string' || c.station.length > 100 || JSON.stringify(c) !== JSON.stringify(cleanCandidate(c)) ||
    ['carrier', 'pickupAddress', 'waybillNumber'].some(k => c[k] !== undefined && !string(c[k], k === 'carrier' ? 40 : 100)) ||
    ['needsReview', 'batchConflict', 'uncertainCode', 'timeConflict', 'memoryAddress', 'unresolvedRegion'].some(k => c[k] !== undefined && typeof c[k] !== 'boolean') ||
    c.noticeAt !== undefined && (!Number.isSafeInteger(c.noticeAt) || c.noticeAt <= 0) ||
    c.parcelStatus !== undefined && !require('./import-evidence').statuses.includes(c.parcelStatus) ||
    ['sourceIds', 'locationOptions', 'confirmedFields'].some(k => c[k] !== undefined && (!Array.isArray(c[k]) || c[k].some(s => !string(s)))) ||
    c.sourceRegions !== undefined && (!Array.isArray(c.sourceRegions) || c.sourceRegions.length > 40 || c.sourceRegions.some(r => !r || !onlyKeys(r, ['imageIndex', 'start', 'end', 'boxes', 'fields']) || !Number.isInteger(r.imageIndex) || r.imageIndex < 0 || r.imageIndex > 8 || !Number.isInteger(r.start) || r.start < 0 || !Number.isInteger(r.end) || r.end < r.start || !Array.isArray(r.boxes) || r.boxes.some(b => !onlyKeys(b, ['x', 'y', 'width', 'height']) || ![b.x,b.y,b.width,b.height].every(Number.isFinite)) || !Array.isArray(r.fields) || r.fields.some(f => !string(f, 30)))) ||
    c.fieldSources !== undefined && (!c.fieldSources || Object.values(c.fieldSources).some(i => !Number.isInteger(i) || i < -1 || i > 8)) ||
    c.statusEvents !== undefined && (!Array.isArray(c.statusEvents) || c.statusEvents.some(e => !e || !onlyKeys(e, ['parcelStatus', 'noticeAt']) || !require('./import-evidence').statuses.includes(e.parcelStatus) || !Number.isSafeInteger(e.noticeAt) || e.noticeAt <= 0)) ||
    ['conflictFields'].some(k => c[k] !== undefined && (!Array.isArray(c[k]) || c[k].some(f => !string(f, 30)))) ||
    c.relatedSourceIndices !== undefined && (!Array.isArray(c.relatedSourceIndices) || c.relatedSourceIndices.some(i => !Number.isInteger(i) || i < -1 || i > 8)) ||
    c.sourceIndices !== undefined && (!Array.isArray(c.sourceIndices) || c.sourceIndices.some(i => !Number.isInteger(i) || i < -1 || i > 8))) throw Error('导入候选字段异常');
}
function begin(id, count, now = Date.now()) {
  return { id, createdAt: now, status: 'processing', additions: [], updates: [], reviews: [], outcomes: [],
    images: Array.from({ length: count }, (_, index) => ({ index, hash: '', state: 'queued', status: 'queued', candidates: [] })), elapsedMs: 0, skipped: 0 };
}
function apply(batch, plan, images, now = Date.now()) {
  const b = copy(batch);
  b.status = 'completed'; b.images = copy(images); b.elapsedMs = Math.max(0, now - b.createdAt); b.skipped = plan.skipped;
  b.additions.push(...plan.additions);
  for (const u of plan.updates) {
    const added = b.additions.findIndex(r => r.id === u.after.id);
    if (added >= 0 && JSON.stringify(b.additions[added]) === JSON.stringify(u.before)) b.additions[added] = u.after;
    else {
      // Never absorb an intervening user edit into an automatic undo snapshot.
      const previous = b.updates.slice().reverse().find(p => p.after.id === u.after.id && JSON.stringify(p.after) === JSON.stringify(u.before));
      if (previous) previous.after = u.after;
      else b.updates.push(u);
    }
  }
  const resolved = new Set((b.resolved || []));
  b.reviews = plan.reviews.filter(d => !resolved.has(d.candidate.id)).map(d => {
    const previous = batch.reviews.find(r => r.id === d.candidate.id);
    return { id: d.candidate.id, candidate: cleanCandidate(d.candidate), reason: d.reason, matches: d.matches || [], allowNew: d.allowNew !== false, conflictFields: d.conflictFields || [],
      ...(previous && previous.choice ? { choice: previous.choice } : {}) };
  });
  b.outcomes = [...batch.outcomes.filter(o => resolved.has(o.id)), ...plan.decisions.map(d => {
    const previous = batch.outcomes.find(o => o.id === d.candidate.id);
    if (previous && previous.decision === 'AUTO_IMPORT' && d.decision === 'AUTO_SKIP' &&
      (d.matches || []).some(m => batch.additions.some(r => r.id === m.id))) return previous;
    return { id: d.candidate.id, decision: d.decision, reason: d.reason };
  })];
  return b;
}
function undo(batch, records) {
  const b = copy(batch), conflicts = [], removed = new Set(), restore = new Map();
  for (const after of b.additions) {
    const current = records.find(r => r.id === after.id);
    if (!current) continue;
    if (JSON.stringify(current) === JSON.stringify(after)) removed.add(after.id);
    else conflicts.push(after.id);
  }
  for (const u of b.updates) {
    const current = records.find(r => r.id === u.after.id);
    if (current && JSON.stringify(current) === JSON.stringify(u.after)) restore.set(current.id, u.before);
    else conflicts.push(u.after.id);
  }
  b.status = 'undone'; b.undoConflicts = [...new Set(conflicts)]; b.reviews = [];
  return { batch: b, records: records.filter(r => !removed.has(r.id)).map(r => restore.get(r.id) || r), conflicts: b.undoConflicts,
    removed: removed.size, restored: restore.size };
}
function replace(state, batch) {
  const all = state.batches.some(b => b.id === batch.id) ? state.batches.map(b => b.id === batch.id ? batch : b) : [...state.batches, batch];
  // Keep unresolved work; cap only older finished receipts and their image fingerprints.
  return { version: 1, batches: all.filter((b, i) => i >= all.length - 10 || b.reviews.length || b.status === 'processing' || b.status === 'interrupted' || b.images.some(im => im.state === 'failed' && im.status !== 'SKIPPED_BY_USER')) };
}
// A fingerprint caches recognition evidence, never the existence of a parcel.
function cachedImage(state, hash, batchId) {
  if (!hash) return null;
  for (const b of state.batches.slice().reverse()) {
    if (b.id === batchId) continue;
    const image = b.images.find(i => i.hash === hash && i.state === 'done');
    if (image) return image;
  }
  return null;
}
module.exports = { empty, validate, cleanCandidate, begin, apply, undo, replace, cachedImage };
