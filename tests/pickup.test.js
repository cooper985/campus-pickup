const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const storage = require('../miniprogram/services/pickup-store');
const { fakeStorage } = require('./helpers/storage');
function page(wx = fakeStorage(), recognize = async () => ({ mock: true, lines: ['北门驿站', '取件码1-2-3456'] })) {
  let result;
  wx.showModal ||= async () => ({ confirm: true });
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/pickup/index.js', 'utf8'), {
    require: name => /(?:cloud|mock)-ocr$/.test(name) ? { recognize } : require('../miniprogram/services/' + name.split('/').pop()),
    wx, Page: p => { result = p; },
  });
  result.setData = function(data) { Object.assign(this.data, data); };
  result.onLoad();
  return result;
}
const event = id => ({ currentTarget: { dataset: { id } } });
async function importOne(p) { p.data.images = ['a.png']; await p.recognizeCloud(); await p.confirmImport(); }
test('批量选择、预览、串行识别；确认前不保存，整批确认后重启恢复独立 ID', async () => {
  let preview, active = 0;
  const wx = fakeStorage();
  wx.chooseImage = async o => { assert.equal(o.count, 9); return { tempFiles: [{ path: 'a.png', size: 10 }, { path: 'b.png', size: 10 }] }; };
  wx.previewImage = o => { preview = o.current; };
  const p = page(wx, async () => {
    assert.equal(active++, 0); await Promise.resolve(); active--;
    return { mock: false, lines: ['北门驿站', '取件码1-2-3456'] };
  });
  await p.chooseImage(); p.previewImage({ currentTarget: { dataset: { index: 1 } } }); await p.recognizeCloud();
  assert.equal(preview, 'b.png'); assert.equal(p.data.drafts.length, 2); assert.equal(p.data.records.length, 0);
  assert.equal(page(wx).data.records.length, 0);
  await p.confirmImport();
  const restarted = page(wx);
  assert.equal(restarted.data.records.length, 2); assert.equal(restarted.data.groups.length, 1);
  assert.equal(new Set(restarted.data.records.map(r => r.id)).size, 2);
  assert.equal(wx.writes.filter(k => k === storage.KEY).length, 1);
  const saved = JSON.stringify(wx.values);
  for (const privateField of ['a.png', 'sourceIndex', 'lines', 'images', 'draft-']) assert.ok(!saved.includes(privateField));
});
test('标记已取、恢复待取、修改取件码和地点后分别重启，时间和 ID 正确', async () => {
  const wx = fakeStorage(); let p = page(wx); await importOne(p);
  const original = p.data.records[0], id = original.id;
  p.toggleTaken(event(id)); p = page(wx);
  assert.equal(p.data.remaining, 0); assert.equal(p.data.records[0].taken, true); assert.ok(p.data.records[0].takenAt >= original.createdAt);
  p.toggleTaken(event(id)); p = page(wx);
  assert.equal(p.data.remaining, 1); assert.equal(p.data.records[0].takenAt, null);
  p.editRecord(event(id)); p.data.editing.station = '南门驿站'; p.data.editing.code = '9-9-9999'; p.saveEdit(); p = page(wx);
  assert.equal(p.data.records[0].code, '9-9-9999'); assert.equal(p.data.groups[0].station, '南门驿站');
  assert.equal(p.data.records[0].id, id); assert.equal(p.data.records[0].createdAt, original.createdAt);
  assert.ok(p.data.records[0].updatedAt >= original.updatedAt);
});
test('重复导入截图时提示；可跳过，也可确认是不同包裹；不删除旧记录', async () => {
  const wx = fakeStorage(); const p = page(wx); await importOne(p);
  const old = p.data.records[0]; const titles = [];
  wx.showModal = async o => { titles.push(o.title); return { confirm: o.title !== '疑似重复，请确认' }; };
  await importOne(p); assert.equal(p.data.records.length, 1); assert.ok(titles.includes('疑似重复，请确认'));
  p.toggleTaken(event(old.id));
  wx.showModal = async o => { if (o.title === '疑似重复，请确认') assert.match(o.content, /已取.*复用/); return { confirm: true }; };
  await importOne(p); assert.equal(p.data.records.length, 2); assert.equal(p.data.records[0].taken, true);
});
test('可靠运单重复提示并跳过，重复检查也覆盖本批次', async () => {
  const wx = fakeStorage(), titles = [];
  wx.showModal = async o => { titles.push(o.title); return { confirm: true }; };
  const p = page(wx, async () => ({ mock: false, lines: ['北门驿站', '取件码1234', '运单号: SF123456789012'] }));
  p.data.images = ['a', 'a']; await p.recognizeCloud(); await p.confirmImport();
  assert.equal(p.data.records.length, 1); assert.ok(titles.includes('运单号重复'));
  await importOne(p); assert.equal(p.data.records.length, 1);
});
test('取消导入不保存；确认中的连点不会重复保存', async () => {
  const wx = fakeStorage(), p = page(wx); p.data.images = ['a']; await p.recognizeCloud();
  wx.showModal = async () => ({ confirm: false }); await p.confirmImport(); assert.equal(p.data.records.length, 0); assert.equal(p.data.drafts.length, 1);
  let release; wx.showModal = () => new Promise(r => { release = r; });
  const run = p.confirmImport(); await p.confirmImport(); release({ confirm: true }); await run;
  assert.equal(p.data.records.length, 1); assert.equal(wx.writes.length, 1);
});
test('取消和超限选图保留原批次；成功选图和 OCR 失败均不影响已保存记录', async () => {
  const wx = fakeStorage(); let p = page(wx); await importOne(p); const before = JSON.stringify(wx.values);
  wx.chooseImage = async () => { throw { errMsg: 'cancel' }; }; p.data.images = ['old.png'];
  await p.chooseImage(); assert.equal(p.data.images[0], 'old.png');
  wx.chooseImage = async () => ({ tempFiles: [{ path: 'big', size: 6 * 1024 * 1024 }] });
  await p.chooseImage(); assert.match(p.data.error, /5 MB/); assert.equal(p.data.images[0], 'old.png');
  p = page(wx, async () => { throw Error('network'); });
  wx.chooseImage = async () => ({ tempFiles: [{ path: 'new', size: 10 }] });
  await p.chooseImage(); await p.recognizeCloud();
  assert.equal(p.data.records.length, 1); assert.equal(p.data.drafts.length, 0); assert.equal(p.data.results[0].error, 'network');
  assert.equal(JSON.stringify(wx.values), before); assert.equal(page(wx).data.records.length, 1);
});
test('重复点击不重复调用，单图失败保留其他草稿', async () => {
  let calls = 0, release;
  const p = page(fakeStorage(), async () => { calls++; if (calls === 1) await new Promise(r => release = r); else throw Error('network'); return { mock: false, lines: ['取件码1234'] }; });
  await p.recognizeCloud(); assert.equal(calls, 0); p.data.images = ['a', 'b'];
  const run = p.recognizeCloud(); await p.recognizeCloud(); assert.equal(calls, 1); release(); await run;
  assert.equal(calls, 2); assert.equal(p.data.drafts.length, 1); assert.equal(p.data.records.length, 0); assert.equal(p.data.loading, false);
});
test('保存失败不改变看板、不丢草稿，编辑失败保留编辑内容，异常加载禁写', async () => {
  const wx = fakeStorage(); let p = page(wx); await importOne(p);
  wx.failWrite = storage.KEY;
  p.editRecord(event(p.data.records[0].id)); p.data.editing.code = '9999'; p.saveEdit();
  assert.equal(p.data.records[0].code, '1-2-3456'); assert.equal(p.data.editing.code, '9999'); assert.equal(p.data.storageBlocked, true);
  p = page(wx); await importOne(p); assert.equal(p.data.records.length, 1); assert.equal(p.data.drafts.length, 1);
  wx.values[storage.KEY] = { version: 999 }; p = page(wx);
  assert.equal(p.data.storageBlocked, true); const writes = wx.writes.length; p.toggleTaken(event('any')); await p.confirmImport(); assert.equal(wx.writes.length, writes);
});
test('修改待导入记录只改草稿，确认后持久化修改值', async () => {
  const wx = fakeStorage(), p = page(wx); p.data.images = ['a']; await p.recognizeCloud();
  p.editRecord(event(p.data.drafts[0].id)); p.data.editing.code = '4321'; p.saveEdit();
  assert.equal(wx.writes.length, 0); await p.confirmImport(); assert.equal(page(wx).data.records[0].code, '4321');
});
test('过长识别地点可先修改再导入，不进入存储保护或丢弃草稿', async () => {
  const wx = fakeStorage(), p = page(wx); p.data.images = ['a']; await p.recognizeCloud();
  p.data.drafts[0].station = '站'.repeat(101); await p.confirmImport();
  assert.equal(wx.writes.length, 0); assert.equal(p.data.storageBlocked, false); assert.match(p.data.error, /先修改/);
  p.editRecord(event(p.data.drafts[0].id)); p.data.editing.station = '北门驿站'; p.saveEdit();
  await p.confirmImport(); assert.equal(page(wx).data.records.length, 1);
});
