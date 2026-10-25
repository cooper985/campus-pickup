const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const batches = require('../miniprogram/services/import-batches');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const candidate = (id, sourceIndex, changes = {}) => ({ id, code: '1234', station: '北门驿站', sourceIndex, ...changes });
const image = candidates => ({ hash: '', state: 'done', status: 'parsed', candidates: candidates.map(batches.cleanCandidate) });

test('V302 数据边界：同码同站不同运单的新来源不继承旧来源收据', () => {
  const p = page(fakeStorage()), batchId = 'distinct-waybills';
  const old = candidate('old', 0, { waybillNumber: 'SF123456789012' });
  const fresh = candidate('fresh', 1, { waybillNumber: 'SF999999999999' });
  try {
    p.persistBatch(batches.begin(batchId, 2));
    p.checkpointImage({ batchId }, 0, image([old]));
    p.completeAutoBatch({ batchId }, fuse([old]));
    p.persistRecords([]);
    p.checkpointImage({ batchId }, 1, image([fresh]));
    assert.deepEqual(Array.from(p.handledBatchSources(p.importState.batches[0])), ['old']);
    p.completeAutoBatch({ batchId }, fuse([old, fresh]));
    assert.deepEqual(Array.from(p.data.records, r => r.waybillNumber), [fresh.waybillNumber]);
    assert.equal(p.importState.batches[0].reviews[0].candidate.id, old.id);
    assert.ok(p.importState.batches[0].handledSources.includes(fresh.id));
  } finally { p.onUnload(); }
});

test('V302 数据边界：已跳过来源换融合代表仍不入库，独立新运单继续入库', () => {
  const p = page(fakeStorage()), batchId = 'resolved-fusion';
  const skipped = candidate('skipped', 1, { station: '待确认地点', waybillNumber: 'SF123456789012' });
  const representative = candidate('representative', 0, { waybillNumber: skipped.waybillNumber });
  const fresh = candidate('fresh', 2, { waybillNumber: 'SF999999999999' });
  try {
    p.persistBatch(batches.begin(batchId, 3));
    p.checkpointImage({ batchId }, 1, image([skipped]));
    p.completeAutoBatch({ batchId }, fuse([skipped]));
    p.chooseException({ currentTarget: { dataset: { id: skipped.id, action: 'skip' } } });
    assert.equal(p.data.exceptionCount, 0);
    p.checkpointImage({ batchId }, 0, image([representative]));
    p.checkpointImage({ batchId }, 2, image([fresh]));
    p.completeAutoBatch({ batchId }, fuse([representative, skipped, fresh]));
    assert.deepEqual(Array.from(p.data.records, r => r.waybillNumber), [fresh.waybillNumber]);
    assert.equal(p.data.exceptionCount, 0);
    assert.ok(p.importState.batches[0].resolved.includes(skipped.id));
  } finally { p.onUnload(); }
});
