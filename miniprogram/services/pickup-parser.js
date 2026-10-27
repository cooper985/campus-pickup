// Only explicit pickup semantics or recognizable station names may identify a location.
const notifications = require("./notification-parser");
const { validCode, codeLabels } = require("./pickup-code");
const evidence = require('./import-evidence');
const layout = require('./recognition-layout');
const { boundary } = require('./station-name');
const { metadata } = require('./pickup-duplicates');
const UNKNOWN = "待确认地点";
const noise = /物流求助|复制|订阅|提醒|查看|地图|导航|收件|收货|寄件|运输|转运|分拨|途经|预计|揽收|发往|离开|到达|派送中|电话|联系|运单|单号|取件码|取货码|提货码|提货号|领取码|订单|商品|购买|付款|旗舰店|专营店/;
const labels = codeLabels();
function clean(text) {
  return String(text).normalize("NFKC").replace(/[—–－﹣−‐‑‒]/g, "-").trim();
}
function validPlace(s) {
  return s.length >= 2 && s.length <= 100 && /[\u4e00-\u9fff]/.test(s) && !noise.test(s) &&
    !/^(?:营业|工作|开放|服务)时间/.test(s) &&
    !/^(?:站?\d+\s*(?:小时|分钟|天)|今日到站|已到(?:站)?\s*\d*\s*(?:天|小时)|已入库|等待领取|待取件)/.test(s) &&
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
const sectionStop = /同学都在买|猜你喜欢|为你推荐|收货地址示例|专属收货密令|还有包裹未显示|网购包裹到站都能查|^(?:已签收|已领取|已退回)\s*\d*$/;
function badgeHeader(text, boxes, i) {
  if (/[>›〉]\s*绿色公益/.test(text[i])) return true;
  const a = boxAt(boxes, i);
  return /[>›〉]\s*$/.test(text[i]) && text.slice(i + 1, i + 3).some((s, offset) => {
    const b = boxAt(boxes, i + 1 + offset);
    return /^绿色公益$/.test(s) && a && b && b.x >= a.x + a.width && Math.abs(b.y - a.y) <= Math.max(a.height, b.height);
  });
}
// A station section owns every parcel card until the next heading or non-parcel area.
function stationSection(text, boxes, index) {
  if (!cainiaoPage(text)) return null;
  const a = boxAt(boxes, index);
  let heading = null;
  for (let i = 0; i < index; i++) {
    const b = boxAt(boxes, i);
    if (a && b && (!sameColumn(a, b) || b.y >= a.y)) continue;
    if (sectionStop.test(text[i])) heading = null;
    const name = boundary(stationHeader(text[i]).replace(/[>›〉]\s*$/, ''));
    if (validPlace(name) && (badgeHeader(text, boxes, i) || /驿站|服务站|快递柜/.test(name) && !/^(?:菜鸟驿站|妈妈驿站)$/.test(name))) heading = { i, name };
  }
  return heading;
}
function extractCodes(text, boxes) {
  const codes = [];
  let uncertainCount = 0;
  const issues = [];
  const consumed = new Set(), cainiao = cainiaoPage(text);
  for (let i = 0; i < text.length; i++) {
    const matches = [...text[i].matchAll(labels)];
    for (let n = 0; n < matches.length; n++) {
      const label = matches[n];
      const prefix = text[i].slice(0, label.index);
      if (/(?:https?:\/\/|www\.|[A-Za-z0-9-]+\.[A-Za-z]{2,}\/)[^\s，。]*$/.test(prefix)) continue;
      if (/(?:没有|暂无|未生成|未发现|未获取|无有效|复制|分享|查询|查看|获得|获取|输入|凭)\s*$/.test(prefix)) continue;
      let valueIndex = i;
      let value = text[i].slice(label.index + label[0].length, n + 1 < matches.length ? matches[n + 1].index : undefined).trim();
      if (!value && text[i + 1] !== undefined) {
        const a = boxAt(boxes, i), b = boxAt(boxes, i + 1);
        if (!a || !b || labelNeighbor(a, b)) { value = text[i + 1] || ""; valueIndex = i + 1; }
      }
      // Help text mentions the field; it does not describe another parcel's missing value.
      if (!/[:：]/.test(label[0]) && /^(?:问题|疑问)/.test(value)) continue;
      const code = codeValue(value, cainiao);
      if (code) { codes.push({ i: valueIndex, code }); consumed.add(valueIndex); }
      else if (!value || !/^[*＊·•●xX\s-]+$|已隐藏|点击.*查看|待生成|暂未生成/.test(value)) { uncertainCount++; issues.push({ i: valueIndex }); }
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
        if (text.slice(j + 1, i).some(s => sectionStop.test(s))) return false;
        return a && b ? b.y + b.height <= a.y && a.y - b.y <= a.height * 5 && sameColumn(a, b)
          : j < i && i - j <= 3;
      });
      const section = stationSection(text, boxes, i);
      // Continued cards need their own arrival evidence; ads cannot extend a section.
      const tail = text.slice(i + 1, i + 4).join(' ');
      const continuedCard = section && /今日到站|已到(?:站)?\s*\d*|已入库|等待领取/.test(tail);
      if (!nearbyStation && !continuedCard) continue;
      const code = /^(?:[A-Za-z]?\d{1,4}-){1,2}\d{1,6}$/.test(value) ? codeValue(value) : "";
      if (code) codes.push({ i, code });
      else { uncertainCount++; issues.push({ i }); }
    }
  }
  codes.sort((a, b) => a.i - b.i);
  return { codes, uncertainCount, issues };
}
function placeName(candidates) {
  const explicit = candidates.filter(p => p.explicit);
  if (explicit.length) candidates = explicit;
  const names = [...new Set(candidates.map(p => p.name))];
  if (names.length === 1) return names[0];
  const branches = names.filter(name => !/^(?:菜鸟驿站|妈妈驿站|快递驿站)$/.test(name));
  return branches.length === 1 ? branches[0] : UNKNOWN;
}
function parse(lines, sourceIndex = 0, boxes = [], trace) {
  const text = lines.map(clean), eventText = evidence.withoutNavigation(text, boxes), extracted = extractCodes(text, boxes), places = [];
  // Join only contiguous notification rows, never the entire screenshot or adjacent columns.
  const notificationRecords = [], covered = new Set();
  for (let i = 0; i < text.length; i++) {
    if (!/^【(?:递管家|驿小哥|京东(?:快递|物流)?|菜鸟(?:驿站)?|顺丰(?:快递|速运)?)】/.test(text[i]) &&
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
    notificationRecords.push(...parsed.map(r => ({ ...r, sourceType: 'image', sourceIndex, lineIndex: i, sourceRegions: [region(sourceIndex, i, end, boxes, r)] })));
    for (let j = i; j <= end; j++) covered.add(j);
    i = end;
  }
  const codes = extracted.codes.filter(c => !covered.has(c.i));
  covered.forEach(i => { eventText[i] = ''; });
  const cainiao = cainiaoPage(text);
  for (let i = 0; i < text.length; i++) {
    if (covered.has(i) || /(?:收件|收货|寄件|寄货)(?:人)?地址/.test(text[i])) continue;
    const explicit = text[i].match(/(?:已派送至|已送至|已送达|已到达?|已入库(?:至|到|于)?|领取地点|自提地点|自提点|取件地址|取件地点|地址(?=\s*[:：]))\s*[:：]?\s*(.*)/);
    let destination = explicit ? explicit[1] : '';
    if (/^[【\[]?(?:菜鸟驿站|妈妈驿站|快递驿站)[】\]]?\s*[(（][^()（）]*$/.test(destination)) {
      const a = boxAt(boxes, i), b = boxAt(boxes, i + 1);
      if (a && b && b.y > a.y && b.y - a.y - a.height <= Math.max(a.height, b.height) * 1.5 &&
          Math.abs(a.x - b.x) <= Math.max(a.height, b.height) * 2 && sameColumn(a, b) &&
          !/^(?:另一个|另一件|另外一件|下一个)(?:包裹|快递)/.test(text[i + 1]) &&
          ![...extracted.codes, ...extracted.issues].some(c => c.i === i + 1)) destination += text[i + 1];
    }
    const branch = destination.match(/^[【\[]?(?:菜鸟驿站|妈妈驿站|快递驿站)[】\]]?\s*[(（]([^()（）]+)[)）]/);
    let name = explicit ? boundary(branch && /[栋楼号街路门站柜店]|中心|小区/.test(branch[1]) ? branch[1] : destination) : text[i].replace(/^支持退换货\s*/, "");
    const header = cainiao && badgeHeader(text, boxes, i);
    if (header) name = stationHeader(name).replace(/[>›〉]\s*$/, '');
    name = name.replace(/((?:驿站|服务站|快递柜))[>›〉]\s*$/, '$1');
    const detailPlace = cainiao && text.includes("添加包裹") && /[栋楼]|\d+号|小区/.test(name) && codes.some(c => {
      const a = boxAt(boxes, c.i), b = boxAt(boxes, i);
      return a && b && b.y >= a.y + a.height && b.y - a.y - a.height <= a.height * 2 &&
        Math.abs(b.x - a.x) <= a.height && sameColumn(a, b);
    });
    const badgeDetail = cainiao && codes.length === 1 && !extracted.issues.length && /[栋楼]/.test(name) && /(?:在|旁|侧|对面|附近|门|入口)/.test(name) &&
      [i - 1, i + 1].some(j => /^(?:菜鸟驿站|妈妈驿站|快递驿站)$/.test(text[j] || '') && boxAt(boxes, i) && boxAt(boxes, j) &&
        Math.abs(boxAt(boxes, i).y - boxAt(boxes, j).y) <= Math.max(boxAt(boxes, i).height, boxAt(boxes, j).height) * 3 && sameColumn(boxAt(boxes, i), boxAt(boxes, j)));
    let locationIndex = i;
    if (explicit && !name && text[i + 1] && (!boxAt(boxes, i) || !boxAt(boxes, i + 1) || labelNeighbor(boxAt(boxes, i), boxAt(boxes, i + 1)))) {
      const value = layout.addressValue(text, boxes, i);
      name = value ? value.value : text[i + 1]; locationIndex = i + 1;
    }
    name = boundary(name);
    name = name.replace(/^[【\[（(]([^】\]）)]+)[】\]）)].*$/, "$1");
    const next = text[i + 1] || "", a = boxAt(boxes, i), b = boxAt(boxes, i + 1);
    // Unfamiliar section names need an adjacent address, not just arbitrary Chinese text.
    const section = /[号栋]|小区/.test(next) && validPlace(next) && (!a || !b ||
      Math.abs(a.x - b.x) <= Math.max(a.height, b.height) && b.y > a.y && b.y - a.y <= a.height * 3);
    if (validPlace(name) && !/^(?:中国邮政|邮政|中通快递|极兔速递)$/.test(name) &&
      (explicit || header || detailPlace || badgeDetail || /驿站|自提柜|快递柜|邮政$|(?:店|服务站)$/.test(name) || section)) {
      places.push({ i: locationIndex, name, explicit: !!explicit, detail: !!explicit && /^地址/.test(explicit[0]) });
    }
  }
  if (trace) { trace.codeCandidates = extracted.codes; trace.coveredCodeLines = [...covered]; trace.placeCandidates = places; }
  const records = [];
  for (const code of codes) {
    const a = boxAt(boxes, code.i);
    const compatible = p => !a || !boxAt(boxes, p.i) || sameColumn(a, boxAt(boxes, p.i));
    const anchors = [...codes, ...extracted.issues].sort((a, b) => a.i - b.i);
    const previous = anchors.filter(c => c.i < code.i && compatible(c)).pop();
    const next = anchors.find(c => c.i > code.i && compatible(c));
    const owned = layout.parcelRows(eventText, boxes, anchors, places, code.i, evidence.inspect);
    const ownedIds = new Set(owned.indices);
    let candidates = places.filter(p => ownedIds.has(p.i) && compatible(p) && p.i > (previous ? previous.i : -1) && p.i <= code.i &&
      (!a || !boxAt(boxes, p.i) || boxAt(boxes, p.i).y <= a.y + a.height / 2));
    const after = places.filter(p => ownedIds.has(p.i) && (p.explicit || codes.length === 1) && compatible(p) && p.i > code.i && p.i < (next ? next.i : text.length) &&
      (!a || !boxAt(boxes, p.i) || Math.abs(boxAt(boxes, p.i).y - a.y) <= Math.max(a.height, boxAt(boxes, p.i).height) * 8) &&
      (!next || !a || !boxAt(boxes, p.i) || !boxAt(boxes, next.i) ||
        Math.abs(boxAt(boxes, p.i).y - a.y) < Math.abs(boxAt(boxes, p.i).y - boxAt(boxes, next.i).y)));
    if (after.length) candidates = [...candidates, ...after];
    const shared = stationSection(text, boxes, code.i);
    if (shared && !candidates.some(p => !p.detail)) candidates.push({ ...shared, explicit: false });
    const previousRecord = previous && records.find(r => r.lineIndex === previous.i);
    const stationCandidates = candidates.filter(p => !p.detail);
    const addresses = [...new Set(candidates.filter(p => p.detail).map(p => p.name))];
    const nearbyPrevious = previousRecord && (!a || !boxAt(boxes, previous.i) ||
      Math.abs(a.y - boxAt(boxes, previous.i).y) <= Math.max(a.height, boxAt(boxes, previous.i).height) * 8);
    const station = candidates.length ? placeName(stationCandidates.length ? stationCandidates : candidates) : nearbyPrevious ? previousRecord.station : UNKNOWN;
    const scope = owned.indices.map(i => eventText[i]);
    const status = evidence.inspect(scope.join('\n'));
    if (!owned.reliable && !['unknown', 'pending'].includes(status.parcelStatus)) status.parcelStatus = 'conflict';
    const options = [...new Set(candidates.map(p => p.name))];
    const record = { station, ...(station === UNKNOWN && options.length > 1 ? { locationOptions: options } : {}), ...status, ...(addresses.length === 1 ? { pickupAddress: addresses[0] } : {}), code: code.code, ...(/\d[OILSB](?:\d|-|$)/i.test(code.code) ? { uncertainCode: true } : {}), sourceIndex, needsReview: station === UNKNOWN, lineIndex: code.i };
    Object.assign(record, metadata(owned.indices.map(i => text[i]), extracted.codes.length + notificationRecords.length + extracted.uncertainCount));
    record.sourceRegions = [region(sourceIndex, Math.min(...owned.indices), Math.max(...owned.indices), boxes, record, owned.indices)];
    if (shared && !ownedIds.has(shared.i)) record.sourceRegions.push(region(sourceIndex, shared.i, shared.i, boxes, { station }));
    records.push(record);
  }
  return [...records, ...notificationRecords].sort((a, b) => a.lineIndex - b.lineIndex).map(({ lineIndex, sourceType, ...r }) => r);
}
function region(imageIndex, start, end, boxes, record, indices = boxes.map((_, i) => i).filter(i => i >= start && i <= end)) {
  return { imageIndex, start, end, boxes: indices.map(i => boxes[i]).filter(b => b && [b.x, b.y, b.width, b.height].every(Number.isFinite)).map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
    fields: ['code', 'station', 'pickupAddress', 'carrier', 'waybillNumber', 'parcelStatus', 'noticeAt'].filter(f => record[f] && record[f] !== UNKNOWN && record[f] !== 'unknown') };
}
function analyze(lines, sourceIndex = 0, boxes = [], trace) {
  const records = parse(lines, sourceIndex, boxes, trace);
  const extracted = extractCodes(lines.map(clean), boxes), uncertainCount = extracted.uncertainCount;
  const issues = extracted.issues.map(({ i }) => {
    const text = lines.map(clean), events = evidence.withoutNavigation(text, boxes);
    const places = text.map((s, i) => ({ i, name: boundary(s) })).filter(p => validPlace(p.name) && /驿站|服务站|快递柜|店$/.test(p.name));
    const owned = layout.parcelRows(events, boxes, [...extracted.codes, ...extracted.issues], places, i, evidence.inspect);
    const scope = owned.indices.map(j => events[j]), status = evidence.inspect(scope.join('\n'));
    if (!owned.reliable && !['unknown', 'pending'].includes(status.parcelStatus)) status.parcelStatus = 'conflict';
    const item = { code: '', station: UNKNOWN, sourceIndex, needsReview: true, ...metadata(scope, 1), ...status };
    item.sourceRegions = [region(sourceIndex, Math.min(...owned.indices), Math.max(...owned.indices), boxes, item, owned.indices)];
    return item;
  });
  if (records.length) return { records, issues, uncertainCount, status: "code_found", reason: "code_found", message: `识别到 ${records.length} 件快递` };
  const text = lines.map(clean).join("\n");
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(text) || uncertainCount) {
    return { records, issues, uncertainCount, status: "unrecognized", reason: uncertainCount ? "candidate_unparsed" : "ocr_empty", message: "识别不出来" };
  }
  if (/已到站|已入库|已派送至|已送至|已签收|已取件|已领取|取件完成|待取件|等待领取|请.*(?:取件|领取)/.test(text)) {
    return { records, issues, uncertainCount, status: "arrived_no_code", reason: "no_valid_code", message: "没有取件码" };
  }
  if (/运输中|已揽收|预计.*(?:送达|到达)|派送中|转运中/.test(text)) {
    return { records, issues, uncertainCount, status: "in_transit", reason: "no_valid_code", message: "还在运输" };
  }
  return { records, issues, uncertainCount, status: "no_code", reason: "no_valid_code", message: "没有取件码" };
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
module.exports = { parse, analyze, group, region, UNKNOWN, extractCodes, clean };
