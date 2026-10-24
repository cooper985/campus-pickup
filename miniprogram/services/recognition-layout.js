// Counted section headings on a parcel-list page bound events and identity metadata.
// shortcut: other layouts retain the existing conservative parser until labelled evidence exists.
function sectionBounds(lines, boxes, index) {
  if (!lines.some(s => /^我的快递$/.test(s))) return null;
  const headings = lines.map((s, i) => ({ s, i, b: boxes[i] })).filter(({ s, b }) =>
    b && [b.x,b.y,b.width,b.height].every(Number.isFinite) && b.height > 0 &&
    /^(?:公|口)?(?:待取件|已签收|已领取|已退回)\s*\d+$/.test(s));
  // A horizontal row of filter buttons is never a section boundary.
  const sections = headings.filter(a => !lines.some((s, i) => i !== a.i && boxes[i] &&
    /^(?:派送中|运输中|已揽收|已发货|待取件|已签收)(?:\s*\d+)?$/.test(s) &&
    Math.abs(boxes[i].y - a.b.y) < a.b.height));
  const anchor = boxes[index];
  if (sections.length < 2 || !anchor) return null;
  const ordered = sections.sort((a,b) => a.b.y - b.b.y);
  let position = -1;
  ordered.forEach((s, i) => { if (s.b.y <= anchor.y) position = i; });
  if (position < 0 || !/(?:待取件|已签收|已领取|已退回)\s*1$/.test(ordered[position].s)) return null;
  const start = ordered[position].i, next = ordered[position + 1];
  return { start, end: next ? next.i - 1 : lines.length - 1, type: 'parcel_list_section' };
}
module.exports = { sectionBounds };

// A labelled address value may wrap within its own right-hand column.
function addressValue(lines, boxes, labelIndex) {
  const a = boxes[labelIndex], b = boxes[labelIndex + 1];
  if (!a || !b || b.x < a.x + a.width || Math.abs(b.y - a.y) > Math.max(a.height,b.height)) return null;
  let end = labelIndex + 1, value = lines[end];
  while (end + 1 < lines.length) {
    const prev = boxes[end], next = boxes[end + 1];
    if (!next || Math.abs(next.x - b.x) > b.height || next.y <= prev.y ||
      next.y - prev.y - prev.height > Math.max(prev.height,next.height) ||
      /^(?:快递公司|运单号|取件码|提货号|复制|取件地址|取件地点)/.test(lines[end + 1])) break;
    value += lines[++end];
  }
  const destination = value.match(/(?:请(?:您)?到|请前往)(.+)/);
  return { value: destination ? destination[1] : value, end };
}
module.exports.addressValue = addressValue;
