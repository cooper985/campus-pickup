const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { page } = require('./helpers/page');
const { fakeStorage } = require('./helpers/storage');
const storage = require('../miniprogram/services/pickup-store');

test('V3.0 暖纸关键文字和按钮组合对比度至少 4.5:1', () => {
  const css = fs.readFileSync('miniprogram/app.wxss', 'utf8');
  const colors = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\dA-F]{6})/g)].map(m => [m[1], m[2]]));
  const luminance = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  for (const [foreground, background] of [['text', 'page'], ['secondary', 'page'], ['secondary', 'card'], ['card', 'primary'], ['accent-ink', 'surface'], ['danger', 'card']]) {
    const [high, low] = [luminance(colors[foreground]), luminance(colors[background])].sort((a, b) => b - a);
    assert.ok((high + .05) / (low + .05) >= 4.5, `${foreground}/${background}`);
  }
});

test('V3.0 长取件码复制保留所有字母和分隔符，不改动记录', () => {
  const wx = fakeStorage(); let copied, feedback;
  wx.setClipboardData = ({ data, success }) => { copied = data; success(); };
  wx.showToast = options => { feedback = options; };
  const p = page(wx), record = storage.newRecord({ code: 'AB12-345678-901234', station: '北门驿站' });
  p.persistRecords([record]);
  const before = JSON.stringify(p.data.records);
  p.copyCode({ currentTarget: { dataset: { id: record.id } } });
  assert.equal(copied, record.code);
  assert.equal(feedback.title, '取件码已复制');
  assert.equal(JSON.stringify(p.data.records), before);
  p.onUnload();
});
