const duplicateReasons = ['pending_duplicate', 'same_waybill'];
function details(batch) {
  const outcomes = new Map(batch.outcomes.map(o => [o.id, o]));
  return batch.images.map(image => {
    const base = { batchId: batch.id, index: image.index, duplicate: [], unrelated: [], failure: [] };
    if (image.state === 'queued') return base;
    if (image.state === 'failed') {
      if (image.status !== 'SKIPPED_BY_USER') base.failure.push('识别失败，可重试');
      return base;
    }
    if (image.state === 'duplicate') {
      base.duplicate.push(image.duplicateOf === undefined ? '与本批其他截图重复' : `与本批截图 ${image.duplicateOf + 1} 重复`);
      return base;
    }
    const candidates = image.candidates;
    if (!candidates.length) base.unrelated.push(image.status === 'in_transit' ? '包裹还在运输中' : '未发现快递信息');
    for (const c of candidates) {
      const outcome = outcomes.get(c.id);
      if (outcome && duplicateReasons.includes(outcome.reason)) base.duplicate.push(outcome.reason === 'same_waybill' ? '相同运单已取件' : '已有待取包裹');
      if (outcome && outcome.reason === 'terminal') base.unrelated.push('截图显示已取、取消或退回');
    }
    // Fusion can make several screenshots describe one parcel; show the later sources as parcel duplicates.
    for (const other of batch.images.filter(i => i.index < image.index && i.state === 'done')) {
      if (candidates.some(c => other.candidates.some(p => p.id !== c.id && outcomes.has(p.id) &&
        !outcomes.has(c.id) && p.code && p.code === c.code))) base.duplicate.push(`与截图 ${other.index + 1} 为同一包裹，已合并`);
    }
    for (const key of ['duplicate', 'unrelated', 'failure']) base[key] = [...new Set(base[key])];
    return base;
  });
}
module.exports = { details };
