const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fakeStorage } = require('./helpers/storage');
const { CLOUD_ENV } = require('../miniprogram/services/recognition-task');

const root = path.resolve(__dirname, '..');
const files = ['storage-probe', 'fileid-ocr', 'recognition-task', 'recognition-queue', 'image-dedup'];
const old = Object.fromEntries([...files.map(name => `miniprogram/services/${name}.js`), 'miniprogram/pages/pickup/index.js']
  .map(file => [file, execFileSync('git', ['show', `c356e5f:${file}`], { cwd: root, encoding: 'utf8' })]));
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const reply = (code, station = '大学服务站', extra = []) => ({ ok: true, mock: false,
  lines: [station, `取件码${code}`, ...extra].filter(Boolean), timings: { ocrMs: 500 } });

// Deterministic delays exercise the actual adapters and queue; no files or network are accessed.
function harness(baseline = false, options = {}) {
  let now = 1792972800000, sequence = 0;
  const timers = new Map(), uploaded = new Map(), modules = {};
  const metrics = { checks: 0, stats: 0, compressions: 0, uploads: 0, calls: 0,
    finished: 0, resultBytes: 0, fullResults: 0, recordRefreshes: 0, preparedPaths: [] };
  const setTimer = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  class ClockDate extends Date { static now() { return now; } }
  const delay = ms => new Promise(resolve => setTimer(resolve, ms));
  const originalPath = file => file.replace(/^prepared:/, '');
  const imageSize = file => file.startsWith('prepared:') ? 300000 : options.sizes?.[file] || 100000;
  const prefix = `cloud://${CLOUD_ENV}.test-bucket/ocr-probe/test-user/`;
  const wx = fakeStorage();
  wx.getFileInfo = ({ filePath, success }) => success({ size: imageSize(filePath),
    digest: String(options.hashes?.[filePath] || filePath).split('').reduce((n, c) => n * 31n + BigInt(c.charCodeAt(0)), 1n).toString(16).slice(-40).padStart(40, '0') });
  wx.getFileSystemManager = () => ({ getFileInfo({ filePath, success }) {
    metrics.stats++; setTimer(() => success({ size: imageSize(filePath) }), 20);
  } });
  wx.compressImage = ({ src, quality, success }) => {
    assert.equal(quality, 70); metrics.compressions++;
    setTimer(() => success({ tempFilePath: `prepared:${src}` }), 80);
  };
  wx.cloud = {
    async uploadFile({ cloudPath, filePath }) {
      metrics.uploads++; metrics.preparedPaths.push(filePath);
      await delay(180);
      const fileID = prefix + cloudPath.split('/').pop();
      uploaded.set(fileID, filePath); return { fileID };
    },
    async callFunction({ data }) {
      if (data.check) {
        metrics.checks++; await delay(120);
        return { result: options.preflightError ? { protocol: 1, ok: false, error: { code: 'CONFIG_ERROR' } }
          : { protocol: 1, ok: true, openid: 'test-user', filePrefix: prefix } };
      }
      assert.equal(data.action, 'recognizeFile'); assert.ok(!('imageBase64' in data));
      metrics.calls++;
      const file = uploaded.get(data.fileID), source = originalPath(file);
      await delay(options.callDelays?.[source] ?? 600);
      const response = options.responses?.[source] || reply(`A${source.replace(/\D/g, '') || '0'}-1000`);
      if (options.failOnce?.has(source)) { options.failOnce.delete(source); throw { code: 'NETWORK_FAILED' }; }
      uploaded.delete(data.fileID); metrics.finished++;
      return { result: { protocol: 1, ok: true, readSucceeded: true, serverDeleted: true,
        imageBytes: imageSize(file), readMs: 20, deleteMs: 10, ocr: response } };
    },
    async deleteFile({ fileList }) { fileList.forEach(id => uploaded.delete(id)); return { fileList: [{ status: 0 }] }; },
  };
  function load(file, extra = {}) {
    const module = { exports: {} };
    vm.runInNewContext(baseline ? old[file] : fs.readFileSync(path.join(root, file), 'utf8'), {
      module, exports: module.exports, wx, Date: ClockDate, setTimeout: setTimer, clearTimeout: clearTimer,
      console: { info() {} }, require: name => modules[path.basename(name)] || require(path.join(root, 'miniprogram/services', path.basename(name))), ...extra,
    }, { filename: file });
    return module.exports;
  }
  for (const name of ['recognition-task', 'recognition-queue', 'image-dedup', 'storage-probe', 'fileid-ocr']) {
    modules[name] = load(`miniprogram/services/${name}.js`);
  }
  let p;
  load('miniprogram/pages/pickup/index.js', { Page: value => { p = value; } });
  p.setData = function(data, callback) {
    const resultPatch = Object.fromEntries(Object.entries(data).filter(([key]) => /^results(?:\[|$)/.test(key)));
    if (Object.keys(resultPatch).length) metrics.resultBytes += Buffer.byteLength(JSON.stringify(resultPatch));
    if ('results' in data) metrics.fullResults++;
    for (const [key, value] of Object.entries(data)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
    if (callback) callback();
  };
  p.onLoad();
  const refreshRecords = p.updateRecords;
  p.updateRecords = function(...args) { metrics.recordRefreshes++; return refreshRecords.apply(this, args); };
  async function finish(promise) {
    let done = false, result, failure;
    Promise.resolve(promise).then(value => { done = true; result = value; }, err => { done = true; failure = err; });
    for (let guard = 0; !done && guard < 10000; guard++) {
      await tick();
      if (done) break;
      const next = Math.min(...[...timers.values()].map(timer => timer.at));
      assert.ok(Number.isFinite(next), 'synthetic operation stalled without a timer');
      now = next;
      for (const [id, timer] of [...timers]) if (timer.at === next) { timers.delete(id); timer.fn(); }
    }
    assert.equal(done, true, 'synthetic operation must finish');
    if (failure) throw failure;
    return result;
  }
  return { p, wx, metrics, fileid: modules['fileid-ocr'], storage: modules['storage-probe'],
    finish, now: () => now, files: uploaded, async batch(paths) {
      p.data.images = paths; const start = now; await finish(p.recognizeCloud()); return now - start;
    } };
}

test('fileID 合成延迟基线：1/3/6/9 图复用批次预检、小图只 stat 一次，OCR 次数不变', async t => {
  const rows = [];
  for (const count of [1, 3, 6, 9]) {
    const paths = Array.from({ length: count }, (_, i) => `p${i}`), before = harness(true), after = harness();
    const oldMs = await before.batch(paths), newMs = await after.batch(paths);
    assert.equal(before.metrics.checks, count); assert.equal(after.metrics.checks, 1);
    assert.equal(before.metrics.stats, count * 2); assert.equal(after.metrics.stats, count);
    for (const h of [before, after]) {
      assert.equal(h.metrics.uploads, count); assert.equal(h.metrics.calls, count);
      assert.equal(h.p.data.records.length, count); assert.equal(h.files.size, 0);
    }
    assert.equal(oldMs, Math.ceil(count / 3) * 940);
    assert.equal(newMs, 120 + Math.ceil(count / 3) * 800);
    assert.ok(after.metrics.resultBytes < before.metrics.resultBytes);
    assert.equal(after.wx.writes.filter(key => key === 'campus-pickup.records').length,
      before.wx.writes.filter(key => key === 'campus-pickup.records').length, 'recovery checkpoints must still be persisted');
    assert.ok(after.metrics.recordRefreshes < before.metrics.recordRefreshes);
    rows.push({ count, oldMs, newMs, oldChecks: before.metrics.checks, newChecks: after.metrics.checks,
      oldResultBytes: before.metrics.resultBytes, newResultBytes: after.metrics.resultBytes,
      oldFullResults: before.metrics.fullResults, newFullResults: after.metrics.fullResults,
      oldRecordRefreshes: before.metrics.recordRefreshes, newRecordRefreshes: after.metrics.recordRefreshes });
    before.p.onUnload(); after.p.onUnload();
  }
  t.diagnostic(JSON.stringify({ simulatedOnly: true, delaysMs: { check: 120, stat: 20, upload: 180, call: 600 }, rows }));
});

test('fileID 合成大小混合：大图保持 quality 70 和压缩后体积检查，结果与旧版一致', async () => {
  const options = { sizes: { p0: 100000, p1: 700000, p2: 900000 } };
  const before = harness(true, options), after = harness(false, options);
  await before.batch(['p0', 'p1', 'p2']); await after.batch(['p0', 'p1', 'p2']);
  assert.equal(before.metrics.stats, 6); assert.equal(after.metrics.stats, 5);
  assert.equal(after.metrics.compressions, 2);
  assert.deepEqual(after.metrics.preparedPaths, ['p0', 'prepared:p1', 'prepared:p2']);
  assert.deepEqual(plain(after.p.data.records.map(r => [r.code, r.station])), plain(before.p.data.records.map(r => [r.code, r.station])));
  before.p.onUnload(); after.p.onUnload();
});

test('fileID 同批预检失败只检查一次，不读图不上传；下一批重新检查', async () => {
  const h = harness(false, { preflightError: true });
  await h.batch(Array.from({ length: 9 }, (_, i) => `p${i}`));
  assert.equal(h.metrics.checks, 1); assert.equal(h.metrics.stats, 0);
  assert.equal(h.metrics.uploads, 0); assert.equal(h.metrics.calls, 0);
  assert.ok(h.p.data.results.every(r => r.status === 'CONFIG_ERROR'));
  await h.batch(['p0']); assert.equal(h.metrics.checks, 2);
  h.p.onUnload();
});

test('fileID 首图预检时取消不影响共享预检的其他图，取消图不读图不上传', async () => {
  const h = harness(), session = {};
  let cancelled = false;
  const first = h.fileid.recognize('p0', { check() { if (cancelled) throw { code: 'CANCELLED' }; }, stage() {} }, session);
  const second = h.fileid.recognize('p1', { check() {}, stage() {} }, session);
  await tick(); cancelled = true;
  const results = await h.finish(Promise.allSettled([first, second]));
  assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'CANCELLED');
  assert.equal(results[1].status, 'fulfilled'); assert.equal(h.metrics.checks, 1);
  assert.equal(h.metrics.stats, 1); assert.equal(h.metrics.uploads, 1); assert.equal(h.metrics.calls, 1);
  h.p.onUnload();
});

test('fileID 准备期间取消：不再压缩或复查压缩图，不上传也不调用 OCR', async () => {
  for (const phase of ['stat', 'compress']) {
    const h = harness(false, { sizes: { p0: 700000 } });
    let cancelled = false;
    if (phase === 'stat') {
      const manager = h.wx.getFileSystemManager();
      h.wx.getFileSystemManager = () => ({ getFileInfo(args) {
        manager.getFileInfo({ ...args, success(value) { cancelled = true; args.success(value); } });
      } });
    } else {
      const compress = h.wx.compressImage;
      h.wx.compressImage = args => compress({ ...args, success(value) { cancelled = true; args.success(value); } });
    }
    const running = h.fileid.recognize('p0', {
      check() { if (cancelled) throw { code: 'CANCELLED' }; }, stage() {},
    });
    await assert.rejects(h.finish(running), err => err.code === 'CANCELLED');
    assert.equal(h.metrics.stats, 1);
    assert.equal(h.metrics.compressions, phase === 'compress' ? 1 : 0);
    assert.equal(h.metrics.uploads, 0); assert.equal(h.metrics.calls, 0);
    h.p.onUnload();
  }
});

test('fileID 缓存与同批重复图跳过云链路，失败手动重试和新批次重新预检', async () => {
  const h = harness(false, { hashes: { partial: 1, same: 1, full: 2, bad: 3, next: 4 }, failOnce: new Set(['bad']), responses: {
    partial: reply('B3-4-7401', '', ['运单号：SF123456789012']),
    full: reply('B3-4-7401', '河南工业大学服务站', ['运单号：SF123456789012']),
    bad: reply('3333'), next: reply('4444'),
  } });
  await h.batch(['partial', 'same', 'full', 'bad']);
  assert.equal(h.metrics.checks, 1); assert.equal(h.metrics.uploads, 3); assert.equal(h.metrics.calls, 3);
  assert.equal(h.p.data.records.length, 1); assert.equal(h.p.data.records[0].station, '河南工业大学服务站');
  assert.equal(h.p.data.results[1].status, 'duplicate');
  await h.finish(h.p.retryImage({ currentTarget: { dataset: { index: 4 } } }));
  assert.equal(h.metrics.checks, 2); assert.equal(h.metrics.calls, 4); assert.equal(h.p.data.records.length, 2);
  await h.batch(['partial', 'same', 'full', 'bad']);
  assert.equal(h.metrics.checks, 2); assert.equal(h.metrics.calls, 4); assert.equal(h.metrics.uploads, 4);
  assert.equal(h.p.data.records.length, 2);
  await h.batch(['next']); assert.equal(h.metrics.checks, 3); assert.equal(h.metrics.calls, 5);
  h.p.onUnload();
});

test('fileID 九图完成顺序变化仍完整融合后落盘，站点和身份不受并发影响', async () => {
  const snapshots = [];
  for (const reverse of [false, true]) {
    const paths = Array.from({ length: 9 }, (_, i) => `p${i}`);
    const h = harness(false, { callDelays: Object.fromEntries(paths.map((name, i) => [name, (reverse ? 9 - i : i + 1) * 100])), responses: {
      p0: reply('B3-4-7401', '', ['运单号：SF123456789012']),
      p1: reply('B3-4-7401', '河南工业大学服务站', ['运单号：SF123456789012']),
    } });
    const write = h.wx.setStorageSync;
    h.wx.setStorageSync = function(key, value) {
      if (key === 'campus-pickup.records' && value.records.length) assert.equal(h.metrics.finished, 9, 'all images must finish before final records are written');
      return write.call(this, key, value);
    };
    await h.batch(paths);
    assert.equal(h.metrics.calls, 9); assert.equal(h.metrics.checks, 1);
    assert.equal(h.p.data.records.length, 8);
    assert.equal(h.p.data.records.find(r => r.code === 'B3-4-7401').station, '河南工业大学服务站');
    assert.equal(h.p.data.exceptionCount, 0);
    snapshots.push(plain(h.p.data.records.map(r => [r.code, r.station, r.taken]).sort()));
    h.p.onUnload();
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
});
