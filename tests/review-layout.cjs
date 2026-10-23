// Browser geometry regression for the native scroll-view layout contract (not Android acceptance).
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" });
  try {
    for (const [width, height] of [[320, 480], [360, 640], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const css = [fs.readFileSync('miniprogram/app.wxss', 'utf8'), fs.readFileSync('miniprogram/pages/pickup/index.wxss', 'utf8')].join('\n')
        .replace(/([\d.]+)rpx/g, (_, n) => `${Number(n) * width / 750}px`);
      for (const count of [1, 3, 10, 25]) {
        const rows = Array.from({ length: count }, (_, i) => `<view class="review-item"><view class="review-code">A1-${1000 + i}</view><view class="hint">本次地点：测试驿站</view><view class="review-reason">历史记录已取件，同码可能是新包裹</view><view class="match-info"><view class="hint">原记录（已取件）：A1-${1000 + i}</view><view class="match-station">用于验证换行和小屏布局的完整驿站名称</view></view><button class="ui-button review-option">保留原记录，跳过本次</button><button class="ui-button review-option last-choice">确认是另一件包裹，新增</button></view>`).join('');
        await page.setContent(`<style>html,body{margin:0;overflow:hidden}view,page{display:block}button{border:0;display:block}scroll-view{display:block;overflow-y:auto}${css}</style><page><view class="review-screen"><view class="review-header"><view class="section-title">核对重复快递</view><view class="hint">仅补全空缺信息，保留原记录状态。确认后统一保存。</view></view><view class="review-list-slot"><scroll-view class="review-list">${rows}</scroll-view></view><view class="review-footer"><view class="review-summary">新增 ${count} 件 · 更新 0 件 · 跳过重复 0 件</view><view class="actions"><button class="ui-button secondary">返回核对</button><button class="ui-button primary">按以上选择导入</button></view></view></view></page>`);
        const result = await page.evaluate(() => {
          const list = document.querySelector('.review-list');
          list.scrollTop = list.scrollHeight;
          const last = document.querySelector('.review-item:last-child .last-choice').getBoundingClientRect();
          const footer = document.querySelector('.review-footer').getBoundingClientRect();
          const area = list.getBoundingClientRect();
          return { lastTop: last.top, lastBottom: last.bottom, footerTop: footer.top, footerBottom: footer.bottom, listTop: area.top, listBottom: area.bottom, scroll: list.scrollTop, pageScroll: window.scrollY };
        });
        assert.ok(result.lastTop >= result.listTop && result.lastBottom <= result.listBottom, JSON.stringify({ width, height, count, result }));
        assert.ok(result.listBottom <= result.footerTop + 1);
        assert.ok(result.footerBottom <= height + 1);
        assert.equal(result.pageScroll, 0);
        await page.locator('.review-item:last-child .last-choice').click();
        console.log(`${width}x${height}, ${count} records: last choice reachable; footer clear; page fixed`);
      }
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
