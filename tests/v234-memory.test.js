const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const parser = require('../miniprogram/services/pickup-parser');
const stations = require('../miniprogram/services/stations');
const store = require('../miniprogram/services/pickup-store');
const decision = require('../miniprogram/services/import-decision');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const batches = require('../miniprogram/services/import-batches');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const { cacheFile } = require('./live-ocr/run.cjs');
const empty = () => ({ version: 1, groups: [] });
const bath = '河工大洗浴中心北侧菜鸟驿站', tower = '河工大31号楼500以上在钟楼';
const codes = ['127-3-5016', '87-6-4601', '313-3-3308'];
const event = (id, extra = {}) => ({ currentTarget: { dataset: { id, ...extra } } });
const raw = (code, station, extra = {}) => ({ code, station, ...extra });
const candidates = result => parser.analyze(result.lines, 0, result.boxes).records.map((r, i) => ({ ...r, id: 'c'+i }));
const realTwoFile = cacheFile('3e4d26668a0b65a6bf44c0825a7b80f9ce1f3314529fa02b5439918606bf59af');
const realThreeFile = 'test-data/private/v234/rapid-three-full.json';

async function importImages(results, api = fakeStorage()) {
  const paths = Object.keys(results); let calls = 0;
  api.getFileInfo = ({ filePath, success }) => success({ digest: String(paths.indexOf(filePath)+1).padStart(40,'0'), size: 100 });
  const p = page(api, async path => { calls++; return results[path]; });
  p.data.images = paths; await p.recognizeCloud();
  return { p, api, calls: () => calls };
}

