const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const privateDir = path.join(root, 'test-data/private/live-ocr-v23');
const profile = 'GeneralBasicOCR-v20181119-fileid-512kb-quality70-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
}
const controlPath = 'miniprogram/images/create_env.png';
function sampleBytes(sample) {
  if (!sample || typeof sample.path !== 'string' || !/^[a-f0-9]{64}$/.test(sample.hash)) throw Error('MANIFEST_INVALID');
  const relative = sample.path.replace(/\\/g, '/');
  if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.split('/').includes('..') ||
      (!relative.startsWith('test-data/') && relative !== controlPath) || !/\.(?:jpe?g|png)$/i.test(relative)) throw Error('SAMPLE_PATH_INVALID');
  const realRoot = fs.realpathSync(root), file = fs.realpathSync(path.join(root, relative));
  const allowed = relative === controlPath ? file === path.join(realRoot, controlPath) : file.startsWith(path.join(realRoot, 'test-data') + path.sep);
  if (!allowed || !fs.statSync(file).isFile()) throw Error('SAMPLE_PATH_INVALID');
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== sample.hash) throw Error('SAMPLE_HASH_MISMATCH');
  return bytes;
}
function inventory(options = {}) {
  // Historical manifests are read only for offline replay; live runs require an explicit selection.
  const manifestFile = options.manifestFile || path.join(privateDir, 'manifest.json');
  if (!options.manifestFile && !fs.existsSync(manifestFile)) return [];
  const manifest = read(manifestFile);
  if (!manifest || manifest.version !== undefined && manifest.version !== 1 || !Array.isArray(manifest.samples)) throw Error('MANIFEST_INVALID');
  const labels = new Map();
  for (const name of ['real-ocr-20261021', 'android-cases-20261021', 'cainiao-real-ocr-20261022', 'live-ocr-20261023']) {
    for (const c of read(path.join(root, `tests/fixtures/${name}.json`))) labels.set(c.imageSha256, { id: `${name}:${c.case}`, expected: c.expected });
  }
  const found = new Map();
  for (const sample of manifest.samples) {
    sampleBytes(sample);
    if (found.has(sample.hash)) { found.get(sample.hash).copies++; continue; }
    const relative = sample.path.replace(/\\/g, '/'), control = relative === controlPath;
    const label = labels.get(sample.hash);
    found.set(sample.hash, { hash: sample.hash, path: relative, copies: 1,
      id: control ? 'unrelated-project-asset-control' : typeof sample.id === 'string' && sample.id || `unlabeled-${sample.hash.slice(0, 12)}`,
      ...(label || {}), ...(control ? { expected: [], control: true } : {}) });
  }
  return [...found.values()].sort((a, b) => Number(!!b.expected) - Number(!!a.expected) || a.path.localeCompare(b.path));
}
function cacheFile(hash) { return path.join(privateDir, 'cache', `${profile}-${hash}.json`); }
function budget() {
  const file = path.join(privateDir, 'round-1-budget.json');
  const state = fs.existsSync(file) ? read(file) : { version: 1, limit: 30, profile, reservations: [] };
  if (state.limit !== 30 || state.profile !== profile || !Array.isArray(state.reservations) || state.reservations.length > 30) throw Error('BUDGET_INVALID');
  return { file, state };
}
function reserve(b, hash, id) {
  if (b.state.reservations.some(r => r.hash === hash) || b.state.reservations.length >= b.state.limit) return false;
  b.state.reservations.push({ hash, id, issuedAt: Date.now(), status: 'reserved' }); save(b.file, b.state); return true;
}
function serve(options = {}) {
  if (options.allowLive !== true) throw Error('LIVE_NOT_AUTHORIZED');
  if (typeof options.manifestFile !== 'string' || !options.manifestFile) throw Error('MANIFEST_REQUIRED');
  execFileSync('git', ['check-ignore', '-q', 'test-data/private/live-ocr-v23/cache/probe.json'], { cwd: root });
  const samples = inventory(options), b = budget(); let active, stopped = false;
  const sourceCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  save(path.join(privateDir, 'last-live-manifest.json'), { profile, sourceCommit, samples });
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers['x-campus-ocr-test'] !== 'local-run' || req.method === 'OPTIONS') return json(403, { error: 'LOCAL_ONLY' });
    try {
      if (req.url === '/bootstrap' && req.method === 'GET') {
        const code = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
        const probe = fs.readFileSync(path.join(root, 'miniprogram/services/storage-probe.js'), 'utf8');
        const body = code + `\nvoid runLiveOcr(${JSON.stringify(`http://127.0.0.1:${server.address().port}`)}, ${JSON.stringify(probe)}, 'cloud1-d8g3dicam66594fcf').catch(()=>console.log('[live-ocr-stop]','LOCAL_RUN_FAILED'));`;
        return json(200, body);
      }
      if (req.url === '/next' && req.method === 'GET') {
        if (stopped || active) return json(200, { done: true });
        const next = samples.find(s => !fs.existsSync(cacheFile(s.hash)) && !b.state.reservations.some(r => r.hash === s.hash));
        if (!next) return json(200, { done: true });
        const bytes = sampleBytes(next); // Recheck the selected bytes immediately before reserving and sending.
        if (!reserve(b, next.hash, next.id)) return json(200, { done: true });
        active = next;
        return json(200, { id: next.id, hash: next.hash, base64: bytes.toString('base64') });
      }
      if (req.method !== 'POST' || !['/result', '/finish'].includes(req.url)) return json(404, { error: 'NOT_FOUND' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 3 * 1024 * 1024) throw Error('RESPONSE_TOO_LARGE'); }
      const value = JSON.parse(body);
      if (req.url === '/finish') {
        const file = path.join(privateDir, 'completion.json'), historyFile = path.join(privateDir, 'runs.json');
        const previous = fs.existsSync(historyFile) ? read(historyFile) : fs.existsSync(file) ? [read(file)] : [];
        const finished = { processed: value.processed, formalStorageUnchanged: value.formalStorageUnchanged === true, finishedAt: Date.now() };
        save(file, finished); save(historyFile, [...previous, finished]); stopped = true; return json(200, { ok: true });
      }
      if (!active || active.hash !== value.hash || !value.report || value.result && (value.result.ok !== true || value.result.mock !== false || !Array.isArray(value.result.lines))) return json(400, { error: 'INVALID_RESULT' });
      save(cacheFile(active.hash), { version: 1, profile, sourceHash: active.hash, capturedAt: Date.now(), hash: value.hash, report: value.report, ...(value.result ? { result: value.result } : {}) });
      const reservation = b.state.reservations.find(r => r.hash === active.hash); reservation.status = 'completed'; save(b.file, b.state);
      console.log(JSON.stringify({ id: active.id, ok: !!value.result, error: value.report.error || '', ocrMs: value.report.timings.ocrMs || null, totalMs: value.report.timings.totalMs || null, confirmedOcrCalls: value.report.ocrCalls || 0, cleanupPending: !!value.report.cleanupPending }));
      stopped = !!value.report.cleanupPending || /OCR_AUTH|FORBIDDEN|UNAUTHORIZED|CONFIG_ERROR/.test(value.report.error || ''); active = null;
      return json(200, { ok: true });
    } catch (_) { stopped = true; return json(400, { error: 'TEST_REQUEST_FAILED' }); }
  });
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = `void wx.request({url:${JSON.stringify(url + '/bootstrap')},header:{'X-Campus-Ocr-Test':'local-run'},success:r=>{if(r.statusCode===200)new Function('wx',r.data)(wx);else console.log('[live-ocr-stop]','LOCAL_HTTP_ERROR')},fail:()=>console.log('[live-ocr-stop]','LOCAL_CONNECTION_FAILED')})`;
    fs.writeFileSync(path.join(privateDir, 'bootstrap.js'), bootstrap + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ready: true, url, uniqueScreenshots: samples.filter(s => !s.control).length, controls: samples.filter(s => s.control).length, cached: samples.filter(s => fs.existsSync(cacheFile(s.hash))).length, firstRoundReserved: b.state.reservations.length, limit: 30 }));
  });
  return server;
}
module.exports = { inventory, reserve, budget, cacheFile, privateDir, profile, save, read, serve };
if (require.main === module) {
  const args = process.argv.slice(2), index = args.indexOf('--manifest');
  const manifestFile = index < 0 ? undefined : args[index + 1];
  try {
    if (args.includes('--allow-live')) serve({ allowLive: true, manifestFile });
    else if (manifestFile) {
      const samples = inventory({ manifestFile });
      console.log(JSON.stringify({ offline: true, samples: samples.length, controls: samples.filter(s => s.control).length }));
    } else console.log('Offline by default. Inspect: node tests/live-ocr/run.cjs --manifest <private-selection.json>. Live bridge requires --allow-live and --manifest.');
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'LIVE_OCR_START_FAILED'); process.exitCode = 1; }
}
