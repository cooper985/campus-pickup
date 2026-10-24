const normalize = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[—–－﹣−‐‑‒]/g, '-').replace(/\s/g, '');
const validWaybill = value => /^(?=[A-Z0-9]{10,30}$)(?=.*\d)[A-Z0-9]+$/.test(normalize(value));
const known = value => !!normalize(value) && !/^(待确认|待确认地点|地点待确认)$/.test(normalize(value));
const carrierKey = value => normalize(value).replace(/速运|快递|物流|速递/g, '');
function sameWaybill(a, b) { return validWaybill(a.waybillNumber) && validWaybill(b.waybillNumber) && normalize(a.waybillNumber) === normalize(b.waybillNumber); }
function differentWaybill(a, b) { return validWaybill(a.waybillNumber) && validWaybill(b.waybillNumber) && !sameWaybill(a, b); }
function same(a, b, stationKey = normalize) {
  if (differentWaybill(a, b)) return false;
  if (sameWaybill(a, b)) return true;
  if (!a.code || normalize(a.code) !== normalize(b.code)) return false;
  // Code reuse is common; require an additional matching identity field.
  return known(a.station) && known(b.station) && stationKey(a.station) === stationKey(b.station) ||
    !!a.noticeAt && a.noticeAt === b.noticeAt && !!a.carrier && carrierKey(a.carrier) === carrierKey(b.carrier);
}
const labels = { code: '取件码', station: '驿站', pickupAddress: '详细地址', carrier: '快递公司', waybillNumber: '运单号', parcelStatus: '物流状态', noticeAt: '通知时间', identity: '包裹身份' };
function conflicts(a, b, stationKey = normalize) {
  return ['code', 'station', 'pickupAddress', 'carrier', 'waybillNumber'].filter(f => {
    if (!(f === 'station' ? known(a[f]) && known(b[f]) : a[f] && b[f])) return false;
    const key = f === 'station' ? stationKey : f === 'carrier' ? carrierKey : normalize;
    return key(a[f]) !== key(b[f]);
  });
}
module.exports = { normalize, validWaybill, known, carrierKey, sameWaybill, differentWaybill, same, conflicts, labels };
