const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const parser = require("../miniprogram/services/pickup-parser");
function page(wx, recognize = async () => ({ mock: true, lines: ["北门驿站", "取件码1-2-3456"] })) {
  let result;
  vm.runInNewContext(fs.readFileSync("miniprogram/pages/pickup/index.js", "utf8"), {
    require: name => name.endsWith("pickup-parser") ? parser : { recognize }, wx, Page: p => { result = p; },
  });
  result.setData = function(data) { Object.assign(this.data, data); };
  return result;
}
test("批量选择、预览、串行识别与分组", async () => {
  let preview, active = 0;
  const p = page({
    chooseImage: async o => { assert.equal(o.count, 9); return {tempFiles:[{path:"a.png",size:10},{path:"b.png",size:10}]}; },
    previewImage: o => { preview = o.current; },
  }, async () => {
    assert.equal(active++,0); await Promise.resolve(); active--;
    return { mock:false, lines:["北门驿站","取件码1-2-3456"] };
  });
  await p.chooseImage(); p.previewImage({currentTarget:{dataset:{index:1}}}); await p.recognizeCloud();
  assert.equal(preview,"b.png"); assert.equal(p.data.records.length,2);
  assert.equal(p.data.groups.length,1); assert.equal(p.data.mock,false);
  p.toggleTaken({currentTarget:{dataset:{id:"p0-0"}}}); assert.equal(p.data.remaining,1);
  p.editRecord({currentTarget:{dataset:{id:"p0-0"}}});
  p.data.editing.station="南门驿站"; p.saveEdit(); assert.equal(p.data.groups.length,2);
});
test("取消和超限选图保留原批次", async () => {
  const wx={chooseImage:async()=>{throw {errMsg:"cancel"};}};
  const p=page(wx);p.data.images=["old.png"];
  await p.chooseImage();assert.equal(p.data.images[0],"old.png");assert.equal(p.data.error,"");
  wx.chooseImage=async()=>({tempFiles:[{path:"big",size:6*1024*1024}]});
  await p.chooseImage();assert.match(p.data.error,/5 MB/);assert.equal(p.data.images[0],"old.png");
});
test("重复点击不重复调用，单图失败保留其他结果", async () => {
  let calls=0,release;
  const p=page({},async()=>{calls++;if(calls===1)await new Promise(r=>release=r);else throw Error("network");return {mock:false,lines:["取件码1234"]};});
  await p.recognizeCloud();assert.equal(calls,0);
  p.data.images=["a","b"];
  const run=p.recognizeCloud();await p.recognizeCloud();assert.equal(calls,1);
  release();await run;
  assert.equal(calls,2);assert.equal(p.data.records.length,1);assert.equal(p.data.results[1].error,"network");assert.equal(p.data.loading,false);
});
