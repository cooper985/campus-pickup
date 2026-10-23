const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const store = require('../miniprogram/services/pickup-store');
const decision = require('../miniprogram/services/import-decision');
const event = (id, action, extra = {}) => ({ currentTarget: { dataset: { id, action, ...extra } } });
const imageEvent = (batchId, imageIndex) => event('', '', { batchId, imageIndex });
const response = (code, station = '大学服务站', extra = []) => ({ mock: false, lines: [station, `取件码${code}`, ...extra].filter(Boolean) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(recognize, hashes = {}) {
  const wx = fakeStorage();
  wx.getFileInfo = ({ filePath, success }) => success({ size: 100, digest: (hashes[filePath] || 1).toString(16).padStart(40, '0') });
  const p = page(wx, recognize);
  return { p, wx };
}

test('V2.3.1 清空待取与历史后，跨重启命中旧摘要仍重新入库，零额外 OCR', async () => {
  let calls = 0;
  const { p, wx } = setup(async () => { calls++; return response('B3-4-7401'); });
  p.data.images = ['a']; await p.recognizeCloud();
  assert.equal(p.data.activeTab, 'import'); p.toggleTaken(event(p.data.records[0].id)); await p.clearHistory();
  assert.equal(p.data.records.length, 0); assert.equal(p.importState.batches[0].images[0].state, 'done'); p.onUnload();
  const q = page(wx, async () => { throw Error('cache must avoid OCR'); }); q.data.images = ['a']; await q.recognizeCloud();
  assert.equal(q.data.records.length, 1); assert.equal(q.data.recentImport.added, 1); assert.equal(q.data.recentImport.duplicate, 0);
  assert.equal(q.data.results[0].cached, true); assert.equal(calls, 1); q.onUnload();
});
test('V2.3.1 同批相同截图共用一次 OCR，并与其他截图融合，重复图片与重复包裹分开说明', async () => {
  let calls = 0;
  const { p } = setup(async path => { calls++; return response('1111', path === 'full' ? '大学服务站' : ''); }, { partial: 1, same: 1, full: 2 });
  p.data.images = ['partial', 'same', 'full']; await p.recognizeCloud();
  assert.equal(calls, 2); assert.equal(p.data.records.length, 1); assert.equal(p.data.records[0].station, '大学服务站');
  assert.equal(p.data.recentImport.imageCount, 3); assert.equal(p.data.recentImport.added, 1); assert.equal(p.data.recentImport.duplicate, 2);
  p.showResultCategory(event('', '', { category: 'duplicate' }));
  assert.equal(p.data.categoryItems.length, 2); assert.match(p.data.categoryItems[0].reason, /本批截图 1/); assert.match(p.data.categoryItems[1].reason, /同一包裹/); p.onUnload();
});
test('V2.3.1 缓存命中照常检查当前待取与已取历史，同码历史不能永久跳过', async () => {
  const { p } = setup(async () => response('1111'));
  p.data.images = ['a']; await p.recognizeCloud(); await p.recognizeCloud();
  assert.equal(p.data.records.length, 1); assert.equal(p.data.recentImport.duplicate, 1);
  p.toggleTaken(event(p.data.records[0].id)); await p.recognizeCloud();
  assert.equal(p.data.exceptionOpen, true); assert.equal(p.data.currentException.reason, 'historical_code');
  const id = p.data.currentException.id; p.chooseException(event(id, 'new')); p.chooseException(event(id, 'new'));
  assert.equal(p.data.records.length, 2); assert.equal(p.data.remaining, 1); assert.equal(p.data.exceptionCount, 0); p.onUnload();
});
test('V2.3.1 数据为空也保留截图已取、取消、退回证据，缓存重用不生成待取', async () => {
  for (const state of ['已取件', '已取消', '已退回']) {
    const { p } = setup(async () => response('1111', '大学服务站', [state]));
    p.data.images = ['a']; await p.recognizeCloud(); await p.recognizeCloud();
    assert.equal(p.data.records.length, 0); assert.equal(p.data.results[0].cached, true); assert.equal(p.data.recentImport.unrelated, 1); p.onUnload();
  }
});
test('V2.3.1 逐件异常立即落盘并前进，稍后处理跨重启保留，结束留在导入结果', async () => {
  const { p, wx } = setup(async path => response(path === 'a' ? '1111' : '2222', ''), { a: 1, b: 2 });
  p.data.images = ['a', 'b']; await p.recognizeCloud();
  assert.equal(p.data.exceptionOpen, true); assert.equal(p.data.exceptionProgress, '1/2');
  const first = p.data.currentException.id; p.deferException(); assert.equal(p.data.exceptionProgress, '2/2');
  p.chooseException(event(p.data.currentException.id, 'new')); assert.equal(p.data.remaining, 1); assert.equal(p.data.exceptionOpen, false);
  assert.equal(p.data.activeTab, 'import'); assert.equal(p.data.exceptionCount, 1); p.onUnload();
  const q = page(wx); q.openExceptions(); assert.equal(q.data.currentException.id, first);
  q.chooseException(event(first, 'new')); assert.equal(q.data.remaining, 2); assert.equal(q.data.exceptionOpen, false);
  assert.equal(q.data.activeTab, 'import'); assert.equal(page(wx).data.exceptionCount, 0); q.onUnload();
});
test('V2.3.1 选择常用站与手动补码都直接保存，不需要二次保存选择', async () => {
  const { p, wx } = setup(async path => path === 'a' ? response('1111', '') : { mock: false, lines: ['快递已到站，请取件'] }, { a: 1, b: 2 });
  p.persistRecords([store.newRecord({ code: '9999', station: '用户服务站' })]);
  wx.showActionSheet = async () => ({ tapIndex: 0 });
  p.data.images = ['a', 'b']; await p.recognizeCloud();
  await p.chooseExceptionStation(event(p.data.currentException.id)); assert.equal(p.data.records[1].station, '用户服务站');
  assert.equal(p.data.currentException.needsCode, true); assert.equal(p.data.currentException.path, 'b');
  p.editException(event(p.data.currentException.id)); p.editCode({ detail: { value: '2222' } }); p.saveEdit();
  assert.equal(p.data.records.length, 3); assert.equal(p.data.exceptionOpen, false); assert.equal(p.data.exceptionCount, 0); p.onUnload();
});
test('V2.3.1 图片分类统计与明细一致，一张多件不当作多张，失败不冒充无关', async () => {
  const { p } = setup(async path => {
    if (path === 'bad') throw { code: 'NETWORK_FAILED' };
    if (path === 'chat') return { mock: false, lines: ['今晚一起吃饭'] };
    return { mock: false, lines: ['【驿小哥】取件码C205-2004，已到北门驿站。', '【京东】取件码A203-4010，已到西门服务站。'] };
  }, { multi: 1, duplicate: 1, chat: 2, bad: 3 });
  p.data.images = ['multi', 'duplicate', 'chat', 'bad']; await p.recognizeCloud();
  assert.equal(p.data.recentImport.added, 2); assert.equal(p.data.recentImport.imageCount, 4);
  for (const [category, field, count] of [['duplicate', 'duplicate', 1], ['unrelated', 'unrelated', 1], ['failure', 'failures', 1]]) {
    p.showResultCategory(event('', '', { category })); assert.equal(p.data.categoryItems.length, count); assert.equal(p.data.recentImport[field], count);
  }
  assert.equal(p.data.categoryItems[0].index, 3); assert.equal(p.data.failureCount, 1); assert.equal(p.data.categoryItems[0].path, 'bad'); p.onUnload();
});
test('V2.3.1 跨重启旧失败仍可重选原图重试，不重跑成功图、不覆盖已编辑记录', async () => {
  const { p, wx } = setup(async path => { if (path === 'bad') throw { code: 'NETWORK_FAILED' }; return response('1111'); }, { a: 1, bad: 2 });
  p.data.images = ['a', 'bad']; await p.recognizeCloud(); const batchId = p.data.recentImport.id; p.onUnload();
  let calls = 0;
  const q = page(wx, async () => { calls++; return response('2222'); });
  wx.chooseImage = async () => ({ tempFiles: [{ path: 'selected', size: 100 }] });
  q.showImportFailures(); assert.equal(q.data.categoryItems.length, 1); assert.equal(q.data.categoryItems[0].path, '');
  await q.retryFailures(event('', '', { batchId })); assert.equal(calls, 1); assert.equal(q.data.records.length, 2); assert.equal(q.data.failureCount, 0); q.onUnload();
  assert.equal(q.data.recentImport.duplicate, 0);
});
test('V2.3.1 连续重复点击识别、重试或异常选项不重复发送或写入', async () => {
  let release, calls = 0, retry = false;
  const { p } = setup(async () => { calls++; if (!retry) throw { code: 'NETWORK_FAILED' }; return new Promise(r => release = r); });
  p.data.images = ['a']; await p.recognizeCloud(); retry = true;
  const e = imageEvent(p.data.recentImport.id, 0), running = p.retryImage(e); p.retryImage(e); await tick();
  assert.equal(calls, 2); assert.equal(p.data.failureCount, 0); release(response('1111')); await running;
  assert.equal(p.data.records.length, 1); const signature = JSON.stringify(p.data.records); p.refreshRecognition(); assert.equal(JSON.stringify(p.data.records), signature); p.onUnload();
});
test('V2.3.1 历史菜单只清已取，确认取消或写失败均保护数据，撤销恢复精确快照', async () => {
  const { p, wx } = setup(async () => response('1111'));
  const pending = store.newRecord({ station: '待取服务站', code: '1111' });
  const taken = store.updateRecord(store.newRecord({ station: '历史服务站', code: '2222' }), { taken: true });
  p.persistRecords([pending, taken]); const stations = JSON.stringify(p.stationState);
  wx.showActionSheet = async () => ({ tapIndex: 0 }); wx.showModal = async () => ({ confirm: false });
  await p.openHistoryMenu(); assert.equal(p.data.records.length, 2);
  wx.showModal = async () => ({ confirm: true }); await p.openHistoryMenu();
  assert.equal(p.data.history.length, 0); assert.deepEqual(p.data.records[0], pending); assert.equal(JSON.stringify(p.stationState), stations);
  p.undoDelete(); assert.deepEqual(Array.from(p.data.records), [pending, taken]);
  wx.failWrite = store.KEY; await p.clearHistory(); assert.equal(p.data.records.length, 2); assert.equal(p.data.storageBlocked, true); p.onUnload();
});
test('V2.3.1 清空后重新导入时过期撤销不恢复旧历史，旧批次撤销不会复活已清空记录', async () => {
  const { p } = setup(async () => response('1111'));
  p.data.images = ['a']; await p.recognizeCloud(); p.toggleTaken(event(p.data.records[0].id)); await p.clearHistory();
  await p.recognizeCloud(); assert.equal(p.data.remaining, 1); p.undoDelete(); assert.equal(p.data.records.length, 1);
  p.undoImport(); assert.equal(p.data.records.length, 0); assert.equal(p.data.history.length, 0); p.onUnload();
});
test('V2.3.1 评估同批确定同一包裹幂等，完整历史运单跳过、仅同码保留判断', () => {
  const c = { id: 'a', station: '大学服务站', code: '1111' };
  assert.equal(decision.evaluate([c, { ...c, id: 'b' }], []).additions.length, 1);
  const old = store.updateRecord(store.newRecord(c), { taken: true });
  assert.equal(decision.evaluate([c], [old]).reviews[0].reason, 'historical_code');
  assert.equal(decision.evaluate([{ ...c, waybillNumber: 'SF123456789012' }], [{ ...old, waybillNumber: 'SF123456789012' }]).skipped, 1);
});
test('V2.3.1 界面只渲染当前异常，分类按需展开，键盘监听释放且不记录截图原文', () => {
  const wxml = fs.readFileSync('miniprogram/pages/pickup/index.wxml', 'utf8');
  assert.ok(!wxml.includes('保存已选处理')); assert.ok(!wxml.includes('可靠快递已自动保存')); assert.ok(!wxml.includes('wx:for="{{exceptionItems}}"'));
  assert.ok(wxml.includes('wx:if="{{resultCategory}}"')); assert.ok(!wxml.includes('wx:for="{{results}}"'));
  let listener, removed;
  const wx = fakeStorage(); wx.onKeyboardHeightChange = fn => listener = fn; wx.offKeyboardHeightChange = fn => removed = fn;
  const p = page(wx); listener({ height: 300 }); assert.equal(p.data.keyboardHeight, 300); p.onUnload(); assert.equal(removed, listener);
});
test('V2.3.1 缓存导入后的同批重试不复活用户删除的记录，下一批仍可重新导入', async () => {
  const { p } = setup(async () => response('1111'));
  p.data.images = ['a']; await p.recognizeCloud(); p.undoImport(); await p.recognizeCloud();
  assert.equal(p.data.results[0].cached, true);
  p.persistRecords([]);
  await p.retryImage(imageEvent(p.data.recentImport.id, 0));
  assert.equal(p.data.records.length, 0); assert.equal(p.data.currentException.reason, 'batch_conflict');
  p.closeExceptions(); await p.recognizeCloud(); assert.equal(p.data.records.length, 1); p.onUnload();
});
