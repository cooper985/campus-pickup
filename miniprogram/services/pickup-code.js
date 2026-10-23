function validCode(value) {
  if (typeof value !== 'string') return false;
  const code = value.normalize('NFKC').trim().replace(/[—–－﹣−‐‑‒]/g, '-');
  return code.length <= 32 && /\d/.test(code) &&
    /^(?:[A-Za-z]?\d{3,8}|[A-Za-z0-9]{3,8}|[A-Za-z0-9]{1,8}(?:\s*-\s*[A-Za-z0-9]{1,8}){1,3})$/.test(code) &&
    !/^1\d{10}$/.test(code.replace(/\D/g, '')) &&
    !/^(?:19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(code);
}
module.exports = { validCode };
