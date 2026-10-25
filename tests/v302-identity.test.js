const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
const store = require('../miniprogram/services/pickup-store');
const now = new Date(2026, 9, 25, 12).getTime();
const emptyStations = { version: 1, groups: [] };
const candidate = (index, extra = {}) => ({ id: 'identity-' + index, sourceIndex: index, code: '1234', station: '大学北门驿站', parcelStatus: 'pending', ...extra });

test('V302 身份合成 A：同一真实包裹的两图缺运单日期时沿用码站融合', () => {
  const result = decision.evaluate(fuse([candidate(0), candidate(1)]), [], emptyStations, now);
  assert.equal(result.additions.length, 1);
  assert.equal(result.reviews.length, 0);
});

test('V302 身份合成 B：真实身份不同但可见证据与 A 相同时仍不可区分，不能宣称零误合并', () => {
  // A is one parcel photographed twice; B is code reuse by two parcels with no observable extra field.
  const observableA = [candidate(0), candidate(1)];
  const observableB = [candidate(0), candidate(1)];
  assert.deepEqual(observableB, observableA);
  const resultA = decision.evaluate(fuse(observableA), [], emptyStations, now);
  const resultB = decision.evaluate(fuse(observableB), [], emptyStations, now);
  assert.deepEqual(resultB.decisions.map(d => [d.decision, d.reason]), resultA.decisions.map(d => [d.decision, d.reason]));
  assert.equal(resultB.additions.length, 1, '记录现行弱证据策略的限制；B 的真实标签为两件，此断言不是准确率证明');
});

test('V302 身份合成 C：同码同站但两个不同完整运单能明确保留两件', () => {
  const candidates = [candidate(0, { waybillNumber: 'SF123456789012' }), candidate(1, { waybillNumber: 'SF123456789013' })];
  const fused = fuse(candidates);
  assert.equal(fused.length, 2);
  const result = decision.evaluate(fused, [], emptyStations, now);
  assert.equal(result.additions.length, 2);
  assert.equal(result.reviews.length, 0);
});

test('V302 身份合成 D：历史同码遇不同完整新运单可新增，缺运单仍复核、同运单跳过', () => {
  const history = store.updateRecord(store.newRecord(candidate(0, { waybillNumber: 'SF123456789012' }), [], now), { taken: true }, now + 1);
  const snapshot = JSON.stringify(history);
  const fresh = decision.classify(candidate(1, { waybillNumber: 'SF123456789013' }), [history], emptyStations, now + 2);
  assert.equal(fresh.decision, decision.AUTO_IMPORT);
  const weak = decision.classify(candidate(1), [history], emptyStations, now + 2);
  assert.equal(weak.decision, decision.NEEDS_REVIEW);
  assert.equal(weak.reason, 'historical_code');
  const repeated = decision.classify(candidate(1, { waybillNumber: history.waybillNumber }), [history], emptyStations, now + 2);
  assert.equal(repeated.decision, decision.AUTO_SKIP);
  assert.equal(repeated.reason, 'same_waybill');
  assert.equal(JSON.stringify(history), snapshot);
});
