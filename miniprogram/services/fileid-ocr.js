const task = require("./recognition-task");
const storage = require("./storage-probe");

// Upload binary; only the small, owner-scoped file ID crosses callFunction.
async function recognize(imagePath, control) {
  let result;
  const report = await storage.run(imagePath, phase => {
    const stages = { preflightMs: "fileid_preflight", prepareMs: "image_prepare",
      uploadMs: "cloud_roundtrip", callMs: "fileid_call" };
    try { control.check(); if (stages[phase]) control.stage(stages[phase]); } catch (_) {}
  }, { control, ocr: true, onResult: value => { result = value; } });
  const stages = { preflightMs: "fileid_preflight", prepareMs: "image_prepare", uploadMs: "fileid_upload",
    callMs: "fileid_call", readMs: "fileid_read", deleteMs: "fileid_delete", ocrMs: "fileid_ocr", cleanupMs: "fileid_cleanup" };
  for (const key of Object.keys(stages)) {
    if (Number.isFinite(report.timings[key])) task.log(stages[key], Date.now() - report.timings[key], report.failedPhase === key ? (report.error === "PROBE_WAIT_TIMEOUT" ? "WAIT_TIMEOUT" : "OCR_FAILED") : "OK", { traceId: control.traceId });
  }
  task.log("image_total", Date.now() - report.timings.totalMs, report.error || "OK", {
    traceId: control.traceId, imageBytes: report.imageBytes, requestBytes: report.requestBytes,
    sdkCode: report.sdkCode, serverDeleted: report.serverDeleted, clientDeleted: report.clientDeleted, cleanupPending: report.cleanupPending });
  control.check();
  if (report.error) throw Object.assign(task.error(report.error === "PROBE_WAIT_TIMEOUT" ? "WAIT_TIMEOUT"
    : /^PROBE_/.test(report.error) ? "CLOUD_FAILED" : report.error), {
      origin: report.failedPhase === "callMs" ? "cloud_call" : "client", sdkCode: report.sdkCode });
  if (!result || result.ok !== true || result.mock !== false || !Array.isArray(result.lines)) throw task.error("BAD_RESPONSE");
  return result;
}

module.exports = { recognize };
