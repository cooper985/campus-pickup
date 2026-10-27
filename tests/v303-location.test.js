const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../miniprogram/services/pickup-parser');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
const stations = require('../miniprogram/services/stations');
const batches = require('../miniprogram/services/import-batches');
const box = (x, y) => ({ x, y, width: 300, height: 30 });
const analyze = lines => parser.analyze(lines, 0, lines.map((_, i) => box(20, i * 45)));
const plan = a => decision.evaluate(fuse([...a.records, ...a.issues].map((r, i) => ({ ...r, id: String(i) }))), []);

test('合成详情：驿站描述、营业时间和收件地址不混淆', () => {
  const a = analyze(['待取件', '取件码95-1-1104', '菜鸟驿站', '河工大31号楼500以上在钟楼', '营业时间:周一至周日09:00~21:00', '莲花街100号河南工业大学莲花街校区']);
  assert.deepEqual(a.records.map(r => [r.code, r.station, r.parcelStatus]), [['95-1-1104', '河工大31号楼500以上在钟楼', 'pending']]);
  assert.equal(a.issues.length, 0);
  assert.equal(plan(a).additions.length, 1);
  assert.equal(plan(a).reviews.length, 0);
});

test('合成详情：明确取件地点优先，不能把收件地址或营业时间当地点', () => {
  const a = analyze(['待取件', '取件码95-1-1104', '取件地点：北区3号楼东侧', '营业时间：周一至周日09:00~21:00', '收件地址：南区8号楼']);
  assert.equal(a.records[0].station, '北区3号楼东侧');
  const missing = analyze(['待取件', '取件码95-1-1104', '菜鸟驿站', '营业时间：周一至周日09:00~21:00', '收件地址：南区8号楼']);
  assert.equal(plan(missing).reviews.length, 1);
  const reverse = analyze(['待取件', '取件码95-1-1104', '北区3号楼东侧', '菜鸟驿站', '营业时间 周一至周日09:00~21:00']);
  assert.equal(reverse.records[0].station, '北区3号楼东侧');
  const withoutBadge = analyze(['待取件', '取件码95-1-1104', '北区3号楼东侧', '营业时间 周一至周日09:00~21:00']);
  assert.equal(plan(withoutBadge).reviews.length, 1);
});

test('合成多包裹：状态地点不串台，真缺码保留复核', () => {
  const a = analyze(['甲大学驿站', '待取件', '取件码1111', '乙大学驿站', '已领取', '取件码2222']);
  assert.deepEqual(a.records.map(r => [r.station, r.parcelStatus]), [['甲大学驿站', 'pending'], ['乙大学驿站', 'collected']]);
  const missing = analyze(['待取件', '北区驿站', '取件码8-?-9000']);
  assert.equal(missing.issues.length, 1);
  assert.equal(plan(missing).reviews[0].reason, 'missing_code');
  const ambiguous = analyze(['甲大学驿站', '待取件', '取件码1111', '另一件包裹', '取件码', '查看详情']);
  assert.equal(ambiguous.issues.length, 1);
  assert.equal(plan(ambiguous).reviews[0].reason, 'missing_code');
});

test('不同完整运单的同码不同件不可合并', () => {
  const values = ['SF123456789012', 'SF123456789013'].map((waybillNumber, i) => ({ id: String(i), sourceIndex: i, code: '1234', station: '大学驿站', parcelStatus: 'pending', waybillNumber }));
  assert.equal(fuse(values).length, 2);
  assert.equal(decision.evaluate(fuse(values), []).additions.length, 2);
});

test('旧营业时间站点记忆不能覆盖新的可靠地点', () => {
  const wrong = '营业时间:周一至周日09:00~21:00', good = '北区3号楼东侧';
  const state = { version: 1, groups: [{ id: 'old', name: wrong, aliases: [wrong, good], confirmed: true, pickupAddress: '旧地址' }] };
  const a = stations.assist(state, { station: good, code: '1234', pickupAddress: '新地址' });
  assert.equal(a.station, good);
  assert.equal(a.pickupAddress, '新地址');
  assert.equal(state.groups[0].name, wrong);
  assert.equal(stations.reliable(wrong), false);
  assert.notEqual(batches.PARSER_VERSION, '3.0.2');
});

