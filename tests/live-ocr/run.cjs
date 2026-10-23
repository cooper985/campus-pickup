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
function inventory() {
  const labels = new Map();
  for (const name of ['real-ocr-20261021', 'android-cases-20261021', 'cainiao-real-ocr-20261022', 'live-ocr-20261023']) {
    for (const c of read(path.join(root, `tests/fixtures/${name}.json`))) labels.set(c.imageSha256, { id: `${name}:${c.case}`, expected: c.expected });
  }
  const found = new Map();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && file !== privateDir) walk(file);
      else if (entry.isFile() && /\.(?:jpe?g|png)$/i.test(entry.name) && !/^prepared-/.test(entry.name)) {
        const hash = sha(fs.readFileSync(file));
        if (found.has(hash)) { found.get(hash).copies++; continue; }
        const label = labels.get(hash);
        found.set(hash, { hash, path: path.relative(root, file), copies: 1, ...(label || {}) });
      }
    }
  }
  walk(path.join(root, 'test-data'));
  const samples = [...found.values()].sort((a, b) => Number(!!b.expected) - Number(!!a.expected) || a.path.localeCompare(b.path));
  samples.forEach((s, i) => { if (!s.id) s.id = `unlabeled-${s.hash.slice(0, 12)}`; });
  const control = path.join(root, 'miniprogram/images/create_env.png');
  samples.push({ id: 'unrelated-project-asset-control', path: path.relative(root, control), hash: sha(fs.readFileSync(control)), copies: 1, expected: [], control: true });
  return samples;
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
function serve() {
  execFileSync('git', ['check-ignore', '-q', 'test-data/private/live-ocr-v23/cache/probe.json'], { cwd: root });
  const samples = inventory(), b = budget(); let active, stopped = false;
  const sourceCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  save(path.join(privateDir, 'manifest.json'), { profile, sourceCommit, samples });
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
        if (!next || !reserve(b, next.hash, next.id)) return json(200, { done: true });
        active = next;
        return json(200, { id: next.id, hash: next.hash, base64: fs.readFileSync(path.join(root, next.path)).toString('base64') });
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
    } catch (_) { return json(400, { error: 'TEST_REQUEST_FAILED' }); }
  });
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = `void wx.request({url:${JSON.stringify(url + '/bootstrap')},header:{'X-Campus-Ocr-Test':'local-run'},success:r=>{if(r.statusCode===200)new Function('wx',r.data)(wx);else console.log('[live-ocr-stop]','LOCAL_HTTP_ERROR')},fail:()=>console.log('[live-ocr-stop]','LOCAL_CONNECTION_FAILED')})`;
    fs.writeFileSync(path.join(privateDir, 'bootstrap.js'), bootstrap + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ready: true, url, uniqueScreenshots: samples.filter(s => !s.control).length, controls: 1, cached: samples.filter(s => fs.existsSync(cacheFile(s.hash))).length, firstRoundReserved: b.state.reservations.length, limit: 30 }));
  });
  return server;
}
module.exports = { inventory, reserve, budget, cacheFile, privateDir, profile, save, read, serve };
if (require.main === module) serve();
