const { UNKNOWN } = require('./pickup-parser');
const KEY = 'campus-pickup.stations';
const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[—–－﹣−‐‑‒]/g, '-').replace(/[\s\u200b，,。!！?？:：;；、·•“”"'‘’()（）【】\[\]<>《》]/g, '');
const known = value => !!normalize(value) && !/^(待确认|待确认地点|地点待确认|未知地点|未知)$/.test(normalize(value));
const empty = () => ({ version: 1, groups: [] });
function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.groups)) throw Error('驿站设置格式异常');
  const ids = new Set(), keys = new Set();
  for (const g of state.groups) {
    if (!g || typeof g.id !== 'string' || !g.id || ids.has(g.id) || typeof g.name !== 'string' ||
      g.name.length > 100 || !known(g.name) || !Array.isArray(g.aliases) || !g.aliases.length) throw Error('驿站设置格式异常');
    ids.add(g.id);
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
function sync(state, records) {
  const next = JSON.parse(JSON.stringify(state));
  for (const r of records) {
    if (known(r.station) && !next.groups.some(g => g.aliases.some(a => normalize(a) === normalize(r.station)) || normalize(g.name) === normalize(r.station))) {
      let id = normalize(r.station);
      while (next.groups.some(g => g.id === id)) id += '-new';
      next.groups.push({ id, name: r.station.trim(), aliases: [r.station.trim()] });
    } else if (known(r.station)) {
      const g = next.groups.find(g => g.aliases.some(a => normalize(a) === normalize(r.station)) || normalize(g.name) === normalize(r.station));
      if (!g.aliases.some(a => normalize(a) === normalize(r.station))) g.aliases.push(r.station.trim());
    }
  }
  return next;
}
function resolve(state, name) {
  if (!known(name)) return { id: '__unknown', name: UNKNOWN };
  return state.groups.find(g => g.aliases.some(a => normalize(a) === normalize(name)) || normalize(g.name) === normalize(name)) || { id: normalize(name), name };
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
    const station = resolve(state, r.station);
    let g = result.find(g => g.id === station.id);
    if (!g) { g = { id: station.id, station: station.name, items: [] }; result.push(g); }
    g.items.push({ record: r, index });
  });
  result.forEach(g => { g.items.sort((a, b) => natural(a.record, b.record) || a.index - b.index); g.items = g.items.map(i => i.record); });
  const rank = id => { const i = state.groups.findIndex(g => g.id === id); return i < 0 ? state.groups.length : i; };
  return result.sort((a, b) => rank(a.id) - rank(b.id));
}
function merge(state, ids, name) {
  const selected = state.groups.filter(g => ids.includes(g.id));
  name = name.trim();
  if (selected.length !== 2 || !known(name) || name.length > 100) throw Error('请选择两个驿站，并填写有效的统一名称。');
  if (state.groups.some(g => !ids.includes(g.id) && [g.name, ...g.aliases].some(a => normalize(a) === normalize(name)))) throw Error('名称已属于其他驿站，请选择该驿站合并。');
  const aliases = [...new Set(selected.flatMap(g => [...g.aliases, g.name]))];
  const unique = aliases.filter((a, i) => aliases.findIndex(b => normalize(a) === normalize(b)) === i);
  return { version: 1, groups: state.groups.filter(g => g.id !== selected[1].id).map(g => g.id === selected[0].id ? { ...g, name, aliases: unique } : g) };
}
function suggestions(state) {
  const pairs = [];
  state.groups.forEach((a, i) => state.groups.slice(i + 1).forEach(b => {
    const x = normalize(a.name).replace(/菜鸟|快递|驿站|服务站/g, ''), y = normalize(b.name).replace(/菜鸟|快递|驿站|服务站/g, '');
    if (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) pairs.push(`${a.name} / ${b.name}`);
  }));
  return pairs.slice(0, 3);
}
module.exports = { KEY, normalize, known, createStore, sync, resolve, natural, group, merge, suggestions };
