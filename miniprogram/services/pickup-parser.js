// Only explicit pickup semantics or recognizable station names may identify a location.
const notifications = require("./notification-parser");
const { validCode } = require("./pickup-code");
const evidence = require('./import-evidence');
const UNKNOWN = "待确认地点";
const noise = /物流求助|复制|订阅|提醒|查看|地图|导航|收件|收货|寄件|运输|转运|分拨|途经|预计|揽收|发往|离开|到达|派送中|电话|联系|运单|单号|取件码|取货码|提货码|领取码|订单|商品|购买|付款|旗舰店|专营店/;
const labels = /(?:取件码|取货码|提货码|领取码|自提码|提取码|取件密码)\s*[:：]?\s*/g;
function clean(text) {
  return String(text).normalize("NFKC").replace(/[—–－﹣−‐‑‒]/g, "-").trim();
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
function codeValue(value, numericSegments = false) {
  const m = value.match(/^([A-Za-z0-9]{1,8}(?:\s*-\s*[A-Za-z0-9]{1,8}){1,3}|[A-Za-z0-9]{3,9})(?![A-Za-z0-9.\-:/＊*?？_])/);
  if (!m) return "";
  const code = m[1].replace(/\s/g, "");
  // Dates and letter-only fragments are not parcel identifiers, even beside a label.
  if (!validCode(code) || (/^\d+[A-Za-z]/.test(code) && !code.includes('-')) || (numericSegments && /-[^-]*[A-Za-z]/.test(code)) || /^(?:19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(code) ||
      /^1\d{10}$/.test(code.replace(/-/g, "")) ||
      /^\s*(?:[-.:/＊*?？_年月日元时分秒￥¥]|\d)/.test(value.slice(m[0].length)) || code.length > 32) return "";
  return code;
}
function cainiaoPage(text) {
  return text.some(s => /菜鸟驿站/.test(s)) && text.some(s => /待取件|添加包裹/.test(s));
}
function stationHeader(text) {
  // The storefront icon can be OCR'd as 公; strip it only on a Cainiao badge row.
  return text.replace(/[>›〉]\s*绿色公益.*$/, "").replace(/^公(?=.{2,}菜鸟驿站$)/, "");
}
function extractCodes(text, boxes) {
  const codes = [];
  let uncertainCount = 0;
  const consumed = new Set(), cainiao = cainiaoPage(text);
  for (let i = 0; i < text.length; i++) {
    const matches = [...text[i].matchAll(labels)];
    for (let n = 0; n < matches.length; n++) {
      const label = matches[n];
      const prefix = text[i].slice(0, label.index);
      if (/(?:https?:\/\/|www\.|[A-Za-z0-9-]+\.[A-Za-z]{2,}\/)[^\s，。]*$/.test(prefix)) continue;
      if (/(?:没有|暂无|未生成|未发现|未获取|无有效|查询|查看|获得|获取|输入|凭)\s*$/.test(prefix)) continue;
      let valueIndex = i;
      let value = text[i].slice(label.index + label[0].length, n + 1 < matches.length ? matches[n + 1].index : undefined).trim();
      if (!value) {
        const a = boxAt(boxes, i), b = boxAt(boxes, i + 1);
        if (!a || !b || labelNeighbor(a, b)) { value = text[i + 1] || ""; valueIndex = i + 1; }
      }
      const code = codeValue(value, cainiao);
      if (code) { codes.push({ i: valueIndex, code }); consumed.add(valueIndex); }
      else if (!value || !/^[*＊·•●xX\s-]+$|已隐藏|点击.*查看|待生成|暂未生成/.test(value)) uncertainCount++;
    }
  }
  if (cainiao) {
    for (let i = 0; i < text.length; i++) {
      if (consumed.has(i)) continue;
      // Standalone shelf codes only: never take digits embedded in phones, waybills or ads.
      const value = text[i].replace(/\s*-\s*/g, "-");
      if (!/^(?:[A-Za-z]?\d{1,4}-){1,2}[A-Za-z0-9*?＊？]{0,8}$/.test(value)) continue;
      if (/^(?:19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(value)) continue;
      const a = boxAt(boxes, i);
      const nearbyStation = text.some((line, j) => {
        if (!/[>›〉]\s*绿色公益|驿站|服务站|快递柜/.test(line) || noise.test(line)) return false;
        const b = boxAt(boxes, j);
        return a && b ? b.y + b.height <= a.y && a.y - b.y <= a.height * 5 && sameColumn(a, b)
          : j < i && i - j <= 3;
      });
      if (!nearbyStation) continue;
      const code = /^(?:[A-Za-z]?\d{1,4}-){1,2}\d{3,6}$/.test(value) ? codeValue(value) : "";
      if (code) codes.push({ i, code });
      else uncertainCount++;
    }
  }
  codes.sort((a, b) => a.i - b.i);
  return { codes, uncertainCount };
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
  const text = lines.map(clean), extracted = extractCodes(text, boxes), places = [];
  // Join only contiguous notification rows, never the entire screenshot or adjacent columns.
  const notificationRecords = [], covered = new Set();
  for (let i = 0; i < text.length; i++) {
    if (!/^【(?:驿小哥|京东(?:快递|物流)?|菜鸟(?:驿站)?|顺丰(?:快递|速运)?)】/.test(text[i]) &&
        !/(?:已到|已送达|已送至|已入库|凭)[^。]*[A-Za-z0-9]/.test(text[i])) continue;
    let paragraph = text[i], end = i;
    while (end + 1 < text.length) {
      const a = boxAt(boxes, end), b = boxAt(boxes, end + 1);
      if (!a || !b || /^【/.test(text[end + 1]) || !sameColumn(a, b) ||
          Math.abs(a.x - b.x) > Math.max(a.height, b.height) * 2 || b.y <= a.y ||
          b.y - a.y - a.height > Math.max(a.height, b.height) * 1.5 || /[。！!]$/.test(paragraph)) break;
      paragraph += text[++end];
    }
    const parsed = notifications.parse(paragraph);
    if (!parsed.length) continue;
    notificationRecords.push(...parsed.map(r => ({ ...r, sourceType: 'image', sourceIndex, lineIndex: i })));
    for (let j = i; j <= end; j++) covered.add(j);
    i = end;
  }
  const codes = extracted.codes.filter(c => !covered.has(c.i));
  const cainiao = cainiaoPage(text);
  for (let i = 0; i < text.length; i++) {
    if (covered.has(i) || /(?:收件|收货|寄件|寄货)(?:人)?地址/.test(text[i])) continue;
    const explicit = text[i].match(/(?:已派送至|已送至|已送达|已到达?|已入库(?:至|到|于)?|领取地点|自提地点|自提点|取件地址|取件地点|地址(?=\s*[:：]))\s*[:：]?\s*(.*)/);
    let name = explicit ? explicit[1].replace(/[，,。；;].*$/, "").replace(/(?:请|凭).*$/, "").trim() : text[i].replace(/^支持退换货\s*/, "");
    const header = cainiao && /[>›〉]\s*绿色公益/.test(name);
    if (header) name = stationHeader(name);
    const detailPlace = cainiao && text.includes("添加包裹") && /[栋楼]|\d+号|小区/.test(name) && codes.some(c => {
      const a = boxAt(boxes, c.i), b = boxAt(boxes, i);
      return a && b && b.y >= a.y + a.height && b.y - a.y - a.height <= a.height * 2 &&
        Math.abs(b.x - a.x) <= a.height && sameColumn(a, b);
    });
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
      (explicit || header || detailPlace || /驿站|自提柜|快递柜|邮政$|(?:店|服务站)$/.test(name) || section)) {
      places.push({ i: locationIndex, name, explicit: !!explicit, detail: !!explicit && /^地址/.test(explicit[0]) });
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
    const stationCandidates = candidates.filter(p => !p.detail);
    const addresses = [...new Set(candidates.filter(p => p.detail).map(p => p.name))];
    const nearbyPrevious = previousRecord && (!a || !boxAt(boxes, previous.i) ||
      Math.abs(a.y - boxAt(boxes, previous.i).y) <= Math.max(a.height, boxAt(boxes, previous.i).height) * 8);
    const station = candidates.length ? placeName(stationCandidates.length ? stationCandidates : candidates) : nearbyPrevious ? previousRecord.station : UNKNOWN;
    const scope = codes.length === 1 && !notificationRecords.length ? text.join('\n') : text.slice(code.i, next ? next.i : text.length).filter((_, offset) => compatible({ i: code.i + offset })).join('\n');
    const options = [...new Set(candidates.map(p => p.name))];
    records.push({ station, ...(station === UNKNOWN && options.length > 1 ? { locationOptions: options } : {}), ...evidence.inspect(scope), ...(addresses.length === 1 ? { pickupAddress: addresses[0] } : {}), code: code.code, ...(/\d[OILSB](?:\d|-|$)/i.test(code.code) ? { uncertainCode: true } : {}), sourceIndex, needsReview: station === UNKNOWN, lineIndex: code.i });
  }
  return [...records, ...notificationRecords].sort((a, b) => a.lineIndex - b.lineIndex).map(({ lineIndex, sourceType, ...r }) => r);
}
function analyze(lines, sourceIndex = 0, boxes = []) {
  const records = parse(lines, sourceIndex, boxes);
  const { uncertainCount } = extractCodes(lines.map(clean), boxes);
  if (records.length) return { records, uncertainCount, status: "code_found", reason: "code_found", message: `识别到 ${records.length} 件快递` };
  const text = lines.map(clean).join("\n");
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(text) || uncertainCount) {
    return { records, uncertainCount, status: "unrecognized", reason: uncertainCount ? "candidate_unparsed" : "ocr_empty", message: "识别不出来" };
  }
  if (/已到站|已入库|已派送至|已送至|已签收|已取件|已领取|取件完成|待取件|等待领取|请.*(?:取件|领取)/.test(text)) {
    return { records, uncertainCount, status: "arrived_no_code", reason: "no_valid_code", message: "没有取件码" };
  }
  if (/运输中|已揽收|预计.*(?:送达|到达)|派送中|转运中/.test(text)) {
    return { records, uncertainCount, status: "in_transit", reason: "no_valid_code", message: "还在运输" };
  }
  return { records, uncertainCount, status: "no_code", reason: "no_valid_code", message: "没有取件码" };
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
