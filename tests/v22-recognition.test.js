const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuse } = require('../miniprogram/services/candidate-fusion');
const notifications = require('../miniprogram/services/notification-parser');
const parser = require('../miniprogram/services/pickup-parser');
const { planImport } = require('../miniprogram/services/pickup-duplicates');
const storage = require('../miniprogram/services/pickup-store');
const stations = require('../miniprogram/services/stations');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const real = require('./fixtures/real-ocr-20261021.json');
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = (i, extra = {}) => ({ id: `source-${i}`, sourceIndex: i, code: 'B3-4-7401', station: parser.UNKNOWN, carrier: '', ...extra });
const event = (id, action) => ({ currentTarget: { dataset: { id, action } } });

test('结构化通知：多通知各自关联、入库/领取地点/凭码取、全角短码，排除链接尾号', () => {
  const samples = [
    ['【驿小哥】您的顺丰快递9465已到北校洗浴中心驿站顺丰专区，可凭C205-2004到店洗浴中心店提取。', [['C205-2004', '北校洗浴中心驿站顺丰专区']]],
    ['【驿小哥】已到东门驿站，凭ＡＢ１２３４免费取。【驿小哥】取件码5678，已入库西门超市。', [['AB1234','东门驿站'],['5678','西门超市']]],
    ['领取地点：31号楼便利店，提货码：１２３。', [['123', '31号楼便利店']]],
    ['凭ABC-12-345取，取件地址：东区2号楼快递柜', [['ABC-12-345', '东区2号楼快递柜']]],
    ['取件码1234，已送达大学服务站，地址：大学31号楼京东快递；取件码5678，已送至南门便利店，地址：南门2栋一层', [['1234','大学服务站'],['5678','南门便利店']]],
    ['取件码1234、5678，已到大学服务站，地址：大学31号楼', [['1234','大学服务站'],['5678','大学服务站']]],
    ['订单号7202，快件尾号9465，网址https://example.com/取件码1234，电话13800138000', []],
    ['取件码1234，取件地址东门驿站，取件地点西门驿站', [['1234', parser.UNKNOWN]]],
  ];
  for (const [text, expected] of samples) assert.deepEqual(notifications.parse(text).map(r => [r.code,r.station]), expected);
  const paired = notifications.parse(samples[4][0]);
  assert.deepEqual(paired.map(r => r.pickupAddress), ['大学31号楼京东快递','南门2栋一层']);
});
test('OCR保留坐标：两列地址各归其码，独立详细地址保留，短码和字母前缀有效', () => {
  const box = (x,y) => ({ x,y,width:150,height:20 });
  const rows = ['取件地址：东门服务站','取件码AB1234','地址：东门31号楼便利店','取件地址：西门服务站','取件码123','地址：西门2号楼'];
  const records = parser.parse(rows,0,[box(0,0),box(0,30),box(0,60),box(500,0),box(500,30),box(500,60)]);
  assert.deepEqual(records.map(r => [r.code,r.station,r.pickupAddress]), [['AB1234','东门服务站','东门31号楼便利店'],['123','西门服务站','西门2号楼']]);
  assert.equal(parser.parse(['取件码6034O2']).length, 0);
  assert.equal(parser.parse(['东门驿站','取件码1234','取件码5678'],0,[box(0,0),box(0,30),box(0,1000)])[1].station,parser.UNKNOWN);
});
test('OCR换行通知只连接相邻同列行，不把邻列另一条通知拼进来', () => {
  const rows = ['【驿小哥】已到东门驿站，','凭A203-4010免费取','【京东快递】取件码C2-3-1304，已送达西门服务站，','地址：西门31号楼京东快递'];
  const boxes = [{x:0,y:0,width:200,height:20},{x:0,y:25,width:200,height:20},{x:400,y:0,width:250,height:20},{x:400,y:25,width:250,height:20}];
  const records = parser.parse(rows,0,boxes);
  assert.deepEqual(records.map(r => [r.code,r.station]),[['A203-4010','东门驿站'],['C2-3-1304','西门服务站']]);
  assert.equal(records[1].pickupAddress,'西门31号楼京东快递');
});
test('三图逐步补全：同码补地点、公司、详细地址，来源仅在草稿；不同码不合并', () => {
  const merged = fuse([item(0), item(1,{station:'大学服务站'}), item(2,{station:'大学服务站',carrier:'京东物流',pickupAddress:'31号楼北校超市'})]);
  assert.equal(merged.length,1); assert.equal(merged[0].pickupAddress,'31号楼北校超市');
  assert.deepEqual(merged[0].sourceIndices,[0,1,2]); assert.equal(merged[0].fieldSources.station,1);
  const saved = storage.newRecord(merged[0]); assert.equal(saved.pickupAddress,'31号楼北校超市');
  assert.equal(saved.fieldSources,undefined); assert.equal(saved.sourceIds,undefined);
  assert.equal(fuse([item(0),item(1,{code:'B3-4-7402'})]).length,2);
});
test('整组冲突先检查：缺地址不能桥接不同站点；不同运单、同图同码和疑似字符都进入核对', () => {
  for (const inputs of [
    [item(0),item(1,{station:'东门'}),item(2,{station:'西门'})],
    [item(0,{waybillNumber:'SF123456789012'}),item(1,{waybillNumber:'SF999999999999'})],
    [item(0),item(0,{id:'same-image-other'})],
    [item(0,{code:'A1-1200'}),item(1,{code:'A1-12O0'})],
  ]) {
    const candidates = fuse(inputs);
    assert.equal(candidates.length,inputs.length);
    assert.ok(candidates.every(r => r.batchConflict || r.uncertainCode));
    const plan = planImport([],candidates);
    assert.equal(plan.added,0); assert.equal(plan.reviews.length,inputs.length);
    assert.ok(plan.reviews.every(r => r.action === 'skip'));
  }
});
test('只使用用户已确认别名；手动字段优先且不按公司或站点合并不同码', () => {
  let state = stations.sync({ version: 1, groups: [] }, [item(0,{station:'东门驿站'}),item(1,{station:'东门快递站'})]);
  state = stations.merge(state,state.groups.map(g=>g.id),'东门驿站');
  const merged = fuse([item(0,{station:'东门驿站'}),item(1,{station:'东门快递站',pickupAddress:'手动地址',confirmedFields:['pickupAddress']})], name=>stations.resolve(state,name).id);
  assert.equal(merged.length,1); assert.equal(merged[0].pickupAddress,'手动地址');
  assert.ok(merged[0].confirmedFields.includes('pickupAddress'));
  assert.equal(fuse([item(0,{station:'东门驿站'}),item(1,{station:'东门快递站'})]).length,2);
});
test('真实OCR跨图互补：两种完成顺序一致，第三张失败不阻止收齐后补全，确认前不落盘', async () => {
  for (const order of [[0,1],[1,0]]) {
    const releases = {}, wx=fakeStorage();
    const p=page(wx,path=>new Promise((resolve,reject)=>releases[path]={resolve,reject}));
    p.data.images=['order-list','detail','failed']; const run=p.recognizeCloud(); await tick();
    const keys=['order-list','detail'], responses=[real[4].result,real[5].result];
    releases[keys[order[0]]].resolve(responses[order[0]]); await tick();
    await p.confirmImport(); assert.equal(p.data.records.length,0); assert.equal(p.data.drafts.length,0);
    releases.failed.reject({code:'NETWORK_FAILED'}); releases[keys[order[1]]].resolve(responses[order[1]]); await run;
    assert.equal(p.data.drafts.length,2);
    const merged=p.data.drafts.find(r=>r.code==='B3-4-7401');
    assert.equal(merged.station,'河南工业大学服务站'); assert.deepEqual(Array.from(merged.sourceIndices),[0,1]);
    await p.confirmImport(); assert.equal(p.data.records.length,2); assert.equal(p.data.reviewOpen,false); p.onUnload();
  }
});
test('手动修改在单图重试后保留，历史已取同码仍可选择新增而不覆盖', async () => {
  const wx=fakeStorage(); let failed=true;
  const p=page(wx,async path=>{if(path==='bad'&&failed)throw {code:'NETWORK_FAILED'};return {mock:false,lines:['取件码1234']};});
  p.data.images=['good','bad'];await p.recognizeCloud();
  const id=p.data.drafts[0].id;p.editRecord(event(id));p.editStation({detail:{value:'用户确认驿站'}});p.saveEdit();
  failed=false;await p.retryImage({currentTarget:{dataset:{index:2}}});
  assert.equal(p.data.drafts.length,1);assert.equal(p.data.drafts[0].station,'用户确认驿站');
  const old=storage.updateRecord(storage.newRecord(p.data.drafts[0]),{taken:true});p.persistRecords([old]);
  const importing=p.confirmImport();assert.equal(p.data.reviewOpen,true);
  p.chooseImportAction(event(p.data.reviewItems[0].id,'new'));p.finishImportReview();await importing;
  assert.equal(p.data.records.length,2);assert.deepEqual(p.data.records[0],old);p.onUnload();
});

