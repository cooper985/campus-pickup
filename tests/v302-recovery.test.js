const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const storage = require('../miniprogram/services/pickup-store');
const batches = require('../miniprogram/services/import-batches');
const { fuse } = require('../miniprogram/services/candidate-fusion');

const candidate = (id, sourceIndex, changes = {}) => ({ id, sourceIndex, code: '1234', station: '北门驿站', ...changes });
const image = (index, candidates, state = 'done') => ({ index, hash: '', state, status: state === 'done' ? 'parsed' : 'queued', candidates: candidates.map(batches.cleanCandidate),
  ...(state === 'done' ? { parserVersion: batches.PARSER_VERSION } : {}) });
function prepared(sources) {
  const api = fakeStorage(), p = page(api), batchId = 'v302-batch';
  const batch = batches.begin(batchId, sources.length);
  batch.images = sources.map((items, index) => image(index, items));
  assert.equal(p.persistBatch(batch), true);
  p.completeAutoBatch({ batchId }, fuse(sources.flat()));
  return { api, p, batchId };
}
const codes = p => Array.from(p.data.records, r => r.code);

for (const change of ['删除', '改码']) {
  test(`V302 同批${change}后重试检查点中断，重启不复活旧码`, () => {
    const { api, p, batchId } = prepared([[candidate('old-source', 0)], []]);
    const current = p.data.records[0];
    p.persistRecords(change === '删除' ? [] : [storage.updateRecord(current, { code: '5678', confirmedFields: ['code'] })]);
    p.checkpointImage({ batchId }, 1, image(1, [], 'queued'));
    p.onUnload();
    const q = page(api);
    try {
      assert.deepEqual(codes(q), change === '删除' ? [] : ['5678']);
      assert.equal(q.data.exceptionCount, 1);
      assert.equal(q.importState.batches[0].reviews[0].reason, 'batch_conflict');
      q.checkpointImage({ batchId }, 1, image(1, [], 'queued'));
      q.recoverInterrupted();
      assert.deepEqual(codes(q), change === '删除' ? [] : ['5678']);
      assert.equal(q.data.exceptionCount, 1);
    } finally { q.onUnload(); }
  });
}

test('V302 中断时首次处理的新来源正常入库，多次恢复与重启幂等', () => {
  const { api, p, batchId } = prepared([[candidate('old-source', 0)], []]);
  const existingId = p.data.records[0].id;
  p.checkpointImage({ batchId }, 1, image(1, [candidate('new-source', 1, { code: '5678' })]));
  p.onUnload();
  const q = page(api);
  try {
    assert.deepEqual(codes(q), ['1234', '5678']);
    assert.equal(q.data.records[0].id, existingId);
    const snapshot = JSON.stringify(q.data.records);
    q.recoverInterrupted(); q.recoverInterrupted();
    assert.equal(JSON.stringify(q.data.records), snapshot);
  } finally { q.onUnload(); }
  const r = page(api);
  try { assert.deepEqual(codes(r), ['1234', '5678']); }
  finally { r.onUnload(); }
});

for (const recovery of [false, true]) {
  test(`V302 融合代表ID改变仍保护已处理来源（${recovery ? '重启恢复' : '正常完成'}）`, () => {
    const old = candidate('old-source', 1), added = candidate('new-representative', 0);
    const { api, p, batchId } = prepared([[], [old]]);
    p.persistRecords([]);
    p.checkpointImage({ batchId }, 0, image(0, [added]));
    let q = p;
    if (recovery) { p.onUnload(); q = page(api); }
    else q.completeAutoBatch({ batchId }, fuse([added, old]));
    try {
      assert.deepEqual(codes(q), []);
      assert.equal(q.data.exceptionCount, 1);
      assert.equal(q.importState.batches[0].reviews[0].reason, 'batch_conflict');
      q.completeAutoBatch({ batchId }, fuse([added, old]));
      assert.deepEqual(codes(q), []);
      assert.equal(q.data.exceptionCount, 1);
    } finally { q.onUnload(); }
  });
}

test('V302 旧融合代表在重试中消失，剩余已处理来源不被当成新包裹', () => {
  const first = candidate('first-source', 0), second = candidate('second-source', 1);
  const { api, p, batchId } = prepared([[first], [second]]);
  assert.equal(p.importState.batches[0].outcomes[0].id, first.id);
  const { handledSources, ...legacy } = p.importState.batches[0];
  p.persistBatch(legacy);
  p.persistRecords([]);
  p.checkpointImage({ batchId }, 0, image(0, []));
  p.onUnload();
  const q = page(api);
  try {
    assert.deepEqual(codes(q), []);
    assert.equal(q.importState.batches[0].reviews[0].candidate.id, second.id);
    assert.equal(q.importState.batches[0].reviews[0].reason, 'batch_conflict');
  } finally { q.onUnload(); }
});

test('V302 新批次重选同图仍重新判断现有记录，缓存不成为永久拒绝导入', async () => {
  const api = fakeStorage(); let calls = 0;
  api.getFileInfo = ({ success }) => success({ digest: '1'.padStart(40, '0'), size: 100 });
  const p = page(api, async () => { calls++; return { mock: false, lines: ['北门驿站', '取件码1234'] }; });
  try {
    p.data.images = ['same-image']; await p.recognizeCloud();
    const firstId = p.data.records[0].id;
    p.persistRecords([]);
    await p.recognizeCloud();
    assert.deepEqual(codes(p), ['1234']);
    assert.notEqual(p.data.records[0].id, firstId);
    assert.equal(p.data.results[0].cached, true);
    assert.equal(calls, 1);
  } finally { p.onUnload(); }
});
