const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');

test('首轮检查点不融合未处理来源；旧回执仍补齐已处理的融合来源', () => {
  const fusion = require('../miniprogram/services/candidate-fusion');
  let calls = 0;
  const p = page(fakeStorage(), undefined, undefined, { 'candidate-fusion': {
    fuse(...args) { calls++; return fusion.fuse(...args); },
  } });
  try {
    const candidates = [0, 1].map(sourceIndex => ({ id: `source-${sourceIndex}`, sourceIndex,
      code: 'A1-2-3456', station: '北门驿站', waybillNumber: 'SF123456789012' }));
    const batch = { handledSources: [], outcomes: [], images: candidates.map(c => ({ candidates: [c] })) };
    calls = 0;
    assert.deepEqual(Array.from(p.handledBatchSources(batch)), []);
    assert.equal(calls, 0);
    batch.outcomes.push({ id: 'source-0', decision: 'AUTO_IMPORT' });
    assert.deepEqual(Array.from(p.handledBatchSources(batch)).sort(), ['source-0', 'source-1']);
    assert.equal(calls, 1);
  } finally { p.onUnload(); }
});

// Only virtual time and synthetic responses: these numbers do not measure Tencent OCR.
function simulation(concurrency) {
  let now = 0, sequence = 0;
  const timers = new Map();
  const clock = {
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { info() {} },
  };
  const load = (file, require) => {
    const module = { exports: {} };
    let source = fs.readFileSync(`miniprogram/services/${file}.js`, 'utf8');
    if (file === 'recognition-queue') source = source.replace(/const MAX_CONCURRENCY = \d+;/, `const MAX_CONCURRENCY = ${concurrency};`);
    vm.runInNewContext(source, { module, require, ...clock });
    return module.exports;
  };
  const task = load('recognition-task');
  const queue = load('recognition-queue', () => task).createQueue();
  const starts = [], ends = [], outcomes = [], executions = new Map();
  let active = 0, peak = 0;
  const add = (id, duration, { fail = false, timeoutMs } = {}) => {
    const job = queue.add(async control => {
      executions.set(id, (executions.get(id) || 0) + 1);
      peak = Math.max(peak, ++active);
      control.stage('cloud_roundtrip');
      await new Promise(resolve => clock.setTimeout(resolve, duration));
      active--;
      ends.push({ id, at: now });
      control.check();
      if (fail) throw task.error('NETWORK_FAILED');
      return id;
    }, { timeoutMs, onStart: () => starts.push({ id, at: now }) });
    job.promise.then(value => outcomes.push({ id, at: now, value }), err => outcomes.push({ id, at: now, error: err.code }));
    return job;
  };
  // setImmediate allows the complete Promise chain to drain before advancing time.
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const advance = async target => {
    await flush();
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    now = target;
    await flush();
  };
  return { add, advance, starts, ends, outcomes, executions, get peak() { return peak; }, get active() { return active; } };
}

async function benchmark(concurrency, durations) {
  const run = simulation(concurrency);
  durations.forEach((duration, id) => run.add(id, duration));
  await run.advance(durations.reduce((sum, duration) => sum + duration, 0));
  assert.equal(run.outcomes.length, durations.length);
  assert.equal(run.peak, Math.min(concurrency, durations.length));
  assert.ok([...run.executions.values()].every(count => count === 1));
  // Every queued task starts exactly when a physical slot becomes available.
  const freeSlots = [...run.ends].sort((a, b) => a.at - b.at);
  run.starts.slice(concurrency).forEach((start, i) => assert.equal(start.at, freeSlots[i].at));
  return {
    totalMs: Math.max(...run.outcomes.map(outcome => outcome.at)),
    meanQueueMs: Math.round(run.starts.reduce((sum, start) => sum + start.at, 0) / durations.length),
  };
}

test('离线并发 3/4/5/6：1/3/6/9 张及快慢混合，物理槽及时补位且每图只执行一次', async t => {
  const scenarios = [1, 3, 6, 9].map(count => ({ name: `${count} 张等时`, durations: Array(count).fill(1000) }));
  scenarios.push({ name: '9 张混合', durations: [900, 100, 200, 800, 150, 300, 700, 250, 400] });
  for (const scenario of scenarios) {
    const row = { scenario: scenario.name };
    for (const concurrency of [3, 4, 5, 6]) row[concurrency] = await benchmark(concurrency, scenario.durations);
    assert.ok(row[4].totalMs <= row[3].totalMs);
    assert.ok(row[5].totalMs <= row[4].totalMs);
    assert.ok(row[6].totalMs <= row[5].totalMs);
    t.diagnostic(JSON.stringify(row));
  }
});

