// Synthetic OCR latency replay; this measures page scheduling, not cloud or phone performance.
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const baseline = execFileSync('git', ['show', '6e0fa55:miniprogram/pages/pickup/index.js'], { encoding: 'utf8' });
const scenarios = [
  { name: 'slow-no-code', delays: [600, 200, 100], timeoutMs: 1000 },
  { name: 'first-timeout', delays: [900, 200, 100], timeoutMs: 500 },
];
async function measure(source, scenario) {
  const p = page(fakeStorage(), path => new Promise(resolve => setTimeout(() => resolve({
    mock: false, lines: path === '0' ? ['运输中'] : ['测试驿站', `取件码${path === '1' ? '2222' : '3333'}`],
  }), scenario.delays[Number(path)])), source);
  p.data.images = ['0', '1', '2']; p.recognitionTimeoutMs = scenario.timeoutMs;
  const appearedMs = {}, original = p.setData, started = performance.now();
  p.setData = function(data, callback) {
    original.call(this, data, callback);
    for (const result of this.data.results) {
      if (result.status !== 'queued' && result.state !== 'running' && !appearedMs[result.index]) {
        appearedMs[result.index] = Math.round(performance.now() - started);
      }
    }
  };
  await p.recognizeCloud();
  return { totalMs: Math.round(performance.now() - started), appearedMs,
    statuses: p.data.results.map(r => r.status), draftCount: p.data.drafts.length };
}
(async () => {
  const info = console.info; console.info = () => {};
  const results = [];
  try {
    for (const scenario of scenarios) results.push({ scenario: scenario.name, delaysMs: scenario.delays,
      timeoutMs: scenario.timeoutMs, serial: await measure(baseline, scenario), concurrent: await measure(undefined, scenario) });
  } finally { console.info = info; }
  console.log(JSON.stringify({ type: 'synthetic-latency-replay', results }, null, 2));
})();
