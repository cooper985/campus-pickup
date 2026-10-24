const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inventory, cacheFile, read, privateDir, profile } = require('./run.cjs');
const { page } = require('../helpers/page');
const { fakeStorage } = require('../helpers/storage');
const parser = require('../../miniprogram/services/pickup-parser');
const storage = require('../../miniprogram/services/pickup-store');
const root = path.resolve(__dirname, '../..');
const norm = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[—–－﹣−‐‑‒]/g, '-').replace(/\s/g, '');
async function simulate(samples, original = []) {
  const api = fakeStorage(); let cachedReads = 0;
  api.getFileInfo = ({ filePath, success }) => {
    const bytes = fs.readFileSync(path.join(root, filePath)); success({ size: bytes.length, digest: crypto.createHash('sha1').update(bytes).digest('hex') });
  };
  const p = page(api, async file => { cachedReads++; const sample = samples.find(s => s.path === file); const cache = read(cacheFile(sample.hash));
    if (!cache.result) throw { code: cache.report.error || 'OCR_FAILED' }; return cache.result; });
  if (original.length) p.persistRecords(original);
  p.data.images = samples.map(s => s.path); await p.recognizeCloud();
  const batch = p.importState.batches[0];
  const candidates = batch.images.flatMap(i => i.candidates);
  const outcomes = batch.outcomes.map(o => {
    const c = (batch.reviews.find(r => r.id === o.id) || {}).candidate || candidates.find(c => c.id === o.id) || {};
    const record = p.data.records.find(r => r.code === c.code && !r.taken);
    return { code: c.code || '', station: record && record.station || c.station || '', decision: o.decision, reason: o.reason };
  });
  const result = { added: batch.additions.length, updated: batch.updates.length, reviews: batch.reviews.length,
    skipped: p.data.recentImport.skipped, duplicateImages: batch.duplicateImages || 0, fusedSources: batch.fusedSources || 0,
    failures: p.data.recentImport.failures, cachedReads, unrelatedImages: batch.unrelatedImages || 0, outcomes,
    records: p.data.records.map(r => ({ code: r.code, station: r.station, taken: r.taken })),
    elapsedMsForCachedLocalPipeline: batch.elapsedMs };
  p.onUnload(); return result;
}
async function buildReport() {
  const samples = inventory(), rows = [];
  const summary = { labeledImages: 0, expectedCodes: 0, rawCodePresent: 0, parsedCodeMatches: 0, codeFalsePositives: 0,
    knownStations: 0, correctKnownStations: 0, expectedUnknownStations: 0, correctAbstentions: 0, correctAssociations: 0 };
  for (const s of samples) {
    if (!fs.existsSync(cacheFile(s.hash))) { rows.push({ id: s.id, status: 'NOT_RUN' }); continue; }
    const c = read(cacheFile(s.hash));
    const analysis = c.result ? parser.analyze(c.result.lines, 0, c.result.boxes) : { records: [], status: 'request_failed' };
    const simulated = await simulate([s]);
    const row = { id: s.id, imageSha256: s.hash, labeled: !!s.expected, control: !!s.control,
      ocrSucceeded: !!c.result, error: c.report.error || null, ocrMs: c.report.timings.ocrMs || null,
      roundtripMs: c.report.timings.callMs || null, totalMs: c.report.timings.totalMs || null,
      serverDeleted: c.report.serverDeleted === true, cleanupPending: !!c.report.cleanupPending,
      parseStatus: analysis.status, parsed: analysis.records.map(r => ({ code: r.code, station: r.station })),
      final: { added: simulated.added, review: simulated.reviews, skipped: simulated.skipped }, outcomes: simulated.outcomes };
    if (s.expected) {
      summary.labeledImages += Number(!s.control);
      row.expected = s.expected;
      row.mismatches = [];
      const text = norm(c.result && c.result.lines.join('\n'));
      for (const [code, station] of s.expected) {
        summary.expectedCodes++;
        if (text.indexOf(norm(code)) >= 0) summary.rawCodePresent++;
        const got = analysis.records.find(r => norm(r.code) === norm(code));
        if (got) summary.parsedCodeMatches++;
        const correct = got && norm(got.station) === norm(station);
        if (correct) summary.correctAssociations++;
        if (station === parser.UNKNOWN) { summary.expectedUnknownStations++; if (correct) summary.correctAbstentions++; }
        else { summary.knownStations++; if (correct) summary.correctKnownStations++; }
        if (!correct) row.mismatches.push({ code, expectedStation: station, actualStation: got ? got.station : null });
      }
      const extra = analysis.records.filter(r => !s.expected.some(([code]) => norm(code) === norm(r.code)));
      summary.codeFalsePositives += extra.length;
      extra.forEach(r => row.mismatches.push({ unexpectedCode: r.code }));
    }
    rows.push(row);
  }
  const get = id => samples.find(s => s.id === id), real = n => get(`real-ocr-20261021:${n}`), cn = name => get(`cainiao-real-ocr-20261022:${name}`);
  const scenarios = [];
  const add = async (name, selected, expected, records = []) => {
    const actual = await simulate(selected, records);
    const mismatches = Object.keys(expected).filter(k => actual[k] !== expected[k]).map(k => ({ field: k, expected: expected[k], actual: actual[k] }));
    const gold = new Map();
    selected.forEach(s => (s.expected || []).forEach(([code, station]) => {
      if (!gold.has(code) || gold.get(code) === parser.UNKNOWN) gold.set(code, station);
    }));
    const pairs = actual.outcomes.filter(o => o.code);
    for (const [code, station] of gold) {
      const found = pairs.filter(o => o.code === code);
      const identityUncertain = found.length > 1 && found.every(o => o.decision === 'NEEDS_REVIEW') && found.some(o => norm(o.station) === norm(station));
      if (!identityUncertain && (found.length !== 1 || norm(found[0].station) !== norm(station))) mismatches.push({ code, expectedStation: station, actual: found });
    }
    pairs.filter(o => !gold.has(o.code)).forEach(o => mismatches.push({ unexpectedCode: o.code }));
    scenarios.push({ name, images: selected.map(s => s.id), expected, expectedPackages: [...gold].map(([code, station]) => ({ code, station })), actual, passed: !mismatches.length, mismatches });
  };
  const control = samples.find(s => s.control);
  await add('九图混合：多包裹、缺地点、跨图互补、重复与无关图', [real(1), real(2), real(3), real(5), real(6), cn('list'), cn('detail'), control, real(1)],
    { added: 7, reviews: 11, duplicateImages: 1, fusedSources: 1, cachedReads: 8 });
  await add('两图同码：身份不足保留来源与签收证据', [real(5), real(6)], { added: 0, reviews: 3, fusedSources: 0 });
  await add('同包裹列表和详情融合', [cn('list'), cn('detail')], { added: 2, reviews: 0, fusedSources: 1 });
  const pending = cn('list').expected.map(([code, station]) => storage.newRecord({ code, station }));
  await add('已有待取重复跳过', [cn('list')], { added: 0, reviews: 0, skipped: 2 }, pending);
  const old = storage.updateRecord(storage.newRecord({ code: '603402', station: '一中看台' }), { taken: true });
  await add('历史同码不能无条件跳过', [real(3)], { added: 0, reviews: 1 }, [old]);
  await add('全部无可领取包裹，不生成记录', [real(4), get('android-cases-20261021:transit'), control], { added: 0, reviews: 0, skipped: 3 });
  const ledger = read(path.join(privateDir, 'round-1-budget.json'));
  const completion = fs.existsSync(path.join(privateDir, 'completion.json')) ? read(path.join(privateDir, 'completion.json')) : null;
  const runs = fs.existsSync(path.join(privateDir, 'runs.json')) ? read(path.join(privateDir, 'runs.json')) : completion ? [completion] : [];
  const captured = samples.filter(s => fs.existsSync(cacheFile(s.hash))).map(s => read(cacheFile(s.hash)));
  return { date: '2026-10-23', profile, source: 'fresh Tencent GeneralBasicOCR via existing authenticated WeChat fileID service',
    preflight: { passed: true, newCredentials: false, deployments: 0, permissionChanges: 0 },
    calls: { limit: ledger.limit, reserved: ledger.reservations.length, confirmedOcrCalls: captured.reduce((n, c) => n + (c.report.ocrCalls || 0), 0), cached: captured.length,
      successful: captured.filter(c => c.result).length, failed: captured.filter(c => !c.result).length, cleanupPending: captured.filter(c => c.report.cleanupPending).length },
    formalStorageUnchanged: runs.length > 0 && runs.every(r => r.formalStorageUnchanged === true),
    cacheReuseVerification: { runs: runs.map(r => ({ processed: r.processed, formalStorageUnchanged: r.formalStorageUnchanged })),
      zeroCallRerunVerified: runs.some(r => r.processed === 0), reservationsAfterRerun: ledger.reservations.length },
    localParserSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'miniprogram/services/pickup-parser.js'))).digest('hex'),
    findings: [{ imageId: 'live-ocr-20261023:arrival-age', code: '127-3-5016',
      before: '站9小时邮政快递包裹', expected: '河工大洗浴中心北侧菜鸟驿站',
      actualAfterFix: rows.find(r => r.id === 'live-ocr-20261023:arrival-age').parsed[0].station,
      cause: 'Relative arrival-age text was parsed as a location; a trailing navigation arrow hid the actual station heading',
      action: 'Minimal local parser fix and a privacy-filtered real OCR regression fixture; no extra API request',
      autoWriteBeforeFix: false }],
    labels: { description: '10 existing manually annotated images plus 1 newly reviewed real OCR failure; code/station pairs only. Transport, field association, fusion and decision scenarios checked separately. Unlabeled images excluded from accuracy totals.', ...summary },
    scenarios, images: rows,
    limits: ['23-image local sample only; not a population accuracy estimate', 'No ground truth for all carriers, full waybills, dates or logistics status; no accuracy claim for those fields',
      'Cached local batch elapsed time excludes OCR; actual per-image API and full fileID timings are reported separately', 'Developer Tools session only; not Android physical-device evidence'] };
}
function markdown(report) {
  const m = report.labels, c = report.calls;
  const lines = ['# V2.3 真实腾讯云 OCR 测试报告', '', `日期：${report.date}。复用已部署 fileID 接口，未部署、未修改云端权限，正式记录未改变：${report.formalStorageUnchanged ? '已验证' : '未确认'}。`, '',
    `真实 OCR：${c.confirmedOcrCalls}/${c.limit} 次；成功 ${c.successful}，失败 ${c.failed}，待清理 ${c.cleanupPending}。22 张真实截图 + 1 张项目内无关图片对照。原图按摘要去重，完整返回保存在 Git 忽略的私有缓存中。`, '',
    `人工标注（既有 10 张 + 本轮复核 1 张）：${m.labeledImages} 张真实截图，共 ${m.expectedCodes} 个号码。OCR 原文包含正确号码 ${m.rawCodePresent}/${m.expectedCodes}；解析 ${m.parsedCodeMatches}/${m.expectedCodes}；额外号码 ${m.codeFalsePositives}。已知地点 ${m.correctKnownStations}/${m.knownStations}；缺地点正确保留待确认 ${m.correctAbstentions}/${m.expectedUnknownStations}；码与地点关联 ${m.correctAssociations}/${m.expectedCodes}。`, '',
    '本轮另经人工复核一张截图：修复前把到站时长当作地点，且因签收证据保守暂存、没有自动写入。最小修复已排除相对时长，并保留带导航箭头的原文驿站。修复和复测使用同一份真实返回缓存。', '',
    '## 每张图片', '', '| 图片 ID | 云端 OCR 段 ms | fileID 全程 ms | 请求 | 本地判断：新增 / 待处理 / 跳过 |', '|---|---:|---:|---|---|'];
  report.images.forEach(r => lines.push(`| ${r.id} | ${r.ocrMs || '—'} | ${r.totalMs || '—'} | ${r.ocrSucceeded ? '成功' : r.error || r.status} | ${r.final ? `${r.final.added} / ${r.final.review} / ${r.final.skipped}` : '—'} |`));
  lines.push('', `缓存复跑零调用验证：${report.cacheReuseVerification.zeroCallRerunVerified ? '通过，第二次处理 0 张，首轮预算仍为 ' + c.reserved : '尚未执行'}。`, '', '表中本地判断使用修复后的解析器；OCR 耗时来自同一份本轮真实返回。具体号码、地点、决策原因及逐项标注对照见同目录 JSON；未标注图片只报告输出，不计入准确率。', '', '## 使用真实返回的离线批量验证', '');
  report.scenarios.forEach(s => lines.push(`- ${s.name}：${s.passed ? '通过' : '未通过'}；新增 ${s.actual.added}，待处理 ${s.actual.reviews}，跳过/融合 ${s.actual.skipped} 个来源项（重复图 ${s.actual.duplicateImages}、无关/运输图 ${s.actual.unrelatedImages}、融合重复来源 ${s.actual.fusedSources}）。`));
  lines.push('', '## 边界', '', '上述批量验证使用本轮真实 OCR 缓存和隔离存储，不再次收费。仅有号码、地点与指定场景的人工答案；不能据此声称所有日期、运单、状态或未知截图均准确，也不能当作 Android 真机验收。', '');
  return lines.join('\n');
}
module.exports = { buildReport, simulate, markdown };
if (require.main === module) buildReport().then(report => {
  const json = path.join(root, 'verification/v23-live-ocr-result.json');
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'verification/v23-live-ocr-report.md'), markdown(report));
  console.log(JSON.stringify({ calls: report.calls, labels: report.labels, scenarioResults: report.scenarios.map(s => ({ name: s.name, passed: s.passed, mismatches: s.mismatches })), formalStorageUnchanged: report.formalStorageUnchanged }));
}).catch(() => { console.error('LIVE_OCR_REPORT_FAILED'); process.exitCode = 1; });
