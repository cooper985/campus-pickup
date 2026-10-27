const { UNKNOWN } = require('./pickup-parser');
const { boundary, suspicious } = require('./station-name');
const KEY = 'campus-pickup.stations';
const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[—–－﹣−‐‑‒]/g, '-').replace(/[\s\u200b，,。!！?？:：;；、·•“”"'‘’()（）【】\[\]<>《》]/g, '');
const uniqueAliases = aliases => aliases.filter((a, i) => aliases.findIndex(b => normalize(a) === normalize(b)) === i);
const known = value => !!normalize(value) && !/^(待确认|待确认地点|地点待确认|未知地点|未知)$/.test(normalize(value));
const reliable = name => known(name) && String(name).length <= 100 && !suspicious(name) &&
  !/^(?:菜鸟驿站|妈妈驿站|快递驿站|驿站|快递柜|自提点|服务站|便利店|超市)$/.test(normalize(name)) &&
  !/取件码|运单|单号|咨询|电话|https?:|\d{11}|^今日到站|^等待领取|^待取件/.test(name);
const canonical = name => {
  const value = String(name || '').trim(), clean = boundary(value);
  const tail = value.slice(clean.length).replace(/^[，,。；;！!\s]+/, '');
  return clean !== value && /^(?:尽早|尽快|及时|今早|今晚|今日|今天|明早|明天|请|可凭|凭码|您|领取|提取|取件|取货|提货|取包裹|拿取)/.test(tail) && reliable(clean) ? clean : value;
};
const isConfirmed = g => g.confirmed === true || g.discoveryStatus === 'confirmed' || !g.discoveryStatus && g.aliases.some(a => normalize(a) !== normalize(g.name));
const empty = () => ({ version: 1, groups: [] });
function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.groups)) throw Error('驿站设置格式异常');
  if (state.deletedNames !== undefined && (!Array.isArray(state.deletedNames) || state.deletedNames.some(n => typeof n !== 'string' || n.length > 150))) throw Error('驿站删除设置异常');
  for (const field of ['deletedIds']) if (state[field] !== undefined && (!Array.isArray(state[field]) || state[field].some(n => typeof n !== 'string' || n.length > 150))) throw Error('驿站删除设置异常');
  const ids = new Set(), keys = new Set();
  for (const g of state.groups) {
    if (!g || typeof g.id !== 'string' || !g.id || ids.has(g.id) || typeof g.name !== 'string' ||
      g.name.length > 100 || !known(g.name) || !Array.isArray(g.aliases) || !g.aliases.length) throw Error('驿站设置格式异常');
    ids.add(g.id);
    if (g.discoveryStatus !== undefined && !['confirmed', 'discovered'].includes(g.discoveryStatus)) throw Error('驿站状态异常');
    for (const field of ['redirectIds', 'revokedAliases']) if (g[field] !== undefined && (!Array.isArray(g[field]) || g[field].some(a => typeof a !== 'string' || a.length > 150))) throw Error('驿站关联异常');
    if (g.confirmed !== undefined && typeof g.confirmed !== 'boolean' || g.pickupAddress !== undefined && (typeof g.pickupAddress !== 'string' || g.pickupAddress.length > 100)) throw Error('驿站记忆格式异常');
    for (const alias of g.aliases) {
      if (typeof alias !== 'string' || alias.length > 100 || !known(alias) || keys.has(normalize(alias))) throw Error('驿站别名格式异常');
      keys.add(normalize(alias));
    }
  }
  return state;
}
function createStore(api) {
  let baseline, blocked = false;
  const read = () => api.getStorageInfoSync().keys.includes(KEY) ? api.getStorageSync(KEY) : undefined;
  return {
    load() {
      try {
        baseline = read();
        if (baseline === undefined && api.getStorageInfoSync().keys.includes(`${KEY}.backup`)) throw Error('主设置缺失');
        return { state: baseline === undefined ? empty() : validate(baseline), error: '' };
      }
      catch (_) { blocked = true; return { state: empty(), error: '驿站设置读取异常，已暂停设置保存；请重启重试，请勿清理缓存。' }; }
    },
    save(state) {
      validate(state);
      if (blocked) throw Error('驿站设置已暂停保存，请重启核对。');
      try {
        if (JSON.stringify(read()) !== JSON.stringify(baseline)) throw Error('驿站设置已变化');
        if (baseline !== undefined) {
          api.setStorageSync(`${KEY}.backup`, baseline);
          if (JSON.stringify(api.getStorageSync(`${KEY}.backup`)) !== JSON.stringify(baseline)) throw Error('备份失败');
        }
        api.setStorageSync(KEY, state);
        if (JSON.stringify(read()) !== JSON.stringify(state)) throw Error('保存校验失败');
        baseline = JSON.parse(JSON.stringify(state));
        return baseline;
      } catch (_) { blocked = true; throw Error('驿站设置保存未确认成功，页面保留原设置；请重启核对，请勿清理缓存。'); }
    }
  };
}
function deleted(state, name, id) {
  return !!id && (state.deletedIds || []).includes(id) || (state.deletedNames || []).some(n => n === normalize(name) || n === normalize(canonical(name)));
}
function match(state, name, clean = true) {
  if (!known(name)) return null;
  const key = normalize(name);
  const exact = state.groups.filter(g => [g.name, ...g.aliases].some(a => normalize(a) === key));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { id: '__unknown', name: UNKNOWN };
  if (!clean || deleted(state, name)) return null;
  const normalized = normalize(canonical(name));
  const matches = state.groups.filter(g => reliable(g.name) && [g.name, ...g.aliases].some(a => normalize(a) === normalized));
  return matches.length === 1 ? matches[0] : matches.length > 1 ? { id: '__unknown', name: UNKNOWN } : null;
}
function nextId(state, name) {
  let id = normalize(name);
  while (state.groups.some(g => g.id === id || (g.redirectIds || []).includes(id)) || (state.deletedIds || []).includes(id)) id += '-new';
  return id;
}
function sync(state, records) {
  const next = JSON.parse(JSON.stringify(state));
  // Only repair unconfirmed legacy labels; records and manually confirmed names stay intact.
  for (const g of next.groups.slice()) {
    if (isConfirmed(g) || !suspicious(g.name) || records.some(r => (r.confirmedFields || []).includes('station') && (r.stationId === g.id || normalize(r.station) === normalize(g.name)))) continue;
    const name = canonical(g.name);
    if (!reliable(name) || deleted(next, name)) continue;
    const target = next.groups.find(other => other.id !== g.id && normalize(other.name) === normalize(name));
    if (target) {
      target.redirectIds = [...new Set([...(target.redirectIds || []), g.id, ...(g.redirectIds || [])])];
      // An established alias is never discarded by an automatic label repair.
      target.aliases = [...new Set([...target.aliases, ...g.aliases.filter(a => !suspicious(a))])];
      next.groups = next.groups.filter(other => other.id !== g.id);
    } else { g.legacyName = g.name; g.name = name; g.aliases = [...new Set([name, ...g.aliases.filter(a => !suspicious(a))])]; }
  }
  for (const r of records) {
    if (deleted(next, r.station, r.stationId)) continue;
    const locked = (r.confirmedFields || []).includes('station');
    const name = locked ? r.station : canonical(r.station);
    if (!reliable(name) || match(next, name, !locked)) continue;
    next.groups.push({ id: nextId(next, name), name: name.trim(), aliases: [name.trim()], discoveryStatus: locked ? 'confirmed' : 'discovered', confirmed: locked });
  }
  return next;
}
function resolve(state, name, record = {}) {
  const locked = (record.confirmedFields || []).includes('station');
  const byId = state.groups.find(g => g.id === record.stationId || (g.redirectIds || []).includes(record.stationId));
  if (!known(name)) return byId && reliable(byId.name) ? byId : { id: '__unknown', name: UNKNOWN };
  const original = record.originalPickupLocation || name;
  if (byId && !(reliable(name) && /^(?:营业|工作|开放|服务)时间/.test(byId.name)) && !(byId.revokedAliases || []).some(a => normalize(a) === normalize(original) || normalize(a) === normalize(name)) &&
      [byId.name, ...byId.aliases, byId.legacyName].filter(Boolean).some(a => normalize(a) === normalize(name) || !locked && normalize(a) === normalize(canonical(name)))) return byId;
  if (byId && (byId.revokedAliases || []).some(a => normalize(a) === normalize(original))) name = original;
  const found = match(state, name, !locked);
  if (found && !(reliable(name) && /^(?:营业|工作|开放|服务)时间/.test(found.name)) && (!locked || !found.legacyName || normalize(name) !== normalize(found.legacyName))) return found;
  const display = locked ? name : canonical(name);
  return reliable(display) || locked ? { id: state.groups.some(g => g.id === normalize(display)) ? 'unmapped-' + normalize(display) : normalize(display), name: display } : { id: '__unknown', name: UNKNOWN };
}
function natural(a, b) {
  const parts = code => String(code).normalize('NFKC').toUpperCase().replace(/[—–－﹣−‐‑‒]/g, '-').replace(/\s*-\s*/g, '-').match(/\d+|\D+/g) || [];
  const x = parts(a.code), y = parts(b.code);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    let diff;
    if (/^\d+$/.test(x[i]) && /^\d+$/.test(y[i])) {
      const n = x[i].replace(/^0+(?=\d)/, ''), m = y[i].replace(/^0+(?=\d)/, '');
      diff = n.length - m.length || (n < m ? -1 : n > m ? 1 : 0);
    } else diff = x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0;
    if (diff) return diff;
  }
  return x.length - y.length;
}
function group(state, records) {
  const result = [];
  records.forEach((r, index) => {
    const station = resolve(state, r.station, r);
    let g = result.find(g => g.id === station.id);
    if (!g) { g = { id: station.id, station: station.name, items: [] }; result.push(g); }
    g.items.push({ record: r, index });
  });
  result.forEach(g => { g.items.sort((a, b) => natural(a.record, b.record) || a.index - b.index); g.items = g.items.map(i => i.record); });
  const rank = id => { const i = state.groups.findIndex(g => g.id === id); return i < 0 ? state.groups.length : i; };
  return result.sort((a, b) => rank(a.id) - rank(b.id));
}
function merge(state, ids, name) {
  const selected = ids.map(id => state.groups.find(g => g.id === id)).filter(Boolean);
  name = name.trim();
  if (selected.length !== 2 || selected[0].id === selected[1].id || !reliable(name) || name.length > 100) throw Error('请选择两个驿站，并填写有效的统一名称。');
  if (state.groups.some(g => !ids.includes(g.id) && [g.name, ...g.aliases].some(a => normalize(a) === normalize(name)))) throw Error('名称已属于其他驿站，请选择该驿站合并。');
  const aliases = uniqueAliases([name, ...selected.flatMap(g => [...g.aliases, g.name])]);
  const revoked = uniqueAliases(selected.flatMap(g => g.revokedAliases || [])).filter(a => !aliases.some(b => normalize(a) === normalize(b)));
  return { ...state, groups: state.groups.filter(g => g.id !== selected[1].id).map(g => g.id === selected[0].id ? { ...g, name, aliases, confirmed: true, discoveryStatus: 'confirmed', redirectIds: [...new Set([...(g.redirectIds || []), selected[1].id, ...(selected[1].redirectIds || [])])], revokedAliases: revoked } : g) };
}
function assist(state, candidate) {
  let resolved = resolve(state, candidate.station, candidate);
  if (!known(candidate.station) && candidate.pickupAddress) {
    const matches = state.groups.filter(g => isConfirmed(g) && reliable(g.name) && g.pickupAddress && normalize(g.pickupAddress) === normalize(candidate.pickupAddress));
    if (matches.length === 1) resolved = matches[0];
  }
  const g = state.groups.find(g => g.id === resolved.id);
  const station = resolved.name;
  const result = { ...candidate, originalPickupLocation: candidate.originalPickupLocation || candidate.station, station };
  delete result.stationId;
  if (g || reliable(station) && !deleted(state, station)) result.stationId = g ? g.id : nextId(state, station);
  if (g && !candidate.pickupAddress && isConfirmed(g) && g.pickupAddress) Object.assign(result, { pickupAddress: g.pickupAddress, memoryAddress: true });
  return result;
}
function remember(state, record, alias) {
  if (!reliable(record.station)) throw Error('请填写具体地点，且不要包含通知正文');
  const restored = { ...state, ...(state.deletedNames ? { deletedNames: state.deletedNames.filter(n => n !== normalize(record.station) && n !== normalize(canonical(record.station))) } : {}) };
  const next = sync(restored, [{ ...record, stationId: undefined }]);
  const g = match(next, record.station);
  if (g) {
    g.confirmed = true; g.discoveryStatus = 'confirmed';
    if (record.pickupAddress !== undefined) g.pickupAddress = record.pickupAddress;
    if (alias && normalize(alias) !== normalize(g.name)) {
      const source = match(next, alias, false);
      if (source && source.id !== g.id && !isConfirmed(source) && source.aliases.every(a => normalize(a) === normalize(alias))) {
        return merge(next, [g.id, source.id], g.name);
      }
      return addAlias(next, g.id, alias);
    }
  }
  return next;
}
function addAlias(state, id, alias) {
  alias = String(alias || '').trim();
  if (!reliable(alias)) throw Error('请填写具体地点别名，且不要包含通知正文');
  if (state.groups.some(g => g.id !== id && [g.name, ...g.aliases].some(a => normalize(a) === normalize(alias)))) throw Error('此别名已属于另一驿站，请先取消原关联或明确合并。');
  if (deleted(state, alias)) throw Error('此地点已被删除，请先重新启用。');
  return { ...state, groups: state.groups.map(g => g.id === id ? { ...g, confirmed: true, discoveryStatus: 'confirmed',
    aliases: g.aliases.some(a => normalize(a) === normalize(alias)) ? g.aliases : [...g.aliases, alias],
    revokedAliases: (g.revokedAliases || []).filter(a => normalize(a) !== normalize(alias)) } : g) };
}
function unlink(state, id, alias) {
  const group = state.groups.find(g => g.id === id);
  if (!group || !group.aliases.includes(alias) || normalize(alias) === normalize(group.name)) throw Error('标准名称不能取消关联，请先修改名称');
  const next = { ...state, groups: state.groups.map(g => g.id === id ? { ...g, aliases: g.aliases.filter(a => a !== alias), revokedAliases: [...new Set([...(g.revokedAliases || []), alias])] } : g) };
  if (!match(next, alias, false)) next.groups.push({ id: nextId(next, alias), name: alias, aliases: [alias], confirmed: true, discoveryStatus: 'confirmed' });
  return next;
}
function remove(state, id) {
  const g = state.groups.find(g => g.id === id);
  if (!g) return state;
  return { ...state, groups: state.groups.filter(g => g.id !== id),
    deletedIds: [...new Set([...(state.deletedIds || []), id, ...(g.redirectIds || [])])],
    deletedNames: [...new Set([...(state.deletedNames || []), ...[g.name, ...g.aliases].flatMap(n => [normalize(n), normalize(canonical(n))])])] };
}
function suggestions(state) {
  const pairs = [];
  state.groups.forEach((a, i) => state.groups.slice(i + 1).forEach(b => {
    const x = normalize(a.name).replace(/菜鸟|快递|驿站|服务站/g, ''), y = normalize(b.name).replace(/菜鸟|快递|驿站|服务站/g, '');
    if (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) pairs.push(`${a.name} / ${b.name}`);
  }));
  return pairs.slice(0, 3);
}
module.exports = { KEY, normalize, uniqueAliases, validate, known, createStore, sync, resolve, natural, group, merge, suggestions, assist, remember, remove, suspicious, reliable, canonical, deleted, addAlias, unlink };