test('合成 OCR 经导入批次保存来源，旧缓存不可复用且已有记录不自动改写', async () => {
  const { page } = require('./helpers/page');
  const { fakeStorage } = require('./helpers/storage');
  const store = require('../miniprogram/services/pickup-store');
  const api = fakeStorage();
  api.getFileInfo = ({ success }) => success({ digest: 'a'.repeat(40), size: 100 });
  const lines = ['待取件', '取件码95-1-1104', '菜鸟驿站', '河工大31号楼500以上在钟楼', '营业时间:周一至周日09:00~21:00', '莲花街100号河南工业大学莲花街校区'];
  let calls = 0;
  const p = page(api, async () => { calls++; return { mock: false, lines, boxes: lines.map((_, i) => box(20, i * 45)) }; });
  try {
    const old = store.newRecord({ code: '95-1-1104', station: '营业时间:周一至周日09:00~21:00' });
    p.persistRecords([old]);
    const previous = batches.begin('old', 1);
    previous.status = 'completed';
    previous.images[0] = { index: 0, hash: 'a'.repeat(40) + ':100', state: 'done', status: 'code_found', parserVersion: '3.0.2', candidates: [batches.cleanCandidate({ id: 'old-c', code: old.code, station: old.station, sourceIndex: 0 })] };
    p.persistBatch(previous);
    p.data.images = ['synthetic']; await p.recognizeCloud();
    assert.equal(calls, 1);
    assert.deepEqual(p.data.records[0], old);
    const current = p.importState.batches.find(b => b.id !== 'old');
    assert.equal(current.images[0].parserVersion, batches.PARSER_VERSION);
    assert.equal(current.images[0].candidates[0].station, '河工大31号楼500以上在钟楼');
    assert.equal(current.reviews[0].reason, 'record_conflict');
    assert.ok(current.reviews[0].candidate.sourceRegions.length);
  } finally { p.onUnload(); }
});

// Equivalent synthetic OCR only; these rows/coordinates are not a captured Tencent response.
function logisticsDetail({ help = true, wrapped = false, location = '北区3号楼东侧', code = '95-1-1104' } = {}) {
  const lines = ['物流详情', '圆通快递', '待取件', ...(location ? [location] : []), '营业时间：周一至周日09:00~21:00',
    '示例路100号示例大学', '取件码：', code, '复制', '更多', '联系驿站'];
  const label = lines.indexOf('取件码：');
  const boxes = lines.map((_, i) => ({ x: 100, y: 100 + i * 50, width: 500, height: 32 }));
  boxes[label].width = 100;
  boxes[label + 1] = { x: 220, y: boxes[label].y, width: 250, height: 40 };
  boxes[label + 2] = { x: 500, y: boxes[label].y, width: 60, height: 32 };
  const start = lines.length;
  const notice = location ? `您好，快件已到达【菜鸟驿站】（${location}），请及时取件` : '您好，快件已到达【菜鸟驿站】，请及时取件';
  const paragraph = notice + (help ? '，如有取件码问题或找不到包裹...展开' : '。');
  const splitAt = wrapped && location ? paragraph.indexOf(location) + Math.ceil(location.length / 2) : -1;
  const rows = splitAt < 0 ? [paragraph] : [paragraph.slice(0, splitAt), paragraph.slice(splitAt)];
  lines.push(...rows, '查看更多物流信息', '收件地址：示例路100号示例大学校区');
  for (let i = start; i < lines.length; i++) boxes.push({ x: 100, y: 700 + (i - start) * 45, width: 650, height: 32 });
  return { mock: false, lines, boxes };
}

test('合成物流详情：说明文字不造缺码候选，营业时间隔开的地点与取件码仍属一件', () => {
  const input = logisticsDetail(), a = parser.analyze(input.lines, 0, input.boxes);
  assert.equal(a.issues.length, 0);
  assert.equal(a.uncertainCount, 0);
  assert.deepEqual(a.records.map(r => [r.code, r.station, r.parcelStatus]), [['95-1-1104', '北区3号楼东侧', 'pending']]);
  assert.equal(plan(a).additions.length, 1);
  assert.equal(plan(a).reviews.length, 0);
});

test('合成到站正文：泛称后括号地点保留，换行地点仅在相邻坐标内续接', () => {
  for (const wrapped of [false, true]) {
    const input = logisticsDetail({ help: false, wrapped });
    const a = parser.analyze(input.lines, 0, input.boxes);
    assert.equal(a.records[0].station, '北区3号楼东侧');
    assert.equal(a.issues.length, 0);
  }
  const far = logisticsDetail({ help: false, wrapped: true });
  const index = far.lines.findIndex(s => s.startsWith('您好'));
  far.boxes[index + 1].x += 1000;
  assert.equal(plan(parser.analyze(far.lines, 0, far.boxes)).reviews[0].reason, 'missing_location');
  for (const note of ['自提', '仅供参考', '已签收']) {
    const a = analyze(['待取件', '取件码1111', `快件已到达【菜鸟驿站】（${note}）`]);
    assert.equal(plan(a).reviews.length, 1);
  }
});

