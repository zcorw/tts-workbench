// 只使用虚构 API 响应，验证知声网页筛选与分页；不调用生产数据或音频合成。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.BASE_URL || 'http://127.0.0.1:4384';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('Loopback preview required');
const make = (draft, i) => ({ id: (draft ? 'draft-' : 'published-') + i, title: (draft ? '草稿' : '已发布') + i,
  revision: 1, contentRevision: 1, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
  currentRuleVersion: 0, audio: null, audioStale: false,
  cms: { revision: 1, slug: 'fixture-' + i, summary: 'fixture', categoryId: null, tagIds: [], publishedReleaseId: draft ? null : 'release-' + i } });
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], reads = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/site-config.json', route => route.fulfill({ json: { workbenchUrl: base, cmsUrl: base } }));
    await page.route('**/v1/**', route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const reply = json => route.fulfill({ json });
      if (path === '/v1/config') return reply({ registrationEnabled:false,maxText:10000,maxBytes:49152,maxArticles:100 });
      if (path === '/v1/auth/me') return reply({ id:'fixture-owner',displayName:'虚构账号',login:'fixture' });
      if (path === '/v1/auth/csrf') return reply({ csrfToken:'fixture-csrf' });
      if (path === '/v1/cms/audio-batches') return reply({ items:[] });
      if (path === '/v1/cms/taxonomy') return reply({ categories:[],tags:[],totalArticles:47,uncategorizedCount:47 });
      if (path === '/v1/cms/articles') {
        const status = url.searchParams.get('status') || '', offset = Number(url.searchParams.get('offset') || 0);
        reads.push({ status,offset,q:url.searchParams.get('q') });
        const items = [...Array.from({length:23},(_,i)=>make(true,i)),...Array.from({length:24},(_,i)=>make(false,i))]
          .filter(item => !status || Boolean(item.cms.publishedReleaseId) === (status === 'published'));
        return reply({ items:items.slice(offset,offset+20),total:items.length,offset,limit:20 });
      }
      return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
    });
    await page.goto(base + '/articles?q=fixture&page=2');
    const status = page.getByRole('combobox', { name:'发布状态', exact:true });
    await status.waitFor();
    assert.deepEqual(await status.locator('option').allTextContents(),['全部状态','草稿','已发布']);
    await status.selectOption('draft');
    await page.waitForURL(url => url.searchParams.get('status') === 'draft' && !url.searchParams.has('page'));
    await page.waitForFunction(() => document.querySelector('.cms-selectable-items li')?.textContent.includes('草稿0'));
    assert.equal(new URL(page.url()).searchParams.get('q'),'fixture');
    assert.equal(await page.locator('.cms-selectable-items > li').count(),20);
    assert.ok((await page.locator('.cms-article-summary p').allTextContents()).every(text=>text.includes('草稿')));
    await page.getByRole('button',{name:'下一页',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.cms-selectable-items li')?.textContent.includes('草稿20'));
    assert.equal(await page.locator('.cms-selectable-items > li').count(),3);
    assert.ok(reads.some(read=>read.status==='draft'&&read.offset===20&&read.q==='fixture'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.cms-selectable-items li')?.textContent.includes('草稿20'));
    assert.equal(await status.inputValue(),'draft');
    await status.selectOption('published');
    await page.waitForFunction(() => document.querySelector('.cms-selectable-items li')?.textContent.includes('已发布0'));
    assert.ok(!new URL(page.url()).searchParams.has('page'));
    assert.ok((await page.locator('.cms-article-summary p').allTextContents()).every(text=>text.includes('已发布')));
    await status.selectOption('');
    await page.waitForFunction(() => document.querySelector('.cms-selectable-items li')?.textContent.includes('草稿0'));
    assert.equal(new URL(page.url()).searchParams.has('status'),false);
    assert.deepEqual(errors,[]);
    console.log('PASS 知声网页：草稿/已发布/全部、搜索组合、切换回首页、分页和刷新保留');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
