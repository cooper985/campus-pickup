const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const parser=require('../miniprogram/services/pickup-parser');
const {fuse}=require('../miniprogram/services/candidate-fusion');
const batches=require('../miniprogram/services/import-batches');
const {page}=require('./helpers/page');
const {fakeStorage}=require('./helpers/storage');
const box=(x,y,width=160,height=30)=>({x,y,width,height});

test('V233 合成：复制按钮不制造第二件异常，真正坏码仍保留',()=>{
  for(const code of ['Y2-7-47','2-1-2003']){
    const a=parser.analyze(['大学驿站','取件码',code,'复制取件码']);
    assert.equal(a.records[0].code,code);assert.equal(a.issues.length,0);
  }
  assert.equal(parser.analyze(['大学驿站','取件码1111','复制取件码','取件码8-?-1234']).issues.length,1);
  assert.equal(parser.analyze(['复制取件码1234']).records.length,0);
});
test('V233 合成：短信提货号跨行关联，通知正文不作地点，排除电话运单及链接',()=>{
  const lines=['【递管家】您的京东快递已到河南工业','大学31号楼北京东快递，请用提货号','A4-1-15010取包裹，咨询驿站工作人员'];
  const r=parser.parse(lines,0,lines.map((_,i)=>box(20,i*40,600)));
  assert.equal(r.length,1);assert.equal(r[0].code,'A4-1-15010');assert.equal(r[0].station,'河南工业大学31号楼北京东快递');
  for(const text of ['提货号13800138000','订单号12345678','https://example.test/提货号1234','查看提货号']) assert.equal(parser.parse([text]).length,0);
});
test('V233 合成：右列地址续行保留具体位置，不跨到下一个字段',()=>{
  const lines=['取件码Y2-7-47','取件地址','妈妈驿站请到河工大31号楼北校便利东','门驿站取件','快递公司','圆通快递'];
  const boxes=[box(200,0),box(0,70,100),box(150,70,500),box(150,110,160),box(0,155,100),box(150,155)];
  assert.equal(parser.parse(lines,0,boxes)[0].station,'河工大31号楼北校便利东门驿站');
});
test('V233 合成：列表事件限定单包裹区域，不把别件签收覆盖待取',()=>{
  const lines=['我的快递','待取件1','派送中','运输中','已揽收','待取件1','大学菜鸟驿站','1-2-3000','已到站','已签收2','另一包裹已签收'];
  const boxes=[box(0,0),box(0,50),box(200,50),box(400,50),box(600,50),box(0,130),box(0,180),box(100,230),box(100,280),box(0,380),box(100,430)];
  assert.equal(parser.parse(lines,0,boxes)[0].parcelStatus,'pending');
  const noLayout=parser.parse(lines);assert.equal(noLayout[0].parcelStatus,'conflict');
  const more=lines.slice();more[5]='待取件2';assert.equal(require('../miniprogram/services/recognition-layout').sectionBounds(more,boxes,7),null);
});
test('V233 合成：非传递匹配不能借中间记录桥接身份，未知不产生状态冲突',()=>{
  const a={id:'a',sourceIndex:0,code:'1234',station:'东门驿站'}, b={...a,id:'b',sourceIndex:1,carrier:'顺丰',noticeAt:1000}, c={...b,id:'c',sourceIndex:2,station:'待确认地点'};
  const output=fuse([a,b,c]);assert.ok(output.every(r=>(r.sourceIds||[]).length<3));
  assert.equal(fuse([{...a,parcelStatus:'unknown'},{...a,id:'d',sourceIndex:1,parcelStatus:'pending'}])[0].parcelStatus,'pending');
});
test('V233 缓存升级：旧结构缓存重新识别一次，现版本重传不重复 OCR 或包裹',async()=>{
  const api=fakeStorage();api.getFileInfo=({success})=>success({digest:'a'.repeat(40),size:100});let calls=0;
  const p=page(api,async()=>{calls++;return {mock:false,lines:['大学驿站','取件码1111']};});
  p.data.images=['a'];await p.recognizeCloud();assert.equal(calls,1);
  const b=JSON.parse(JSON.stringify(p.importState.batches[0]));delete b.images[0].parserVersion;p.persistBatch(b);
  assert.equal(batches.cachedImage(p.importState,'a'.repeat(40)+':100','other'),null);
  p.data.images=['a'];await p.recognizeCloud();assert.equal(calls,2);
  p.data.images=['a'];await p.recognizeCloud();assert.equal(calls,2);assert.equal(p.data.records.length,1);p.onUnload();
});
test('V233 旧异常重新选图会升级解析，不被旧来源区域阻挡',async()=>{
  const api=fakeStorage();api.getFileInfo=({success})=>success({digest:'b'.repeat(40),size:100});let calls=0;
  const p=page(api,async()=>{calls++;return {mock:false,lines:calls===1?['取件码1111']:['大学驿站','取件码1111']};});
  p.data.images=['a'];await p.recognizeCloud();const b=JSON.parse(JSON.stringify(p.importState.batches[0]));delete b.images[0].parserVersion;p.persistBatch(b);p.openExceptions();
  assert.equal(p.data.currentException.sources[0].needsRecognition,true);api.chooseImage=async()=>({tempFiles:[{path:'a',size:100}]});
  await p.selectSourceImage({currentTarget:{dataset:{batchId:b.id,imageIndex:0}}});assert.equal(calls,2);assert.equal(p.data.exceptionCount,0);assert.equal(p.data.records.length,1);p.onUnload();
});
test('V233 本地诊断保留字段证据与阶段，持久化过滤诊断和原文',()=>{
  const d=require('../miniprogram/services/recognition-diagnostics').analyze(['大学驿站','取件码1111','私人通知正文'],0,[],[['1111','大学驿站'],['2222','大学驿站']]);
  assert.equal(d.diagnostics.failures[0].stage,'parsed');assert.equal(d.diagnostics.failures[1].stage,'ocr_missing');
  assert.ok(d.diagnostics.entities.some(e=>e.type==='pickup_code'));assert.ok(!JSON.stringify(d.diagnostics).includes('私人通知正文'));
  const c=batches.cleanCandidate({...d.records[0],id:'a',diagnostics:d.diagnostics});assert.equal(c.diagnostics,undefined);
});
test('V233 真实 RapidOCR 留样：原图和裁剪分别通过，不冒充腾讯 OCR', {skip:!fs.existsSync('test-data/private/v233/rapid-A-full.json')},()=>{
  const expected={A:['Y2-7-47','河工大31号楼北校便利东门驿站'],B:['A4-1-15010','河南工业大学31号楼北京东快递'],C:['2-1-2003','商丘景苑鑫冉超市店']};
  const {read,cacheFile}=require('./live-ocr/run.cjs');
  const d=read(cacheFile(require('./fixtures/live-ocr-20261023.json')[0].imageSha256)).result;
  assert.equal(parser.analyze(d.lines,0,d.boxes).records[0].parcelStatus,'pending');
  for(const id of Object.keys(expected))for(const mode of ['full','crop']){
    const c=JSON.parse(fs.readFileSync(`test-data/private/v233/rapid-${id}-${mode}.json`));
    assert.equal(c.engine,'rapidocr-onnxruntime==1.4.4');const a=parser.analyze(c.result.lines,0,c.result.boxes);
    assert.deepEqual(a.records.map(r=>[r.code,r.station]),[expected[id]]);assert.equal(a.issues.length,0);
  }
});
