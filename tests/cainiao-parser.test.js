const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const parser = require('../miniprogram/services/pickup-parser');
const cases = require('./fixtures/cainiao-real-ocr-20261022.json');
const {page} = require('./helpers/page');
const {fakeStorage} = require('./helpers/storage');

test('真实原图OCR回归：旧解析器忽略两个独立码，广告标签造成整图unrecognized；新版列表与详情地点正确', () => {
  const old = {exports:{}};
  vm.runInNewContext(execFileSync('git', ['show', '9600c1e1cd31b404e261363be65b8e6cc12c1398:miniprogram/services/pickup-parser.js'], {encoding:'utf8'}), {module:old});
  // Pin the failing source so this regression still proves the cause after committing.
  for (const c of cases) {
    assert.equal(c.result.mock, false);
    const result = parser.analyze(c.result.lines, 0, c.result.boxes);
    assert.deepEqual(result.records.map(r=>[r.code,r.station]), c.expected);
    assert.equal(result.reason, 'code_found');
    assert.equal(result.uncertainCount, 0);
    assert.ok(result.records.every(r=>!r.needsReview));
    const privatePath = `test-data/private/cainiao-20261022/${c.case}-ocr.json`;
    if (fs.existsSync(privatePath)) {
      const raw = JSON.parse(fs.readFileSync(privatePath));
      assert.deepEqual(parser.parse(raw.lines,0,raw.boxes), result.records);
    }
  }
  const list=cases[0].result;
  assert.equal(old.exports.analyze(list.lines,0,list.boxes).status,'unrecognized');
  assert.equal(old.exports.parse(list.lines,0,list.boxes).length,0);
});

test('真实OCR经过页面生成两条独立草稿；单个坏码不阻塞另一个，四类结果有明确原因', async () => {
  const list=cases[0].result, partial=JSON.parse(JSON.stringify(list));
  partial.lines[partial.lines.indexOf('313-3-3308')]='313-3-33O8';
  const wx=fakeStorage(), p=page(wx, async image=>image==='list'?list:partial);
  p.data.images=['list','partial']; await p.runRecognition(true, { shadow: true });
  assert.deepEqual(Array.from(p.data.drafts,r=>[r.code,r.station]), cases[0].expected);
  assert.equal(p.data.results[0].count,2);
  assert.equal(p.data.results[1].count,1);
  assert.equal(p.data.results[1].uncertainCount,1);
  assert.equal(p.data.results[1].parseReason,'code_found');
  assert.equal(parser.analyze([]).reason,'ocr_empty');
  assert.equal(parser.analyze(['待取件','取件码：****']).reason,'no_valid_code');
  assert.equal(parser.analyze(['添加包裹','菜鸟驿站','取件码：313-3-33O8']).reason,'candidate_unparsed');
  p.onUnload();
});

test('同结构换码换站、Unicode横杠、店铺图标；过滤电话、运单、日期和广告，不猜数字', () => {
  const c=JSON.parse(JSON.stringify(cases[0].result));
  c.lines[c.lines.indexOf('73-3-4003')]='28－6－1902';
  c.lines[c.lines.indexOf('313-3-3308')]='126–2–6841';
  c.lines[c.lines.findIndex(s=>s.includes('洗浴中心'))]='南门书店菜鸟驿站>绿色公益';
  c.lines[c.lines.findIndex(s=>s.includes('31号楼'))]='北校区18号楼东侧>绿色公益';
  assert.deepEqual(parser.parse(c.lines,0,c.boxes).map(r=>[r.code,r.station]),[
    ['28-6-1902','南门书店菜鸟驿站'],['126-2-6841','北校区18号楼东侧']]);
  const list=cases[0].result;
  const extra=['138-0013-8000','JT5538437736721','2026-10-22','广告取件码优惠','12-3-4567'];
  assert.equal(parser.parse([...list.lines,...extra],0,[...list.boxes,...extra.map((_,i)=>({x:360,y:3000+i*80,width:330,height:50}))]).length,2);
  for(const bad of ['313-3-33O8','313-3-33?8','313-3-']) {
    const only=JSON.parse(JSON.stringify(list));
    only.lines[31]=bad; only.lines[45]=bad;
    assert.equal(parser.analyze(only.lines,0,only.boxes).reason,'candidate_unparsed');
  }
  assert.equal(parser.parse(['菜鸟驿站','待取件','运单：73-3-4003']).length,0);
});
