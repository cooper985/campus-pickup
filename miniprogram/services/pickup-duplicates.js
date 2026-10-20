const { validWaybill } = require("./pickup-store");
const normalize = value => String(value || "").normalize("NFKC")
  .replace(/[—–－﹣]/g, "-").replace(/\s/g, "").toUpperCase();

function findDuplicate(candidate, records) {
  const waybill = normalize(candidate.waybillNumber);
  const exact = validWaybill(waybill) && records.find(r => normalize(r.waybillNumber) === waybill);
  if (exact) return { kind: "waybill", record: exact };
  const matches = records.filter(r => {
    if (validWaybill(waybill) && validWaybill(r.waybillNumber) && r.waybillNumber !== waybill) return false;
    if (normalize(r.code) !== normalize(candidate.code)) return false;
    return normalize(r.station) === normalize(candidate.station) ||
      r.station === "待确认地点" || candidate.station === "待确认地点";
  });
  const record = matches.find(r => !r.taken) || matches[0];
  return record ? { kind: record.taken ? "reused-code" : "pending-code", record } : null;
}

// Only attach metadata where the screenshot contains one parcel and one explicit number.
// Multi-parcel layout association is deliberately left to a future parser upgrade.
function metadata(lines, recordCount) {
  if (recordCount !== 1) return { carrier: "", waybillNumber: "" };
  const text = lines.join("\n").normalize("NFKC");
  const carriers = [...new Set(text.match(/顺丰速运|顺丰快递|中通快递|圆通速递|申通快递|韵达快递|极兔速递|邮政快递包裹|京东物流|德邦快递/g) || [])];
  const numbers = [];
  const pattern = /(?:运单号|快递单号|物流单号)\s*[:：]?\s*([A-Za-z0-9]{10,30})(?![A-Za-z0-9])/g;
  let match;
  while ((match = pattern.exec(text))) {
    const value = normalize(match[1]);
    if (validWaybill(value)) numbers.push(value);
  }
  const unique = [...new Set(numbers)];
  return { carrier: carriers.length === 1 ? carriers[0] : "", waybillNumber: unique.length === 1 ? unique[0] : "" };
}
module.exports = { findDuplicate, metadata };
