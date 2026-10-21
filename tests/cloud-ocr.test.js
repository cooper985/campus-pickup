const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("miniprogram/services/cloud-ocr.js", "utf8");
const small = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
const large = Buffer.alloc(513 * 1024).toString("base64");
function service(files, result) {
  const calls = [];
  const wx = {
    getFileSystemManager: () => ({
      readFile: ({ filePath, success }) => success({ data: files[filePath] }),
    }),
    compressImage: ({ success }) => success({ tempFilePath: "compressed" }),
    cloud: { callFunction: async options => { calls.push(options); return { result }; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { wx, module, Error, require: name => require("../miniprogram/services/" + name.slice(2)) });
  return { ...module.exports, calls, wx };
}
test("云识别传图并保留服务器模式；错误不自动重试", async () => {
  for (const mock of [true, false]) {
    const s = service({ image: small }, { ok: true, mock, lines: ["取件码：1-2-3"] });
    assert.equal((await s.recognize("image")).mock, mock);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].data.imageBase64, small);
    assert.equal(s.calls[0].name, "recognizePickup");
  }
  const s = service({ image: small }, { ok: false, error: { code: "OCR_AUTH", message: "private" } });
  await assert.rejects(s.recognize("image"), /尚未授权/);
  assert.equal(s.calls.length, 1);
  s.wx.cloud.callFunction = async () => { throw new Error("private internal details"); };
  await assert.rejects(s.recognize("image"), /云服务连接失败/);
});
test("大图压缩后再上传，仍超限或格式错误时不上传", async () => {
  const s = service({ image: large, compressed: small }, { ok: true, mock: true, lines: [] });
  await s.recognize("image");
  assert.equal(s.calls[0].data.imageBase64, small);
  const tooLarge = service({ image: large, compressed: large });
  await assert.rejects(tooLarge.recognize("image"), /仍超过/);
  assert.equal(tooLarge.calls.length, 0);
  const invalid = service({ image: "YWJj" });
  await assert.rejects(invalid.recognize("image"), /仅支持/);
  assert.equal(invalid.calls.length, 0);
});
test('读图超时或取消后不能继续发送云端请求',async()=>{
 const { start }=require('../miniprogram/services/recognition-task');
 const s=service({image:small},{ok:true,mock:false,lines:[]}); let release;
 s.wx.getFileSystemManager=()=>({readFile:({success})=>release=success});
 const job=start(control=>s.recognize('image',control),5);
 await assert.rejects(job.promise,e=>e.code==='WAIT_TIMEOUT'); release({data:small});
 await new Promise(r=>setImmediate(r)); assert.equal(s.calls.length,0);
});

test('网络和云调用超时保留内部类型，不采用不受支持的超时配置，不输出供应商详情', async () => {
 for(const [errMsg,code] of [['request fail timeout private','TIMEOUT'],['network failed private','NETWORK_FAILED']]) {
  const s=service({image:small}); s.wx.cloud.callFunction=async()=>{throw {errMsg,errCode:-404012};};
  await assert.rejects(s.recognize('image'),err=>err.code===code && err.sdkCode===-404012 && !err.message.includes('private'));
 }
 const s=service({image:small},{ok:true,mock:false,lines:[]}); await s.recognize('image');
 assert.equal(s.calls[0].config,undefined);
});
