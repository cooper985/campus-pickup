const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../miniprogram/services/pickup-parser');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
const batches = require('../miniprogram/services/import-batches');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const box = (x, y, width = 160) => ({ x, y, width, height: 30 });
const vertical = lines => lines.map((_, i) => box(20, i * 50));
function analyze(lines, boxes = vertical(lines)) {
  const result = parser.analyze(lines, 0, boxes);
  const candidates = [...result.records, ...result.issues].map((r, i) => ({ ...r, id: 'c' + i }));
  return { ...result, plan: decision.evaluate(fuse(candidates), []) };
}
function expectParcels(result, statuses, added) {
  assert.deepEqual(result.records.map(r => [r.code, r.parcelStatus]), statuses);
  assert.deepEqual(result.plan.additions.map(r => r.code), added);
  assert.equal(result.plan.reviews.length, 0);
}

for (const after of [false, true]) for (const reverse of [false, true]) {
  test(`V302 合成状态：独立两卡 ${after ? '码后' : '码前'}，${reverse ? '已取在前' : '待取在前'}`, () => {
    const cards = [['甲大学驿站', '1111', '待取件', 'pending'], ['乙大学驿站', '2222', '已取件', 'collected']];
    if (reverse) cards.reverse();
    const lines = cards.flatMap(([station, code, status]) => after ? [station, '取件码' + code, status] : [station, status, '取件码' + code]);
    const result = analyze(lines);
    expectParcels(result, cards.map(([, code, , status]) => [code, status]), ['1111']);
    result.records.forEach((r, i) => {
      const statusIndex = i * 3 + (after ? 2 : 1), otherStatus = (1 - i) * 3 + (after ? 2 : 1);
      assert.ok(r.sourceRegions.some(s => s.boxes.some(b => b.y === statusIndex * 50)), '状态证据必须可见');
      assert.ok(r.sourceRegions.every(s => s.boxes.every(b => b.y !== otherStatus * 50)), '不能引用另一卡状态');
    });
  });
}

test('V302 合成状态：三卡、连续不同站、取消与待取分别决策', () => {
  expectParcels(analyze(['甲大学驿站', '待取件', '取件码1111', '乙大学驿站', '已退回', '取件码2222', '丙大学驿站', '已到站', '取件码3333']),
    [['1111', 'pending'], ['2222', 'cancelled'], ['3333', 'pending']], ['1111', '3333']);
});

for (const after of [false, true]) test(`V302 合成状态：共享站头只继承地点，${after ? '码后' : '码前'}重复卡片各自取状态`, () => {
  const lines = ['大学菜鸟驿站', ...(after ? ['取件码1111', '待取件', '取件码2222', '已领取', '取件码3333', '已到站'] : ['待取件', '取件码1111', '已领取', '取件码2222', '已到站', '取件码3333'])];
  const result = analyze(lines);
  expectParcels(result, [['1111', 'pending'], ['2222', 'collected'], ['3333', 'pending']], ['1111', '3333']);
  assert.ok(result.records.every(r => r.station === '大学菜鸟驿站'));
});

test('V302 合成状态：两项与多项水平导航不能当包裹状态', () => {
  for (const labels of [['全部', '已取件'], ['待取件', '已签收'], ['全部', '待取件', '已领取']]) {
    const lines = [...labels, '大学驿站', '取件码1111'];
    const boxes = [...labels.map((_, i) => box(i * 240, 0)), box(20, 100), box(20, 150)];
    expectParcels(analyze(lines, boxes), [['1111', 'unknown']], ['1111']);
  }
});

test('V302 合成状态：双列按行输出，状态和来源不跨列', () => {
  const lines = ['甲大学驿站', '乙大学驿站', '已领取', '待取件', '取件码1111', '取件码2222'];
  const boxes = [box(0, 0), box(400, 0), box(0, 50), box(400, 50), box(0, 100), box(400, 100)];
  const result = analyze(lines, boxes);
  expectParcels(result, [['1111', 'collected'], ['2222', 'pending']], ['2222']);
  assert.ok(result.records[0].sourceRegions.every(s => s.boxes.every(b => b.x === 0)));
  assert.ok(result.records[1].sourceRegions.every(s => s.boxes.every(b => b.x === 400)));
});

test('V302 合成状态：同列 OCR 行序不规则时按坐标归属', () => {
  const lines = ['甲大学驿站', '取件码1111', '乙大学驿站', '取件码2222', '已领取', '待取件'];
  const boxes = [box(0, 0), box(0, 100), box(0, 200), box(0, 300), box(0, 250), box(0, 50)];
  expectParcels(analyze(lines, boxes), [['1111', 'pending'], ['2222', 'collected']], ['1111']);
});

