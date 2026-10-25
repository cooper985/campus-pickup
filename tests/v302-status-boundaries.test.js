const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../miniprogram/services/pickup-parser');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
const box = (x, y, width = 160) => ({ x, y, width, height: 30 });
function plan(lines, boxes = lines.map((_, i) => box(0, i * 50))) {
  const result = parser.analyze(lines, 0, boxes);
  return decision.evaluate(fuse([...result.records, ...result.issues].map((r, i) => ({ ...r, id: 'boundary-' + i }))), []);
}
const isTerminalSkip = d => d.decision === decision.AUTO_SKIP && d.reason === 'terminal';

test('V302 边界合成：已由通知适配器消费的终态不能再次归给普通 OCR 包裹', () => {
  const result = plan(['大学驿站', '取件码1111', '【菜鸟驿站】取件码2222，已到东门驿站，已领取']);
  assert.ok(!result.decisions.some(d => d.candidate.code === '1111' && isTerminalSkip(d)));
});

test('V302 边界合成：同一行多码不能因行号去重被当作单码确定终态', () => {
  const result = plan(['大学驿站', '取件码1111 取件码2222', '已领取']);
  assert.equal(result.decisions.length, 2);
  assert.ok(result.decisions.every(d => !isTerminalSkip(d)));
  assert.ok(result.reviews.length > 0);
});

test('V302 边界合成：无标签缺码的同站第二卡不能用终态跳过前卡', () => {
  const result = plan(['大学驿站', '取件码1111', '大学驿站', '已领取']);
  assert.ok(!result.decisions.some(d => d.candidate.code === '1111' && isTerminalSkip(d)));
});

test('V302 边界合成：双列宽站头下终态缺坐标时不能分配给任一列自动跳过', () => {
  const lines = ['大学驿站', '取件码1111', '取件码2222', '已领取'];
  const result = plan(lines, [box(0, 0, 700), box(0, 100), box(400, 100)]);
  assert.equal(result.decisions.length, 2);
  assert.ok(result.decisions.every(d => !isTerminalSkip(d)));
  assert.ok(result.reviews.length > 0);
});

test('V302 边界合成：宽站头下两项导航不能因为下方双列号码被当作独立卡片状态', () => {
  const result = plan(['大学驿站', '全部', '已领取', '取件码1111', '取件码2222'],
    [box(0, 0, 700), box(0, 50), box(400, 50), box(0, 150), box(400, 150)]);
  assert.equal(result.additions.length, 2);
  assert.ok(result.decisions.every(d => !isTerminalSkip(d)));
});
