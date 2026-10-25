const { test } = require('node:test');
const assert = require('node:assert/strict');
const stations = require('../miniprogram/services/stations');
const storage = require('../miniprogram/services/pickup-store');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const empty = () => ({ version: 1, groups: [] });
const event = id => ({ currentTarget: { dataset: { id } } });

for (const reverse of [false, true]) test(`V302 驿站：合并${reverse ? '反向' : '正向'}保留双方解绑，显式重新合并可以重绑`, () => {
  let state = stations.remember(empty(), { station: '北门驿站' }, '北门便利店');
  const a = stations.resolve(state, '北门驿站').id;
  const record = storage.newRecord(stations.assist(state, { station: '北门便利店', code: '1234' }));
  const original = JSON.stringify(record);
  state = stations.unlink(state, a, '北门便利店');
  state = stations.remember(state, { station: '西门驿站' }, '西门便利店');
  const b = stations.resolve(state, '西门驿站').id;
  state = stations.unlink(state, b, '西门便利店');
  state = stations.merge(state, reverse ? [a, b] : [b, a], '统一驿站');
  assert.equal(stations.resolve(state, record.station, record).name, '北门便利店');
  const target = stations.resolve(state, '统一驿站');
  assert.ok(target.revokedAliases.includes('北门便利店'));
  assert.ok(target.revokedAliases.includes('西门便利店'));
  assert.equal(JSON.stringify(record), original);
  const separate = stations.resolve(state, '北门便利店');
  state = stations.merge(state, [target.id, separate.id], '统一驿站');
  assert.equal(stations.resolve(state, record.station, record).name, '统一驿站');
  assert.ok(!stations.resolve(state, '统一驿站').revokedAliases.includes('北门便利店'));
  assert.equal(record.originalPickupLocation, '北门便利店');
});

for (const field of ['code', 'carrier']) test(`V302 驿站：仅改旧包裹${field}不覆盖更新后的地址记忆`, () => {
  const api = fakeStorage(), p = page(api);
  try {
    const record = storage.newRecord({ station: '北门驿站', code: '1234', carrier: '中通', pickupAddress: '旧楼一层' });
    assert.equal(p.persistRecords([record]), true);
    p.saveStations(stations.remember(p.stationState, { station: '北门驿站', pickupAddress: '新楼二层' }));
    p.editRecord(event(record.id));
    p.data.editing[field] = field === 'code' ? '5678' : '顺丰';
    p.saveEdit();
    assert.equal(p.stationState.groups[0].pickupAddress, '新楼二层');
    assert.equal(p.data.records[0].pickupAddress, '旧楼一层');
    assert.equal(p.data.records[0][field], field === 'code' ? '5678' : '顺丰');
    assert.equal(stations.assist(p.stationState, { station: '北门驿站', code: '9999' }).pickupAddress, '新楼二层');
  } finally { p.onUnload(); }
});

test('V302 驿站：显式修改及清空地址仍更新记忆，换站不携带未改旧地址', () => {
  const p = page(fakeStorage());
  try {
    const record = storage.newRecord({ station: '北门驿站', code: '1234', pickupAddress: '旧楼一层' });
    p.persistRecords([record]);
    for (const address of ['新楼二层', '']) {
      p.editRecord(event(record.id)); p.data.editing.pickupAddress = address; p.saveEdit();
      assert.equal(p.stationState.groups[0].pickupAddress, address);
      assert.equal(p.data.records[0].pickupAddress, address);
    }
    p.saveStations(stations.remember(p.stationState, { station: '南门驿站', pickupAddress: '南楼三层' }));
    p.editRecord(event(record.id)); p.data.editing.station = '南门驿站'; p.saveEdit();
    assert.equal(stations.resolve(p.stationState, '南门驿站').pickupAddress, '南楼三层');
  } finally { p.onUnload(); }
});

test('V302 驿站：空格大小写全角等价改名统一去重，稳定ID且不锁设置', async () => {
  for (const [before, after] of [['北门驿站', '北门 驿站'], ['North北门驿站', 'NORTH北门驿站'], ['北门（A）驿站', '北门(A)驿站']]) {
    const p = page(fakeStorage());
    try {
      p.saveStations(stations.remember(empty(), { station: before }));
      const id = p.stationState.groups[0].id;
      p.editStationName(event(id)); p.data.stationEditor.name = after; await p.confirmStationEdit();
      assert.equal(p.data.stationBlocked, false);
      assert.equal(p.data.stationError, '');
      assert.equal(p.stationState.groups[0].id, id);
      assert.equal(p.stationState.groups[0].name, after);
      const aliases = p.stationState.groups[0].aliases.map(stations.normalize);
      assert.equal(new Set(aliases).size, aliases.length);
    } finally { p.onUnload(); }
  }
});

test('V302 驿站：输入校验失败不锁写入，实际存储失败仍保留保护', () => {
  const api = fakeStorage(), p = page(api);
  try {
    const state = stations.remember(empty(), { station: '北门驿站' });
    assert.equal(p.saveStations(state), true);
    const bad = JSON.parse(JSON.stringify(state)); bad.groups[0].aliases.push('北门 驿站');
    assert.equal(p.saveStations(bad), false);
    assert.equal(p.data.stationBlocked, false);
    assert.equal(p.saveStations(stations.addAlias(p.stationState, state.groups[0].id, '北门服务站')), true);
    const before = JSON.stringify(p.stationState);
    api.failWrite = stations.KEY;
    assert.equal(p.saveStations(stations.addAlias(p.stationState, state.groups[0].id, '北门便利店')), false);
    assert.equal(p.data.stationBlocked, true);
    assert.equal(JSON.stringify(p.stationState), before);
  } finally { p.onUnload(); }
});
