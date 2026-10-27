const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../miniprogram/services/pickup-parser');
const decision = require('../miniprogram/services/import-decision');
const fuse = require('../miniprogram/services/candidate-fusion').fuse;
const batches = require('../miniprogram/services/import-batches');

// Redacted equivalents of R08/R15/R22; not original Tencent responses.
const box = (y, x = 80, width = 850) => ({ x, y, width, height: 55 });
const plan = a => decision.evaluate(fuse([...a.records, ...a.issues].map((r, i) => ({ ...r, id: `c${i}` }))), []);

test('V31 短信截图：方括号签名与相邻换行组成完整地点和取件凭据', () => {
  const lines = ['[递管家]您的京东快递已到示例工业', '大学31号楼北京东快递，请用提货号', 'A4-1-12010取包裹，咨询驿站工作人', '员'];
  const a = parser.analyze(lines, 0, lines.map((_, i) => box(550 + i * 68)));
  assert.deepEqual(a.records.map(r => [r.code, r.station]), [['A4-1-12010', '示例工业大学31号楼北京东快递']]);
  assert.equal(a.issues.length, 0);
  assert.equal(plan(a).additions.length, 1);
  assert.deepEqual(a.records[0].sourceRegions.map(r => [r.start, r.end]), [[0, 3]]);
});

test('V31 两条方括号短信不会连接成一个包裹或串站', () => {
  const lines = ['[递管家]您的快递已到北区', '服务站，请用提货号A4-1-12010取包裹。', '[递管家]您的快递已到南区', '服务站，请用提货号B4-1-12011取包裹。'];
  const a = parser.analyze(lines, 0, lines.map((_, i) => box(550 + i * 68)));
  assert.deepEqual(a.records.map(r => [r.code, r.station]), [['A4-1-12010', '北区服务站'], ['B4-1-12011', '南区服务站']]);
});

test('V31 短信内换行拆码已被完整提取，不再留下额外缺码复核', () => {
  const lines = ['[递管家]您的京东快递已到示例工业', '大学31号楼北京东快递，请用提货号',
    'A4-1-', '12010取包裹，咨询驿站工作人员'];
  const a = parser.analyze(lines, 0, lines.map((_, i) => box(550 + i * 68)));
  assert.deepEqual(a.records.map(r => [r.code, r.station]), [['A4-1-12010', '示例工业大学31号楼北京东快递']]);
  assert.equal(a.issues.length, 0);
  assert.equal(plan(a).additions.length, 1);
  assert.equal(plan(a).reviews.length, 0);
  const field = ['取件码A4-1-', '12010'];
  assert.equal(parser.extractCodes(field, [box(0), box(68)]).codes[0].code, 'A4-1-12010');
  assert.equal(parser.extractCodes(field, [box(0), box(68, 2000)]).codes.length, 0);
  assert.equal(parser.extractCodes(field, [box(0), box(500)]).codes.length, 0);
  const shelf = ['菜鸟驿站', '待取件', '北门菜鸟驿站', '取件码A4-', '1-12010'];
  const wrapped = parser.analyze(shelf, 0, shelf.map((_, i) => box(i * 68)));
  assert.deepEqual(wrapped.records.map(r => r.code), ['A4-1-12010']);
  assert.equal(plan(wrapped).additions.length, 1);
  const missing = parser.analyze(['北区服务站', '取件码1111', '另一件包裹', '取件码：']);
  assert.equal(missing.issues.length, 1);
});

test('V31 地图状态不是站名：实际卡片地点仍可直接导入', () => {
  const lines = ['已放入菜鸟驿站', '待取件', '北区洗浴中心北侧菜鸟驿站', '示例路100号示例大学', '取件码', '73-3-4103'];
  const boxes = [box(555), box(991), box(1108), box(1175), box(1279, 164, 139), { x: 303, y: 1256, width: 414, height: 71 }];
  const a = parser.analyze(lines, 0, boxes);
  assert.equal(a.records[0].station, '北区洗浴中心北侧菜鸟驿站');
  assert.equal(plan(a).additions.length, 1);
  const mapOnly = parser.analyze(['已放入菜鸟驿站', '待取件', '取件码1234']);
  assert.equal(plan(mapOnly).reviews[0].reason, 'missing_location');
});

test('V31 暂存说明不成为站名，省略地点保持复核', () => {
  const a = parser.analyze(['待取件', '您的快件已暂存至驿站菜鸟驿站，请凭取货码及时领取', '北区31号楼500以上...', '取件码313-3-3318']);
  assert.equal(a.records[0].station, parser.UNKNOWN);
  assert.equal(plan(a).reviews[0].reason, 'missing_location');
});

test('V31 地点解析升级后不复用3.0.3.1候选缓存', () => {
  const old = batches.begin('before-v31', 1);
  old.status = 'completed';
  old.images[0] = { index: 0, hash: 'c'.repeat(40) + ':100', state: 'done', status: 'code_found', parserVersion: '3.0.3.1', candidates: [] };
  assert.equal(batches.cachedImage({ version: 1, batches: [old] }, old.images[0].hash, 'after-v31'), null);
});
