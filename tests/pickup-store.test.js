const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore, newRecord, updateRecord, KEY, BACKUP_KEY } = require('../miniprogram/services/pickup-store');
const { findDuplicate, metadata } = require('../miniprogram/services/pickup-duplicates');
const { fakeStorage } = require('./helpers/storage');
const parcel = (changes = {}) => newRecord({ station: '北门驿站', code: '1-2-3456', ...changes }, [], 100);
const envelope = records => ({ version: 1, savedAt: 200, records });
test('空存储不写入；白名单剔除 OCR 原文、截图、个人信息', () => {
  const wx = fakeStorage(), store = createStore(wx);
  assert.deepEqual(store.load(), { records: [], blocked: false, error: '' }); assert.equal(wx.writes.length, 0);
  store.save([{ ...parcel(), lines: ['private phone'], image: 'secret.png', phone: '13800000000' }]);
  assert.equal(wx.values[KEY].version, 1); assert.ok(!JSON.stringify(wx.values).includes('private'));
  assert.ok(!JSON.stringify(wx.values).includes('secret')); assert.ok(!JSON.stringify(wx.values).includes('phone'));
});
test('各类损坏、未知版本与重复 ID 不覆盖；上一版有效备份只读展示', () => {
  const r = parcel();
  for (const bad of [null, '', 'bad json', {}, { version: 2, records: [] }, envelope([r, r]), envelope([{ ...r, taken: 'false' }]), envelope([{ ...r, taken: true, takenAt: null }]), envelope([{ ...r, updatedAt: 1 }])]) {
    const wx = fakeStorage({ [KEY]: bad, [BACKUP_KEY]: envelope([r]) }), store = createStore(wx);
    const before = JSON.stringify(wx.values), result = store.load();
    assert.equal(result.blocked, true); assert.equal(result.records.length, 1); assert.match(result.error, /备份/);
    assert.throws(() => store.save([]), /保护/); assert.equal(JSON.stringify(wx.values), before); assert.equal(wx.writes.length, 0);
  }
});
test('缺主数据有备份时不能当作新用户覆盖；读取异常同样禁写', () => {
  const wx = fakeStorage({ [BACKUP_KEY]: envelope([parcel()]) });
  assert.equal(createStore(wx).load().blocked, true);
  wx.failRead = true; const store = createStore(wx); assert.equal(store.load().blocked, true); assert.throws(() => store.save([])); assert.equal(wx.writes.length, 0);
});
test('备份写失败、主写失败、静默写失败均保护上次有效数据', () => {
  for (const fault of ['backup', 'primary', 'silent']) {
    const old = envelope([parcel()]), wx = fakeStorage({ [KEY]: old }), store = createStore(wx); store.load();
    if (fault === 'silent') wx.dropWrite = KEY; else wx.failWrite = fault === 'backup' ? BACKUP_KEY : KEY;
    assert.throws(() => store.save([updateRecord(old.records[0], { taken: true }, 300)]), /未能确认/);
    assert.deepEqual(wx.values[KEY], old); assert.throws(() => store.save([]), /保护/);
    if (fault === 'backup') assert.ok(!wx.writes.includes(KEY)); else assert.deepEqual(wx.values[BACKUP_KEY], old);
  }
});
test('首次保存失败可重启重试；已落盘但抛错时重启可读，不回滚覆盖', () => {
  const wx = fakeStorage(), store = createStore(wx); store.load(); wx.failWrite = KEY;
  assert.throws(() => store.save([parcel()])); assert.equal(createStore(wx).load().records.length, 0);
  const restarted = createStore(wx); restarted.load();
  wx.setStorageSync = function(key, value) { this.values[key] = value; throw Error('after write'); };
  assert.throws(() => restarted.save([parcel()])); assert.equal(createStore(wx).load().records.length, 1);
});
test('陈旧页面不能覆盖较新的记录；数据校验失败不写入', () => {
  const wx = fakeStorage(), first = createStore(wx), second = createStore(wx); first.load(); second.load();
  first.save([parcel()]); assert.throws(() => second.save([])); assert.equal(createStore(wx).load().records.length, 1);
  const third = createStore(wx); third.load(); const writes = wx.writes.length;
  assert.throws(() => third.save([{ ...parcel(), code: '' }])); assert.equal(wx.writes.length, writes);
});
test('ID 在同一毫秒内唯一；系统时间回退不破坏时间顺序', () => {
  const records = Array.from({ length: 1000 }, () => parcel()); assert.equal(new Set(records.map(r => r.id)).size, 1000);
  const taken = updateRecord(records[0], { taken: true }, 50); assert.equal(taken.updatedAt, 100); assert.equal(taken.takenAt, 100);
  assert.equal(updateRecord(taken, { code: '4321' }, 400).takenAt, 100);
  assert.equal(updateRecord(taken, { taken: false }, 500).takenAt, null);
});
test('去重优先运单；不同可靠运单允许同码；归一化、未知地点和已取码提示', () => {
  const a = parcel({ waybillNumber: 'SF123456789012' });
  assert.equal(findDuplicate({ ...a, station: '其他站', code: '9999' }, [a]).kind, 'waybill');
  assert.equal(findDuplicate({ ...a, waybillNumber: 'SF999999999999' }, [a]), null);
  assert.equal(findDuplicate({ station: '北门 驿站', code: '１－２－３４５６' }, [a]).kind, 'pending-code');
  assert.equal(findDuplicate({ station: '待确认地点', code: a.code }, [a]).kind, 'pending-code');
  assert.equal(findDuplicate({ ...a, waybillNumber: '' }, [{ ...a, taken: true }]).kind, 'reused-code');
  assert.equal(findDuplicate({ station: '南门驿站', code: a.code }, [a]).kind, 'location-conflict');
});
test('元信息仅采纳单包裹明确标注的唯一运单，不把电话或多包裹号码错误关联', () => {
  assert.deepEqual(metadata(['中通快递', '运单号: SF123456789012'], 1), { carrier: '中通快递', waybillNumber: 'SF123456789012' });
  assert.equal(metadata(['电话13800000000', '订单号123456789012'], 1).waybillNumber, '');
  assert.equal(metadata(['运单号: SF123456789012', '运单号: SF999999999999'], 1).waybillNumber, '');
  assert.deepEqual(metadata(['中通快递', '运单号: SF123456789012'], 2), { carrier: '', waybillNumber: '' });
});
