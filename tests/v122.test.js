const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const parser = require('../miniprogram/services/notification-parser');
const notify = (p, value) => { p.openNotification(); p.notificationInput({ detail: { value } }); };

test('整段通知按分句关联地点，凭码领取、多字母码和共用地点多码不漏；拒绝普通数字', () => {
  const cases = [
    ['【菜鸟驿站】您的快递已到达河工大洗浴中心北侧菜鸟驿站，取件码为73-3-4003，请及时领取。', [['73-3-4003', '河工大洗浴中心北侧菜鸟驿站', '']]],
    ['【邮政】包裹已到西门服务站，凭码领取：AB1234。', [['AB1234', '西门服务站', '中国邮政']]],
    ['快递已存入西门快递柜，取件码AB12CD34。', [['AB12CD34', '西门快递柜', '']]],
    ['【中通】包裹已到北门驿站，取件码A12345678。', [['A12345678', '北门驿站', '中通快递']]],
    ['取件码1234，取件地点东门驿站；包裹已到西门驿站，取件码5678。', [['1234', '东门驿站', ''], ['5678', '西门驿站', '']]],
    ['包裹已到东门驿站，取件码1111。另一个包裹取件码2222，请到西门驿站领取。', [['1111', '东门驿站', ''], ['2222', '西门驿站', '']]],
    ['取件码：\n1234、\n5678\n取件地点：东门驿站。', [['1234', '东门驿站', ''], ['5678', '东门驿站', '']]],
    ['快递已到东门驿站。\n取件码1234\n快递已到西门驿站。\n取件码5678', [['1234', '东门驿站', ''], ['5678', '西门驿站', '']]],
    ['凭码AB1234领取', [['AB1234', '待确认地点', '']]],
    ['联系电话13812345678，运单号SF123456789012，验证码123456，日期2026-10-23，18:30，普通数字1234', []],
    ['取件码：2026-10-23，取件码：13812345678，取件码：18:30，取件码：SF123456789012', []],
    ['取件码1234，取件地址东门驿站，取件地点西门驿站', [['1234', '待确认地点', '']]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parser.parse(text).map(r => [r.code, r.station, r.carrier]), expected, text);
});
test('打开和输入不读取剪贴板或自动解析；点击才识别，修改/重识别/清空/取消均只影响草稿', async () => {
  const wx = fakeStorage(); let reads = 0, calls = 0, ocrCalls = 0;
  wx.getClipboardData = () => { reads++; throw Error('no clipboard access'); };
  const p = page(wx, () => { ocrCalls++; throw Error('no OCR'); }, undefined, {
    'notification-parser': { parse: text => { calls++; return parser.parse(text); } }
  });
  notify(p, '【菜鸟】已到北门驿站，取件码1234');
  assert.equal(reads, 0); assert.equal(calls, 0); assert.equal(p.data.validDraftCount, 0);
  await p.recognizeNotification({ shadow: true }); assert.equal(calls, 1); assert.equal(ocrCalls, 0);
  assert.equal(p.data.notificationOpen, false); assert.equal(p.data.drafts[0].station, '北门驿站');
  notify(p, '取件码5678，请到南门驿站领取'); assert.equal(calls, 1);
  await p.recognizeNotification({ shadow: true }); assert.equal(p.data.drafts.length, 1); assert.equal(p.data.drafts[0].code, '5678');
  p.openNotification(); p.clearNotificationText(); assert.equal(p.data.notificationText, ''); assert.equal(p.data.drafts.length, 0);
  await p.recognizeNotification({ shadow: true }); assert.equal(calls, 2); assert.match(p.data.error, /粘贴通知/);
  p.notificationInput({ detail: { value: '取件码8888' } }); await p.recognizeNotification({ shadow: true });
  p.openNotification(); p.cancelNotification(); assert.equal(p.data.notificationText, ''); assert.equal(p.data.drafts.length, 0);
  assert.equal(reads, 0); assert.equal(Object.keys(wx.values).length, 0); p.onUnload();
});
test('通知输入取消不删除原有截图草稿；取消替换或页面卸载不产生迟到草稿', async () => {
  const wx = fakeStorage(), p = page(wx); p.setDrafts([{ id: 'image', code: '1111', station: '北门' }]);
  notify(p, '取件码2222'); p.cancelNotification(); assert.equal(p.data.drafts[0].id, 'image');
  wx.showModal = async () => ({ confirm: false }); notify(p, '取件码2222'); await p.recognizeNotification({ shadow: true });
  assert.equal(p.data.drafts[0].id, 'image'); assert.equal(p.data.notificationOpen, true);
  let release; wx.showModal = () => new Promise(resolve => release = resolve);
  const run = p.recognizeNotification({ shadow: true }); p.onUnload(); release({ confirm: true }); await run;
  assert.equal(p.data.drafts[0].id, 'image'); assert.equal(p.data.notificationText, '');
});
