const MAX_BYTES = 512 * 1024;
const failure = code => ({ protocol: 1, ok: false, error: { code } });
function storageFailure(err) {
  const message = String(err && (err.errMsg || err.message) || "");
  const serviceCode = typeof (err && err.code) === "string" && /^[A-Z][A-Z_]{1,63}$/.test(err.code) ? err.code : null;
  const deniedAction = ["tcb:GetFileDownloadUrl", "tcb:GetDownloadUrl", "tcb:DeleteFile", "tcb:GetFileAuthority"]
    .find(action => message.includes(`(${action})`)) || null;
  return { deniedAction, serviceCode, sdkCode: Number.isInteger(err && err.errCode) ? err.errCode : null,
    kind: /permission|denied|unauthor|not authorized|forbidden|权限|未授权|CAM_CHECK/i.test(message) ? "permission"
      : /credential|secretId|secretKey|token|signature|签名|鉴权/i.test(message) ? "credentials"
      : /not.?found|no.?such|不存在|not exist/i.test(message) ? "not_found"
        : /undefined|cannot read|fileList/i.test(message) ? "sdk_response"
          : /timeout|timed out/i.test(message) ? "timeout" : "other" };
}

async function probe(event, identity, options) {
  const openid = identity && identity.OPENID;
  if (!openid || !/^[A-Za-z0-9_-]{1,128}$/.test(openid) || !options.allowedOpenids.includes(openid)) return failure("FORBIDDEN");
  // Enable only after private storage rules and prefix lifecycle have been verified.
  if (!options.ready || !/^[a-z0-9-]+$/.test(options.bucket || "")) return failure("PROBE_NOT_READY");
  const prefix = `cloud://${options.envId}.${options.bucket}/ocr-probe/${openid}/`;
  if (event.check === true) return { protocol: 1, ok: true, openid, filePrefix: prefix, runtime: options.runtime };
  const fileID = event.fileID;
  if (typeof fileID !== "string" || !fileID.startsWith(prefix) ||
      !/^\d{13}-[a-f0-9]{16}\.img$/.test(fileID.slice(prefix.length))) return failure("INVALID_FILE");
  const report = { protocol: 1, ok: false, readSucceeded: false, serverDeleted: false, imageBytes: 0, readMs: 0, deleteMs: 0 };
  const started = Date.now();
  try {
    const { fileContent } = await options.cloud.downloadFile({ fileID });
    report.readMs = Date.now() - started;
    if (!Buffer.isBuffer(fileContent) || !fileContent.length || fileContent.length > MAX_BYTES) {
      report.error = { code: "INVALID_IMAGE" };
    } else {
      const png = fileContent.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = fileContent[0] === 255 && fileContent[1] === 216 && fileContent[2] === 255;
      report.imageBytes = fileContent.length;
      report.readSucceeded = png || jpeg;
      if (!report.readSucceeded) report.error = { code: "INVALID_IMAGE" };
    }
  } catch (err) {
    report.readMs = Date.now() - started;
    report.readFailure = storageFailure(err);
    report.error = { code: "PROBE_READ_FAILED" };
  } finally {
    const deletionStarted = Date.now();
    try {
      const result = await options.cloud.deleteFile({ fileList: [fileID] });
      report.serverDeleted = !!(result && result.fileList && result.fileList.length === 1 && result.fileList[0].status === 0);
      if (!report.serverDeleted) {
        const item = result && result.fileList && result.fileList[0];
        report.deleteFailure = storageFailure(item && { errCode: item.status, errMsg: item.errMsg });
      }
    } catch (err) { report.deleteFailure = storageFailure(err); }
    report.deleteMs = Date.now() - deletionStarted;
  }
  report.ok = report.readSucceeded && report.serverDeleted;
  if (!report.serverDeleted && !report.error) report.error = { code: "PROBE_DELETE_FAILED" };
  return report;
}

module.exports = { probe };
