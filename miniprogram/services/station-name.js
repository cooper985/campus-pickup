// Semantic boundaries preserve branches/areas; never truncate by a character count.
function boundary(value) {
  return String(value || '').trim().replace(/(?:[，,。；;！!]|(?:今早|今晚|今日|今天|明早|明天|尽早|尽快|及时)(?:请|来|取|领)|(?:请您|请|可凭|凭码|您(?:的)?(?:中通|圆通|申通|韵达|极兔|顺丰|邮政|京东|包裹|快递))|(?:领取|提取|取件(?!区|点|处|柜|站|中心|大厅|窗口|服务)|取货(?!区|点|处|柜|站|中心|大厅|窗口|服务)|提货(?!区|点|处|柜|站|中心|大厅|窗口|服务)|取包裹|拿取)).*$/, '').trim();
}
const suspicious = value => boundary(value) !== String(value || '').trim() || /通知|包裹|取您|快递已|今早取|您的|暂存至|已送达|已到站|^(?:营业|工作|开放|服务)时间/.test(value);
module.exports = { boundary, suspicious };
