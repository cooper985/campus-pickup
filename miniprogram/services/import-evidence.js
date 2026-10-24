// Only notification/logistics event times can order states, never image or upload times.
const statuses = ['unknown', 'transit', 'pending', 'signed', 'collected', 'cancelled', 'terminal', 'conflict'];
function states(text) {
  const value = String(text || '').replace(/(?:尚未|还未|未|没有)(?:取件|领取|签收)|(?:申请|如何|点击|可|去)(?:取消|退回|退件)/g, '');
  const result = [];
  if (/已领取|已取件|取件完成/.test(value)) result.push('collected');
  if (/已取消|已退回|已退件/.test(value)) result.push('cancelled');
  if (/待取件|等待领取|已入库|已到站|已送达[^。\n]*(?:驿站|服务站|快递柜)|凭[^。\n]{1,40}(?:取|领取)/.test(value)) result.push('pending');
  if (/已签收/.test(value) && !/驿站.*(?:代签收|签收)|代签收.*(?:驿站|待取)/.test(value)) result.push('signed');
  if (/运输中|已揽收|派送中|转运中/.test(value)) result.push('transit');
  return result;
}
function reconcile(items, reliableIdentity = false) {
  const active = items.filter(i => i.parcelStatus && i.parcelStatus !== 'unknown');
  const unique = [...new Set(active.map(i => i.parcelStatus))];
  if (!unique.length) return { parcelStatus: 'unknown' };
  if (unique.includes('conflict')) return { parcelStatus: 'conflict' };
  if (unique.length === 1) return { parcelStatus: unique[0] };
  if (!reliableIdentity || active.some(i => !i.noticeAt || i.timeConflict)) return { parcelStatus: 'conflict' };
  const ordered = active.slice().sort((a, b) => a.noticeAt - b.noticeAt);
  const allowed = { transit: ['pending', 'signed', 'collected', 'cancelled'], signed: ['pending', 'collected', 'cancelled'], pending: ['collected', 'cancelled'] };
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], next = ordered[i];
    if (prev.parcelStatus !== next.parcelStatus && (prev.noticeAt === next.noticeAt || !(allowed[prev.parcelStatus] || []).includes(next.parcelStatus))) return { parcelStatus: 'conflict' };
  }
  return { parcelStatus: ordered[ordered.length - 1].parcelStatus };
}
function inspect(value) {
  const text = String(value || '').normalize('NFKC');
  const dates = [], events = [];
  const pattern = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/g;
  const matches = [...text.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i], prefix = text.slice(Math.max(0, match.index - 14), match.index);
    if (/创建|拍摄|保存|上传|下单|订单|生产|保质|截止|过期|有效|预计/.test(prefix)) continue;
    const [, y, m, d, h = '0', min = '0'] = match;
    const date = new Date(+y, +m - 1, +d, +h, +min);
    if (date.getFullYear() !== +y || date.getMonth() !== +m - 1 || date.getDate() !== +d || +h > 23 || +min > 59) continue;
    const scope = text.slice(match.index + match[0].length, matches[i + 1] ? matches[i + 1].index : text.length);
    const local = states(scope), all = states(text);
    const status = local.length === 1 ? local[0] : matches.length === 1 && all.length === 1 ? all[0] : '';
    // Bare dates without notification labels or a neighboring status are not event evidence.
    if (!status && !/(?:通知|入库|到站|送达|取件|物流|签收)时间\s*[:：]?\s*$/.test(prefix)) continue;
    dates.push(date.getTime());
    if (status) events.push({ parcelStatus: status, noticeAt: date.getTime() });
  }
  const unique = [...new Set(dates)], found = states(text);
  const resolved = reconcile(events.length === found.length && found.length > 1 ? events : found.map(parcelStatus => ({ parcelStatus })), true);
  return { ...resolved, ...(unique.length === 1 ? { noticeAt: unique[0] } : {}),
    ...(events.length ? { statusEvents: events } : {}), ...(unique.length > 1 && resolved.parcelStatus === 'conflict' ? { timeConflict: true } : {}),
    ...(events.length > 1 && resolved.parcelStatus !== 'conflict' ? { noticeAt: Math.max(...events.map(e => e.noticeAt)) } : {}) };
}
// Pure status labels in a horizontal navigation row are controls, not parcel events.
function withoutNavigation(lines, boxes = []) {
  const label = /^(?:全部|运输中|待取件|已签收|已取件|已领取|已退回|已取消)(?:\s*\d+)?$/;
  const ignored = new Set();
  lines.forEach((line, i) => {
    const a = boxes[i];
    if (!a || !label.test(line.trim())) return;
    const row = lines.map((s, j) => ({ s, j, b: boxes[j] })).filter(({ s, b }) => b && label.test(s.trim()) && Math.abs(b.y - a.y) <= Math.max(a.height, b.height) * .65);
    if (row.length >= 3) row.forEach(({ j }) => ignored.add(j));
  });
  return lines.map((line, i) => ignored.has(i) ? '' : line);
}
module.exports = { inspect, reconcile, statuses, withoutNavigation };
