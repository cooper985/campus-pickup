const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const cases = require('./fixtures/real-ocr-20261021.json');
const task = require('../miniprogram/services/recognition-task');
const parser = require('../miniprogram/services/pickup-parser');
const privateDir = path.resolve('test-data/private/ocr-regression-20261021');
function oldModule(version, file) {
  const module = { exports: {} };
  vm.runInNewContext(execFileSync('git', ['show', `${version}:miniprogram/services/${file}.js`], { encoding: 'utf8' }),
    { module, setTimeout, clearTimeout, Date, console: { info() {} } });
  return module.exports;
}
test('同一份真实 OCR 返回对照旧版：号码丢失和跨站误配被定位，四类边界保持正确', () => {
  const original = oldModule('7fddd4f', 'pickup-parser'), previous = oldModule('767b35d', 'pickup-parser');
  const postal = cases[2].result;
  assert.equal(original.parse(postal.lines, 0, postal.boxes)[0].code, '603402');
  assert.equal(previous.parse(postal.lines, 0, postal.boxes).length, 0);
  assert.equal(previous.parse(cases[0].result.lines, 0, cases[0].result.boxes)[2].station, '菜鸟驿站');
  for (const c of cases) {
    assert.deepEqual(parser.parse(c.result.lines, 0, c.result.boxes).map(r => [r.code, r.station]), c.expected);
    assert.ok(!c.result.lines.some(line => /\d{9,}/.test(line)), 'fixture must not contain phone or waybill numbers');
  }
  assert.equal(parser.analyze(cases[3].result.lines, 0, cases[3].result.boxes).message, '还在运输');
});
test('原图字节→真实压缩输入回放→云适配器→并发页面→草稿→保存重启，16个码均到达列表', {
  skip: !fs.existsSync(path.join(privateDir, 'prepared-01.jpg')) && 'Original private screenshots and captured preparation are required',
}, async () => {
  const wx = fakeStorage(), byImage = new Map(); let cloudCalls = 0, compressCalls = 0;
  for (const c of cases) {
    const original = fs.readFileSync(path.join(privateDir, `0${c.case}.jpg`));
    assert.equal(createHash('sha256').update(original).digest('hex'), c.imageSha256);
    const prepared = fs.readFileSync(path.join(privateDir, `prepared-0${c.case}.jpg`));
    assert.ok(prepared.length <= 512 * 1024);
    assert.equal(createHash('sha256').update(prepared).digest('hex'), c.preparedImageSha256);
    byImage.set(prepared.toString('base64'), c.result);
  }
  wx.getFileSystemManager = () => ({ getFileInfo: ({ filePath, success }) => success({size: fs.statSync(filePath).size}), readFile: ({ filePath, success }) => success({ data: fs.readFileSync(filePath).toString('base64') }) });
  wx.compressImage = ({ src, success }) => { compressCalls++; success({ tempFilePath: path.join(path.dirname(src), `prepared-${path.basename(src)}`) }); };
  wx.cloud = { callFunction: async options => {
    cloudCalls++; assert.equal(options.name, 'recognizePickup');
    assert.equal(options.config, undefined);
    const result = byImage.get(options.data.imageBase64); assert.ok(result);
    return { result };
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('miniprogram/services/cloud-ocr.js', 'utf8'), { module, wx,
    require: () => task });
  const p = page(wx, module.exports.recognize);
  p.data.images = cases.map(c => path.join(privateDir, `0${c.case}.jpg`)); await p.recognizeCloud();
  assert.equal(cloudCalls, 6); assert.equal(compressCalls, 6); assert.equal(p.data.drafts.length, 16);
  for (const c of cases) assert.deepEqual(Array.from(p.data.drafts.filter(r => r.sourceIndex === c.case - 1), r => [r.code, r.station]), c.expected);
  assert.equal(p.data.results[3].status, 'in_transit'); assert.equal(p.data.results[3].error, '');
  wx.showModal = async o => ({ confirm: o.title !== '疑似重复，请确认' });
  await p.confirmImport();
  assert.equal(page(wx).data.records.length, 15); // An unknown-place B3-4-7401 triggers duplicate review and is skipped.
});
test('11秒正常响应：767的10秒硬截止丢弃，稳定版与修复版接受；慢提示不会冒充超时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const current = oldModule('767b35d', 'recognition-task'), stable = oldModule('6e0fa55', 'recognition-task');
  let release, slow = false;
  const response = new Promise(resolve => release = resolve);
  const work = control => { control.stage('cloud_roundtrip'); return response; };
  const jobs = [current.start(work), stable.start(work), task.start(work, undefined, undefined, () => slow = true)];
  const outcomes = jobs.map(job => job.promise.then(() => 'success', err => err.code));
  t.mock.timers.tick(11000); await Promise.resolve();
  assert.equal(slow, true);
  release({ mock: false, lines: ['取件码603402'] });
  assert.deepEqual(await Promise.all(outcomes), ['WAIT_TIMEOUT', 'success', 'success']);
});
test('准备和云调用独立计时，取消及真正超时不会伪装为运输业务结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let prepared, returned;
  const prep = new Promise(resolve => prepared = resolve), cloud = new Promise(resolve => returned = resolve);
  const job = task.start(async control => { await prep; control.stage('cloud_roundtrip'); return cloud; });
  t.mock.timers.tick(14000); prepared(); await Promise.resolve();
  t.mock.timers.tick(19000); returned('success'); assert.equal(await job.promise, 'success');
  const hanging = task.start(control => { control.stage('cloud_roundtrip'); return new Promise(() => {}); });
  const stopped = hanging.promise.catch(err => err.code);
  t.mock.timers.tick(task.WAIT_TIMEOUT_MS); assert.equal(await stopped, 'WAIT_TIMEOUT');
});

