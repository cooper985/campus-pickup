// Only explicit pickup semantics or recognizable station names may identify a location.
const UNKNOWN = "待确认地点";
const noise = /物流求助|复制|订阅|提醒|查看|地图|导航|收件|收货|寄件|运输|转运|分拨|途经|预计|揽收|发往|离开|到达|派送中|电话|联系|运单|单号|取件码|提货码|领取码/;
function clean(text) {
  return String(text).normalize("NFKC").replace(/[—–－﹣]/g, "-").trim();
}
function validPlace(s) {
  return s.length >= 2 && s.length <= 100 && /[\u4e00-\u9fff]/.test(s) && !noise.test(s) &&
    !/^(?:收|寄)?[\u4e00-\u9fff]+(?:省|市|县|区)$/.test(s);
}
function boxAt(boxes, i) {
  const b = boxes && boxes[i];
  return b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0 ? b : null;
}
function near(a, b) {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return overlap > 0 && Math.abs(a.y - b.y) <= Math.max(a.height, b.height) * 8;
}
function parse(lines, sourceIndex = 0, boxes = []) {
  const text = lines.map(clean), codes = [], places = [];
  for (let i = 0; i < text.length; i++) {
    const label = text[i].match(/(?:取件码|提货码|领取码)\s*[:：]?\s*(.*)/);
    if (label) {
      const nextAllowed = !boxAt(boxes, i) || !boxAt(boxes, i + 1) || near(boxAt(boxes, i), boxAt(boxes, i + 1));
      const candidate = label[1] || (nextAllowed ? text[i + 1] : "") || "";
      const m = candidate.match(/^([A-Za-z0-9]{1,8}(?:\s*-\s*[A-Za-z0-9]{1,8}){1,3}|\d{4,8})(?![A-Za-z0-9-])/);
      if (m) codes.push({ i, code: m[1].replace(/\s/g, "") });
    }
    const explicit = text[i].match(/(?:已派送至|已送至|自提点|取件地址|取件地点)\s*[:：]?\s*(.*)/);
    let name = explicit ? explicit[1].replace(/[，,。；;].*$/, "").replace(/(?:请|凭).*$/, "").trim() : text[i].replace(/^支持退换货\s*/, "");
    let locationIndex = i;
    if (explicit && !name && text[i + 1] && (!boxAt(boxes, i) || !boxAt(boxes, i + 1) || near(boxAt(boxes, i), boxAt(boxes, i + 1)))) {
      name = text[i + 1]; locationIndex = i + 1;
    }
    if (validPlace(name) && (explicit || /驿站|自提柜|快递柜|邮政$|(?:店|服务站)$/.test(name))) {
      places.push({ i: locationIndex, name, explicit: !!explicit });
    }
  }
  return codes.map((code, n) => {
    const previous = n ? codes[n - 1].i : -1, next = n + 1 < codes.length ? codes[n + 1].i : text.length;
    let candidates = places.filter(p => {
      const a = boxAt(boxes, code.i), b = boxAt(boxes, p.i);
      if (a && b) return near(a, b) && !codes.some(other => {
        const c = boxAt(boxes, other.i);
        return other !== code && c && near(c, b) && Math.abs(c.y - b.y) < Math.abs(a.y - b.y);
      });
      return p.i > previous && p.i < next && (p.i <= code.i || codes.length === 1);
    });
    // Consecutive codes may share a clearly named station in the same text block.
    if (!candidates.length && n && !boxAt(boxes, code.i)) {
      candidates = places.filter(p => p.i < code.i && p.i > (n > 1 ? codes[n - 2].i : -1));
    }
    if (candidates.some(p => p.explicit)) candidates = candidates.filter(p => p.explicit);
    const names = [...new Set(candidates.map(p => p.name))];
    const station = names.length === 1 ? names[0] : UNKNOWN;
    return { station, code: code.code, sourceIndex, needsReview: station === UNKNOWN };
  });
}
function analyze(lines, sourceIndex = 0, boxes = []) {
  const records = parse(lines, sourceIndex, boxes);
  if (records.length) return { records, status: "code_found", message: "已识别取件码，请核对地点。" };
  const text = lines.map(clean).join("\n");
  if (/已到站|已入库|已派送至|已送至|待取件|等待领取|请.*(?:取件|领取)/.test(text)) {
    return { records, status: "arrived_no_code", message: "检测到已到站或待取件信息，但未发现可用取件码，可能尚未显示或已隐藏，请查看原图。" };
  }
  if (/运输中|已揽收|预计.*(?:送达|到达)|派送中|转运中/.test(text)) {
    return { records, status: "in_transit", message: "未发现取件码；截图包含运输或预计送达信息，可能尚未进入取件阶段。" };
  }
  return { records, status: "no_code", message: "OCR 已完成，未发现明确取件码，无法判断物流状态。" };
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
module.exports = { parse, analyze, group, UNKNOWN };
