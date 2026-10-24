const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const store = require('../miniprogram/services/pickup-store');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
const journal = require('../miniprogram/services/import-batches');
const evidence = require('../miniprogram/services/import-evidence');
const stations = require('../miniprogram/services/stations');
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (id, action, extra = {}) => ({ currentTarget: { dataset: { id, action, ...extra } } });
const candidate = (i, extra = {}) => ({ id: `c${i}`, code: `A${i}-1000`, station: '大学服务站', sourceIndex: i, carrier: '', ...extra });
const response = (code, station = '大学服务站', extra = []) => ({ mock: false, lines: [station, `取件码${code}`, ...extra].filter(Boolean) });
const sha = n => n.toString(16).padStart(40, '0');
function hashing(wx, values) {
  wx.getFileInfo = ({ filePath, success }) => success({ size: 100, digest: sha(values[filePath] || 1) });
}
async function batch(inputs, wx = fakeStorage(), responses) {
  let calls = 0;
  const p = page(wx, async path => { calls++; const r = responses ? responses[path] : inputs[path]; if (r instanceof Error) throw { code: 'NETWORK_FAILED' }; return r; });
  p.data.images = Object.keys(inputs); await p.recognizeCloud();
  return { p, wx, calls };
}

test('V2.3 九张有效截图：自动保存、无需确认，整批三并发并在最后一张完成后才写记录', async () => {
  const wx = fakeStorage(), releases = {}; let active = 0, peak = 0, modals = 0;
  wx.showModal = async () => { modals++; return { confirm: true }; };
  const p = page(wx, path => { peak = Math.max(peak, ++active); return new Promise(resolve => releases[path] = value => { active--; resolve(value); }); });
  p.data.images = Array.from({ length: 9 }, (_, i) => `p${i}`);
  const run = p.recognizeCloud(); await tick(); assert.equal(peak, 3);
  for (let i = 0; i < 8; i++) { releases[`p${i}`](response(`A${i}-1000`)); await tick(); assert.equal(p.data.records.length, 0); }
  releases.p8(response('A8-1000')); await run;
  assert.equal(p.data.records.length, 9); assert.equal(page(wx).data.remaining, 9); assert.equal(modals, 0);
  assert.equal(p.data.activeTab, 'import'); assert.equal(p.data.drafts.length, 0); assert.equal(p.data.recentImport.added, 9); p.onUnload();
});
test('V2.3 完全重复图片只 OCR 一次；重启后再次选择相同摘要不调用 OCR，撤销后可重导', async () => {
  const wx = fakeStorage(); hashing(wx, { a: 1, duplicate: 1, b: 2 });
  let calls = 0; const recognize = async path => { calls++; return response(path === 'b' ? '2222' : '1111'); };
  const p = page(wx, recognize); p.data.images = ['a', 'duplicate', 'b']; await p.recognizeCloud();
  assert.equal(calls, 2); assert.equal(p.data.records.length, 2); assert.equal(p.data.results[1].status, 'duplicate');
  const q = page(wx, recognize); q.data.images = ['a']; await q.recognizeCloud();
  assert.equal(calls, 2); assert.equal(q.data.records.length, 2); assert.equal(q.data.recentImport.skipped, 1);
  p.onUnload(); q.onUnload();
});
test('V2.3 相似页面保留新增信息，同码两图补地点只新增一件，一图多通知独立保存', async () => {
  const wx = fakeStorage(); hashing(wx, { a: 1, b: 2, multi: 3 });
  const { p, calls } = await batch({ a: response('B3-4-7401', '', ['运单号：SF123456789012']), b: response('B3-4-7401', '河南工业大学服务站', ['运单号：SF123456789012']),
    multi: { mock: false, lines: ['【驿小哥】取件码C205-2004，已到北门驿站。', '【京东】取件码A203-4010，已到西门服务站。'] } }, wx);
  assert.equal(calls, 3); assert.equal(p.data.records.length, 3);
  assert.equal(p.data.records.find(r => r.code === 'B3-4-7401').station, '河南工业大学服务站');
  assert.ok(p.data.records.some(r => r.code === 'A203-4010')); assert.ok(p.data.records.some(r => r.code === 'C205-2004')); p.onUnload();
});
test('V2.3 九图混合：五新件、缺地点、已有件、无关图、重复图，正常件先保存', async () => {
  const wx = fakeStorage(); hashing(wx, { p0: 1, p1: 2, p2: 3, p3: 4, p4: 5, missing: 6, old: 7, chat: 8, duplicate: 1 });
  const p = page(wx, async path => path === 'chat' ? { mock: false, lines: ['今晚一起去食堂吃饭'] } : response(path === 'missing' ? '8888' : path === 'old' ? '9999' : path === 'duplicate' ? 'A0-1000' : `A${path.slice(1)}-1000`, path === 'missing' ? '' : '大学服务站'));
  p.persistRecords([store.newRecord(candidate(0, { code: '9999' }))]);
  p.data.images = ['p0', 'p1', 'p2', 'p3', 'p4', 'missing', 'old', 'chat', 'duplicate']; await p.recognizeCloud();
  assert.equal(p.data.records.length, 6); assert.equal(p.data.recentImport.added, 5); assert.equal(p.data.recentImport.skipped, 3);
  assert.equal(p.data.exceptionCount, 1); assert.equal(p.data.recentImport.reviewCount, 1); p.onUnload();
});
test('V2.3 全部已有待取：零新增；老通知、签收及状态冲突分别有理由且不改旧状态', async () => {
  const old = store.newRecord(candidate(0, { code: '1111' }));
  const wx = fakeStorage(); const p = page(wx, async () => response('1111')); p.persistRecords([old]); p.data.images = ['a', 'b']; await p.recognizeCloud();
  assert.equal(p.data.records.length, 1); assert.equal(p.data.recentImport.added, 0); assert.deepEqual(p.data.records[0], old);
  for (const [extra, reason] of [[['通知时间：2020-01-02 12:00'], 'old_notice'], [['已签收'], 'signed'], [['已取件', '待取件'], 'status_conflict']]) {
    const r = await batch({ a: response('2222', '大学服务站', extra) });
    assert.equal(r.p.data.records.length, 0); assert.equal(r.p.importState.batches[0].reviews[0].reason, reason); r.p.onUnload();
  }
  p.onUnload();
});
test('V2.3 历史同码重新出现必须确认；相同运单跳过，异运单或地点冲突需处理', () => {
  const c = candidate(0), old = store.updateRecord(store.newRecord(c), { taken: true });
  assert.equal(decision.evaluate([c], [old]).reviews[0].reason, 'historical_code');
  const waybillNumber = 'SF123456789012';
  assert.equal(decision.evaluate([{ ...c, waybillNumber }], [{ ...old, waybillNumber }]).skipped, 1);
  assert.equal(decision.evaluate([{ ...c, waybillNumber: 'SF999999999999' }], [{ ...old, taken: false, takenAt: null, waybillNumber }]).additions.length, 1);
  for (const changes of [{ station: '西门服务站' }]) {
    assert.equal(decision.evaluate([{ ...c, ...changes }], [{ ...old, taken: false, takenAt: null, waybillNumber }]).reviews.length, 1);
  }
  assert.equal(decision.evaluate([{ ...c, parcelStatus: 'terminal' }], []).skipped, 1);
  assert.equal(decision.evaluate([{ ...c, parcelStatus: 'terminal' }], [{ ...old, taken: false, takenAt: null }]).reviews[0].reason, 'status_conflict');
});
test('V2.3 跨图整组检查防传递误合并：地点、运单、状态冲突与相似码均需处理', () => {
  const c = extra => candidate(0, extra);
  for (const values of [
    [c({ id: 'a', sourceIndex: 0, station: '东门驿站' }), c({ id: 'b', sourceIndex: 1, station: '待确认地点' }), c({ id: 'c', sourceIndex: 2, station: '西门驿站' })],
    [c({ id: 'a', sourceIndex: 0, parcelStatus: 'pending' }), c({ id: 'b', sourceIndex: 1, parcelStatus: 'terminal' })],
    [c({ id: 'a', code: 'A1-1200', sourceIndex: 0 }), c({ id: 'b', code: 'A1-12O0', sourceIndex: 1 })],
  ]) {
    const plan = decision.evaluate(fuse(values), []); assert.equal(plan.additions.length, 0); assert.ok(plan.reviews.length);
  }
});
test('V2.3 新地点直接导入；确认别名和地址参与补全，但不覆盖新通知的地点和地址', async () => {
  let state = stations.sync({ version: 1, groups: [] }, [candidate(0, { station: '东门驿站' }), candidate(1, { station: '东门快递站' })]);
  state = stations.merge(state, state.groups.map(g => g.id), '东门驿站'); state = stations.remember(state, { station: '东门驿站', pickupAddress: '31号楼一层' });
  assert.equal(stations.assist(state, candidate(0, { station: '东门快递站' })).pickupAddress, '31号楼一层');
  assert.equal(stations.assist(state, candidate(0, { station: '西门驿站' })).station, '西门驿站');
  assert.equal(stations.assist(state, candidate(0, { station: '东门快递站', pickupAddress: '新明确地址' })).pickupAddress, '新明确地址');
  const { p } = await batch({ a: response('C2-3-1304', '陌生大学服务站') }); assert.equal(p.data.records.length, 1); assert.equal(p.data.newStations.length, 1);
  p.addNewStations(); assert.ok(p.stationState.groups[0].confirmed); p.onUnload();
});
test('V2.3 部分 OCR 失败：成功件自动保存，单图重试不重复写入；返回顺序不影响结果', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const releases = {}; let retry = false;
    const p = page(fakeStorage(), path => retry ? Promise.resolve(response('3333')) : new Promise((resolve, reject) => releases[path] = { resolve, reject }));
    p.data.images = ['a', 'b', 'bad']; const run = p.recognizeCloud(); await tick();
    const codes = ['1111', '2222']; releases[['a', 'b'][order[0]]].resolve(response(codes[order[0]])); await tick(); assert.equal(p.data.records.length, 0);
    releases.bad.reject({ code: 'NETWORK_FAILED' }); releases[['a', 'b'][order[1]]].resolve(response(codes[order[1]])); await run;
    assert.deepEqual(Array.from(p.data.records, r => r.code), ['1111', '2222']); assert.equal(p.data.recentImport.failures, 1);
    retry = true; await p.retryImage({ currentTarget: { dataset: { index: 3 } } });
    assert.equal(p.data.records.length, 3); assert.equal(p.data.recentImport.added, 3); assert.equal(p.data.recentImport.failures, 0); p.onUnload();
  }
});
test('V2.3 小程序中途退出：完整批次前不写记录，已识别候选可恢复，未识别图仍报告失败', async () => {
  const wx = fakeStorage(), releases = {};
  const p = page(wx, path => new Promise(resolve => releases[path] = resolve));
  p.data.images = ['done', 'pending']; const run = p.recognizeCloud(); await tick();
  releases.done(response('1111')); await tick(); assert.equal(p.data.records.length, 0); p.onUnload(); await run;
  const q = page(wx); assert.equal(q.data.records.length, 1); assert.equal(q.data.records[0].code, '1111'); assert.equal(q.data.recentImport.failures, 1);
  const r = page(wx); assert.equal(r.data.records.length, 1); releases.pending(response('2222')); await tick(); assert.equal(q.data.records.length, 1); q.onUnload(); r.onUnload();
});
test('V2.3 同批重复触发、重复完成和重进页面不能重复新增', async () => {
  let release, calls = 0; const wx = fakeStorage();
  const p = page(wx, async () => { calls++; return new Promise(resolve => release = resolve); });
  p.data.images = ['a']; const first = p.recognizeCloud(); await p.recognizeCloud(); await tick(); release(response('1111')); await first;
  const batchId = p.data.recentImport.id; p.refreshRecognition(); p.refreshRecognition();
  assert.equal(calls, 1); assert.equal(p.data.records.length, 1); assert.equal(p.importState.batches.filter(b => b.id === batchId).length, 1); assert.equal(page(wx).data.records.length, 1); p.onUnload();
});
test('V2.3 自动导入后立即撤销并重启，原有记录不删、恢复旧字段且再次撤销无效', async () => {
  const wx = fakeStorage(); const p = page(wx, async path => response(path === 'old' ? '1111' : '2222', '大学服务站', path === 'old' ? ['运单号SF123456789012'] : []));
  const old = store.newRecord(candidate(0, { code: '1111', station: '待确认地点', waybillNumber: 'SF123456789012' })); p.persistRecords([old]);
  p.data.images = ['old', 'new']; await p.recognizeCloud(); assert.equal(p.data.recentImport.updated, 1); assert.equal(p.data.records.length, 2);
  const q = page(wx); q.undoImport(); assert.equal(q.data.records.length, 1); assert.deepEqual(q.data.records[0], old); assert.equal(page(wx).data.records.length, 1);
  q.undoImport(); assert.equal(q.data.records.length, 1); p.onUnload(); q.onUnload();
});
test('V2.3 导入后编辑或核销，再撤销保留后续操作；同毫秒修改再改回也不能覆盖', async () => {
  const { p, wx } = await batch({ a: response('1111'), b: response('2222'), c: response('3333') });
  p.toggleTaken(event(p.data.records[0].id));
  p.editRecord(event(p.data.records[1].id)); p.editStation({ detail: { value: '用户新地点' } }); p.saveEdit();
  p.undoImport(); assert.equal(p.data.records.length, 2); assert.equal(p.data.records[0].taken, true); assert.equal(p.data.records[1].station, '用户新地点');
  assert.equal(p.data.recentImport.conflicts, 2); assert.equal(page(wx).data.records.length, 2); p.onUnload();
});
test('V2.3 缺地点稍后处理与选择跨重启保留；可直接加入待确认，不核对可靠号码', async () => {
  const { p, wx } = await batch({ a: response('A203-4010', '') });
  p.openExceptions(); const id = p.data.exceptionItems[0].id;
  p.closeExceptions(); p.onUnload();
  const q = page(wx); q.openExceptions(); assert.equal(q.data.exceptionItems[0].action, ''); assert.equal(q.data.exceptionItems[0].code, 'A203-4010');
  q.chooseException(event(id, 'new')); assert.equal(q.data.records.length, 1); assert.equal(q.data.records[0].station, '待确认地点'); assert.equal(q.data.exceptionCount, 0);
  q.applyExceptions(); assert.equal(q.data.records.length, 1); q.undoImport(); assert.equal(q.data.records.length, 0); q.onUnload();
});
test('V2.3 九张均不可靠不能造记录，快递无号码与失败不同于无关图片', async () => {
  const inputs = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, { mock: false, lines: i % 3 === 0 ? ['已到站，请取件'] : i % 3 === 1 ? ['今晚食堂见'] : ['取件码A?-1234'] }]));
  const { p } = await batch(inputs); assert.equal(p.data.records.length, 0); assert.ok(p.data.exceptionCount >= 6); assert.equal(p.data.recentImport.added, 0); p.onUnload();
});
test('V2.3 记录与撤销凭据原子保存，主写后抛错重启不重复；保存失败不宣称成功', async () => {
  const wx = fakeStorage(); let failOnComplete = true;
  const write = wx.setStorageSync;
  wx.setStorageSync = function(key, value) { write.call(this, key, value); if (key === store.KEY && value.records.length && failOnComplete) { failOnComplete = false; throw Error('after commit'); } };
  const p = page(wx, async () => response('1111')); p.data.images = ['a']; await p.recognizeCloud(); assert.equal(p.data.storageBlocked, true); assert.equal(p.data.records.length, 0);
  const q = page(wx); assert.equal(q.data.records.length, 1); assert.equal(q.data.recentImport.added, 1); q.undoImport(); assert.equal(q.data.records.length, 0); p.onUnload(); q.onUnload();
  const broken = fakeStorage(); broken.failWrite = store.KEY; const r = page(broken); r.data.images = ['x']; await r.recognizeCloud();
  assert.equal(r.data.records.length, 0); assert.equal(r.data.storageBlocked, true); r.onUnload();
});
test('V2.3 协议兼容和隐私：旧数据可读，快照和异常不保存原图路径或原文；损坏批次保护', async () => {
  const wx = fakeStorage({ [store.KEY]: { version: 1, savedAt: 100, records: [store.newRecord(candidate(0), [], 100)] } });
  const { p } = await batch({ 'private-image.jpg': response('8888', '', ['隐私原文占位']) }, wx);
  const saved = JSON.stringify(wx.values); assert.ok(!saved.includes('private-image')); assert.ok(!saved.includes('隐私原文占位'));
  assert.ok(!saved.includes('"lines"')); p.onUnload();
  wx.values[store.KEY].imports.batches[0].images[0].candidates[0].rawText = 'forbidden';
  const bad = page(wx); assert.equal(bad.data.storageBlocked, true); bad.onUnload();
});
test('V2.3 影子评估是纯函数，状态时间证据不使用上传时间，不产生写入', () => {
  const records = [store.newRecord(candidate(0))], before = JSON.stringify(records);
  const plan = decision.evaluate([candidate(1)], records); assert.equal(plan.additions.length, 1); assert.equal(JSON.stringify(records), before);
  assert.equal(evidence.inspect('文件创建时间：2020-01-01').noticeAt, undefined);
  assert.equal(evidence.inspect('今天收到，取件码1111').noticeAt, undefined);
  assert.equal(evidence.inspect('2020-02-31').noticeAt, undefined);
  assert.equal(evidence.inspect('2026-10-22 已入库 2026-10-23 已取件').parcelStatus, 'collected');
});

