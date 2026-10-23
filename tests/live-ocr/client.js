// Runs only in the Developer Tools console. No Page methods or pickup storage writes.
async function runLiveOcr(base, probeSource, envId) {
  const request = (route, data) => new Promise((resolve, reject) => wx.request({ url: base + route, method: data ? 'POST' : 'GET',
    header: { 'X-Campus-Ocr-Test': 'local-run' }, ...(data ? { data } : {}), timeout: 60000,
    success: r => r.statusCode === 200 ? resolve(r.data) : reject({ code: 'LOCAL_HTTP_ERROR' }), fail: () => reject({ code: 'LOCAL_CONNECTION_FAILED' }) }));
  const fs = wx.getFileSystemManager();
  const keys = ['campus-pickup.records', 'campus-pickup.stations'];
  const before = keys.map(key => JSON.stringify(wx.getStorageSync(key)));
  const module = { exports: {} };
  new Function('module', 'require', 'wx', probeSource)(module, () => ({ CLOUD_ENV: envId, isDevelopment: () => true }), wx);
  let processed = 0;
  while (true) {
    const job = await request('/next');
    if (job.done) break;
    const imagePath = `${wx.env.USER_DATA_PATH}/live-ocr-${job.hash.slice(0, 20)}.jpg`;
    let result, report;
    try {
      await new Promise((resolve, reject) => fs.writeFile({ filePath: imagePath, data: job.base64, encoding: 'base64', success: resolve, fail: () => reject({ code: 'LOCAL_IMAGE_WRITE' }) }));
      report = await module.exports.run(imagePath, () => {}, { ocr: true, onResult: value => { result = value; } });
    } catch (err) { report = { error: ['LOCAL_IMAGE_WRITE'].indexOf(err && err.code) >= 0 ? err.code : 'CLIENT_ERROR', ocrCalls: 0, timings: {} }; }
    finally { await new Promise(resolve => fs.unlink({ filePath: imagePath, success: resolve, fail: resolve })); }
    await request('/result', { hash: job.hash, report, ...(result ? { result } : {}) });
    processed++;
    console.log('[live-ocr]', JSON.stringify({ id: job.id, ok: !!result, error: report.error || '', ocrMs: report.timings.ocrMs || null, totalMs: report.timings.totalMs || null, cleanupPending: !!report.cleanupPending }));
    if (report.cleanupPending || /OCR_AUTH|FORBIDDEN|UNAUTHORIZED|CONFIG_ERROR/.test(report.error || '')) break;
  }
  const unchanged = keys.every((key, i) => JSON.stringify(wx.getStorageSync(key)) === before[i]);
  await request('/finish', { processed, formalStorageUnchanged: unchanged });
  console.log('[live-ocr-finished]', JSON.stringify({ processed, formalStorageUnchanged: unchanged }));
}
