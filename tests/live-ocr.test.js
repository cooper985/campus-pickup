const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { reserve, inventory, cacheFile } = require('./live-ocr/run.cjs');
const parser = require('../miniprogram/services/pickup-parser');
const fixture = require('./fixtures/live-ocr-20261023.json')[0];

test('真实 OCR 失败回归：相对到站时长不能当地点，带导航箭头的原文驿站应正确关联', () => {
  assert.deepEqual(parser.parse(fixture.result.lines, 0, fixture.result.boxes).map(r => [r.code, r.station]), fixture.expected);
  const old = execFileSync('git', ['show', '86f0af9:miniprogram/services/pickup-parser.js'], { encoding: 'utf8' });
  const vm = require('node:vm'), module = { exports: {} };
  vm.runInNewContext(old, { module, require: name => require('../miniprogram/services/' + name.slice(2)) });
  assert.equal(module.exports.parse(fixture.result.lines, 0, fixture.result.boxes)[0].station, fixture.previousFailure.station);
});
test('真实 OCR 调用预算：先持久化预留，同图不重复，30 次封顶，重启不重置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-ocr-budget-'));
  try {
    const b = { file: path.join(dir, 'budget.json'), state: { limit: 30, reservations: [] } };
    for (let i = 0; i < 30; i++) assert.equal(reserve(b, String(i), 'test'), true);
    assert.equal(reserve(b, '0', 'duplicate'), false); assert.equal(reserve(b, '31', 'over limit'), false);
    const restarted = { file: b.file, state: JSON.parse(fs.readFileSync(b.file, 'utf8')) };
    assert.equal(reserve(restarted, '32', 'restart'), false); assert.equal(restarted.state.reservations.length, 30);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('实时 OCR 缓存和原图被 Git 忽略；11 张有标注截图与无关对照只按原图摘要列入一次', { skip: !fs.existsSync('test-data/private/ocr-regression-20261021/01.jpg') }, () => {
  const samples = inventory();
  assert.equal(new Set(samples.map(s => s.hash)).size, samples.length);
  assert.equal(samples.filter(s => s.expected && !s.control).length, 11);
  assert.equal(samples.filter(s => s.control).length, 1);
  assert.ok(samples.every(s => !path.basename(s.path).startsWith('prepared-')));
  execFileSync('git', ['check-ignore', '-q', path.relative(process.cwd(), cacheFile(samples[0].hash))]);
});

test('本轮真实 OCR 缓存可离线验证六类批次，不触发云 API 或正式存储', { skip: !fs.existsSync(cacheFile(fixture.imageSha256)) }, async () => {
  const report = await require('./live-ocr/report.cjs').buildReport();
  assert.equal(report.calls.reserved, 23); assert.equal(report.calls.confirmedOcrCalls, 23);
  assert.equal(report.formalStorageUnchanged, true); assert.ok(report.scenarios.every(s => s.passed));
  assert.equal(report.labels.parsedCodeMatches, 21); assert.equal(report.labels.correctAssociations, 21);
});
