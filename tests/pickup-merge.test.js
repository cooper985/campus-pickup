const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const store = require('../miniprogram/services/pickup-store');
const { planImport } = require('../miniprogram/services/pickup-duplicates');
const event = dataset => ({ currentTarget: { dataset } });
const draft = (id, changes = {}) => ({ id, code: '313-3-3308', station: '待确认地点', carrier: '', ...changes });
const record = changes => store.newRecord(draft('x', changes), [], 100);
function prepare(records, drafts, wx = fakeStorage()) {
  const p = page(wx); p.persistRecords(records); p.setData({ drafts, activeTab: 'import' }); return { p, wx };
}
test('同码补全默认推荐更新；跳过不写入，确认才保存，保留身份及状态并可撤销', async () => {
  const old = record(), incoming = draft('d', { station: '河工大31号楼500以上在钟楼', carrier: '中通快递' });
  const { p, wx } = prepare([old], [incoming]); let writes = wx.writes.length;
  const skipped = p.confirmImport(); assert.equal(p.data.reviewItems[0].action, 'update');
  assert.equal(p.data.records[0].station, '待确认地点');
  p.chooseImportAction(event({ id: 'd', action: 'skip' })); p.finishImportReview(); await skipped;
  assert.equal(wx.writes.length, writes); assert.equal(p.data.records[0].station, old.station);
  p.data.drafts = [incoming]; const importing = p.confirmImport(); p.finishImportReview(); await importing;
  const saved = page(wx).data.records[0];
  assert.equal(p.data.records.length, 1); assert.equal(saved.id, old.id); assert.equal(saved.createdAt, 100);
  assert.equal(saved.taken, false); assert.equal(saved.station, incoming.station); assert.equal(saved.carrier, incoming.carrier);
  assert.equal(p.data.unknownCount, 0); assert.equal(p.data.remaining, 1);
  assert.equal(p.data.importFeedback, '已新增 0 件，更新 1 件，跳过重复 0 件');
  p.undoDelete(); assert.equal(page(wx).data.records[0].station, old.station); p.onUnload();
});
test('完全重复和新图缺字段时跳过，无确认窗口、不清空地点或公司', async () => {
  const old = record({ station: '北门', carrier: '中通快递' }); const { p, wx } = prepare([old], [draft('d')]);
  let modals = 0; wx.showModal = async () => { modals++; return { confirm: true }; };
  const writes = wx.writes.length; await p.confirmImport();
  assert.equal(modals, 0); assert.equal(wx.writes.length, writes); assert.equal(p.data.records[0].carrier, '中通快递');
  assert.equal(p.data.importFeedback, '已新增 0 件，更新 0 件，跳过重复 1 件'); p.onUnload();
});
test('已知地点冲突及多个候选不擅自合并；只有明确选择另一件才新增', async () => {
  const old = record({ station: '北门' }); const incoming = draft('d', { station: '南门', carrier: '中通快递' });
  const { p } = prepare([old], [incoming]); const importing = p.confirmImport();
  assert.equal(p.data.reviewItems[0].action, 'skip'); assert.equal(p.data.reviewItems[0].matches[0].canUpdate, false);
  p.chooseImportAction(event({ id: 'd', action: 'new' })); p.finishImportReview(); await importing;
  assert.equal(p.data.records.length, 2); assert.equal(p.data.records[0].station, '北门');
  const plan = planImport([record(), record()], [incoming]);
  assert.equal(plan.reviews[0].matches.length, 2); assert.equal(plan.reviews[0].action, 'skip'); assert.equal(plan.updated, 0); p.onUnload();
});
test('历史同码只允许跳过或明确新增；可靠同运单可补全且不改变已取状态', () => {
  const old = store.updateRecord(record(), { taken: true }, 200); const incoming = draft('d', { station: '北门' });
  let plan = planImport([old], [incoming]);
  assert.equal(plan.reviews[0].action, 'skip'); assert.equal(plan.reviews[0].matches[0].canUpdate, false);
  plan = planImport([old], [incoming], { d: { action: 'new' } }); assert.equal(plan.added, 1); assert.equal(plan.records[0].taken, true);
  const waybillNumber = 'SF123456789012'; const withWaybill = { ...old, waybillNumber };
  plan = planImport([withWaybill], [{ ...incoming, waybillNumber }]);
  assert.equal(plan.updated, 1); assert.equal(plan.records[0].id, old.id); assert.equal(plan.records[0].takenAt, old.takenAt);
  assert.equal(plan.records[0].taken, true); assert.equal(plan.reviews[0].allowNew, false);
  plan = planImport([withWaybill], [{ ...incoming, waybillNumber: 'SF999999999999' }]); assert.equal(plan.added, 1);
});
test('批内相同截图合一；缺失地点可补全新记录，计数按实际保存的快递计算', () => {
  const drafts = [draft('a'), draft('b', { station: '北门' }), draft('c', { station: '北门' })];
  const plan = planImport([], drafts);
  assert.equal(plan.records.length, 1); assert.equal(plan.records[0].station, '北门');
  assert.deepEqual([plan.added, plan.updated, plan.skipped], [1, 0, 2]);
  const pending = record(); const mixed = planImport([pending], [draft('a', { station: '北门' }), draft('b', { station: '北门' }), draft('c', { code: '9999', station: '南门' })]);
  assert.deepEqual([mixed.added, mixed.updated, mixed.skipped], [1, 1, 1]);
});
test('手动清空的公司受保护且跨重启保留；未确认的空公司仍可补全', async () => {
  const old = record({ station: '北门', carrier: '中通快递' }); const { p, wx } = prepare([old], []);
  p.editRecord(event({ id: old.id })); p.data.editing.carrier = ''; p.saveEdit();
  const saved = page(wx).data.records[0]; assert.ok(saved.confirmedFields.includes('carrier')); assert.equal(wx.values[store.KEY].version, 1);
  let plan = planImport([saved], [draft('d', { station: '北门', carrier: '顺丰快递' })]);
  assert.equal(plan.updated, 0); assert.equal(plan.records[0].carrier, '');
  plan = planImport([record({ station: '北门' })], [draft('d', { station: '北门', carrier: '顺丰快递' })]); assert.equal(plan.updated, 1);
  // Even legacy nonempty values cannot be overwritten by a matching waybill.
  plan = planImport([{ ...old, waybillNumber: 'SF123456789012' }], [draft('d', { station: '南门', waybillNumber: 'SF123456789012' })]);
  assert.equal(plan.records[0].station, '北门'); assert.equal(plan.updated, 0); p.onUnload();
});
test('保存失败保护旧记录、保留草稿、不显示成功；取消或卸载核对面板不写入', async () => {
  const old = record(), incoming = draft('d', { station: '北门' }); const { p, wx } = prepare([old], [incoming]);
  const before = JSON.stringify(wx.values[store.KEY]); const importing = p.confirmImport();
  wx.failWrite = store.KEY; p.finishImportReview(); await importing;
  assert.equal(JSON.stringify(wx.values[store.KEY]), before); assert.equal(p.data.records[0].station, old.station);
  assert.equal(p.data.storageBlocked, true); assert.equal(p.data.drafts.length, 1); assert.equal(p.data.importFeedback, ''); assert.equal(p.data.undoAvailable, false);
  const other = prepare([old], [incoming]); const writes = other.wx.writes.length;
  let run = other.p.confirmImport(); other.p.cancelImportReview(); await run; assert.equal(other.wx.writes.length, writes);
  run = other.p.confirmImport(); other.p.onUnload(); await run; assert.equal(other.wx.writes.length, writes); p.onUnload();
});
test('点击完整号码调用原生剪贴板，成功失败均有反馈，不改变取件状态', () => {
  const old = record({ code: '313-3-3308' }); const { p, wx } = prepare([old], []); let copied, title;
  wx.showToast = o => title = o.title; wx.setClipboardData = o => { copied = o.data; o.success(); };
  const writes = wx.writes.length; p.copyCode(event({ id: old.id })); assert.equal(copied, old.code); assert.equal(title, '取件码已复制');
  assert.equal(wx.writes.length, writes); assert.equal(p.data.records[0].taken, false);
  wx.setClipboardData = o => o.fail(); p.copyCode(event({ id: old.id })); assert.match(title, /复制失败/); p.onUnload();
});
