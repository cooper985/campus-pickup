const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const parser = require('../miniprogram/services/pickup-parser');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const decision = require('../miniprogram/services/import-decision');
const evidence = require('../miniprogram/services/import-evidence');
const stations = require('../miniprogram/services/stations');
const store = require('../miniprogram/services/pickup-store');
const batches = require('../miniprogram/services/import-batches');
const drag = require('../miniprogram/services/station-drag');
const event = (id, extra = {}) => ({ currentTarget: { dataset: { id, ...extra } } });
const waybill = 'SF123456789012';
const c = (i, extra = {}) => ({ id: `c${i}`, code: '87-6-4601', station: '大学北门驿站', sourceIndex: i, parcelStatus: 'unknown', ...extra });
const response = lines => ({ mock: false, lines });
async function run(images, records = []) {
  const wx = fakeStorage();
  const names = Object.keys(images);
  wx.getFileInfo = ({ filePath, success }) => success({ digest: String(names.indexOf(filePath) + 1).padStart(40, '0'), size: 100 });
  const p = page(wx, async path => images[path]);
  if (records.length) p.persistRecords(records);
  p.data.images = names; await p.recognizeCloud();
  return { p, wx };
}

test('V2.3.2 原留样结构：横排状态导航不是取件状态，不对已有87-6-4601制造冲突', async () => {
  const lines = ['大学北门驿站', '取件码87-6-4601', '待取件', '已签收', '已退回'];
  const boxes = [{x:0,y:0,width:250,height:30},{x:0,y:50,width:250,height:30}, ...[0,300,600].map(x => ({x,y:400,width:120,height:30}))];
  assert.equal(evidence.inspect(lines.join('\n')).parcelStatus, 'conflict');
  const old = store.newRecord(c(0));
  const { p } = await run({ tabs: { mock: false, lines, boxes } }, [old]);
  assert.equal(p.data.records.length, 1); assert.equal(p.data.exceptionCount, 0);
  assert.deepEqual(p.data.records[0], old); p.onUnload();
});
test('V2.3.2 菜鸟短尾码Y2-7-47可识别；同图另一个坏码仍保留独立区域异常', async () => {
  const good = ['大学菜鸟驿站', '待取件', 'Y2-7-47'];
  assert.equal(parser.parse(good)[0].code, 'Y2-7-47');
  const { p } = await run({ partial: response(['大学北门驿站', '取件码Y2-7-47', '已到站', '另一件包裹', '取件码：8-?-9000', '已领取']) });
  assert.equal(p.data.records.length, 1); assert.equal(p.data.exceptionCount, 1);
  assert.equal(p.data.currentException.needsCode, true); assert.ok(p.data.currentException.sources[0].regions.length);
  assert.equal(p.data.currentException.sources[0].path, 'partial'); p.onUnload();
});
test('V2.3.2 同运单多图互补与单图无可靠码，收齐后只导入一次，无多余异常', async () => {
  for (const pair of [
    [response(['运单号：'+waybill, '取件码87-6-4601']), response(['大学北门驿站', '运单号：'+waybill, '取件码87-6-4601'])],
    [response(['运单号：'+waybill, '取件码：???', '已到站']), response(['大学北门驿站', '运单号：'+waybill, '取件码87-6-4601', '已到站'])],
  ]) {
    const { p, wx } = await run({ a: pair[0], b: pair[1] });
    assert.equal(p.data.records.length, 1); assert.equal(p.data.exceptionCount, 0);
    assert.equal(p.importState.batches[0].fusedSources, 1);
    p.refreshRecognition(); assert.equal(p.data.records.length, 1);
    assert.equal(page(wx).data.remaining, 1); p.onUnload();
  }
});
test('V2.3.2 完整运单区分复用码；仅同码缺地点不擅自融合', () => {
  const plan = decision.evaluate(fuse([c(0, { waybillNumber: waybill }), c(1, { waybillNumber: 'SF999999999999' })]), []);
  assert.equal(plan.additions.length, 2); assert.equal(plan.reviews.length, 0);
  const ambiguous = decision.evaluate(fuse([c(0, { station: parser.UNKNOWN }), c(1)]), []);
  assert.equal(ambiguous.additions.length, 0); assert.equal(ambiguous.reviews.length, 2);
});
test('V2.3.2 全批自动入库参与最终异常去重，顺序无关，真实身份字段冲突保留', () => {
  const now = Date.now();
  const partial = c(0, { code: '', waybillNumber: waybill, noticeAt: now });
  const complete = c(1, { waybillNumber: waybill });
  for (const input of [[partial, complete], [complete, partial]]) {
    const plan = decision.evaluate(input, [], undefined, now);
    assert.equal(plan.additions.length, 1); assert.equal(plan.reviews.length, 0);
  }
  const plan = decision.evaluate(fuse([c(0,{waybillNumber:waybill}), c(1,{waybillNumber:waybill, station:'西门驿站'})]), []);
  assert.equal(plan.additions.length, 0); assert.ok(plan.reviews.every(r => r.conflictFields.includes('station')));
});
test('V2.3.2 同运单可靠事件由运输到站是演进；未知时间、反向状态、不同身份仍冲突', () => {
  const at = Date.now(), items = [c(0,{ code:'', station:parser.UNKNOWN, waybillNumber:waybill, parcelStatus:'transit', noticeAt:at-3600000 }), c(1,{ waybillNumber:waybill, parcelStatus:'pending', noticeAt:at })];
  const forward = fuse(items); assert.equal(forward[0].parcelStatus, 'pending'); assert.equal(decision.evaluate(forward, []).additions.length, 1);
  for (const bad of [[{...items[0],noticeAt:undefined},items[1]], [{...items[0],noticeAt:at+3600000},items[1]]]) {
    assert.equal(fuse(bad)[0].parcelStatus, 'conflict'); assert.equal(decision.evaluate(fuse(bad), []).additions.length, 0);
  }
  assert.equal(evidence.inspect('创建时间：2026-10-24 08:00，运输中').noticeAt, undefined);
  assert.equal(evidence.inspect('通知时间：2026-10-24 08:00，运输中').parcelStatus, 'transit');
  assert.equal(evidence.inspect('2026-10-23 08:00 运输中\n2026-10-24 08:00 已到站').parcelStatus, 'pending');
});
test('V2.3.2 签收、领取、取消不同语义；不修改手动确认取件状态', () => {
  for (const [text, status] of [['运输中','transit'],['已到站','pending'],['已签收','signed'],['已领取','collected'],['已取消','cancelled'],['已退回','cancelled'],['未取件','unknown']]) assert.equal(evidence.inspect(text).parcelStatus, status);
  const old = store.updateRecord(store.newRecord(c(0,{waybillNumber:waybill})), { taken:true });
  const plan = decision.evaluate([c(1,{waybillNumber:waybill,parcelStatus:'pending'})], [old]);
  assert.deepEqual(plan.records[0], old); assert.equal(plan.additions.length, 0);
});
test('V2.3.2 两图状态冲突并排显示来源，放大原图；历史记录单独标注', async () => {
  const old = store.newRecord(c(0,{code:'1111'}));
  const { p, wx } = await run({ a: response(['大学北门驿站','取件码1111','运单号：'+waybill,'已到站']), b:response(['大学北门驿站','取件码1111','运单号：'+waybill,'已领取']) }, [old]);
  const entry = p.data.currentException;
  assert.equal(entry.sources.length, 2); assert.equal(entry.matches.length, 1); assert.match(entry.conflictText,/物流状态/);
  let opened; wx.previewImage = args => opened = args;
  p.previewResultImage(event('', {batchId:entry.batchId,imageIndex:1})); assert.equal(opened.current,'b');
  assert.ok(entry.sources.every(s=>s.imageId.startsWith(entry.batchId+':')));
  assert.ok(!JSON.stringify(wx.values).includes('"path"')); assert.ok(!JSON.stringify(wx.values).includes('原始私人通知'));
  batches.validate(p.importState); p.onUnload();
});
test('V2.3.2 图片失效不展示失效入口，跨重启恢复异常，重选需匹配摘要', async () => {
  const {p,wx}=await run({a:response(['取件码1111'])}); const batchId=p.data.currentException.batchId;
  wx.getFileSystemManager=()=>({accessSync(){throw Error('expired');}});
  p.openExceptions({keepSession:true});assert.equal(p.data.currentException.sources[0].path,''); p.onUnload();
  delete wx.getFileSystemManager;
  const q=page(wx);q.openExceptions();assert.equal(q.data.currentException.sources[0].path,'');
  wx.chooseImage=async()=>({tempFiles:[{path:'a',size:100}]});await q.selectSourceImage(event('',{batchId,imageIndex:0}));assert.equal(q.data.currentException.sources[0].path,'a');
  q.sourceImageError(event('',{batchId,imageIndex:0}));assert.equal(q.data.currentException.sources[0].path,'');
  wx.chooseImage=async()=>({tempFiles:[{path:'different',size:100}]});await q.selectSourceImage(event('',{batchId,imageIndex:0}));assert.equal(q.data.currentException.sources[0].path,'');q.onUnload();
});
test('V2.3.2 通知正文不进入驿站名称，楼栋专区保留，错误名称禁止自动记忆', () => {
  for(const [text,expected] of [
    ['【菜鸟驿站】已到河工大洗浴中心北侧菜鸟驿站今早取您中通的包裹，取件码87-6-4601。','河工大洗浴中心北侧菜鸟驿站'],
    ['【驿小哥】已到北校区31号楼北侧驿站顺丰专区请您及时领取，取件码87-6-4601。','北校区31号楼北侧驿站顺丰专区'],
    ['【菜鸟】已到南区2栋一层便利店今晚取件，取件码87-6-4601。','南区2栋一层便利店'],
  ]) assert.equal(require('../miniprogram/services/notification-parser').parse(text)[0].station,expected);
  assert.throws(()=>stations.remember({version:1,groups:[]},{station:'大学驿站今早取您中通的包裹'}));
});
test('V2.3.2 驿站删除保留待取历史及地址，撤销与重启安全，删除配置不被sync复活', async () => {
  const api=fakeStorage(),p=page(api);const raw=[store.newRecord(c(0,{pickupAddress:'北门1号楼'})),store.updateRecord(store.newRecord(c(1,{code:'2222'})),{taken:true})];p.persistRecords(raw);
  p.saveStations(stations.remember(p.stationState,raw[0])); const before=JSON.stringify(p.data.records), id=p.data.stationList[0].id;
  p.openStationDetail(event(id));await p.deleteStation();assert.equal(p.data.stationList.length,0);assert.equal(JSON.stringify(p.data.records),before);
  assert.equal(p.data.pendingGroups[0].items[0].pickupAddress,'北门1号楼');assert.equal(stations.assist(p.stationState,c(0)).memoryAddress,undefined);
  p.undoDelete();assert.equal(p.data.stationList.length,1);p.openStationDetail(event(id));await p.deleteStation();
  p.updateRecords(p.data.records);assert.equal(p.data.stationList.length,0);p.onUnload();
  const restarted=page(api);assert.equal(restarted.data.stationList.length,0);assert.equal(JSON.stringify(restarted.data.records),before);restarted.onUnload();
});
test('V2.3.2 删除已确认别名不再归类；拖动保留删除标记，列表没有上下移按钮', async () => {
  const p=page(fakeStorage());p.persistRecords([store.newRecord(c(0,{station:'北门驿站'})),store.newRecord(c(1,{code:'2222',station:'北门快递站'}))]);
  const ids=p.data.stationList.map(s=>s.id);p.saveStations(stations.merge(p.stationState,ids,'北门驿站'));
  await p.unlinkStation(event(ids[0],{alias:'北门快递站'}));assert.equal(stations.assist(p.stationState,{station:'北门快递站'}).station,'北门快递站');
  p.openStationDetail(event(ids[0]));await p.deleteStation();const state=drag.reorder(p.stationState,p.stationState.groups.map(g=>g.id),0,0);assert.deepEqual(state.deletedNames,p.stationState.deletedNames);
  const wxml=fs.readFileSync('miniprogram/pages/pickup/index.wxml','utf8');assert.ok(!/上移|下移|catchtap="moveStation"/.test(wxml));assert.match(wxml,/bindtouchstart="stationTouchStart"/);p.onUnload();
});
test('V2.3.2 异常单次解决立即前进，连续点击不重复加入且其他记录保留', async () => {
  const {p}=await run({a:response(['取件码1111']),b:response(['取件码2222'])});const first=p.data.currentException.id;
  p.chooseException(event(first,{action:'new',station:'北门驿站'}));p.chooseException(event(first,{action:'new',station:'北门驿站'}));assert.equal(p.data.records.length,1);assert.equal(p.data.exceptionCount,1);
  p.chooseException(event(p.data.currentException.id,{action:'new',station:'西门驿站'}));assert.equal(p.data.records.length,2);assert.equal(p.data.exceptionCount,0);p.onUnload();
});