test('30秒云端往返：857的22秒截止丢弃成功结果，新版接受同一响应', async t => {
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const previous=oldModule('8573b6e','recognition-task');
 let release; const response=new Promise(resolve=>release=resolve);
 const work=control=>{control.stage('cloud_roundtrip');return response;};
 const jobs=[previous.start(work),task.start(work)];
 const outcomes=jobs.map(job=>job.promise.then(value=>value,err=>err.code));
 t.mock.timers.tick(30000); await Promise.resolve(); release('success');
 assert.deepEqual(await Promise.all(outcomes),['WAIT_TIMEOUT','success']);
});

const androidCases = require('./fixtures/android-cases-20261021.json');
test('新收到的两张原图真实OCR返回：运输不生成记录，字母码与已签收并存仍保留服务站', () => {
  for (const c of androidCases) {
    const image = path.join('test-data/private/android-cases-20261021', c.case === 'jd' ? 'jd-service.jpg' : 'in-transit.jpg');
    if (fs.existsSync(image)) assert.equal(createHash('sha256').update(fs.readFileSync(image)).digest('hex'), c.imageSha256);
    assert.equal(c.result.ok, true); assert.equal(c.result.mock, false);
    const result = parser.analyze(c.result.lines, 0, c.result.boxes);
    assert.deepEqual(result.records.map(r => [r.code, r.station]), c.expected);
    assert.equal(result.message, c.case === 'jd' ? '识别到 1 件快递' : '还在运输');
    assert.equal(result.uncertainCount, 0);
    if (c.case === 'jd') assert.ok(c.result.lines.includes('已签收'));
  }
});
test('真实返回经过页面：有码、运输与请求失败分别呈现，失败不清空成功草稿也不伪装为业务状态', async () => {
  const jd = androidCases.find(c => c.case === 'jd').result, transit = androidCases.find(c => c.case === 'transit').result;
  for (const [code, message] of [['TIMEOUT','识别超时，请重试'],['NETWORK_FAILED','网络异常，请重试'],['CLOUD_FAILED','连接失败，请重试'],['OCR_FAILED','识别服务暂不可用，请重试']]) {
    const calls = [], wx = fakeStorage();
    const p = page(wx, async image => { calls.push(image); if (image === 'failed') throw {code,message:'private detail'}; return image === 'jd' ? jd : transit; });
    p.data.images = ['jd','transit','failed']; await p.recognizeCloud();
    assert.equal(p.data.results[0].message, '识别到 1 件快递'); assert.equal(p.data.results[1].message, '还在运输');
    assert.equal(p.data.results[2].error, message); assert.equal(p.data.results[2].status, code); assert.equal(p.data.results[2].retryable, true);
    assert.deepEqual(Array.from(p.data.drafts,r=>[r.code,r.station]), [['B3-4-7401','河南工业大学服务站']]);
    assert.equal(calls.length,3); assert.equal(p.data.records.length,0);
    assert.ok(p.data.results.every(r=>!r.lines && !r.boxes));
    assert.ok(!JSON.stringify(p.data.results).includes('private detail')); p.onUnload();
  }
});
