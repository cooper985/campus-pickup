// OCR is fallible: keep source text and let users correct inferred stations/codes.
const UNKNOWN = "待确认地点";
function clean(text) {
  return String(text).normalize("NFKC").replace(/[—–－﹣]/g, "-").trim();
}
function isHeading(s) {
  return (s.match(/[\u4e00-\u9fff]/g) || []).length >= 3 &&
    !/取件码|提货码|领取码|快递|速递|运单|单号|电话|联系|查看|今日|待取|取快递|复制|删除|请凭|已取|配送|订单/.test(s);
}
function parse(lines, sourceIndex = 0) {
  let station = UNKNOWN, candidates = [];
  const records = [];
  const text = lines.map(clean);
  for (let i = 0; i < text.length; i++) {
    const s = text[i];
    const label = s.match(/(?:取件码|提货码|领取码)\s*[:：]?\s*(.*)/);
    if (label) {
      const candidate = label[1] || text[i + 1] || "";
      const m = candidate.match(/^([A-Za-z0-9]{1,8}(?:\s*-\s*[A-Za-z0-9]{1,8}){1,3}|\d{4,8})(?![A-Za-z0-9-])/);
      if (candidates.length) {
        const unique = [...new Set(candidates)];
        station = unique.slice(0, 2).join(" · ");
        candidates = [];
      }
      if (m) {
        const code = m[1].replace(/\s/g, "");
        records.push({ station, code, sourceIndex, needsReview: station === UNKNOWN });
        if (!label[1]) i++;
      }
    } else if (isHeading(s)) {
      const heading = s.replace(/^支持退换货\s*/, "");
      if (heading) candidates.push(heading);
    }
  }
  return records;
}
function group(records) {
  const groups = [];
  for (const record of records) {
    let g = groups.find(item => item.station === record.station);
    if (!g) { g = { station: record.station, items: [] }; groups.push(g); }
    // Keep duplicate codes visible; identical codes can represent separate parcels.
    g.items.push(record);
  }
  return groups;
}
module.exports = { parse, group, UNKNOWN };