test('V2.3 异常期间新增同码待取或核销原记录，过期选择不能再重复入库', async () => {
  const { p } = await batch({ a: response('1111', '') });
  p.openExceptions(); const id = p.data.exceptionItems[0].id; p.updateException(id, { action: 'new' });
  p.persistRecords([store.newRecord(candidate(0, { code: '1111' }))]);
  p.applyExceptions(); assert.equal(p.data.records.length, 1); assert.equal(p.data.exceptionCount, 1);
  assert.equal(p.data.exceptionItems[0].action, ''); assert.equal(p.data.currentException.reason, 'record_conflict'); p.onUnload();
});
test('V2.3 选择常用站或手动地点仅处理地点问题，取消不丢选择；同码冲突可明确保留两件', async () => {
  const { p, wx } = await batch({ a: response('1111', '') });
  p.openExceptions(); const id = p.data.exceptionItems[0].id;
  p.exceptionStationInput({ currentTarget: { dataset: { id } }, detail: { value: '用户确认服务站' } });
  p.closeExceptions(); const q = page(wx); q.openExceptions(); assert.equal(q.data.exceptionItems[0].selectedStation, '用户确认服务站');
  q.applyExceptions(); assert.equal(q.data.records[0].station, '用户确认服务站'); assert.equal(q.data.records[0].code, '1111'); p.onUnload(); q.onUnload();
  const r = (await batch({ a: response('2222', '东门驿站'), b: response('2222', '西门驿站') })).p;
  r.openExceptions(); assert.equal(r.data.exceptionItems.length, 2); r.data.exceptionItems.forEach(e => r.chooseException(event(e.id, 'new')));
  r.applyExceptions(); assert.equal(r.data.records.length, 2); assert.equal(r.data.exceptionCount, 0); r.onUnload();
});
test('V2.3 哈希不可用时继续识别，不以相似性丢图；失败可由用户忽略且保持失败凭据', async () => {
  const wx = fakeStorage(); wx.getFileInfo = ({ fail }) => fail();
  const { p, calls } = await batch({ a: response('1111'), b: response('2222'), bad: new Error('network') }, wx);
  assert.equal(calls, 3); assert.equal(p.data.records.length, 2); assert.equal(p.data.recentImport.failures, 1);
  p.dismissFailedImage({ currentTarget: { dataset: { taskId: p.data.results[2].taskId } } });
  assert.equal(p.data.recentImport.failures, 0); assert.equal(p.importState.batches[0].images[2].state, 'failed');
  assert.equal(p.importState.batches[0].images[2].status, 'SKIPPED_BY_USER'); p.onUnload();
});
test('V2.3 撤销后重导同摘要复用识别证据；同毫秒编辑再还原也属于后续操作', async () => {
  const wx = fakeStorage(); hashing(wx, { a: 1 }); let calls = 0;
  const p = page(wx, async () => { calls++; return response('1111'); }); p.data.images = ['a']; await p.recognizeCloud(); p.undoImport();
  assert.equal(p.data.records.length, 0); await p.recognizeCloud(); assert.equal(calls, 1); assert.equal(p.data.records.length, 1);
  const b = p.importState.batches.at(-1), before = p.data.records[0];
  const changed = store.updateRecord(store.updateRecord(before, { carrier: '中通快递' }, before.updatedAt), { carrier: before.carrier }, before.updatedAt);
  assert.ok(changed.updatedAt > before.updatedAt); assert.equal(journal.undo(b, [changed]).conflicts.length, 1); p.onUnload();
});
test('V2.3 同运单不同码、同码不同通知时间不会自动合并；只凭同码不能给旧记录猜补地点', () => {
  const items = [candidate(0, { code: '1111', waybillNumber: 'SF123456789012' }), candidate(1, { code: '2222', waybillNumber: 'SF123456789012' })];
  assert.equal(decision.evaluate(fuse(items), []).reviews.length, 2);
  const dated = fuse([candidate(0, { code: '1111', noticeAt: 100 }), candidate(1, { code: '1111', noticeAt: 200 })]);
  assert.equal(decision.evaluate(dated, []).reviews.length, 2);
  const old = store.newRecord(candidate(0, { station: '待确认地点' }));
  assert.equal(decision.evaluate([candidate(0)], [old]).reviews.length, 1);
  assert.deepEqual(decision.evaluate([candidate(0)], [old]).records[0], old);
});
test('V2.3 32 条标注候选影子指标可重复计算，错误合并与漏包裹独立计数', () => {
  const { execFileSync } = require('node:child_process');
  const metrics = JSON.parse(execFileSync(process.execPath, ['tests/v23-shadow.cjs'], { encoding: 'utf8' }));
  assert.equal(metrics.samples, 32); assert.equal(metrics.batches, 7);
  assert.equal(metrics.wrongMerges, 0); assert.equal(metrics.missedParcels, 0); assert.equal(metrics.unnecessaryReviews, 0);
  assert.equal(metrics.autoImportFieldAccuracy.correct, metrics.autoImportFieldAccuracy.total);
  assert.equal(metrics.autoSkipAccuracy.correct, metrics.autoSkipAccuracy.total);
  assert.equal(metrics.results[0].modeledUserActions, 1);
});

