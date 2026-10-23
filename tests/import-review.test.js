const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { page } = require('./helpers/page');
const storage = require('../miniprogram/services/pickup-store');
const event = (id, action) => ({ currentTarget: { dataset: { id, action } } });
for (const count of [1, 3, 10, 25]) {
  test(`${count} 条历史同码核对：返回重进保留逐条选择，确认才保存且历史不变`, async () => {
    const p = page();
    const drafts = Array.from({ length: count }, (_, i) => ({ id: `draft-${i}`, code: `A1-${1000 + i}`, station: '测试驿站', carrier: '' }));
    const history = drafts.map(d => storage.updateRecord(storage.newRecord(d), { taken: true }, 1000));
    p.persistRecords(history); p.setDrafts(drafts);
    let run = p.confirmImport();
    assert.equal(p.data.reviewItems.length, count);
    p.data.reviewItems.forEach((entry, i) => {
      assert.equal(entry.allowNew, true);
      p.chooseImportAction(event(entry.id, i % 2 === 0 ? 'new' : 'skip'));
    });
    p.cancelImportReview(); await run;
    assert.equal(p.data.records.length, count);
    assert.equal(p.data.importing, false);
    run = p.confirmImport();
    p.data.reviewItems.forEach((entry, i) => assert.equal(entry.action, i % 2 === 0 ? 'new' : 'skip'));
    p.finishImportReview(); await run;
    assert.equal(p.data.records.length, count + Math.ceil(count / 2));
    history.forEach(old => assert.deepEqual(p.data.records.find(r => r.id === old.id), old));
    assert.equal(p.data.reviewOpen, false);
    assert.equal(p.data.drafts.length, 0);
    assert.equal(p.reviewResume, null);
    p.onUnload();
  });
}
test('修改一条草稿只重置该条选择；清空导入不遗留选择', async () => {
  const p = page();
  const drafts = [0, 1].map(i => ({ id: `draft-${i}`, code: `A1-${1000 + i}`, station: '测试驿站' }));
  p.persistRecords(drafts.map(d => storage.updateRecord(storage.newRecord(d), { taken: true })));
  p.setDrafts(drafts);
  let run = p.confirmImport(); drafts.forEach(d => p.chooseImportAction(event(d.id, 'new')));
  p.cancelImportReview(); await run;
  p.setDrafts([{ ...drafts[0], station: '修改后的驿站' }, drafts[1]]);
  run = p.confirmImport();
  assert.equal(p.data.reviewItems[0].action, 'skip');
  assert.equal(p.data.reviewItems[1].action, 'new');
  p.cancelImportReview(); await run;
  p.resetImport(); assert.equal(p.reviewResume, null); p.onUnload();
});
test('核对层仅一个受约束滚动容器，无祖先触摸拦截，底栏独占布局空间', () => {
  const wxml = fs.readFileSync('miniprogram/pages/pickup/index.wxml', 'utf8');
  const css = fs.readFileSync('miniprogram/pages/pickup/index.wxss', 'utf8');
  const review = wxml.slice(wxml.indexOf('<view wx:if="{{reviewOpen}}"'));
  assert.equal((review.match(/<scroll-view\b/g) || []).length, 1);
  assert.doesNotMatch(review, /catchtouchmove/);
  assert.match(wxml, /<view hidden="{{reviewOpen}}">/);
  assert.match(wxml.split('\n')[0], /reviewOpen.*overflow: hidden/);
  assert.match(css, /\.review-screen \{[^}]*position: fixed;[^}]*top: 0;[^}]*bottom: 0;[^}]*flex-direction: column/);
  assert.match(css, /\.review-list-slot \{[^}]*flex: 1;[^}]*min-height: 0/);
  assert.match(css, /\.review-list \{[^}]*height: 100%/);
  assert.match(css, /\.review-footer \{[^}]*flex-shrink: 0;[^}]*safe-area-inset-bottom/);
  assert.doesNotMatch(css, /\.import-result-actions \{[^}]*(?:sticky|fixed)/);
});