test('V302 合成状态：坏码和无取件码卡片的已领取不污染前件', () => {
  for (const tail of [['乙大学驿站', '已领取', '取件码8-?-9000'], ['另一件包裹', '已领取']]) {
    const result = analyze(['甲大学驿站', '待取件', '取件码1111', ...tail]);
    assert.equal(result.records[0].parcelStatus, 'pending');
    assert.deepEqual(result.plan.additions.map(r => r.code), ['1111']);
    assert.ok(!result.plan.decisions.some(d => d.candidate.code === '1111' && d.reason === 'terminal'));
    if (tail.length === 3) {
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].parcelStatus, 'collected');
    }
  }
});

test('V302 合成状态：孤立或远离包裹的终态证据不允许自动跳过', () => {
  for (const boxes of [[], [box(0, 0), box(0, 1500), box(0, 1550)]]) {
    const result = analyze(['已领取', '大学驿站', '取件码1111'], boxes);
    assert.ok(!result.plan.decisions.some(d => d.reason === 'terminal'));
    assert.equal(result.plan.reviews.length, 1);
  }
  const unclear = analyze(['大学驿站', '取件码1111', '已领取', '待取件', '取件码2222']);
  assert.ok(!unclear.plan.decisions.some(d => d.reason === 'terminal'));
  assert.ok(unclear.plan.reviews.length > 0);
});

test('V302 合成状态：单件明确终态仍可自动判断', () => {
  expectParcels(analyze(['大学驿站', '取件码1111', '已领取']), [['1111', 'collected']], []);
});

test('V302 缓存：旧版错误终态不再复用，新证据不清空旧记录', async () => {
  const api = fakeStorage();
  api.getFileInfo = ({ success }) => success({ digest: 'a'.repeat(40), size: 100 });
  const batch = batches.begin('old', 1);
  batch.status = 'completed';
  batch.images[0] = { index: 0, hash: 'a'.repeat(40) + ':100', state: 'done', status: 'code_found', parserVersion: '2.3.4',
    candidates: [batches.cleanCandidate({ id: 'old-c', code: '1111', station: '大学驿站', parcelStatus: 'collected', sourceIndex: 0 })] };
  const p = page(api, async () => ({ mock: false, lines: ['大学驿站', '取件码1111', '待取件'] }));
  assert.equal(p.persistBatch(batch), true); p.data.images = ['local-image'];
  await p.recognizeCloud();
  assert.equal(p.data.records.length, 1);
  assert.equal(p.data.records[0].code, '1111');
  assert.equal(p.data.results[0].cached, undefined);
  assert.notEqual(batches.PARSER_VERSION, '2.3.4');
  p.onUnload();
});

test('V302 缓存：未完成旧批次恢复也不能据旧终态自动跳过，重新识别后再入库', async () => {
  const api = fakeStorage(), p = page(api);
  const batch = batches.begin('old-processing', 1);
  batch.images[0] = { index: 0, hash: '', state: 'done', status: 'code_found', parserVersion: '2.3.4',
    candidates: [batches.cleanCandidate({ id: 'old-source', code: '1111', station: '大学驿站', sourceIndex: 0, parcelStatus: 'collected' })] };
  assert.equal(p.persistBatch(batch), true); p.onUnload();
  api.chooseImage = async () => ({ tempFiles: [{ path: 'reselected', size: 100 }] });
  const q = page(api, async () => ({ mock: false, lines: ['大学驿站', '取件码1111', '待取件'] }));
  try {
    assert.equal(q.data.records.length, 0);
    assert.equal(q.data.exceptionCount, 1);
    assert.equal(q.importState.batches[0].reviews[0].reason, 'status_conflict');
    assert.equal(q.importState.batches[0].images[0].candidates[0].parcelStatus, 'collected', '原始旧证据仍保留');
    await q.retryImage({ currentTarget: { dataset: { batchId: batch.id, imageIndex: 0 } } });
    assert.deepEqual(Array.from(q.data.records, r => r.code), ['1111']);
    assert.equal(q.data.exceptionCount, 0);
  } finally { q.onUnload(); }
});

test('V302 缓存：当前证据在排队和重试失败后保留解析版本，不制造旧版状态异常', async () => {
  const api = fakeStorage(); let calls = 0;
  const p = page(api, async () => { if (++calls > 1) throw { code: 'NETWORK_FAILED' }; return { mock: false, lines: ['取件码1111'] }; });
  try {
    p.data.images = ['local-image']; await p.recognizeCloud();
    const batchId = p.importState.batches[0].id;
    assert.equal(p.importState.batches[0].reviews[0].reason, 'missing_location');
    await p.retryImage({ currentTarget: { dataset: { batchId, imageIndex: 0 } } });
    assert.equal(p.importState.batches[0].images[0].parserVersion, batches.PARSER_VERSION);
    assert.equal(p.importState.batches[0].reviews[0].reason, 'missing_location');
  } finally { p.onUnload(); }
});
