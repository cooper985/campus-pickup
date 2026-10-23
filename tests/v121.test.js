const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../miniprogram/services/notification-parser');
const { validCode } = require('../miniprogram/services/pickup-code');
const drag = require('../miniprogram/services/station-drag');
const stations = require('../miniprogram/services/stations');
const storage = require('../miniprogram/services/pickup-store');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const event = id => ({ currentTarget: { dataset: { id } } });
const touch = (id, x, y, end = false) => ({ ...event(id), [end ? 'changedTouches' : 'touches']: [{ clientX: x, clientY: y }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('整段通知无需分段复制，处理无标点、换行、多包裹及码在地点前，过滤验证码', () => {
  const samples = [
    ['【中通】您的快递已到31号楼驿站取件码为【 1-1-25 】请及时领取', [['1-1-25', '31号楼驿站']]],
    ['您的快递已到31号楼驿站，取件码1-1-8，另一个包裹已到西门快递柜，取件码B3-4-25。联系电话13812345678', [['1-1-8', '31号楼驿站'], ['B3-4-25', '西门快递柜']]],
    ['取件码1234，取件地点东门驿站，取件码5678，取件地点西门驿站', [['1234', '东门驿站'], ['5678', '西门驿站']]],
    ['【京东物流】您的快递已送达西门快递柜。\n取件码：\nB3-4-7401。验证码：9876，电话：13812345678', [['B3-4-7401', '西门快递柜']]],
    ['验证码：1234，请凭1234取件', []],
  ];
  for (const [text, expected] of samples) assert.deepEqual(parser.parse(text).map(r => [r.code, r.station]), expected, text);
  assert.equal(parser.parse('取件码123')[0].code, '123');
  assert.equal(parser.parse(samples[0][0])[0].carrier, '中通快递');
  assert.equal(parser.parse('您的韵达包裹已到北门驿站，取件码1234')[0].carrier, '韵达快递');
  assert.equal(parser.parse('验证码为：1234，请凭1234取件').length, 0);
  assert.equal(parser.parse('取件码1234，您的快递尚未到31号楼')[0].station, '待确认地点');
});
test('无可靠号码不生成草稿，核对修改和保存仍拦截占位、电话和日期', async () => {
  const p = page(); p.openNotification();
  p.notificationInput({ detail: { value: '验证码：123456，联系电话13812345678，运单号123456789012' } });
  await p.recognizeNotification({ shadow: true });
  assert.equal(p.data.drafts.length, 0); assert.equal(p.data.validDraftCount, 0); assert.match(p.data.error, /未找到取件码/);
  for (const code of ['', '请补充取件码', '号码缺失', '13812345678', '2026-10-22', '18:30', '123456789012', '待确认', '****']) {
    assert.equal(validCode(code), false, code);
    p.setDrafts([{ id: 'bad', code, station: '待确认地点', carrier: '' }]);
    p.editRecord(event('bad')); p.saveEdit(); assert.ok(p.data.editing);
    await p.confirmImport(); assert.equal(p.data.records.length, 0); assert.equal(p.data.validDraftCount, 0);
  }
  p.setDrafts([{ id: 'good', code: 'B3-4-7401', station: '待确认地点', carrier: '' }]);
  await p.confirmImport(); assert.equal(p.data.records.length, 1); assert.equal(p.data.drafts.length, 0); p.onUnload();
});
test('移除、清空和取消仅影响草稿；有效计数精确，成功后不残留旧草稿和错误', async () => {
  const p = page(); p.persistRecords([storage.newRecord({ station: '原驿站', code: '1111' })]);
  const before = JSON.stringify(p.data.records);
  p.setDrafts([{ id: 'a', station: '北门', code: '2222' }, { id: 'b', station: '北门', code: '3333' }, { id: 'bad', station: '北门', code: '请补充取件码' }]);
  assert.equal(p.data.validDraftCount, 2); assert.equal(p.data.draftGroups[0].validCount, 2); p.removeDraft(event('a')); assert.equal(p.data.validDraftCount, 1);
  await p.confirmImport(); assert.equal(p.data.records.length, 2); assert.equal(p.data.drafts.length, 0); assert.equal(p.data.validDraftCount, 0);
  p.setDrafts([{ id: 'a', station: '北门', code: '4444' }]); p.clearImportResults(); assert.equal(p.data.drafts.length, 0);
  assert.equal(JSON.stringify(p.data.records[0]), JSON.stringify(JSON.parse(before)[0]));
  p.setDrafts([{ id: 'a', station: '北门', code: '4444' }]); p.data.error = '旧识别错误'; p.cancelImport();
  assert.equal(p.data.activeTab, 'home'); assert.equal(p.data.error, ''); assert.equal(p.data.validDraftCount, 0); assert.equal(p.data.records.length, 2); p.onUnload();
});
test('清空/取消隔离仍运行的识别；离开通知输入界面清理文字和提示', async () => {
  const wx = fakeStorage(); let release;
  const p = page(wx, () => new Promise(resolve => release = resolve)); p.data.images = ['pending'];
  const run = p.runRecognition(true, { shadow: true }); await tick(); p.clearImportResults();
  release({ mock: false, lines: ['取件码1234'] }); await run; assert.equal(p.data.drafts.length, 0);
  p.openNotification(); p.notificationInput({ detail: { value: '已到西门驿站，取件码1234' } });
  p.cancelImport(); assert.equal(p.data.notificationText, '');
  assert.equal(p.data.drafts.length, 0); assert.equal(p.data.choosing, false);
  p.data.error = '旧错误'; p.data.importFeedback = '旧成功'; p.switchTab({ currentTarget: { dataset: { tab: 'history' } } });
  assert.equal(p.data.error, ''); assert.equal(p.data.importFeedback, ''); p.onUnload();
});
function dragPage() {
  const wx = fakeStorage(), p = page(wx);
  p.persistRecords(['A', 'B', 'C'].map(station => storage.newRecord({ station, code: '1111' })));
  const rects = [{ top: 100, bottom: 220 }, { top: 230, bottom: 410 }, { top: 420, bottom: 520 }];
  wx.createSelectorQuery = () => { const q = { in: () => q, selectAll: () => q, boundingClientRect: () => q,
    selectViewport: () => q, scrollOffset: () => q, exec: cb => cb([rects, { scrollTop: 0 }]) }; return q; };
  wx.getWindowInfo = () => ({ windowHeight: 800 });
  return { p, wx, rects };
}
test('长按前移动视为滚动；长按预览让位、取消不存盘；松手落盘且不影响站内排序', async () => {
  const { p, wx, rects } = dragPage();
  const ids = p.data.pendingGroups.map(g => g.id), before = JSON.stringify(p.data.records);
  p.stationTouchStart(touch(ids[0], 20, 120)); p.moveStationDrag(touch(ids[0], 20, 145)); p.beginStationDrag(); assert.equal(p.data.dragId, '');
  p.stationTouchStart(touch(ids[0], 20, 120)); p.beginStationDrag(); assert.equal(p.data.dragId, ids[0]);
  const preview = drag.preview(rects, 0, 350); assert.equal(preview.target, 2); assert.equal(preview.offsets[1], -130);
  p.moveStationDrag(touch(ids[0], 20, 470)); p.cancelStationDrag(); assert.equal(p.stationState.groups[0].id, ids[0]);
  p.stationTouchStart(touch(ids[0], 20, 120)); p.beginStationDrag(); p.finishStationDrag(touch(ids[0], 20, 470, true));
  assert.deepEqual(Array.from(page(wx).data.pendingGroups, g => g.id), [ids[1], ids[2], ids[0]]);
  assert.equal(p.stationDragging.settling, true);
  await new Promise(resolve => setTimeout(resolve, 210));
  assert.deepEqual(Array.from(p.data.pendingGroups, g => g.id), [ids[1], ids[2], ids[0]]);
  assert.equal(p.data.dragId, '');
  assert.equal(JSON.stringify(p.data.records), before); p.onUnload();
});
test('拖动保存失败恢复原顺序，触摸取消和隐藏页面退出拖动；隐藏驿站保留原槽位', () => {
  const { p, wx } = dragPage(); const id = p.data.pendingGroups[0].id, before = JSON.stringify(p.stationState);
  p.stationTouchStart(touch(id, 20, 120)); p.beginStationDrag(); wx.failWrite = stations.KEY; p.finishStationDrag(touch(id, 20, 470, true));
  assert.equal(JSON.stringify(p.stationState), before); assert.equal(p.data.dragId, ''); assert.equal(p.data.stationBlocked, true); p.onUnload();
  const q = dragPage().p; q.stationTouchStart(touch(q.data.pendingGroups[0].id, 20, 120)); q.beginStationDrag(); q.onHide(); assert.equal(q.data.dragId, ''); q.onUnload();
  const state = { version: 1, groups: ['A', 'hidden', 'B', 'C'].map(id => ({ id })) };
  assert.deepEqual(drag.reorder(state, ['A', 'B', 'C'], 0, 2).groups.map(g => g.id), ['B', 'hidden', 'C', 'A']);
});
