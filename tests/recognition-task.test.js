const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('诊断日志只含阶段、毫秒和白名单错误类型，不输出异常原文',async()=>{
 const logs=[],module={exports:{}};
 vm.runInNewContext(fs.readFileSync('miniprogram/services/recognition-task.js','utf8'),{module,setTimeout,clearTimeout,wx:{getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}})},console:{info:(...args)=>logs.push(args)}});
 const t=module.exports;
 for(const code of ['secret-token','__proto__','constructor']) {
  assert.equal(t.error(code).code,'OCR_FAILED'); t.log('image_total',Date.now(),code);
 }
 const job=t.start(control=>{control.stage('cloud_roundtrip'); return new Promise(()=>{});},5);
 await assert.rejects(job.promise,e=>e.code==='WAIT_TIMEOUT');
 assert.equal(t.WAIT_TIMEOUT_MS,60000);
 assert.ok(!JSON.stringify(logs).includes('secret-token'));
 assert.deepEqual(Object.keys(logs[0][1]).sort(),['ms','stage','type']);
 assert.equal(logs.at(-1)[1].stage,'cloud_roundtrip');
});

test('取消同一事件循环内已经完成的结果也不接受它',async()=>{
 const {start}=require('../miniprogram/services/recognition-task');
 const job=start(()=>Promise.resolve({lines:['取件码1234']})); job.cancel();
 await assert.rejects(job.promise,e=>e.code==='CANCELLED');
});

test('开发版失败后只复制一次脱敏诊断，正式版不显示入口且拒绝复制', async()=>{
 const {page}=require('./helpers/page'),{fakeStorage}=require('./helpers/storage');
 const wx=fakeStorage(); let copied='', mode='develop';
 wx.getAccountInfoSync=()=>({miniProgram:{envVersion:mode}});
 wx.getDeviceInfo=()=>({platform:'android',model:'private-device'});
 wx.getAppBaseInfo=()=>({SDKVersion:'3.17.4',version:'8.0.76'});
 wx.setClipboardData=({data,success})=>{copied=data;success();}; wx.showToast=()=>{};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync('miniprogram/services/recognition-task.js','utf8'),
  {module,wx,setTimeout,clearTimeout,console:{info(){}}});
 const task=module.exports;
 const p=page(wx,async(_,control)=>{
  control.stage('cloud_roundtrip');
  task.log('cloud_roundtrip',Date.now(),'TIMEOUT',{traceId:control.traceId,origin:'cloud_call',sdkCode:-404012,errorKind:'polling_timeout'});
  throw {code:'TIMEOUT',origin:'cloud_call',sdkCode:-404012,message:'private-text'};
 },undefined,{'recognition-task':task});
 p.data.images=['private-path']; await p.recognizeCloud();
 assert.equal(p.data.diagnosticEnabled,true);
 p.copyRecognitionDiagnostic({currentTarget:{dataset:{taskId:p.data.results[0].taskId}}});
 const report=JSON.parse(copied)[0];
 assert.equal(report.platform,'android'); assert.equal(report.SDKVersion,'3.17.4');
 assert.equal(report.env,task.CLOUD_ENV);
 assert.ok(report.events.some(e=>e.stage==='image_total'&&e.phase==='cloud_roundtrip'&&e.sdkCode===-404012));
 assert.ok(!copied.includes('private')); assert.equal(p.data.drafts.length,0);
 mode='release'; copied=''; p.copyRecognitionDiagnostic({currentTarget:{dataset:{taskId:p.data.results[0].taskId}}});
 assert.equal(copied,''); assert.equal(page(wx,undefined,undefined,{'recognition-task':task}).data.diagnosticEnabled,false);
});
