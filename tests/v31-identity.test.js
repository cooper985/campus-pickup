const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const storage = require('../miniprogram/services/pickup-store');

test('V3.1 身份码指引不启动外部应用、不写入包裹或驿站记忆、不核销', () => {
  const wx = fakeStorage();
  for (const name of ['navigateToMiniProgram', 'openEmbeddedMiniProgram', 'setClipboardData']) wx[name] = () => assert.fail(name);
  const p = page(wx);
  p.persistRecords([storage.newRecord({ station: '测试驿站', code: '127-3-5016' })]);
  const before = JSON.stringify({ values: wx.values, records: p.data.records, stations: p.stationState, writes: wx.writes });
  p.openIdentityGuide();
  for (const platform of ['taobao', 'pinduoduo']) {
    p.selectIdentityPlatform({ currentTarget: { dataset: { platform } } });
    assert.equal(p.data.identityPlatform, platform);
  }
  p.selectIdentityPlatform({ currentTarget: { dataset: { platform: 'unknown' } } });
  assert.equal(p.data.identityPlatform, 'pinduoduo');
  p.closeIdentityGuide();
  p.openIdentityGuide();
  assert.equal(p.data.identityPlatform, '');
  assert.equal(JSON.stringify({ values: wx.values, records: p.data.records, stations: p.stationState, writes: wx.writes }), before);
  p.onUnload();
});

test('V3.1 隔离验证拒绝 App Scheme，不将小程序 API 成功当作身份码成功', () => {
  let p, call;
  const wx = { getLaunchOptionsSync: () => ({ scene: 1001 }), navigateToMiniProgram: options => { call = options; } };
  vm.runInNewContext(fs.readFileSync('tools/identity-probe/pages/probe/index.js', 'utf8'), { wx, Page: definition => { p = definition; } });
  p.setData = patch => Object.assign(p.data, patch);
  p.onLoad();
  assert.equal(p.data.capabilities.find(c => c.name === 'navigateToMiniProgramDirectly').available, false);
  p.data.shortLink = 'pinduoduo://com.xunmeng.pinduoduo/mdkd/package';
  p.testOfficialLink();
  assert.equal(call, undefined);
  p.data.shortLink = '#小程序://仅测试替身/fixture';
  p.testOfficialLink();
  assert.equal(call.shortLink, p.data.shortLink);
  assert.equal(call.appId, undefined);
  call.success();
  assert.match(p.data.result, /仍需|需人工/);
  assert.match(p.data.result, /不会真实跳转/);
  call.fail();
  assert.match(p.data.result, /失败或用户取消/);
});