test('跨句详细地址保留；单独地点来源不能给多码截图猜配；移除草稿不被重试复活', async () => {
  const n=notifications.parse('取件码1234，已送达大学服务站。地址：大学31号楼便利店。');
  assert.equal(n[0].station,'大学服务站');assert.equal(n[0].pickupAddress,'大学31号楼便利店');
  const p=page(fakeStorage(),async path=>({mock:false,lines:path==='codes'?['取件码1234','取件码5678']:['大学服务站']}));
  p.data.images=['codes','address'];await p.recognizeCloud();
  assert.equal(p.data.drafts.length,2);assert.ok(p.data.drafts.every(r=>r.station===parser.UNKNOWN));
  p.removeDraft(event(p.data.drafts[0].id));
  await p.startImage(1,p.recognitionRun);
  assert.equal(p.data.drafts.length,1);assert.equal(p.data.drafts[0].code,'5678');p.onUnload();
});
test('同码冲突两条均需显式选择，选择两件后重进核对仍保留，未选择不保存', async () => {
  const p=page(fakeStorage(),async path=>({mock:false,lines:[path==='east'?'东门驿站':'西门驿站','取件码1234']}));
  p.data.images=['east','west'];await p.recognizeCloud();
  let run=p.confirmImport();assert.equal(p.data.reviewItems.length,2);assert.equal(p.data.records.length,0);
  p.data.reviewItems.forEach(r=>p.chooseImportAction(event(r.id,'new')));
  p.cancelImportReview();await run;
  run=p.confirmImport();assert.ok(p.data.reviewItems.every(r=>r.action==='new'));
  p.finishImportReview();await run;
  assert.equal(p.data.records.length,2);assert.deepEqual(Array.from(p.data.records,r=>r.station),['东门驿站','西门驿站']);p.onUnload();
});


test('收件地址不是取件地址，图片网址中的标签也不能生成取件码', () => {
  const notice = notifications.parse('取件码1234，已到东门驿站，收件地址：南门宿舍1号楼');
  assert.equal(notice[0].station,'东门驿站');assert.equal(notice[0].pickupAddress,undefined);
  const image = parser.parse(['取件码1234','东门驿站','收件地址：南门宿舍1号楼']);
  assert.equal(image[0].station,'东门驿站');assert.equal(image[0].pickupAddress,undefined);
  assert.equal(parser.parse(['https://example.com/取件码1234','3.cn/取件码5678']).length,0);
});
