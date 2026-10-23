const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');

test('退出动画只保留展示副本，连续更新和减少动效不会复活草稿', async () => {
  const p = page();
  const a = { id: 'a', code: '1234', station: '测试站' };
  p.setDrafts([a]);
  p.removeDraft({ currentTarget: { dataset: { id: 'a' } } });
  assert.equal(p.data.validDraftCount, 0);
  assert.equal(p.data.drafts.length, 0);
  assert.equal(p.data.visibleDraftGroups[0].items[0].leaving, true);
  p.setDrafts([{ ...a, id: 'b' }]);
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(p.data.visibleDraftGroups[0].items.length, 1);
  assert.equal(p.data.visibleDraftGroups[0].items[0].id, 'b');
  p.toggleMotion();
  p.setDrafts([]);
  assert.equal(p.data.visibleDraftGroups.length, 0);
  p.onUnload();
});

test('V2.1 左滑跟手只更新样式，竖滑不拖动，取消清理临时状态', () => {
  const p = page();
  const storage = require('../miniprogram/services/pickup-store');
  const record = storage.updateRecord(storage.newRecord({ code: '1234', station: '测试站' }), { taken: true });
  p.persistRecords([record]);
  const event = (x, y) => ({ currentTarget: { dataset: { id: record.id } }, touches: [{ clientX: x, clientY: y }] });
  p.touchStart(event(100, 100)); p.touchMove(event(70, 102));
  assert.equal(p.data.swipeId, record.id);
  assert.match(p.data.swipeStyle, /translateX\(-30px\)/);
  p.touchCancel(); assert.equal(p.data.swipeId, '');
  p.touchStart(event(100, 100)); p.touchMove(event(90, 150));
  assert.equal(p.data.swipeId, '');
  p.onUnload();
});

test('V2.1 展开不重算记录，颜色不随排序变化，拖动仅传局部位移', () => {
  const p = page();
  const storage = require('../miniprogram/services/pickup-store');
  p.persistRecords(['北门', '南门'].map((station, i) => storage.newRecord({ station, code: `123${i}` })));
  const colors = Object.fromEntries(p.data.pendingGroups.map(g => [g.id, g.tone]));
  const ids = p.data.pendingGroups.map(g => g.id);
  p.stationState.groups.reverse(); p.updateRecords(p.data.records);
  p.data.pendingGroups.forEach(g => assert.equal(g.tone, colors[g.id]));
  const update = p.updateRecords; p.updateRecords = () => { throw Error('展开不应重算'); };
  p.toggleGroup({ currentTarget: { dataset: { station: '北门' } } });
  assert.equal(p.data.visiblePendingGroups.find(g => g.station === '北门').collapsed, true);
  p.updateRecords = update;
  p.stationDragging = { ids, rects: [{ top: 0, bottom: 100 }, { top: 120, bottom: 220 }], from: 0, clientY: 30, startPageY: 0 };
  p.data.dragId = ids[0];
  const patches = [], setData = p.setData;
  p.setData = function(patch) { patches.push(patch); setData.call(this, patch); };
  p.renderStationDrag();
  assert.equal(patches.length, 1);
  assert.ok(Object.keys(patches[0]).every(key => /^visiblePendingGroups\[\d+\]\.dragStyle$/.test(key)));
  p.renderStationDrag(); assert.equal(patches.length, 1);
  p.onUnload();
});

test('V2.1 快速重复核销不会恢复记录，最后一件保存成功后整站退出', () => {
  const p = page();
  const storage = require('../miniprogram/services/pickup-store');
  const record = storage.newRecord({ code: '1234', station: '测试站' });
  p.persistRecords([record]);
  const e = { currentTarget: { dataset: { id: record.id } } };
  p.toggleTaken(e); p.toggleTaken(e);
  assert.equal(p.data.remaining, 0);
  assert.equal(p.data.records[0].taken, true);
  assert.equal(p.data.visiblePendingGroups[0].leaving, true);
  p.undoDelete(); assert.equal(p.data.remaining, 1);
  assert.equal(p.data.visiblePendingGroups[0].leaving, undefined);
  p.onUnload();
});
