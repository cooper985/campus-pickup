const vm = require("node:vm");
const fs = require("node:fs");
const { fakeStorage } = require("./storage");
function page(wx = fakeStorage(), recognize = async () => ({ mock: true, lines: ['北门驿站', '取件码1-2-3456'] }), source, services = {}) {
  let result;
  wx.showModal ||= async () => ({ confirm: true });
  vm.runInNewContext(source || fs.readFileSync('miniprogram/pages/pickup/index.js', 'utf8'), {
    require: name => services[name.split('/').pop()] || (/(?:cloud|fileid|mock)-ocr$/.test(name) ? { recognize } : require('../../miniprogram/services/' + name.split('/').pop())),
    wx, setTimeout, clearTimeout, console: { info() {} }, Page: p => { result = p; },
  });
  result.setData = function(data) { for (const [path, value] of Object.entries(data)) {
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = this.data;
    parts.slice(0, -1).forEach(key => { target = target[key]; });
    target[parts[parts.length - 1]] = value;
  } if (arguments[1]) arguments[1](); };
  result.onLoad();
  return result;
}
module.exports = { page };
