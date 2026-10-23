const { UNKNOWN } = require('./pickup-parser');
const { metadata } = require('./pickup-duplicates');
const { validCode } = require('./pickup-code');
const signatures = { '邮政': '中国邮政', '中国邮政': '中国邮政', '邮政快递': '中国邮政', 'EMS': '中国邮政', '京东': '京东物流', '京东快递': '京东物流', '京东物流': '京东物流', '中通': '中通快递', '圆通': '圆通速递', '申通': '申通快递', '韵达': '韵达快递', '极兔': '极兔速递', '顺丰': '顺丰速运', '德邦': '德邦快递' };
const token = '[A-Za-z0-9]{1,9}(?:\\s*-\\s*[A-Za-z0-9]{1,8}){0,3}';
const codeHead = new RegExp('^\\s*[【\\[（(“"]?\\s*(' + token + ')(?![A-Za-z0-9.\\-:/年月日时分秒元])');
function places(text) {
  const result = [];
  const pattern = /(?:已(?:派送至|送(?:到|达|至)|到达?|放(?:至|在)|存(?:入|至|放(?:在|至)))|(?:快递|包裹)(?:现)?(?:到达?|在|放在|存入)|自提地点|自提点|取件地址|取件地点|取货地址|请(?:您)?(?:前往|到)|(?:凭|凭借)[^，,。；;\n]{1,40}?(?:前往|到|至))\s*[:：]?\s*([^，,。；;！!\n]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (/(?:未|没|预计|即将|将|尚未|还未)\s*$/.test(text.slice(0, match.index))) continue;
    const name = match[1].replace(/^[【\[“「(]/, '').replace(/(?:请|凭|领取|提取|取件|取货|提货|取包裹|拿取).*$/, '').replace(/[】\]”」)]$/, '').trim();
    if (name.length >= 2 && name.length <= 100 && /[\u4e00-\u9fff]/.test(name) &&
      !/电话|运单|单号|https?:|\d{11}|运输中|派送中|验证码/.test(name)) result.push({ name, index: match.index });
  }
  return result;
}
function carrier(text) {
  const signature = text.match(/^\s*【([^】]+)】/);
  const names = [...new Set(Array.from(text.matchAll(/(中通|圆通|申通|韵达|极兔|顺丰|德邦|京东|邮政)(?:的)?(?:快递|包裹|物流|速运|速递)/g), m => signatures[m[1]]))];
  return names.length > 1 ? '' : metadata([text], 1).carrier || names[0] || (signature && signatures[signature[1]]) || '';
}
function parse(text) {
  const normalized = String(text || '').normalize('NFKC').replace(/[—–－﹣−‐‑‒]/g, '-');
  const blocks = normalized.split(/\n\s*\n|(?=【(?:菜鸟(?:驿站|裹裹)?|(?:中国)?邮政(?:快递|快递包裹)?|EMS|京东(?:物流|快递)?|中通(?:快递)?|圆通(?:速递)?|申通(?:快递)?|韵达(?:快递)?|极兔(?:速递)?|顺丰(?:速运|快递)?|德邦(?:快递)?)】)|(?=(?:另一个|另一件|另外一件|下一个)(?:包裹|快递))/).filter(s => s.trim());
  const records = [];
  for (const block of blocks) {
    const codes = [], excluded = [];
    const otherNumbers = /(?:验证码|校验码|动态码|登录码|电话|运单号|快递单号|物流单号)\s*(?:为|是)?\s*[:：]?\s*([A-Za-z0-9-]+)/g;
    let match;
    while ((match = otherNumbers.exec(block))) excluded.push(match[1].toUpperCase());
    const add = (value, index, anchor) => {
      const code = value.replace(/\s/g, '').toUpperCase();
      if (validCode(code) && !excluded.includes(code) && !codes.some(c => c.code === code && Math.abs(c.index - index) < 3)) codes.push({ code, index, anchor });
    };
    const labels = /(?:取件码|取货码|提货码|领取码|自提码|提取码|取件密码|凭码(?:领取|取件|取货|提货))\s*(?:为|是)?\s*[:：]?\s*/g;
    let label;
    while ((label = labels.exec(block))) {
      if (/(?:暂无|没有|未生成|查看|查询|获取|输入)\s*$/.test(block.slice(0, label.index))) continue;
      let remaining = block.slice(labels.lastIndex), offset = labels.lastIndex;
      while ((match = remaining.match(codeHead))) {
        add(match[1], offset, label.index);
        offset += match[0].length;
        remaining = remaining.slice(match[0].length);
        const separator = remaining.match(/^[】\]）)”"]?\s*(?:、|,|和|及|\/|\s+(?=[A-Za-z0-9]))\s*/);
        if (!separator) break;
        remaining = remaining.slice(separator[0].length); offset += separator[0].length;
      }
    }
    const credential = new RegExp('凭(?:码)?\\s*[:：]?\\s*[【\\[（(]?\\s*(' + token + ')\\s*[】\\]）)]?\\s*(?:到|至|前往|领取|取件|取货|提货)', 'g');
    while ((match = credential.exec(block))) add(match[1], match.index, match.index);
    codes.sort((a, b) => a.index - b.index);
    const locations = places(block);
    const sentences = Array.from(block.matchAll(/[^。；;！!\n]+/g), m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
    const sentenceAt = index => sentences.find(s => s.start <= index && index < s.end);
    codes.forEach(c => { c.sentence = sentenceAt(c.index); });
    locations.forEach(p => { p.sentence = sentenceAt(p.index); });
    const info = metadata([block], codes.length), blockCarrier = carrier(block);
    // Decide direction per sentence; a whole-message direction can attach a later parcel to the previous station.
    codes.forEach((entry, i) => {
      const sentence = entry.sentence;
      const localCodes = codes.filter(c => c.sentence === sentence);
      const localPlaces = locations.filter(p => p.sentence === sentence);
      const names = [...new Set(localPlaces.map(p => p.name))];
      let candidates = localPlaces;
      if (names.length > 1 && localCodes.length > 1) {
        const before = localPlaces[0].index < localCodes[0].index;
        candidates = localPlaces.filter(p => before
          ? p.index <= entry.index && p.index > (i ? codes[i - 1].index : -1)
          : p.index > entry.index && p.index < (codes[i + 1] ? codes[i + 1].index : block.length));
      } else if (!localPlaces.length) {
        const siblings = codes.filter(c => c.anchor === entry.anchor);
        const first = codes.indexOf(siblings[0]), last = codes.indexOf(siblings[siblings.length - 1]);
        const before = locations.length && locations[0].index < codes[0].anchor;
        candidates = locations.filter(p => before
          ? p.index < codes[first].anchor && p.index > (first ? codes[first - 1].index : -1)
          : p.index > codes[last].index && p.index < (codes[last + 1] ? codes[last + 1].anchor : block.length));
      }
      const unique = [...new Set(candidates.map(p => p.name))];
      let station = unique.length === 1 ? unique[0] : UNKNOWN;
      if (!candidates.length && i && entry.anchor === codes[i - 1].anchor) station = records[records.length - 1].station;
      records.push({ code: entry.code, station, carrier: (sentence && carrier(sentence.text)) || blockCarrier, waybillNumber: info.waybillNumber,
        sourceType: 'text', sourceIndex: -1, needsReview: station === UNKNOWN });
    });
  }
  return records;
}
module.exports = { parse };
