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

// The same owned rows feed events, identity metadata and the displayed evidence.
function parcelRows(lines, boxes, anchors, places, index, inspect) {
  const validBox = i => {
    const b = boxes[i];
    return b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0 ? b : null;
  };
  const anchor = validBox(index);
  const compatible = i => {
    const b = validBox(i);
    return !anchor || !b || Math.min(anchor.x + anchor.width, b.x + b.width) - Math.max(anchor.x, b.x) >= -Math.max(anchor.height, b.height) * 2;
  };
  const rows = lines.map((_, i) => i).filter(i => lines[i] && compatible(i)).sort((i, j) => {
    const a = validBox(i), b = validBox(j);
    return a && b ? a.y - b.y || a.x - b.x || i - j : i - j;
  });
  const ids = new Set(anchors.map(a => a.i));
  const section = sectionBounds(lines, boxes, index);
  if (section && rows.filter(i => i >= section.start && i <= section.end && ids.has(i)).length === 1) {
    return { indices: rows.filter(i => i >= section.start && i <= section.end), reliable: true };
  }
  const at = rows.indexOf(index), firstCode = rows.findIndex(i => ids.has(i));
  const headings = new Set(places.filter(p => !p.explicit && !p.detail && !places.some(other => other.i === p.i && other.explicit)).map(p => p.i));
  const firstHeading = rows.findIndex((i, pos) => pos < firstCode && headings.has(i));
  const boundaries = rows.map((i, pos) => ({ i, pos })).filter(({ i }) =>
    /^(?:另一个|另一件|另外一件|下一个)(?:包裹|快递)/.test(lines[i]));
  if (firstHeading >= 0) rows.forEach((i, pos) => {
    if (pos === firstHeading || pos > firstCode && headings.has(i) && rows.slice(pos + 1).some(j => ids.has(j) || inspect(lines[j]).parcelStatus !== 'unknown')) boundaries.push({ i, pos });
  });
  boundaries.sort((a, b) => a.pos - b.pos);
  const start = boundaries.filter(b => b.pos <= at).pop();
  const end = boundaries.find(b => b.pos > at);
  const group = rows.slice(start ? start.pos : 0, end ? end.pos : rows.length);
  const local = group.filter(i => ids.has(i));
  const events = group.filter(i => inspect(lines[i]).parcelStatus !== 'unknown');
  const orphan = start && rows.slice(0, start.pos).some(i => !ids.has(i) && /collected|cancelled|signed|transit|conflict/.test(inspect(lines[i]).parcelStatus)) &&
    !rows.slice(0, start.pos).some(i => ids.has(i));
  if (local.length === 1) {
    const nearby = events.every(i => {
      const b = validBox(i);
      return !anchor || !!b && Math.abs(b.y - anchor.y) <= Math.max(anchor.height, b.height) * 8;
    });
    const before = events.some(i => group.indexOf(i) < group.indexOf(index));
    const prefix = orphan ? rows.slice(0, start.pos).filter(i => inspect(lines[i]).parcelStatus !== 'unknown') : [];
    return { indices: [...prefix, ...group], reliable: anchors.filter(a => a.i === index).length === 1 && !orphan && nearby && (!before || !!start && !!anchor) };
  }
  // Repeated code/status pairs establish direction; proximity alone does not.
  const tokens = group.filter(i => ids.has(i) || events.includes(i));
  const paired = tokens.length === local.length * 2 && tokens.every((i, n) =>
    ids.has(i) !== events.includes(i) && ids.has(i) === (n % 2 === (ids.has(tokens[0]) ? 0 : 1)));
  if (paired) {
    const position = local.indexOf(index), before = !ids.has(tokens[0]);
    const from = position === 0 ? 0 : group.indexOf(tokens[position * 2]);
    const to = position + 1 < local.length ? group.indexOf(tokens[(position + 1) * 2]) : group.length;
    const indices = group.slice(from, to);
    const eventIndex = tokens[position * 2 + (before ? 0 : 1)], b = validBox(eventIndex);
    return { indices, reliable: !orphan && !!anchor && !!b && Math.abs(b.y - anchor.y) <= Math.max(anchor.height, b.height) * 8 };
  }
  return { indices: group, reliable: false };
}
module.exports.parcelRows = parcelRows;
