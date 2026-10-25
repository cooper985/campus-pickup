function validCode(value) {
  if (typeof value !== 'string') return false;
  const code = value.normalize('NFKC').trim().replace(/[—–－﹣−‐‑‒]/g, '-');
  return code.length <= 32 && /\d/.test(code) &&
    /^(?:[A-Za-z]?\d{3,8}|[A-Za-z0-9]{3,8}|[A-Za-z0-9]{1,8}(?:\s*-\s*[A-Za-z0-9]{1,8}){1,3})$/.test(code) &&
    !/^1\d{10}$/.test(code.replace(/\D/g, '')) &&
    !/^(?:19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(code);
}
function codeLabels() {
  return /(?:取件码|取货码|提货码|提货号|领取码|自提码|提取码|取件密码|凭码(?:领取|取件|取货|提货))\s*(?:为|是)?\s*[:：]?\s*/g;
}
module.exports = { validCode, codeLabels };
