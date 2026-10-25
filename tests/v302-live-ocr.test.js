const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, 'live-ocr/run.cjs'), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-v302-ocr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  for (const name of ['real-ocr-20261021', 'android-cases-20261021', 'cainiao-real-ocr-20261022', 'live-ocr-20261023']) {
    put(`tests/fixtures/${name}.json`, '[]');
  }
  put('miniprogram/images/create_env.png', 'synthetic control');
  const selected = Buffer.from('synthetic explicitly selected image');
  put('test-data/private/selected.png', selected);
  const sample = { id: 'selected', path: 'test-data/private/selected.png', hash: hash(selected) };
  const manifestFile = put('test-data/private/selection.json', JSON.stringify({ version: 1, samples: [sample] }));
  return { root, put, sample, manifestFile };
}

function loadTool(root, cli = false) {
  const module = { exports: {} }, calls = { servers: 0, listens: 0, logs: [] };
  const fakeRequire = name => {
    if (name === 'node:http') return { createServer(handler) {
      calls.servers++;
      calls.handler = handler;
      return { listen(port, host, ready) { calls.listens++; ready(); }, address: () => ({ port: 12345 }) };
    } };
    if (name === 'node:child_process') return { execFileSync: (file, args, options) => options && options.encoding ? 'test-head' : Buffer.from('test-head') };
    return require(name);
  };
  if (cli) fakeRequire.main = module;
  vm.runInNewContext(source, { module, exports: module.exports, require: fakeRequire,
    __dirname: path.join(root, 'tests/live-ocr'), Buffer, setTimeout, clearTimeout,
    process: { argv: ['node', 'run.cjs'], env: {}, exitCode: 0 },
    console: { log: value => calls.logs.push(value), error: value => calls.logs.push(value) } });
  return { tool: module.exports, calls };
}

async function request(calls, url, body) {
  let status, value;
  const req = { url, method: body ? 'POST' : 'GET', headers: { 'x-campus-ocr-test': 'local-run' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
  await calls.handler(req, { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } });
  return { status, value };
}

test('V302 离线样本清单只选明确路径和摘要，不扫描后来加入的私人图', t => {
  const f = fixture(t);
  f.put('test-data/private/unselected.jpg', 'synthetic unrelated private image');
  f.put('test-data/new-folder/nested.png', 'synthetic unrelated nested image');
  const { tool, calls } = loadTool(f.root);
  const samples = tool.inventory({ manifestFile: f.manifestFile });
  assert.deepEqual(Array.from(samples, s => [s.id, s.path, s.hash]), [[f.sample.id, f.sample.path, f.sample.hash]]);
  assert.equal(calls.servers, 0);
});

test('V302 显式样本被替换后摘要校验失败，不能沿用旧清单上传新图', t => {
  const f = fixture(t);
  f.put(f.sample.path, 'synthetic replacement image');
  const { tool } = loadTool(f.root);
  assert.throws(() => tool.inventory({ manifestFile: f.manifestFile }), /SAMPLE_HASH_MISMATCH/);
});

test('V302 清单拒绝越界路径与指向白名单目录外的符号链接', t => {
  const f = fixture(t);
  const outside = f.put('outside.png', 'synthetic outside image');
  f.put('test-data/private/selection.json', JSON.stringify({ version: 1, samples: [{ ...f.sample, path: 'outside.png', hash: hash(fs.readFileSync(outside)) }] }));
  const { tool } = loadTool(f.root);
  assert.throws(() => tool.inventory({ manifestFile: f.manifestFile }), /SAMPLE_PATH_INVALID/);
  fs.symlinkSync(outside, path.join(f.root, 'test-data/private/linked.png'));
  f.put('test-data/private/selection.json', JSON.stringify({ version: 1, samples: [{ ...f.sample, path: 'test-data/private/linked.png', hash: hash(fs.readFileSync(outside)) }] }));
  assert.throws(() => tool.inventory({ manifestFile: f.manifestFile }), /SAMPLE_PATH_INVALID/);
});

test('V302 serve 必须同时显式允许真实运行并指定清单，拒绝时不启动服务', t => {
  const f = fixture(t), { tool, calls } = loadTool(f.root);
  assert.throws(() => tool.serve({ manifestFile: f.manifestFile }), /LIVE_NOT_AUTHORIZED/);
  assert.throws(() => tool.serve({ allowLive: true }), /MANIFEST_REQUIRED/);
  assert.equal(calls.servers, 0);
  assert.equal(calls.listens, 0);
});

test('V302 默认命令行仅显示离线用法，不创建 bridge、bootstrap 或预算文件', t => {
  const f = fixture(t), { calls } = loadTool(f.root, true);
  assert.equal(calls.servers, 0);
  assert.equal(calls.listens, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'test-data/private/live-ocr-v23/bootstrap.js')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'test-data/private/live-ocr-v23/round-1-budget.json')), false);
});

test('V302 HTTP替身：启动校验后换图也不能发送或预留真实调用', async t => {
  const f = fixture(t), { tool, calls } = loadTool(f.root);
  tool.serve({ allowLive: true, manifestFile: f.manifestFile });
  f.put(f.sample.path, 'synthetic replacement after startup');
  const response = await request(calls, '/next');
  assert.equal(response.status, 400);
  assert.equal(response.value.base64, undefined);
  assert.equal(tool.budget().state.reservations.length, 0);
  assert.equal((await request(calls, '/next')).value.done, true);
});

test('V302 HTTP替身：清理未确认就停止下一张，保留原预算协议', async t => {
  const f = fixture(t), second = Buffer.from('synthetic second approved image');
  f.put('test-data/private/second.png', second);
  f.put('test-data/private/selection.json', JSON.stringify({ version: 1, samples: [f.sample,
    { id: 'second', path: 'test-data/private/second.png', hash: hash(second) }] }));
  const { tool, calls } = loadTool(f.root);
  tool.serve({ allowLive: true, manifestFile: f.manifestFile });
  const next = await request(calls, '/next');
  assert.equal(next.status, 200);
  const saved = await request(calls, '/result', { hash: next.value.hash,
    result: { ok: true, mock: false, lines: [] }, report: { cleanupPending: true, timings: {}, ocrCalls: 1 } });
  assert.equal(saved.status, 200);
  assert.equal((await request(calls, '/next')).value.done, true);
  const ledger = tool.budget().state;
  assert.equal(ledger.profile, tool.profile);
  assert.equal(ledger.limit, 30);
  assert.equal(ledger.reservations.length, 1);
  assert.equal(ledger.reservations[0].status, 'completed');
});
