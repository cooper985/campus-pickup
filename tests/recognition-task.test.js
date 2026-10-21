const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('诊断日志只含阶段、毫秒和白名单错误类型，不输出异常原文',async()=>{
 const logs=[],module={exports:{}};
 vm.runInNewContext(fs.readFileSync('miniprogram/services/recognition-task.js','utf8'),{module,setTimeout,clearTimeout,console:{info:(...args)=>logs.push(args)}});
 const t=module.exports;
 for(const code of ['secret-token','__proto__','constructor']) {
  assert.equal(t.error(code).code,'OCR_FAILED'); t.log('image_total',Date.now(),code);
 }
 const job=t.start(control=>{control.stage('cloud_roundtrip'); return new Promise(()=>{});},5);
 await assert.rejects(job.promise,e=>e.code==='WAIT_TIMEOUT');
 assert.equal(t.WAIT_TIMEOUT_MS,10000);
 assert.ok(!JSON.stringify(logs).includes('secret-token'));
 assert.deepEqual(Object.keys(logs[0][1]).sort(),['ms','stage','type']);
 assert.equal(logs.at(-1)[1].stage,'cloud_roundtrip');
});

test('取消同一事件循环内已经完成的结果也不接受它',async()=>{
 const {start}=require('../miniprogram/services/recognition-task');
 const job=start(()=>Promise.resolve({lines:['取件码1234']})); job.cancel();
 await assert.rejects(job.promise,e=>e.code==='CANCELLED');
});
