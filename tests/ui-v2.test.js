const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/page');

test('退出动画只保留展示副本，连续更新和减少动效不会复活草稿', async () => {
  const p = page();
  const a = { id: 'a', code: '1234', station: '测试站' };
  p.setDrafts([a]);
  p.removeDraft({ currentTarget: { dataset: { id: 'a' } } });
  assert.equal(p.data.validDraftCount, 0);
  assert.equal(p.data.drafts.length, 0);
  assert.equal(p.data.visibleDraftGroups[0].items[0].leaving, true);
  p.setDrafts([{ ...a, id: 'b' }]);
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(p.data.visibleDraftGroups[0].items.length, 1);
  assert.equal(p.data.visibleDraftGroups[0].items[0].id, 'b');
  p.toggleMotion();
  p.setDrafts([]);
  assert.equal(p.data.visibleDraftGroups.length, 0);
  p.onUnload();
});
