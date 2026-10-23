// Notification evidence only; upload time and file creation time are never logistics evidence.
function inspect(value) {
  const text = String(value || '').normalize('NFKC');
  const terminal = /已取件|已领取|取件完成|已取消|已退回|已退件/.test(text);
  const signed = /已签收/.test(text);
  const pending = /待取件|等待领取|已入库|已到站|已送达.*(?:驿站|服务站|快递柜)|凭[^。\n]{1,40}(?:取|领取)/.test(text);
  const dates = [];
  for (const match of text.matchAll(/(?:通知时间|入库时间|到站时间|送达时间|取件时间)?\s*[:：]?\s*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/g)) {
    if (/创建|拍摄|保存|上传|下单|订单|生产|保质|截止|过期|有效/.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
    const [, y, m, d, h = '0', min = '0'] = match;
    const date = new Date(+y, +m - 1, +d, +h, +min);
    if (date.getFullYear() === +y && date.getMonth() === +m - 1 && date.getDate() === +d && +h < 24 && +min < 60) dates.push(date.getTime());
  }
  const unique = [...new Set(dates)];
  return { parcelStatus: terminal && pending ? 'conflict' : terminal ? 'terminal' : signed ? 'signed' : pending ? 'pending' : 'unknown',
    ...(unique.length === 1 ? { noticeAt: unique[0] } : {}), ...(unique.length > 1 ? { timeConflict: true } : {}) };
}
module.exports = { inspect };
