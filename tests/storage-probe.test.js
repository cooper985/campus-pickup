const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const { probe } = require("../cloudfunctions/recognizePickup/storage-probe");
const { CLOUD_ENV } = require("../miniprogram/services/recognition-task");
const prefix = `cloud://${CLOUD_ENV}.test-bucket/ocr-probe/test-user/`;
const fileID = prefix + "1792636800000-0123456789abcdef.img";
const image = Buffer.from([137,80,78,71,13,10,26,10,0]);
function server() {
  const calls = [];
  const options = { envId: CLOUD_ENV, ready: true, bucket: "test-bucket", allowedOpenids: ["test-user"], cloud: {
    downloadFile: async args => { calls.push(["read",args.fileID]); return { fileContent: image }; },
    deleteFile: async args => { calls.push(["delete",args.fileList[0]]); return { fileList: [{status:0}] }; },
  } };
  return { options, calls };
}
test("fileID验证仅限已启用的测试用户及本人目录，拒绝其他环境/桶/用户和路径穿越", async () => {
  const s = server();
  for (const bad of [fileID.replace(CLOUD_ENV,"other-env"),fileID.replace("test-bucket","other-bucket"),fileID.replace("test-user","another-user"),prefix+"../image.img"]) {
    assert.equal((await probe({fileID:bad},{OPENID:"test-user"},s.options)).error.code,"INVALID_FILE");
  }
  assert.equal((await probe({fileID},{OPENID:"another-user"},s.options)).error.code,"FORBIDDEN");
  s.options.ready=false;
  assert.equal((await probe({fileID},{OPENID:"test-user"},s.options)).error.code,"PROBE_NOT_READY");
  assert.equal(s.calls.length,0);
});
test("服务端只读取校验图片并在成功/异常时删除，不返回图片或身份", async () => {
  const s=server();
  const result=await probe({fileID},{OPENID:"test-user"},s.options);
  assert.equal(result.ok,true); assert.equal(result.imageBytes,image.length); assert.equal(result.serverDeleted,true);
  assert.deepEqual(s.calls.map(x=>x[0]),["read","delete"]);
  assert.ok(!JSON.stringify(result).includes("test-user"));
  s.options.cloud.downloadFile=async()=>{throw Error("private details");};
  const failed=await probe({fileID},{OPENID:"test-user"},s.options);
  assert.equal(failed.readSucceeded,false); assert.equal(failed.serverDeleted,true);
  assert.equal(failed.error.code,"PROBE_READ_FAILED");
  s.options.cloud.downloadFile=async()=>{throw {errCode:-503002,code:'STORAGE_PERMISSION_DENIED',errMsg:'Permission denied https://private-url/token'};};
  s.options.cloud.deleteFile=async()=>{throw {errCode:-503002,errMsg:'Permission denied private account'};};
  const restricted=await probe({fileID},{OPENID:"test-user"},s.options);
  assert.deepEqual(restricted.readFailure,{serviceCode:'STORAGE_PERMISSION_DENIED',sdkCode:-503002,kind:'permission'});
  assert.deepEqual(restricted.deleteFailure,{serviceCode:null,sdkCode:-503002,kind:'permission'});
  assert.ok(!JSON.stringify(restricted).includes('private'));
  const denied=server(); denied.options.cloud.deleteFile=async()=>({fileList:[{status:-1}]});
  const retained=await probe({fileID},{OPENID:"test-user"},denied.options);
  assert.equal(retained.serverDeleted,false); assert.equal(retained.error.code,"PROBE_DELETE_FAILED");
});

test("上传超时后的迟到文件也清理，不再发起fileID调用",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=client(); let release, lateID;
  s.wx.cloud.uploadFile=args=>new Promise(resolve=>{release=resolve;lateID=prefix+args.cloudPath.split("/").pop();});
  const running=s.run("path"); await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(60000);
  const report=await running;
  assert.equal(report.error,"PROBE_WAIT_TIMEOUT"); assert.equal(report.failedPhase,"uploadMs"); assert.equal(report.cleanupPending,true);
  release({fileID:lateID}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(report.clientDeleted,true); assert.equal(report.cleanupPending,false);
  assert.equal(s.calls.filter(x=>typeof x==="object").length,1);
});
function client({ready=true,callFails=false}={}) {
  const calls=[];
  const wx={ getFileSystemManager:()=>({getFileInfo:({success})=>success({size:image.length})}), cloud:{
    callFunction:async args=>{
      assert.equal(args.config.env,CLOUD_ENV); calls.push(args.data);
      if(args.data.check)return {result:ready?{protocol:1,ok:true,openid:"test-user",filePrefix:prefix}:{ok:false}};
      if(callFails)throw {errCode:-404012,errMsg:"private text"};
      return {result:{protocol:1,ok:true,readSucceeded:true,serverDeleted:true,imageBytes:image.length,readMs:8,deleteMs:3}};
    },
    uploadFile:async args=>{calls.push("upload");return {fileID:prefix+args.cloudPath.split("/").pop()};},
    deleteFile:async()=>{calls.push("delete");return {fileList:[{status:0}]};},
  }};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync("miniprogram/services/storage-probe.js","utf8"),
    {module,wx,setTimeout,clearTimeout,require:()=>({CLOUD_ENV,isDevelopment:()=>true})});
  return {run:module.exports.run,calls,wx};
}
test("客户端单次上传及小参数调用，未部署时不上传，云调用失败也清理，不自动重试",async()=>{
  const s=client(),report=await s.run("private-image-path");
  assert.equal(report.uploadSucceeded,true); assert.equal(report.fileIdValid,true);
  assert.equal(report.readSucceeded,true); assert.equal(report.serverDeleted,true); assert.equal(report.cleanupPending,false);
  assert.equal(report.timings.readMs,8); assert.ok(report.requestBytes<300); assert.equal(report.ocrCalls,0);
  assert.equal(s.calls.length,3); assert.ok(!("imageBase64" in s.calls[2]));
  assert.ok(!JSON.stringify(report).includes("test-user")); assert.ok(!JSON.stringify(report).includes("private"));
  const disabled=client({ready:false}); assert.equal((await disabled.run("path")).error,"PROBE_NOT_READY"); assert.equal(disabled.calls.length,1);
  const failed=client({callFails:true}),failure=await failed.run("path");
  assert.equal(failure.failedPhase,"callMs"); assert.equal(failure.sdkCode,-404012); assert.equal(failure.clientDeleted,true);
  assert.equal(failed.calls.filter(x=>x==="delete").length,1); assert.equal(failed.calls.length,4);
});

test("选图后可直接验证，重复点击只复制同一报告，不为验证调用OCR",async()=>{
  const {page}=require('./helpers/page'),{fakeStorage}=require('./helpers/storage');
  const task=require('../miniprogram/services/recognition-task');
  const wx=fakeStorage();let probes=0,ocr=0,copies=0;
  wx.showLoading=wx.hideLoading=wx.showToast=()=>{};wx.setClipboardData=()=>copies++;
  const p=page(wx,async()=>{ocr++;},undefined,{'recognition-task':{...task,isDevelopment:()=>true},
    'storage-probe':{run:async()=>{probes++;return {ocrCalls:0};}}});
  p.data.images=['local-image'];
  const event={currentTarget:{dataset:{index:'0'}}};
  await p.verifyStoragePath(event);await p.verifyStoragePath(event);
  assert.equal(probes,1);assert.equal(ocr,0);assert.equal(copies,2);assert.equal(p.data.probeReportReady,true);
});
