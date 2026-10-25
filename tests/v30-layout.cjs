// Browser geometry of the actual WXML/WXSS with synthetic view data, not native-device proof.
// Run outside the restricted macOS sandbox, as required by AGENTS.md.
const { chromium } = require('playwright');
const { xml2js } = require('xml-js');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { page: createPage } = require('./helpers/page');
const storage = require('../miniprogram/services/pickup-store');
const output = process.env.V30_OUTPUT || '/private/tmp/pickup-v30';
fs.mkdirSync(output, { recursive: true });
const template = fs.readFileSync('miniprogram/pages/pickup/index.wxml', 'utf8');
const tree = xml2js(`<root>${template.replace(/&/g, '&amp;').replace(/wx:else(?=[\s>])/g, 'wx:else=""')}</root>`).elements[0].elements;
const escape = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const value = (s, data) => {
  const exact = String(s).match(/^{{([^{}]*)}}$/);
  const evalExpr = expr => { try { return Function('data', `with(data){return (${expr})}`)(data); } catch { return undefined; } };
  return exact ? evalExpr(exact[1]) : String(s).replace(/{{([\s\S]*?)}}/g, (_, expr) => evalExpr(expr) ?? '');
};
function render(nodes, data) {
  let matched = false;
  return (nodes || []).map(node => {
    if (node.type === 'text') return escape(value(node.text, data));
    if (node.type !== 'element' || node.name === 'page-meta') return '';
    const a = { ...node.attributes };
    if ('wx:for' in a) {
      const list = value(a['wx:for'], data) || [];
      const item = a['wx:for-item'] || 'item', index = a['wx:for-index'] || 'index';
      delete a['wx:for'];
      return list.map((v, i) => render([{ ...node, attributes: a }], { ...data, [item]: v, [index]: i })).join('');
    }
    if ('wx:if' in a) { matched = !!value(a['wx:if'], data); if (!matched) return ''; }
    else if ('wx:else' in a) { if (matched) return ''; matched = true; }
    else matched = false;
    if (a.hidden && value(a.hidden, data)) return '';
    const children = render(node.elements, data);
    if (node.name === 'block') return children;
    const tag = ({ view: 'div', text: 'span', 'scroll-view': 'div', image: 'img', picker: 'div', 'checkbox-group': 'div', label: 'label', checkbox: 'input' })[node.name] || node.name;
    const attrs = Object.entries(a).filter(([k]) => /^(class|style|src|aria-label|role|placeholder)$/.test(k)).map(([k,v]) => `${k}="${escape(value(v,data))}"`);
    if (a.disabled && value(a.disabled,data)) attrs.push('disabled');
    if (node.name === 'scroll-view') attrs.push(`data-scroll="${a['scroll-y'] ? 'y' : 'x'}"`);
    return `<${tag} ${attrs.join(' ')}>${children}</${tag}>`;
  }).join('');
}
const p = createPage(); p.data.reduceMotion = true;
p.persistRecords([
  storage.newRecord({ station: '北门菜鸟驿站', code: '87-6-4601' }),
  storage.newRecord({ station: '北门菜鸟驿站', code: '313-3-3308' }),
  storage.newRecord({ station: '图书馆东侧服务站', code: 'B3-4-7401' }),
]);
const base = JSON.parse(JSON.stringify(p.data)); p.onUnload();
fs.writeFileSync(`${output}/home-view.json`, JSON.stringify({remaining:base.remaining,visiblePendingGroups:base.visiblePendingGroups}));
const exception = { code:'B3-4-7401',station:'北门菜鸟驿站', message:'这件快递以前取过',reason:'historical_code',allowNew:true,options:[],matches:[{id:'old',code:'B3-4-7401',station:'北门菜鸟驿站',taken:true}],sources:[{imageId:'a',label:'本次截图 1'}, {imageId:'b',label:'本次截图 2'}] };
const states = {
  home: {},
  empty: { remaining:0, visiblePendingGroups:[] },
  identity: { identityOpen:true, identityPlatform:'' },
  identityTaobao: { identityOpen:true, identityPlatform:'taobao' },
  identityPinduoduo: { identityOpen:true, identityPlatform:'pinduoduo' },
  import: { activeTab:'import', recentImport:{id:'demo',added:3,reviewCount:1,duplicate:2,unrelated:0,failures:0,canUndo:true},exceptionCount:1 },
  progress: { activeTab:'import',loading:true,progress:'正在识别 3/9',recentImport:null },
  stations: { activeTab:'stations' },
  detail: { activeTab:'stations', stationEditor:{mode:'detail',id:'demo',name:'北门菜鸟驿站',aliases:['北门菜鸟驿站','学校北门快递中心'],confirmed:false,mergeNames:['图书馆东侧服务站']} },
  history: { activeTab:'history', history:[{}],visibleHistory:[{id:'old',code:'B3-4-7401',station:'北门菜鸟驿站',takenTimeLabel:'10月25日 09:42'},{id:'legacy',code:'87-6-4601',station:'图书馆东侧服务站',takenTimeLabel:'领取时间未知'}] },
  exception: { exceptionOpen:true, currentException:exception, exceptionProgress:'1 / 3' },
  missing: { exceptionOpen:true,currentException:{...exception,code:'',needsCode:true,matches:[]},exceptionProgress:'1 / 3' },
  long: { visiblePendingGroups:[{id:'long',station:'学校生活区北门东侧综合服务中心菜鸟驿站',items:[{id:'long',code:'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'}]}] },
  edit: { editing:{code:'B3-4-7401',station:'北门菜鸟驿站',pickupAddress:'',carrier:''} },
};
(async () => {
 const browser = await chromium.launch({ headless:true,channel:'chrome' });
 try {
  for (const [width,height] of [[320,480],[360,640],[390,844],[430,932]]) {
   const page = await browser.newPage({ viewport:{width,height},reducedMotion:'reduce' });
   const safeAreaBottom = width === 390 ? 34 : 0;
   const css = ['miniprogram/app.wxss','miniprogram/pages/pickup/index.wxss'].map(f=>fs.readFileSync(f,'utf8')).join('\n').replace(/([\d.]+)rpx/g,(_,n)=>`${Number(n)*width/750}px`).replace(/env\(safe-area-inset-bottom\)/g,`${safeAreaBottom}px`);
   for (const [name,patch] of Object.entries(states)) {
    for (const keyboardHeight of name === 'edit' ? [0,Math.min(260,Math.round(height*.5))] : [0]) {
     const html = render(tree,{...base,...patch,keyboardHeight});
     await page.setContent(`<style>html,body{margin:0}page{display:block}button{display:block;border:0;margin:0;font:inherit}input,textarea{display:block;font:inherit}button:disabled{cursor:default}[data-scroll=x]{overflow-x:auto}[data-scroll=y]{overflow-y:auto}${css}</style><page>${html}</page>`);
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${name}: horizontal page overflow`);
     const buttons = await page.locator('button').evaluateAll(es=>es.map(e=>{ const r=e.getBoundingClientRect(); return {x:r.x,width:r.width,height:r.height}; }));
     assert.ok(buttons.every(b=>b.width>0&&b.x>=-1&&b.x+b.width<=width+1&&b.height>=43),`${width} ${name}: touch targets ${JSON.stringify(buttons)}`);
     if (name === 'home') {
      const nav = await page.locator('.bottom-nav button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,text:e.textContent};}));
      assert.equal(nav.length,4);
      assert.ok(nav.every((b,i)=>b.width>=44&&(!i||b.x>=nav[i-1].right-1)),`${width}: identity and import must not overlap`);
      assert.ok(nav.some(b=>b.text.includes('＋')&&b.text.includes('导入')));
      const codes = await page.locator('.copy-code').evaluateAll(es=>es.map(e=>({width:e.getBoundingClientRect().width,available:e.parentElement.clientWidth,whiteSpace:getComputedStyle(e).whiteSpace})));
      assert.ok(codes.every(c=>c.width<=c.available+1&&c.whiteSpace==='nowrap'),`${width}: typical codes must fit ${JSON.stringify(codes)}`);
     }
     if (name === 'long') assert.ok(await page.locator('.code-scroll').evaluate(e=>{e.scrollLeft=e.scrollWidth;return e.scrollLeft>0}), 'long code must scroll to its end');
     if (name.startsWith('identity')) {
      const box = await page.locator('.identity-sheet').boundingBox();
      assert.ok(box.y>=0&&box.y+box.height<=height+1,`${width}: identity sheet fits`);
      await page.locator('.identity-scroll').evaluate(e=>e.scrollTop=e.scrollHeight);
      const note = await page.locator('.identity-note').boundingBox();
      assert.ok(note.y>=box.y&&note.y+note.height<=height-safeAreaBottom+1,`${width}: identity instructions reachable above safe area`);
     }
     if (name === 'exception' || name === 'missing') {
      const box = await page.locator('.review-list').boundingBox();
      const footer = await page.locator('.review-footer').boundingBox();
      assert.ok(box.height>60&&box.y+box.height<=footer.y+1&&footer.y+footer.height<=height+1,`${width} ${name}: scroll and footer`);
     }
     if (name === 'edit') {
      await page.locator('.edit-sheet').evaluate(e=>e.scrollTop=e.scrollHeight);
      const save = await page.locator('.edit-sheet .primary').boundingBox();
      assert.ok(save.y>=0&&save.y+save.height<=height-keyboardHeight+1,`${width}: editor keyboard`);
     }
     if (width===390&&!keyboardHeight&&['home','import','exception','stations','detail','history','identity','identityTaobao','identityPinduoduo'].includes(name)) await page.screenshot({path:`${output}/${name}.png`,fullPage:true});
    }
   }
   await page.close(); console.log(`${width}x${height}: ${Object.keys(states).length} states, safe area ${safeAreaBottom}px, code visibility, touch targets, overflow, scroll and keyboard geometry passed`);
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
