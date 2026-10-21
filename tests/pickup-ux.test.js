const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const storage = require('../miniprogram/services/pickup-store');
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = id => ({ currentTarget: { dataset: { id } } });
const imageEvent = p => ({ currentTarget: { dataset: { taskId: p.data.results[0].taskId } } });
const touch = (id, x, y, ending = false) => ({ ...event(id), [ending ? 'changedTouches' : 'touches']: [{ clientX: x, clientY: y }] });
function savedPage(wx = fakeStorage()) {
  const records = ['1111', '2222', '3333'].map(code => storage.newRecord({ station: '测试驿站', code }));
  records[1] = storage.updateRecord(records[1], { taken: true });
  records[2] = storage.updateRecord(records[2], { taken: true });
  const p = page(wx); p.persistRecords(records);
  return { p, wx, pending: records[0].id, taken: records[1].id, other: records[2].id };
}
test('慢无码图不挡住正常图，完成顺序独立更新且实际同时最多三次', async () => {
  let active = 0, peak = 0; const releases = {};
  const p = page(fakeStorage(), path => new Promise(resolve => {
    peak = Math.max(peak, ++active);
    releases[path] = lines => { active--; resolve({ mock: false, lines }); };
  }));
  p.data.images = ['slow', 'b', 'c', 'd', 'e']; const run = p.recognizeCloud(); await tick();
  assert.equal(peak, 3); assert.equal(Object.keys(releases).length, 3);
  releases.c(['取件码3333']); await tick();
  assert.equal(p.data.results[0].state, 'running'); assert.equal(p.data.results[2].count, 1);
  assert.equal(p.data.drafts[0].sourceIndex, 2); assert.ok(p.data.results[2].appearedMs >= 0);
  releases.b(['取件码2222']); await tick();
  releases.d(['已到站']); releases.e(['物流详情']); releases.slow(['运输中']); await run;
  assert.equal(peak, 3); assert.equal(p.data.drafts.length, 2);
  assert.equal(p.data.results[0].message, '快递运输中，暂无取件码');
  assert.equal(p.data.results[3].message, '已到站，但未发现可用取件码');
  assert.equal(p.data.results[4].message, '未发现取件码');
  assert.equal(p.data.results[2].message, '识别到 1 个取件码');
});
test('超时和手动重试仍占用真实请求槽，不因停止等待突破三次并发', async () => {
  const releases = []; let active = 0, peak = 0;
  const p = page(fakeStorage(), () => new Promise(resolve => {
    peak = Math.max(peak, ++active);
    releases.push(() => { active--; resolve({ mock: false, lines: ['取件码8888'] }); });
  }));
  p.recognitionTimeoutMs = 5; p.data.images = ['a', 'b', 'c']; await p.recognizeCloud();
  assert.equal(releases.length, 3); assert.equal(p.data.results[0].error, '识别超时，可单独重试');
  const oldId = p.data.results[0].taskId;
  const retry = p.retryImage(imageEvent(p)); await tick();
  assert.notEqual(p.data.results[0].taskId, oldId); assert.equal(p.data.results[0].state, 'queued');
  assert.equal(releases.length, 3);
  releases[0](); await tick(); assert.equal(releases.length, 4);
  releases[3](); await retry;
  assert.equal(p.data.drafts.length, 1); assert.equal(peak, 3);
  releases[1](); releases[2](); await tick(); assert.equal(p.data.drafts.length, 1);
});
test('取消批次不启动排队图，旧批次迟到结果不覆盖新选择或重复导入', async () => {
  const releases = [];
  const p = page(fakeStorage(), () => new Promise(resolve => releases.push(resolve)));
  p.data.images = ['a', 'b', 'c', 'd']; const run = p.recognizeCloud(); await tick();
  p.cancelRecognition(); await run; assert.equal(releases.length, 3);
  assert.ok(p.data.results.every(r => r.status === 'CANCELLED'));
  p.data.images = ['new']; const next = p.recognizeCloud();
  releases.forEach(resolve => resolve({ mock: false, lines: ['取件码1111'] })); await tick();
  releases[3]({ mock: false, lines: ['取件码9999'] }); await next;
  assert.equal(p.data.drafts.length, 1); assert.equal(p.data.drafts[0].code, '9999');
  await p.confirmImport(); assert.equal(p.data.records.length, 1);
  await tick(); assert.equal(p.data.records.length, 1);
});
test('识别异常可在其他图仍运行时单独重试，不重跑成功图；合法无码替换旧草稿', async () => {
  let release, fail = true; const calls = [];
  const p = page(fakeStorage(), async path => {
    calls.push(path);
    if (path === 'slow') return new Promise(resolve => release = resolve);
    if (fail) throw { code: 'CLOUD_FAILED' };
    return { mock: false, lines: ['运输中'] };
  });
  p.data.drafts = [{ id: 'old', sourceIndex: 0, code: '1111', station: '测试驿站' }];
  p.data.images = ['bad', 'slow']; const run = p.recognizeCloud(); await tick();
  assert.equal(p.data.results[0].error, '识别暂时不可用，请重试'); assert.equal(p.data.loading, true);
  fail = false; await p.retryImage(imageEvent(p)); assert.equal(p.data.drafts.length, 0);
  assert.equal(calls.join(','), 'bad,slow,bad');
  release({ mock: false, lines: ['已到站'] }); await run;
});
test('仅已取记录可右滑，明确横向阈值且最多展开一条，竖滚/短滑/取消不展开', () => {
  const { p, pending, taken, other } = savedPage();
  function swipe(id, dx, dy) { p.touchStart(touch(id, 20, 20)); p.touchMove(touch(id, 20 + dx, 20 + dy)); p.touchEnd(touch(id, 20 + dx, 20 + dy, true)); }
  swipe(pending, 100, 0); assert.equal(p.data.openDeleteId, '');
  swipe(taken, 55, 0); assert.equal(p.data.openDeleteId, '');
  swipe(taken, 60, 50); assert.equal(p.data.openDeleteId, '');
  swipe(taken, 80, 3); assert.equal(p.data.openDeleteId, taken);
  swipe(other, 80, 0); assert.equal(p.data.openDeleteId, other);
  swipe(other, -80, 0); assert.equal(p.data.openDeleteId, '');
  swipe(taken, 100, 0); p.touchCancel(); assert.equal(p.data.openDeleteId, '');
  p.suppressTapUntil = 0; p.revealDelete(event(taken)); p.recordTap(); assert.equal(p.data.openDeleteId, '');
  p.revealDelete(event(other)); p.onPageScroll(); assert.equal(p.data.openDeleteId, '');
});
test('待取拒绝删除，已取点击确认前保留；取消、重复点击和手势误触均不删除', async () => {
  const { p, wx, pending, taken } = savedPage(); let count = 0, release;
  wx.showModal = () => { count++; return new Promise(resolve => release = resolve); };
  p.revealDelete(event(pending)); await p.deleteRecord(event(pending)); assert.equal(count, 0);
  p.revealDelete(event(taken)); p.suppressTapUntil = Date.now() + 350; await p.deleteRecord(event(taken)); assert.equal(count, 0);
  p.suppressTapUntil = 0; const deletion = p.deleteRecord(event(taken)); await p.deleteRecord(event(taken));
  assert.equal(count, 1); assert.equal(p.data.records.length, 3);
  release({ confirm: false }); await deletion; assert.equal(p.data.records.length, 3);
});
test('删除立即落盘并跨重启消失；五秒内撤销恢复同一 ID 和已取状态', async () => {
  const { p, wx, taken } = savedPage(); const before = JSON.stringify(p.data.records);
  p.revealDelete(event(taken)); await p.deleteRecord(event(taken));
  assert.equal(p.data.records.length, 2); assert.equal(page(wx).data.records.length, 2);
  assert.equal(p.data.undoAvailable, true); p.undoDelete();
  assert.equal(JSON.stringify(p.data.records), before); assert.equal(JSON.stringify(page(wx).data.records), before);
  p.revealDelete(event(taken)); await p.deleteRecord(event(taken)); p.undoRecord.until = Date.now() - 1; p.undoDelete();
  assert.equal(p.data.records.length, 2); assert.equal(p.data.undoAvailable, false); p.onUnload();
});
test('删除与撤销写入失败都保留上次界面并进入保护，不伪装成功', async () => {
  const { p, wx, taken } = savedPage(); wx.failWrite = storage.KEY;
  p.revealDelete(event(taken)); await p.deleteRecord(event(taken));
  assert.equal(p.data.records.length, 3); assert.equal(p.data.undoAvailable, false); assert.equal(p.data.storageBlocked, true);
  const q = savedPage(); q.p.revealDelete(event(q.taken)); await q.p.deleteRecord(event(q.taken));
  q.wx.failWrite = storage.KEY; q.p.undoDelete(); assert.equal(q.p.data.records.length, 2); assert.equal(q.p.data.storageBlocked, true);
  q.p.onUnload();
});
test('已取仍可恢复待取，备用入口仅对已取生效；多指手势被取消', () => {
  const { p, taken } = savedPage(); p.revealDelete(event(taken)); p.toggleTaken(event(taken));
  assert.equal(p.data.records.find(r => r.id === taken).taken, false); assert.equal(p.data.openDeleteId, '');
  p.revealDelete(event(taken)); assert.equal(p.data.openDeleteId, '');
  p.toggleTaken(event(taken)); p.touchStart(touch(taken, 0, 0));
  p.touchMove({ ...event(taken), touches: [{ clientX: 80, clientY: 0 }, { clientX: 90, clientY: 0 }] });
  p.touchEnd(touch(taken, 80, 0, true)); assert.equal(p.data.openDeleteId, '');
});
test('正常图片可先导入，确认弹窗期间和导入后新完成的图片均保留，不丢失或重复导入', async () => {
  let releaseImage, releaseLast, releaseModal;
  const wx = fakeStorage();
  const p = page(wx, async path => path === 'slow' ? new Promise(resolve => releaseImage = resolve)
    : path === 'last' ? new Promise(resolve => releaseLast = resolve) : { mock: false, lines: ['取件码1111'] });
  p.data.images = ['fast', 'slow', 'last']; const run = p.recognizeCloud(); await tick();
  assert.equal(p.data.loading, true); assert.equal(p.data.drafts.length, 1);
  wx.showModal = () => new Promise(resolve => releaseModal = resolve);
  const importing = p.confirmImport();
  releaseImage({ mock: false, lines: ['取件码2222'] }); await tick();
  releaseModal({ confirm: true }); await importing;
  assert.equal(p.data.records.length, 1); assert.equal(p.data.records[0].code, '1111');
  assert.equal(p.data.drafts.length, 1); assert.equal(p.data.drafts[0].code, '2222');
  assert.equal(p.data.images.length, 3); assert.equal(p.data.loading, true);
  releaseLast({ mock: false, lines: ['取件码3333'] }); await run;
  wx.showModal = async () => ({ confirm: true }); await p.confirmImport();
  assert.equal(page(wx).data.records.length, 3);
});
test('删除确认期间页面卸载，不写入旧页面也不持久删除', async () => {
  const { p, wx, taken } = savedPage(); let release;
  wx.showModal = () => new Promise(resolve => release = resolve);
  p.revealDelete(event(taken)); const deletion = p.deleteRecord(event(taken));
  const before = JSON.stringify(wx.values); p.onUnload(); release({ confirm: true }); await deletion;
  assert.equal(JSON.stringify(wx.values), before); assert.equal(p.data.records.length, 3);
});
