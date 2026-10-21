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
function sameColumn(a, b) {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return overlap >= -Math.max(a.height, b.height) * 2;
}
function labelNeighbor(a, b) {
  const height = Math.max(a.height, b.height);
  const sameRow = Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= height * 0.65;
  return sameRow ? b.x >= a.x && b.x - a.x - a.width <= height * 6
    : b.y >= a.y && b.y - a.y - a.height <= height * 3 && sameColumn(a, b);
}
function placeName(candidates) {
  const explicit = candidates.filter(p => p.explicit);
  if (explicit.length) candidates = explicit;
  const names = [...new Set(candidates.map(p => p.name))];
  if (names.length === 1) return names[0];
  const branches = names.filter(name => !/^(?:菜鸟驿站|妈妈驿站|快递驿站)$/.test(name));
  return branches.length === 1 ? branches[0] : UNKNOWN;
}
function parse(lines, sourceIndex = 0, boxes = []) {
  const text = lines.map(clean), codes = [], places = [];
  for (let i = 0; i < text.length; i++) {
    const label = text[i].match(/(?:取件码|提货码|领取码)\s*[:：]?\s*(.*)/);
    if (label) {
      const a = boxAt(boxes, i), b = boxAt(boxes, i + 1);
      const candidate = label[1] || ((!a || !b || labelNeighbor(a, b)) ? text[i + 1] : "") || "";
      const m = candidate.match(/^([A-Za-z0-9]{1,8}(?:\s*-\s*[A-Za-z0-9]{1,8}){1,3}|\d{4,8})(?![A-Za-z0-9-])/);
      if (m) codes.push({ i, code: m[1].replace(/\s/g, "") });
    }
    const explicit = text[i].match(/(?:已派送至|已送至|自提地点|自提点|取件地址|取件地点)\s*[:：]?\s*(.*)/);
    let name = explicit ? explicit[1].replace(/[，,。；;].*$/, "").replace(/(?:请|凭).*$/, "").trim() : text[i].replace(/^支持退换货\s*/, "");
    let locationIndex = i;
    if (explicit && !name && text[i + 1] && (!boxAt(boxes, i) || !boxAt(boxes, i + 1) || labelNeighbor(boxAt(boxes, i), boxAt(boxes, i + 1)))) {
      name = text[i + 1]; locationIndex = i + 1;
    }
    name = name.replace(/^[【\[（(]([^】\]）)]+)[】\]）)].*$/, "$1");
    const next = text[i + 1] || "", a = boxAt(boxes, i), b = boxAt(boxes, i + 1);
    // Unfamiliar section names need an adjacent address, not just arbitrary Chinese text.
    const section = /[号栋]|小区/.test(next) && validPlace(next) && (!a || !b ||
      Math.abs(a.x - b.x) <= Math.max(a.height, b.height) && b.y > a.y && b.y - a.y <= a.height * 3);
    if (validPlace(name) && !/^(?:中国邮政|邮政|中通快递|极兔速递)$/.test(name) &&
      (explicit || /驿站|自提柜|快递柜|邮政$|(?:店|服务站)$/.test(name) || section)) {
      places.push({ i: locationIndex, name, explicit: !!explicit });
    }
  }
  const records = [];
  for (const code of codes) {
    const a = boxAt(boxes, code.i);
    const compatible = p => !a || !boxAt(boxes, p.i) || sameColumn(a, boxAt(boxes, p.i));
    const previous = codes.filter(c => c.i < code.i && compatible(c)).pop();
    const next = codes.find(c => c.i > code.i && compatible(c));
    let candidates = places.filter(p => compatible(p) && p.i > (previous ? previous.i : -1) && p.i <= code.i &&
      (!a || !boxAt(boxes, p.i) || boxAt(boxes, p.i).y <= a.y + a.height / 2));
    const after = places.filter(p => (p.explicit || codes.length === 1) && compatible(p) && p.i > code.i && p.i < (next ? next.i : text.length) &&
      (!a || !boxAt(boxes, p.i) || Math.abs(boxAt(boxes, p.i).y - a.y) <= Math.max(a.height, boxAt(boxes, p.i).height) * 8) &&
      (!next || !a || !boxAt(boxes, p.i) || !boxAt(boxes, next.i) ||
        Math.abs(boxAt(boxes, p.i).y - a.y) < Math.abs(boxAt(boxes, p.i).y - boxAt(boxes, next.i).y)));
    if (after.length) candidates = [...candidates, ...after];
    const previousRecord = previous && records.find(r => r.lineIndex === previous.i);
    const station = candidates.length ? placeName(candidates) : previousRecord ? previousRecord.station : UNKNOWN;
    records.push({ station, code: code.code, sourceIndex, needsReview: station === UNKNOWN, lineIndex: code.i });
  }
  return records.map(r => ({ station: r.station, code: r.code, sourceIndex: r.sourceIndex, needsReview: r.needsReview }));
}
function analyze(lines, sourceIndex = 0, boxes = []) {
  const records = parse(lines, sourceIndex, boxes);
  if (records.length) return { records, status: "code_found", message: `识别到 ${records.length} 件快递` };
  const text = lines.map(clean).join("\n");
  if (/已到站|已入库|已派送至|已送至|待取件|等待领取|请.*(?:取件|领取)/.test(text)) {
    return { records, status: "arrived_no_code", message: "暂未获取到取件码" };
  }
  if (/运输中|已揽收|预计.*(?:送达|到达)|派送中|转运中/.test(text)) {
    return { records, status: "in_transit", message: "快递还在运输中，暂无取件码" };
  }
  return { records, status: "no_code", message: "未发现取件码" };
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
