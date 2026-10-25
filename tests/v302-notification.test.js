const { test } = require('node:test');
const assert = require('node:assert/strict');
const notification = require('../miniprogram/services/notification-parser');
const parser = require('../miniprogram/services/pickup-parser');
const pickupCode = require('../miniprogram/services/pickup-code');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
function plan(text) {
  const candidates = notification.parse(text).map((r, i) => ({ ...r, id: 'notice-' + i }));
  return { candidates, result: decision.evaluate(fuse(candidates), []) };
}

test('V302 通知合成：同一句标签码和凭码指令只是同一包裹的重复提及', () => {
  for (const text of [
    '【菜鸟驿站】您的包裹已到大学驿站，取件码1234，凭1234取件。',
    '【菜鸟驿站】您的包裹已到大学驿站，凭1234取件，取件码1234。',
    '包裹已到大学驿站，取件码为AB1234，请凭AB1234领取。',
  ]) {
    const { candidates, result } = plan(text);
    assert.equal(candidates.length, 1, text);
    assert.equal(result.additions.length, 1, text);
    assert.equal(result.reviews.length, 0, text);
  }
});

test('V302 通知合成：独立通知同码保留来源，不因重复提及修复而全局吞并', () => {
  const notice = '【菜鸟驿站】包裹已到大学驿站，取件码1234。';
  const { candidates, result } = plan(notice + '\n' + notice);
  assert.equal(candidates.length, 2);
  assert.equal(result.additions.length, 0);
  assert.equal(result.reviews.length, 2);
});

test('V302 通知合成：同句不同地点或显式另一包裹的同码仍要求复核', () => {
  for (const text of [
    '取件码1234，请到东门驿站领取，取件码1234，请到西门驿站领取。',
    '包裹已到东门驿站，取件码1234，凭1234到西门驿站取件。',
    '包裹已到大学驿站，取件码1234，另一个包裹已到大学驿站，取件码1234。',
  ]) {
    const { candidates, result } = plan(text);
    assert.equal(candidates.length, 2, text);
    assert.equal(result.additions.length, 0, text);
    assert.equal(result.reviews.length, 2, text);
  }
});

test('V302 通知合成：共享标签语法覆盖为、是、提货号及凭码领取', () => {
  for (const label of ['取件码为：', '取件码是', '提货号为', '提货号是：', '凭码领取：', '凭码取件是：']) {
    const text = label + '1234';
    assert.deepEqual(notification.parse('包裹已到大学驿站，' + text).map(r => r.code), ['1234'], text);
    assert.deepEqual(parser.parse(['大学驿站', text]).map(r => r.code), ['1234'], text);
  }
});

test('V302 共享标签工厂每次创建独立正则，调用顺序不影响下一次识别', () => {
  assert.equal(typeof pickupCode.codeLabels, 'function');
  const first = pickupCode.codeLabels(), second = pickupCode.codeLabels();
  assert.notEqual(first, second);
  assert.ok(first.exec('取件码为1234'));
  assert.equal(second.lastIndex, 0);
  assert.ok(second.exec('提货号是1234'));
});

test('V302 通知合成：共享标签扩展不放行日期、手机号、链接、验证码和掩码', () => {
  for (const text of [
    '取件码为2026-10-25', '提货号是13800138000', '取件码为18:30',
    'https://example.test/取件码1234', '查看取件码为1234',
    '验证码为1234，请凭1234取件', '取件码为8-?-9000',
  ]) {
    assert.equal(notification.parse(text).length, 0, text);
    assert.equal(parser.parse([text]).length, 0, text);
  }
});
