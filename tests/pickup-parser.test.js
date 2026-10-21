const {test}=require("node:test");
const assert=require("node:assert/strict");
const {parse,group,UNKNOWN}=require("../miniprogram/services/pickup-parser");
test("五个取件码分四站，过滤图标、运单与电话",()=>{
 const records=parse(["今日有5个快递待取","校园邮政","大学路14号","电话","取件码1018-0079","亩","邮政快递包裹9810000000000","支持退换货北门水店","北门水店","电话","取件码186-220","亩","中通快递78000000000000","取件码 186-139","菜鸟驿站","西区校园超市店","取件码1-1-6086","极兔速递JT5400000000000","南门好时店","南门小区6栋","电话","TTO","取件码1-1-4956","回","中通快递","查看全部快递"]);
 assert.deepEqual(records.map(r=>r.code),["1018-0079","186-220","186-139","1-1-6086","1-1-4956"]);
 assert.deepEqual(group(records).map(g=>g.items.length),[1,2,1,1]);
 assert.equal(records[3].station,"菜鸟驿站 · 西区校园超市店");
});
test("独立标签、全角与横线；长运单不误识别",()=>{
 assert.equal(parse(["取件码：","１２－３４－５６７８"])[0].code,"12-34-5678");
 assert.equal(parse(["取件码：1234567890123"]).length,0);
 assert.equal(parse(["电话13800000000","运单123456789012"] ).length,0);
 assert.equal(parse(["取件码1234"])[0].station,UNKNOWN);
});
test("跨图不继承上一站，重复码不静默丢弃",()=>{
 const r=[...parse(["北门驿站","取件码1234"],0),...parse(["取件码1234"],1)];
 assert.equal(group(r).length,2);assert.equal(r[1].sourceIndex,1);
 assert.equal(group([...r,...r])[0].items.length,2);
});