test('V234 真实腾讯两件同站：第三目标码进入候选、融合、决策、正式存储和重启；不新增OCR调用', { skip: !fs.existsSync(realTwoFile) }, async () => {
  const result = JSON.parse(fs.readFileSync(realTwoFile)).result;
  const trace = {};
  const parsed = parser.analyze(result.lines, 0, result.boxes, trace);
  assert.deepEqual(parsed.records.map(r => [r.code,r.station]), codes.slice(1).map(c => [c,tower]));
  assert.equal(trace.codeCandidates.length, 2); assert.equal(parsed.issues.length, 0);
  const all = candidates(result); assert.equal(fuse(all).length, 2);
  const { p, api } = await importImages({ two: result });
  assert.equal(p.data.records.length, 2); assert.equal(p.data.exceptionCount, 0);
  assert.equal(p.data.stationList.length, 1); assert.ok(p.data.records.every(r => r.stationId === p.data.stationList[0].id));
  p.onUnload(); const q = page(api); assert.equal(q.data.remaining, 2); q.onUnload();
});
test('V234 真实三件原图离线RapidOCR：三个目标码及两站完整；与腾讯证据分开', { skip: !fs.existsSync(realThreeFile) }, async () => {
  const sample = JSON.parse(fs.readFileSync(realThreeFile));
  assert.equal(sample.imageSha256, '12add6ab732d7fa55c99199ae3799d2c477f95e48bee13a080e3577381f8caf0');
  const parsed = candidates(sample.result);
  assert.deepEqual(parsed.map(r => [r.code, r.station]), codes.map((c,i) => [c,i ? tower : bath]));
  assert.equal(fuse(parsed).length, 3);
  const { p } = await importImages({ three: sample.result });
  assert.deepEqual(Array.from(p.data.records, r => r.code), codes);
  assert.equal(p.data.stationList.length, 2); assert.equal(p.data.exceptionCount, 0); p.onUnload();
});
test('V234 合成：同站三件、跨站连续码、广告停止继承；不同码不融合且来源不丢失', () => {
  const lines = ['菜鸟驿站','待取件4', bath+'>绿色公益',codes[0],'今日到站', tower+'>绿色公益',codes[1],'今日到站',codes[2],'已到1天','314-3-3309','已到2天','同学都在买','999-1-1000','已到站'];
  const boxes = lines.map((_,i) => ({x:0,y:i*60,width:600,height:30}));
  const parsed = candidates({lines,boxes});
  assert.deepEqual(parsed.map(r=>r.code), [...codes,'314-3-3309']);
  assert.ok(parsed.slice(1).every(r=>r.station===tower));
  const output = fuse(parsed); assert.equal(output.length, 4);
  const plan = decision.evaluate(output, []); assert.equal(plan.additions.length, 4); assert.equal(plan.reviews.length, 0);
  assert.equal(new Set(output.flatMap(r=>r.sourceIds)).size, 4);
});
test('V234 合成：尽早取与通知正文切分保留专区，旧污染地点只归类不改原记录', () => {
  const suffixes = ['尽早取','请及时领取','尽快领取','今晚取件'];
  for (const suffix of suffixes) {
    assert.equal(parser.parse(['取件码1234','已送至'+bath+suffix])[0].station,bath);
    assert.equal(parser.parse(['取件码1234','已送至31号楼北侧驿站顺丰专区'+suffix])[0].station,'31号楼北侧驿站顺丰专区');
    assert.equal(require('../miniprogram/services/notification-parser').parse('已送至31号楼取件中心'+suffix+'，取件码1234')[0].station,'31号楼取件中心');
  }
  const old = store.newRecord(raw('1234', bath+'尽早取'));
  const before = JSON.stringify(old);
  let state = stations.remember(empty(),{station:bath});
  state = stations.sync(state,[old]);
  assert.equal(state.groups.length,1); assert.equal(stations.group(state,[old])[0].station,bath);
  assert.equal(JSON.stringify(old),before); assert.ok(!state.groups[0].aliases.includes(old.station));
  assert.throws(()=>stations.addAlias(state,state.groups[0].id,old.station));
  const locked = {...old,confirmedFields:['station']};
  assert.equal(stations.group(state,[locked])[0].station,old.station);
});
test('V234 合成：可靠新站发现、重复不重建；泛称和正文不记忆，相似不同地址不合并', async () => {
  const {p} = await importImages({a:{mock:false,lines:['取件码1234','已送至商丘景苑鑫冉超市店']},b:{mock:false,lines:['菜鸟驿站','取件码2222']}});
  assert.equal(p.data.stationList.length,1); assert.equal(p.data.stationList[0].discoveryStatus,'discovered');
  assert.equal(p.data.exceptionCount,1); assert.equal(stations.sync(p.stationState,p.data.records).groups.length,1);
  const different = stations.sync(empty(),[raw('1111','河南工业大学服务站'),raw('2222','河南工业大学31号楼北校便利超市')]);
  assert.equal(different.groups.length,2);
  assert.equal(stations.sync(empty(),[raw('1111','您的快件已暂存至驿站菜鸟驿站')]).groups.length,0);p.onUnload();
});
test('V234 合成：明确纠正发现的简称后记住关联，稳定ID及原地点保留；未经勾选不学习', async () => {
  for (const learn of [false,true]) {
    const {p,api}=await importImages({a:{mock:false,lines:['取件码1234','已送至洗浴中心北侧店']}});
    p.saveStations(stations.remember(p.stationState,{station:bath}));
    const id=stations.resolve(p.stationState,bath).id;
    p.editRecord(event(p.data.records[0].id));p.data.editing.station=bath;p.data.editing.rememberLocation=learn;p.saveEdit();
    assert.equal(p.data.editError,'');assert.equal(p.data.records[0].originalPickupLocation,'洗浴中心北侧店');assert.equal(p.data.records[0].stationId,id);
    const next=stations.assist(p.stationState,raw('2222','洗浴中心北侧店'));
    assert.equal(next.station,learn?bath:'洗浴中心北侧店');
    p.onUnload();const q=page(api);assert.equal(stations.assist(q.stationState,raw('3333','洗浴中心北侧店')).station,learn?bath:'洗浴中心北侧店');q.onUnload();
  }
});
test('V234 合成：别名不可多绑，取消后含旧ID的包裹重新分组；改名与合并保留关系', async () => {
  let state=stations.remember(empty(),{station:bath}); const id=state.groups[0].id;
  state=stations.addAlias(state,id,'洗浴中心北侧店');
  const parcel=store.newRecord(stations.assist(state,raw('1234','洗浴中心北侧店')));
  state=stations.remember(state,{station:tower});const other=stations.resolve(state,tower).id;
  assert.throws(()=>stations.addAlias(state,other,'洗浴中心北侧店'));
  state=stations.unlink(state,id,'洗浴中心北侧店');
  assert.notEqual(stations.group(state,[parcel])[0].id,id);
  assert.equal(stations.assist(state,raw('2222','洗浴中心北侧店')).station,'洗浴中心北侧店');
  const split=stations.resolve(state,'洗浴中心北侧店').id;
  state=stations.merge(state,[id,split],bath);assert.equal(stations.group(state,[parcel])[0].id,id);
  const p=page(fakeStorage());p.saveStations(state);p.persistRecords([parcel]);p.editStationName(event(id));p.data.stationEditor.name='北侧取件中心';await p.confirmStationEdit();
  assert.equal(p.data.pendingGroups[0].station,'北侧取件中心');assert.equal(p.data.records[0].stationId,id);assert.equal(p.data.records[0].originalPickupLocation,'洗浴中心北侧店');p.onUnload();
});
test('V234 合成：明确新地址不被历史记忆覆盖，唯一已确认详细地址可补地点，多义不选择', () => {
  let state=stations.remember(empty(),{station:bath,pickupAddress:'大学北门1号楼'});
  const id=state.groups[0].id;
  assert.equal(stations.assist(state,raw('1234',tower,{stationId:id,pickupAddress:'大学南门2号楼'})).station,tower);
  assert.equal(stations.assist(state,raw('1234',parser.UNKNOWN,{pickupAddress:'大学北门1号楼'})).station,bath);
  state=stations.remember(state,{station:tower,pickupAddress:'大学北门1号楼'});
  assert.equal(stations.assist(state,raw('1234',parser.UNKNOWN,{pickupAddress:'大学北门1号楼'})).station,parser.UNKNOWN);
});
test('V234 合成：删除保留全部包裹，旧记录、缓存和新截图都不能复活；显式恢复与撤销可用', async () => {
  const {p,api,calls}=await importImages({a:{mock:false,lines:['取件码1234','已送至'+bath]}});
  const id=p.data.stationList[0].id, before=JSON.stringify(p.data.records);
  p.openStationDetail(event(id));await p.deleteStation();assert.equal(JSON.stringify(p.data.records),before);assert.equal(p.data.stationList.length,0);
  p.undoDelete();assert.equal(p.data.stationList.length,1);p.openStationDetail(event(id));await p.deleteStation();
  p.data.images=['a'];await p.recognizeCloud();assert.equal(calls(),1);assert.equal(p.data.stationList.length,0);
  p.persistRecords([...p.data.records,store.newRecord(raw('2222',bath+'尽早取'))]);assert.equal(p.data.stationList.length,0);
  p.onUnload();const q=page(api);assert.equal(q.data.stationList.length,0);q.restoreStation({detail:{value:0}});assert.equal(q.data.stationList.length,1);assert.equal(q.data.pendingGroups.length,1);q.onUnload();
});
test('V234 合成：旧错误配置非破坏性归类，别名和手工确认信息受保护；失败保存不覆盖', () => {
  const legacy={version:1,groups:[{id:'old-bad',name:bath+'尽早取',aliases:[bath+'尽早取']},{id:'good',name:bath,aliases:[bath,'洗浴中心北侧店'],confirmed:true}]};
  const fixed=stations.sync(legacy,[]);assert.equal(legacy.groups.length,2);assert.equal(fixed.groups.length,1);assert.ok(fixed.groups[0].redirectIds.includes('old-bad'));assert.ok(fixed.groups[0].aliases.includes('洗浴中心北侧店'));
  const manual={version:1,groups:[{id:'manual',name:bath+'尽早取',aliases:[bath+'尽早取'],confirmed:true}]};assert.deepEqual(stations.sync(manual,[]),manual);
  const oldRenamed={version:1,groups:[{id:'manual',name:bath+'尽早取',aliases:[bath,bath+'尽早取']}]};assert.deepEqual(stations.sync(oldRenamed,[]),oldRenamed);
  const api=fakeStorage(),p=page(api);p.saveStations(fixed);const before=JSON.stringify(p.stationState);api.failWrite=stations.KEY;
  p.saveStations(stations.addAlias(p.stationState,'good','北侧菜鸟店'));assert.equal(JSON.stringify(p.stationState),before);assert.equal(p.data.stationBlocked,true);p.onUnload();
});
test('V234 合成：现版缓存命中仍重匹配最新别名；旧解析版本不重用漏件结论', async () => {
  const {p,calls}=await importImages({a:{mock:false,lines:['取件码1234','已送至洗浴中心北侧店']}});
  let state=stations.remember(p.stationState,{station:bath},'洗浴中心北侧店');p.saveStations(state);
  p.data.images=['a'];await p.recognizeCloud();assert.equal(calls(),1);assert.equal(p.data.exceptionCount,0);assert.equal(p.data.records.length,1);assert.equal(p.data.pendingGroups[0].station,bath);
  const b=JSON.parse(JSON.stringify(p.importState.batches[0]));b.images[0].parserVersion='2.3.3';p.persistBatch(b);
  // Every old cache for this digest is invalidated, not just the latest batch.
  for (const batch of p.importState.batches.slice()) {const old=JSON.parse(JSON.stringify(batch));old.images.forEach(i=>i.parserVersion='2.3.3');p.persistBatch(old);}
  assert.equal(batches.cachedImage(p.importState,'1'.padStart(40,'0')+':100','other'),null);assert.equal(batches.PARSER_VERSION,'3.0.2');p.onUnload();
});