test('合成帮助文字：单行和换行说明不是码标签，真正末行空标签保留有限来源', () => {
  for (const rows of [['如有取件码问题或找不到包裹，请联系驿站'], ['如有取件码', '问题或找不到包裹，请联系驿站']]) {
    const a = analyze(['甲大学驿站', '待取件', '取件码1111', ...rows]);
    assert.equal(a.records.length, 1);
    assert.equal(a.issues.length, 0);
  }
  const missing = analyze(['甲大学驿站', '待取件', '取件码：']);
  assert.equal(missing.issues.length, 1);
  assert.equal(plan(missing).reviews[0].reason, 'missing_code');
  assert.ok(missing.issues[0].sourceRegions.every(r => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end < 3));
  assert.equal(analyze(['甲大学驿站', '取件码1111', '另一件包裹', '取件码：问题待核实']).issues.length, 1);
});

test('合成两件：第二件真缺码仍复核，帮助说明不成为第三件', () => {
  const a = analyze(['甲大学驿站', '待取件', '取件码1111', '如有取件码问题请联系驿站',
    '乙大学驿站', '待取件', '取件码：']);
  assert.deepEqual(a.records.map(r => [r.code, r.station]), [['1111', '甲大学驿站']]);
  assert.equal(a.issues.length, 1);
  assert.equal(plan(a).reviews[0].reason, 'missing_code');
});

test('合成 OCR 丢失真实地点：保留地点复核，不从收件地址编造驿站', () => {
  const input = logisticsDetail({ location: '' });
  const a = parser.analyze(input.lines, 0, input.boxes);
  assert.equal(a.issues.length, 0);
  assert.equal(plan(a).reviews.length, 1);
  assert.equal(plan(a).reviews[0].reason, 'missing_location');
});

test('合成候选顺序：两件不同运单含同码，调换融合顺序不改包裹身份和决定', () => {
  const values = ['SF123456789012', 'SF123456789013'].map((waybillNumber, i) => ({ id: String(i), sourceIndex: 0, code: '1234', station: i ? '乙大学驿站' : '甲大学驿站', parcelStatus: 'pending', waybillNumber }));
  const outcomes = values => decision.evaluate(fuse(values), []).decisions.map(d => [d.candidate.waybillNumber, d.candidate.station, d.decision]).sort();
  assert.deepEqual(outcomes(values), outcomes(values.slice().reverse()));
  assert.equal(fuse(values).length, 2);
});

test('合成详情完整导入：旧3.0.3缓存不命中，新批次只存一件且重启不添缺码异常', async () => {
  const { page } = require('./helpers/page');
  const { fakeStorage } = require('./helpers/storage');
  const api = fakeStorage();
  api.getFileInfo = ({ success }) => success({ digest: 'b'.repeat(40), size: 100 });
  let calls = 0;
  const p = page(api, async () => { calls++; return logisticsDetail({ wrapped: true }); });
  try {
    const old = batches.begin('old-detail', 1);
    old.status = 'completed';
    old.images[0] = { index: 0, hash: 'b'.repeat(40) + ':100', state: 'done', status: 'code_found', parserVersion: '3.0.3', candidates: [
      { id: 'old-code', sourceIndex: 0, code: '95-1-1104', station: parser.UNKNOWN },
      { id: 'old-issue', sourceIndex: 0, code: '', station: parser.UNKNOWN },
    ].map(batches.cleanCandidate) };
    assert.equal(p.persistBatch(old), true);
    assert.equal(batches.cachedImage(p.importState, old.images[0].hash, 'new-detail'), null);
    p.data.images = ['synthetic-detail']; await p.recognizeCloud();
    assert.equal(calls, 1);
    assert.deepEqual(Array.from(p.data.records, r => [r.code, r.station]), [['95-1-1104', '北区3号楼东侧']]);
    assert.equal(p.data.exceptionCount, 0);
    const current = p.importState.batches.find(b => b.id !== old.id);
    assert.equal(current.images[0].parserVersion, batches.PARSER_VERSION);
    assert.equal(current.images[0].candidates.length, 1);
    assert.equal(current.reviews.length, 0);
    p.onUnload();
    const q = page(api);
    assert.equal(q.data.records.length, 1);
    assert.equal(q.data.exceptionCount, 0);
    q.onUnload();
  } finally { p.onUnload(); }
});