test('V2.3 粘贴通知显式触发后也自动整理，不读取剪贴板，不保留原文，异常仍可稍后处理', async () => {
  const wx = fakeStorage(); wx.getClipboardData = () => { throw Error('must not read clipboard'); };
  const p = page(wx); p.openNotification(); p.notificationInput({ detail: { value: '【驿小哥】取件码C205-2004，已到东门驿站。【京东】取件码A203-4010。' } });
  await p.recognizeNotification(); assert.equal(p.data.records.length, 1); assert.equal(p.data.records[0].code, 'C205-2004');
  assert.equal(p.data.exceptionCount, 1); assert.equal(p.data.activeTab, 'import'); assert.equal(p.data.notificationText, '');
  assert.ok(!JSON.stringify(wx.values).includes('【驿小哥】')); p.undoImport(); assert.equal(p.data.records.length, 0); assert.equal(p.data.exceptionCount, 0); p.onUnload();
});
test('V2.3 整批原文地址优先于驿站记忆，用户清空地址后不再沿用旧记忆', async () => {
  const wx = fakeStorage(); const state = stations.remember({ version: 1, groups: [] }, { station: '大学服务站', pickupAddress: '旧确认地址' });
  stations.createStore(wx).save(state);
  const { p } = await batch({ a: response('1111'), b: response('1111', '大学服务站', ['地址：新楼一层']) }, wx);
  assert.equal(p.data.records.length, 1); assert.equal(p.data.records[0].pickupAddress, '新楼一层');
  assert.equal(p.data.exceptionCount, 0);
  const cleared = stations.remember(state, { station: '大学服务站', pickupAddress: '' });
  assert.equal(stations.assist(cleared, candidate(0)).pickupAddress, undefined); p.onUnload();
});