test('V2.3.2 管理列表长按拖动完成后保存顺序，误触不打开详情，包裹不变', () => {
  const api=fakeStorage(); const p=page(api);
  p.persistRecords([store.newRecord(c(0,{station:'北门驿站'})),store.newRecord(c(1,{station:'南门驿站',code:'2222'}))]);
  const records=JSON.stringify(p.data.records), ids=p.data.stationList.map(g=>g.id);
  const query={in(){return this;},selectAll(){return {boundingClientRect(){}};},selectViewport(){return {scrollOffset(){}};},exec(fn){fn([[{top:20,bottom:100},{top:120,bottom:200}],{scrollTop:0}]);}};
  api.createSelectorQuery=()=>query;api.getWindowInfo=()=>({windowHeight:640});
  p.openStations();p.data.reduceMotion=true;
  p.stationTouchStart({...event(ids[0]),touches:[{clientX:50,clientY:40}]});p.beginStationDrag();
  assert.equal(p.data.dragId,ids[0]);assert.equal(p.stationDragging.field,'stationList');
  p.moveStationDrag({touches:[{clientX:50,clientY:210}]});p.finishStationDrag({changedTouches:[{clientY:210}]});
  assert.deepEqual(Array.from(p.data.stationList,g=>g.id),[ids[1],ids[0]]);assert.equal(JSON.stringify(p.data.records),records);
  p.openStationDetail(event(ids[0]));assert.equal(p.data.stationEditor,null);p.onUnload();
  const q=page(api);assert.deepEqual(Array.from(q.data.stationList,g=>g.id),[ids[1],ids[0]]);q.onUnload();
});

test('V2.3.2 旧批次缺来源区域或图片摘要，重选验证后重新识别补充证据', async () => {
  for (const keepHash of [false, true]) {
  const {p,wx}=await run({a:response(['取件码1111'])});
  const b=JSON.parse(JSON.stringify(p.importState.batches[0]));if(!keepHash)b.images[0].hash='';b.images[0].candidates.forEach(c=>delete c.sourceRegions);p.persistBatch(b);p.onUnload();
  let calls=0;const q=page(wx,async()=>{calls++;return response(['北门驿站','取件码1111']);});q.openExceptions();
  assert.equal(q.data.currentException.sources[0].needsRecognition,true);
  wx.chooseImage=async()=>({tempFiles:[{path:'a',size:100}]});
  await q.selectSourceImage(event('',{batchId:b.id,imageIndex:0}));
  assert.equal(calls,1);assert.equal(q.data.records.length,1);assert.equal(q.data.records[0].code,'1111');assert.equal(q.data.exceptionCount,0);q.onUnload();
  }
});
