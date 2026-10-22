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
  result.setData = function(data) { Object.assign(this.data, data); if (arguments[1]) arguments[1](); };
  result.onLoad();
  return result;
}
module.exports = { page };
