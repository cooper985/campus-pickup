// Preview with transforms; keep the DOM and parcel rows in place until release.
function preview(rects, from, delta) {
  delta = Math.max(rects[0].top - rects[from].top, Math.min(delta, rects[rects.length - 1].bottom - rects[from].bottom));
  const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
  let target = from, passed = 0;
  if (delta > 0) {
    while (target + 1 < rects.length) {
      const distance = rects[target + 1].bottom - rects[target + 1].top + gap;
      if (delta <= passed + distance / 2) break;
      passed += distance; target++;
    }
  } else {
    while (target > 0) {
      const distance = rects[target - 1].bottom - rects[target - 1].top + gap;
      if (-delta <= passed + distance / 2) break;
      passed += distance; target--;
    }
  }
  const distance = rects[from].bottom - rects[from].top + gap;
  return { target, offsets: rects.map((_, i) => i === from ? delta
    : i > from && i <= target ? -distance : i < from && i >= target ? distance : 0) };
}
function reorder(state, visibleIds, from, to) {
  const ids = visibleIds.slice();
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  let index = 0;
  return { ...state, groups: state.groups.map(g => {
    if (!visibleIds.includes(g.id)) return g;
    const id = ids[index++];
    return state.groups.find(item => item.id === id);
  }) };
}
module.exports = { preview, reorder };
