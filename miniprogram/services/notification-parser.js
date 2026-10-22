const { UNKNOWN } = require('./pickup-parser');
const { metadata } = require('./pickup-duplicates');
const signatures = { '邮政': '中国邮政', '中国邮政': '中国邮政', '邮政快递': '中国邮政', 'EMS': '中国邮政', '京东': '京东物流', '京东快递': '京东物流', '京东物流': '京东物流', '中通': '中通快递', '圆通': '圆通速递', '申通': '申通快递', '韵达': '韵达快递', '极兔': '极兔速递', '顺丰': '顺丰速运', '德邦': '德邦快递' };
const token = '[A-Za-z0-9]{1,8}(?:\\s*-\\s*[A-Za-z0-9]{1,8}){1,3}|\\d{4,8}';
function validCode(code) {
  const digits = code.replace(/\D/g, '');
  return /\d/.test(code) && code.length <= 32 && digits.length <= 8 &&
    !/^(?:19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(code);
}
function places(text) {
  const names = [];
  const pattern = /(?:已派送至|已送(?:达|至)|已到(?:达)?|已放(?:至|在)|已存(?:至|放(?:在|至))|自提地点|自提点|取件地址|取件地点|取货地址|请(?:您)?(?:前往|到)|(?:凭|凭借)[^，。；\n]{1,40}?(?:前往|到|至))\s*[:：]?\s*([^，,。；;！!\n]+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const name = match[1].replace(/^[【\[“「]|[】\]”」]$/g, '').replace(/(?:[，,]|请|凭|领取|提取|取件|取货|取包裹|拿取).*$/, '').trim();
    if (name.length >= 2 && name.length <= 100 && /[\u4e00-\u9fff]/.test(name) &&
      !/电话|运单|单号|https?:|\d{11}|运输中|派送中/.test(name)) names.push(name);
  }
  return [...new Set(names)];
}
function parse(text) {
  const normalized = String(text || '').normalize('NFKC').replace(/[—–－﹣−‐‑‒]/g, '-');
  const blocks = normalized.split(/\n\s*\n|(?=【(?:菜鸟(?:驿站|裹裹)?|(?:中国)?邮政(?:快递|快递包裹)?|EMS|京东(?:物流|快递)?|中通(?:快递)?|圆通(?:速递)?|申通(?:快递)?|韵达(?:快递)?|极兔(?:速递)?|顺丰(?:速运|快递)?|德邦(?:快递)?)】)/).filter(s => s.trim());
  const records = [];
  for (const block of blocks) {
    const codes = [];
    const labels = /(?:取件码|取货码|提货码|领取码|自提码|提取码)\s*(?:为|是)?\s*[:：]?\s*/g;
    let label;
    while ((label = labels.exec(block))) {
      if (/(?:暂无|没有|未生成|查看|查询|获取|输入)\s*$/.test(block.slice(0, label.index))) continue;
      const rest = block.slice(labels.lastIndex);
      const pattern = new RegExp('^\\s*[【\\[（(]?(' + token + ')(?![A-Za-z0-9.\\-:/年月日时分秒元])');
      let remaining = rest, match;
      while ((match = remaining.match(pattern))) {
        const code = match[1].replace(/\s/g, '').toUpperCase();
        if (validCode(code)) codes.push(code);
        remaining = remaining.slice(match[0].length).replace(/^[】\]）)]/, '');
        const separator = remaining.match(/^\s*(?:、|,|和|及|\/|\s+(?=[A-Za-z0-9]))\s*/);
        if (!separator) break;
        remaining = remaining.slice(separator[0].length);
      }
    }
    const credential = new RegExp('凭\\s*[【\\[（(]?(' + token + ')[】\\]）)]?\\s*(?:到|至|前往|领取|取件|取货|提货)', 'g');
    let match;
    while ((match = credential.exec(block))) {
      const code = match[1].replace(/\s/g, '').toUpperCase();
      if (validCode(code)) codes.push(code);
    }
    const locations = places(block);
    const station = locations.length === 1 ? locations[0] : UNKNOWN;
    const info = metadata([block], codes.length);
    // A platform signature alone does not identify the parcel's carrier.
    const signature = block.match(/^\s*【([^】]+)】/);
    const carrier = metadata([block], 1).carrier || (signature && signatures[signature[1]]) || '';
    for (const code of [...new Set(codes)]) records.push({ code, station, carrier, waybillNumber: info.waybillNumber,
      sourceType: 'text', sourceIndex: -1, needsReview: station === UNKNOWN });
  }
  return records;
}
module.exports = { parse };
