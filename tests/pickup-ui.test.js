const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const storage = require('../miniprogram/services/pickup-store');
const event = dataset => ({ currentTarget: { dataset } });
test('待取看板按地点分组和数字排序，未知地点独立，收起不影响历史和存储', () => {
  const p = page();
  const records = ['12-1-10', '2-1-10', '2-1-2'].map(code => storage.newRecord({ station: '北门', code }));
  records.push(storage.newRecord({ station: '待确认地点', code: '1111' }));
  records.push(storage.updateRecord(storage.newRecord({ station: '南门', code: '2222' }), { taken: true }));
  p.persistRecords(records);
  assert.equal(p.data.activeTab, 'home'); assert.equal(p.data.remaining, 4);
  assert.equal(p.data.locationCount, 1); assert.equal(p.data.pendingGroups.length, 2);
  assert.deepEqual(Array.from(p.data.pendingGroups[0].items, r => r.code), ['2-1-2', '2-1-10', '12-1-10']);
  assert.equal(p.data.history.length, 1);
  p.toggleGroup(event({ station: '北门' })); assert.equal(p.data.pendingGroups[0].collapsed, true);
  p.toggleGroup(event({ station: '北门' })); assert.equal(p.data.pendingGroups[0].collapsed, false);
  p.switchTab(event({ tab: 'history' })); assert.equal(p.data.activeTab, 'history');
  assert.equal(p.data.records.length, 5); p.onUnload();
});
test('取件从首页移至历史，撤销落盘，写入失败不提示成功', () => {
  const wx = fakeStorage(), p = page(wx);
  const record = storage.newRecord({ station: '北门', code: '1111' }); p.persistRecords([record]);
  p.toggleTaken(event({ id: record.id })); assert.equal(p.data.remaining, 0); assert.equal(p.data.history.length, 1);
  assert.equal(p.data.undoMessage, '已取件'); p.undoDelete();
  assert.equal(p.data.remaining, 1); assert.equal(page(wx).data.records[0].taken, false);
  wx.failWrite = storage.KEY; p.toggleTaken(event({ id: record.id }));
  assert.equal(p.data.remaining, 1); assert.equal(p.data.undoAvailable, false); p.onUnload();
});
test('选图自动走 fileID，缺地点只暂存异常；稍后处理与重新进入保留', async () => {
  const wx = fakeStorage(); let calls = 0;
  wx.chooseImage = async () => ({ tempFiles: [{ path: 'image', size: 10 }] });
  const p = page(wx, async () => { calls++; return { mock: false, lines: ['取件码1111'] }; });
  p.switchTab(event({ tab: 'import' })); await p.chooseImage();
  assert.equal(calls, 1); assert.equal(p.data.results[0].transport, 'fileid'); assert.equal(p.data.drafts.length, 0);
  assert.equal(p.data.activeTab, 'import'); assert.equal(p.data.exceptionCount, 1); assert.equal(p.data.records.length, 0);
  p.openExceptions(); p.closeExceptions();
  const q = page(wx); assert.equal(q.data.exceptionCount, 1); q.openExceptions();
  q.chooseException(event({ id: q.data.exceptionItems[0].id, action: 'new' })); q.applyExceptions();
  assert.equal(q.data.remaining, 1); assert.equal(page(wx).data.records.length, 1); p.onUnload(); q.onUnload();
});
test('整批完成后编辑草稿与公司，确认才写入', async () => {
  let release;
  const p = page(fakeStorage(), path => path === 'slow' ? new Promise(r => release = r)
    : Promise.resolve({ mock: false, lines: ['取件码1111'] }));
  p.data.images = ['fast', 'slow']; const run = p.runRecognition(true, { shadow: true }); await new Promise(r => setImmediate(r));
  assert.equal(p.data.drafts.length, 0);
  release({ mock: false, lines: ['取件码2222'] }); await run;
  const id = p.data.drafts[0].id; p.editRecord(event({ id }));
  p.data.editing.station = '北门'; p.data.editing.carrier = '中通'; p.data.editing.code = '1234'; p.saveEdit();
  assert.equal(p.data.drafts[0].carrier, '中通');
  await p.confirmImport();
  assert.equal(p.data.records.length, 2); assert.equal(p.data.records[0].code, '1234');
  assert.equal(p.data.records[0].carrier, '中通'); p.onUnload();
});
