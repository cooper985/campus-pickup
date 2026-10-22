const cloud = require("wx-server-sdk");
const { handle } = require("./handler");
const { probe } = require("./storage-probe");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const identity = cloud.getWXContext();
  if (event && event.action === "identity") {
    return identity.OPENID ? { openid: identity.OPENID } : { error: "UNAUTHORIZED" };
  }
  const allowedOpenids = (process.env.OCR_ALLOWED_OPENIDS || "").split(",").map(value => value.trim()).filter(Boolean);
  const storageOptions = { cloud, allowedOpenids, envId: "cloud1-d8g3dicam66594fcf",
      ready: process.env.OCR_STORAGE_PROBE_READY === "1", bucket: process.env.OCR_STORAGE_PROBE_BUCKET,
      runtime: {
        credentialsComplete: !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY && process.env.TENCENTCLOUD_SESSIONTOKEN),
        tokenPresent: !!process.env.TENCENTCLOUD_SESSIONTOKEN,
        envMatches: (process.env.TCB_ENV || process.env.SCF_NAMESPACE) === "cloud1-d8g3dicam66594fcf",
        regionMatches: process.env.TENCENTCLOUD_REGION === "ap-shanghai",
      } };
  if (event && event.action === "storageProbe") return probe(event, identity, storageOptions);
  // 每次调用读取临时凭证，避免复用已过期凭证；不接受客户端传入凭证或模式。
  const ocrOptions = {
    mode: process.env.OCR_MODE || "mock",
    allowedOpenids,
    recognize: async (imageBase64) => {
      const secretId = process.env.TENCENTCLOUD_SECRETID;
      const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
      const token = process.env.TENCENTCLOUD_SESSIONTOKEN;
      if (!secretId || !secretKey || !token) throw { code: "MISSING_CREDENTIALS" };
      const { Client } = require("tencentcloud-sdk-nodejs-ocr").ocr.v20181119;
      const client = new Client({
        credential: { secretId, secretKey, token },
        region: "ap-shanghai",
        profile: { httpProfile: { endpoint: "ocr.tencentcloudapi.com", reqTimeout: 10 } },
      });
      return client.GeneralBasicOCR({ ImageBase64: imageBase64 });
    },
  };
  if (event && event.action === "fileidOcr") {
    if (process.env.OCR_FILEID_TEST_READY !== "1" || ocrOptions.mode !== "real" ||
        !Number.isFinite(Number(process.env.OCR_FILEID_TEST_UNTIL)) || Number(process.env.OCR_FILEID_TEST_UNTIL) <= Date.now()) {
      return { protocol: 1, ok: false, error: { code: "PROBE_NOT_READY" } };
    }
    return probe(event, identity, { ...storageOptions,
      recognize: imageBase64 => handle({ imageBase64 }, identity, ocrOptions) });
  }
  return handle(event, identity, ocrOptions);
};