test('离线失败立即补位；超时仍占物理槽；手动重试不突破并发或重复执行', async () => {
  for (const concurrency of [3, 4, 5, 6]) {
    const run = simulation(concurrency);
    run.add('failed', 100, { fail: true });
    run.add('timed-out', 500, { timeoutMs: 50 });
    for (let i = 2; i < concurrency; i++) run.add(`slow-${i}`, 800);
    run.add('following', 100);
    await run.advance(50);
    assert.equal(run.outcomes.find(item => item.id === 'timed-out').error, 'WAIT_TIMEOUT');
    assert.equal(run.starts.length, concurrency, 'a UI timeout cannot release an outstanding physical request');
    run.add('retry', 100);
    await run.advance(100);
    assert.equal(run.outcomes.find(item => item.id === 'failed').error, 'NETWORK_FAILED');
    assert.equal(run.starts.find(item => item.id === 'following').at, 100);
    await run.advance(800);
    assert.equal(run.starts.find(item => item.id === 'retry').at, 200);
    assert.equal(run.peak, concurrency);
    assert.equal(run.outcomes.length, concurrency + 2);
    assert.equal(run.outcomes.filter(item => item.id === 'timed-out').length, 1, 'late result cannot settle twice');
    assert.ok([...run.executions.values()].every(count => count === 1));
  }
});

test('离线取消：排队任务不执行，运行任务结束前不超发，取消整批后不启动剩余图', async () => {
  for (const concurrency of [3, 4, 5, 6]) {
    const run = simulation(concurrency);
    const jobs = Array.from({ length: 9 }, (_, id) => run.add(id, 500));
    await run.advance(10);
    jobs.forEach(job => job.cancel());
    await run.advance(10);
    assert.equal(run.outcomes.length, 9);
    assert.ok(run.outcomes.every(item => item.error === 'CANCELLED'));
    assert.equal(run.starts.length, concurrency);
    assert.equal(run.active, concurrency);
    await run.advance(1000);
    assert.equal(run.active, 0);
    assert.equal(run.starts.length, concurrency);
    assert.equal(run.peak, concurrency);
  }
});

test('完成顺序改变：完整融合后才写入，相同截图和持久缓存跳过 OCR，重导不重复入库', async () => {
  const responses = {
    partial: { mock: false, lines: ['取件码 B3-4-7401', '运单号 SF123456789012'] },
    complete: { mock: false, lines: ['河南工业大学服务站', '取件码 B3-4-7401', '运单号 SF123456789012'] },
    other: { mock: false, lines: ['西门服务站', '取件码 C205-2004'] },
  };
  const results = [];
  for (const order of [['partial', 'other', 'complete'], ['complete', 'partial', 'other']]) {
    const wx = fakeStorage(), releases = {}, calls = [];
    wx.getFileInfo = ({ filePath, success }) => success({ size: 100, digest: ({ partial: 1, complete: 2, other: 3, duplicate: 2 }[filePath]).toString(16).padStart(40, '0') });
    const p = page(wx, path => { calls.push(path); return new Promise(resolve => { releases[path] = () => resolve(responses[path]); }); });
    p.data.images = ['partial', 'complete', 'other', 'duplicate'];
    const importing = p.recognizeCloud();
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < order.length; i++) {
      releases[order[i]]();
      await new Promise(resolve => setImmediate(resolve));
      if (i < order.length - 1) assert.equal(p.data.records.length, 0);
    }
    await importing;
    assert.equal(calls.length, 3);
    assert.equal(p.data.records.length, 2);
    results.push(Array.from(p.data.records, record => [record.code, record.station]).sort());
    await p.recognizeCloud();
    assert.equal(calls.length, 3);
    assert.equal(p.data.records.length, 2);
    p.onUnload();
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], [['B3-4-7401', '河南工业大学服务站'], ['C205-2004', '西门服务站']]);
});