test('V2.3 文件摘要等待时停止批次，不会迟到发送 OCR；重开同批图片不沿用旧候选计数', async () => {
  const wx = fakeStorage(); let hash, calls = 0;
  wx.getFileInfo = ({ success }) => hash = success;
  const p = page(wx, async () => { calls++; return response('1111'); }); p.data.images = ['a'];
  const run = p.recognizeCloud(); p.cancelRecognition(); hash({ digest: sha(1), size: 100 }); await run;
  assert.equal(calls, 0); assert.equal(p.data.records.length, 0); assert.equal(p.data.recentImport.failures, 1);
  hashing(wx, { a: 1 }); await p.recognizeCloud(); assert.equal(calls, 1); assert.equal(p.data.records.length, 1);
  await p.recognizeCloud(); assert.equal(calls, 1); assert.equal(p.data.recentImport.skipped, 1); assert.equal(p.data.recentImport.added, 0); p.onUnload();
});

test('V2.3 自动新增后用户编辑，再重试补全字段，撤销只还原自动补全并保留用户编辑', async () => {
  let retry = false;
  const p = page(fakeStorage(), async path => { if (path === 'bad' && !retry) throw { code: 'NETWORK_FAILED' }; return response('1111', '大学服务站', path === 'bad' ? ['中通快递'] : []); });
  p.data.images = ['a', 'bad']; await p.recognizeCloud();
  const id = p.data.records[0].id; p.editRecord(event(id)); p.editPickupAddress({ detail: { value: '用户指定的一层位置' } }); p.saveEdit();
  retry = true; await p.retryImage({ currentTarget: { dataset: { index: 2 } } });
  assert.equal(p.data.records[0].carrier, '中通快递'); assert.equal(p.data.records[0].pickupAddress, '用户指定的一层位置');
  p.undoImport(); assert.equal(p.data.records.length, 1); assert.equal(p.data.records[0].pickupAddress, '用户指定的一层位置');
  assert.equal(p.data.records[0].carrier, ''); assert.equal(p.data.recentImport.conflicts, 1); p.onUnload();
});
