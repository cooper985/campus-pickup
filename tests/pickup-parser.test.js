const {test}=require("node:test");
const assert=require("node:assert/strict");
const {parse,group,UNKNOWN}=require("../miniprogram/services/pickup-parser");
test("五个取件码分四站，过滤图标、运单与电话",()=>{
 const records=parse(["今日有5个快递待取","校园邮政","大学路14号","电话","取件码1018-0079","亩","邮政快递包裹9810000000000","支持退换货北门水店","北门水店","电话","取件码186-220","亩","中通快递78000000000000","取件码 186-139","菜鸟驿站","西区校园超市店","取件码1-1-6086","极兔速递JT5400000000000","南门好时店","南门小区6栋","电话","TTO","取件码1-1-4956","回","中通快递","查看全部快递"]);
 assert.deepEqual(records.map(r=>r.code),["1018-0079","186-220","186-139","1-1-6086","1-1-4956"]);
 assert.deepEqual(group(records).map(g=>g.items.length),[1,2,1,1]);
 assert.equal(records[3].station,"西区校园超市店"); // A station brand and its branch describe the same block.
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
test("合法无取件码结果区分运输、到站隐藏和未知", () => {
 const {analyze}=require('../miniprogram/services/pickup-parser');
 for (const line of ['运输中','已揽收','预计后天送达']) assert.equal(analyze([line]).status,'in_transit');
 assert.equal(analyze(['已到站','取件码：****']).status,'arrived_no_code');
 assert.equal(analyze(['物流详情']).status,'no_code');
 assert.equal(analyze(['运输中','已到站','取件码：603402']).status,'code_found');
 assert.equal(analyze([]).status,'no_code');
});
test("明确派送地点优先，不拼接求助按钮、收件城市或地图地名", () => {
 for (const city of ['新乡市','杭州市','成都市']) {
  const r=parse(['b物流求助',`收${city}`,'取件码：603402','已派送至：一中看台','复制','订阅提醒',`地图 ${city}`]);
  assert.equal(r[0].code,'603402'); assert.equal(r[0].station,'一中看台');
 }
 assert.equal(parse(['b物流求助','收新乡市','取件码：603402'])[0].station,UNKNOWN);
 assert.equal(parse(['到达北门驿站转运中心','取件码：603402'])[0].station,UNKNOWN);
});
test("坐标区分不同包裹和地图候选；远处标签不借用号码", () => {
 const b=(x,y)=>({x,y,width:150,height:20});
 const lines=['取件地址：南门服务站','取件码1111','取件地址：北门服务站','取件码2222','地图城市'];
 const r=parse(lines,0,[b(10,10),b(10,50),b(300,10),b(300,50),b(10,400)]);
 assert.deepEqual(r.map(x=>x.station),['南门服务站','北门服务站']);
 assert.equal(parse(['取件码','603402'],0,[b(0,0),b(300,500)]).length,0);
 assert.equal(parse(['自提点：','一中看台','取件码603402'],0,[b(0,0),b(0,30),b(0,60)])[0].station,'一中看台');
 assert.equal(parse(['东门驿站','西门驿站','取件码603402'])[0].station,UNKNOWN);
});
