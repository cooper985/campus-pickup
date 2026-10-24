// CSS geometry check; native keyboard and Android gestures still need a phone.
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    for (const [width, height] of [[320, 480], [360, 640], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const css = ['miniprogram/app.wxss', 'miniprogram/pages/pickup/index.wxss'].map(p => fs.readFileSync(p, 'utf8')).join('\n')
        .replace(/([\d.]+)rpx/g, (_, n) => `${Number(n) * width / 750}px`);
      const render = html => page.setContent(`<style>html,body{margin:0}view,page{display:block}scroll-view{display:block;overflow-y:auto}button{border:0;display:block;margin:0;padding:0;font:inherit}textarea{display:block}${css}</style><page>${html}</page>`);
      await render('<view class="review-screen exception-screen"><view class="review-header"><view class="exception-progress">1/25</view></view><view class="review-list-slot"><scroll-view class="review-list"><view class="exception-parcel"><view class="review-code">B3-4-7401</view><view class="review-reason">这件快递以前取过</view><view class="exception-sources"><view class="exception-source"><view class="hint">本次截图 1</view><img class="exception-thumbnail" /></view><view class="exception-source"><view class="hint">本次截图 2</view><img class="exception-thumbnail" /></view></view><view class="existing-evidence">已有记录：北门服务站</view></view></scroll-view></view><view class="review-footer exception-actions"><button class="ui-button primary">是新包裹，加入待取</button><button class="ui-button secondary">已经取过，跳过</button><button class="ui-button text-button">稍后处理</button></view></view>');
      const geometry = await page.evaluate(() => ({
        buttons: [...document.querySelectorAll('.exception-actions button')].map(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, height: e.getBoundingClientRect().height })),
        listBottom: document.querySelector('.review-list').getBoundingClientRect().bottom,
      }));
      assert.ok(geometry.buttons.every(b => b.top >= 0 && b.bottom <= height && b.height >= 44), JSON.stringify({ width, height, geometry }));
      assert.ok(geometry.listBottom <= geometry.buttons[0].top);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const images = await page.locator('.exception-thumbnail').all();
      assert.equal(images.length, 2);
      for (const img of images) { const box = await img.boundingBox(); assert.ok(box.width > 70 && box.x >= 0 && box.x + box.width <= width); }
      await page.locator('.review-list').evaluate(e => e.scrollTop = e.scrollHeight);
      await page.locator('.exception-actions .primary').click();
      if (width === 390) await page.screenshot({ path: '/private/tmp/v232-exception-layout.png' });
      for (const keyboard of [0, Math.min(260, Math.round(height * .5))]) {
        await render(`<view class="modal-mask" style="bottom:${keyboard}px"><view class="edit-sheet" style="max-height:calc(100vh - ${keyboard}px - 16px)"><view class="section-title">手动补充</view>${Array.from({ length: 6 }, (_, i) => `<view class="field-label">字段${i}</view><input class="field-input" value="测试" />`).join('')}<view class="actions"><button class="ui-button secondary">取消</button><button class="ui-button primary save">加入待取</button></view></view></view>`);
        await page.locator('.edit-sheet').evaluate(e => { e.scrollTop = e.scrollHeight; });
        const save = await page.locator('.save').boundingBox();
        assert.ok(save.y >= 0 && save.y + save.height <= height - keyboard + 1, JSON.stringify({ width, height, keyboard, save }));
        await page.locator('.save').click();
      }
      await page.close();
      console.log(`${width}x${height}: two source thumbnails fit; exception buttons reachable; editor scroll and keyboard clearance passed`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