test('V234 合成：手改旧记录阻止设置自动迁移，已知ID可恢复缺失名称，歧义名称不随意选择', () => {
  const legacy={version:1,groups:[{id:'old',name:bath+'尽早取',aliases:[bath+'尽早取']}]};
  const manual=store.newRecord(raw('1111',bath+'尽早取',{confirmedFields:['station']}));
  assert.deepEqual(stations.sync(legacy,[manual]),legacy);
  const state=stations.remember(empty(),{station:bath}), id=state.groups[0].id;
  assert.equal(stations.assist(state,raw('1111',parser.UNKNOWN,{stationId:id})).station,bath);
  const ambiguous={version:1,groups:[{id:'A',name:'共同名称',aliases:['东门站'],confirmed:true},{id:'B',name:'共同名称',aliases:['西门站'],confirmed:true}]};
  assert.equal(stations.assist(ambiguous,raw('1111','共同名称')).station,parser.UNKNOWN);
  assert.equal(stations.sync(empty(),[raw('1111','今日到站')]).groups.length,0);
});
test('V234 合成：取消别名后的历史包裹身份与首页一致，不能按旧标准名错误去重', () => {
  let state=stations.addAlias(stations.remember(empty(),{station:bath}),stations.normalize(bath),'洗浴中心北侧店');
  const parcel=store.newRecord(stations.assist(state,raw('1234','洗浴中心北侧店')));
  state=stations.unlink(state,stations.normalize(bath),'洗浴中心北侧店');
  const plan=decision.evaluate([raw('1234',bath,{id:'new',sourceIndex:0})],[parcel],state);
  assert.equal(plan.decisions[0].decision,'NEEDS_REVIEW');assert.equal(plan.decisions[0].reason,'record_conflict');
  assert.equal(stations.group(state,[parcel])[0].station,'洗浴中心北侧店');
});
