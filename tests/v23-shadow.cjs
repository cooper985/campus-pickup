// Local, read-only rule evaluation against explicitly annotated synthetic candidates.
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/v23-labeled-batches.json');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const { evaluate, AUTO_IMPORT, AUTO_SKIP, NEEDS_REVIEW } = require('../miniprogram/services/import-decision');
const { newRecord, updateRecord } = require('../miniprogram/services/pickup-store');
let wanted = new Set(), imported = new Set(), covered = new Set();
let fields = 0, correctFields = 0, wrongMerges = 0, skipped = 0, correctSkips = 0, unnecessaryReviews = 0;
const batches = [];
for (const [bi, sample] of fixture.batches.entries()) {
  const byId = new Map(sample.candidates.map(c => [c.id, c.label]));
  const originals = sample.records.map(r => { const record = newRecord(r); return r.taken ? updateRecord(record, { taken: true }) : record; });
  const input = sample.candidates.map(({ label, ...c }, i) => ({ ...c, sourceIndex: i }));
  sample.candidates.filter(c => c.label.decision !== AUTO_SKIP).forEach(c => wanted.add(`${bi}:${c.label.parcelId}`));
  const started = performance.now();
  const plan = evaluate(fuse(input), originals, undefined, new Date(2026, 9, 23, 12).getTime());
  const ms = performance.now() - started;
  for (const d of plan.decisions) {
    const labels = (d.candidate.sourceIds || [d.candidate.id]).map(id => byId.get(id));
    const parcels = new Set(labels.map(l => l.parcelId));
    if (parcels.size > 1) wrongMerges++;
    if (d.decision === AUTO_IMPORT) {
      for (const l of labels) {
        imported.add(`${bi}:${l.parcelId}`);
        for (const [key, value] of Object.entries(l.fields)) { fields++; if (d.candidate[key] === value) correctFields++; }
      }
    }
    if (d.decision === AUTO_IMPORT || d.decision === NEEDS_REVIEW) labels.forEach(l => covered.add(`${bi}:${l.parcelId}`));
    if (d.decision === AUTO_SKIP) { skipped++; if (labels.every(l => l.decision === AUTO_SKIP)) correctSkips++; }
    if (d.decision === NEEDS_REVIEW && labels.every(l => l.decision === AUTO_IMPORT)) unnecessaryReviews++;
    assert.ok(labels.every(l => l.decision === d.decision), `${sample.name}: unexpected ${d.decision} (${d.reason})`);
  }
  batches.push({ name: sample.name, added: plan.additions.length, review: plan.reviews.length, skipped: plan.skipped,
    // One image-selection submission; review adds open, one choice per issue, and save.
    modeledUserActions: 1 + (plan.reviews.length ? 2 + plan.reviews.length : 0), localDecisionMs: +ms.toFixed(3) });
}
const report = { dataset: fixture.type, scope: '人工标注候选的本地影子评估；不含云OCR、网络、真机耗时或真实分布准确率',
  samples: fixture.batches.reduce((n, b) => n + b.candidates.length, 0), batches: batches.length,
  autoImportCoverage: { numerator: [...imported].filter(id => wanted.has(id)).length, denominator: wanted.size },
  autoImportFieldAccuracy: { correct: correctFields, total: fields }, wrongMerges,
  missedParcels: [...wanted].filter(id => !covered.has(id)).length, unnecessaryReviews,
  autoSkipAccuracy: { correct: correctSkips, total: skipped }, results: batches };
assert.equal(wrongMerges, 0); assert.equal(report.missedParcels, 0); assert.equal(correctFields, fields); assert.equal(correctSkips, skipped);
console.log(JSON.stringify(report, null, 2));
