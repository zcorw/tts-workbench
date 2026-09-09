const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BASE_URL || 'http://127.0.0.1:4181/';
const out = path.join(__dirname, 'articles-integration-artifacts');
const checks = [],
  errors = [];
const ok = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
async function save(p) {
  await p.locator('#saveArticle').click();
  await p.waitForFunction(
    () => document.querySelector('#articleSaveStatus')?.textContent === '已保存到我的文章',
  );
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  const login = 'article-' + randomUUID().slice(0, 12),
    password = randomUUID() + 'A1';
  const origin = new URL(base).origin;
  async function headers() {
    const r = await context.request.get(base + 'v1/auth/csrf');
    assert.equal(r.status(), 200);
    return { Origin: origin, 'X-CSRF-Token': (await r.json()).csrfToken };
  }
  async function signIn() {
    await p.locator('#authName').fill(login);
    await p.locator('#authPassword').fill(password);
    await p.locator('#authSubmit').click();
    await p.locator('.sidebar').waitFor();
  }
  try {
    await p.goto(base + '#/articles');
    await p.locator('#authSubmit').waitFor();
    ok('真实未登录文章路由保护');
    await p.getByRole('link', { name: '还没有账户？创建账户 →' }).click();
    await p.locator('#registerName').fill('文章联调');
    await p.locator('#authName').fill(login);
    await p.locator('#authPassword').fill(password);
    await p.locator('#confirmPassword').fill(password);
    await p.locator('#authSubmit').click();
    await p.waitForURL('**/#/login');
    await signIn();
    await p.getByText('还没有保存的文章').waitFor();
    ok('真实注册登录与个人空列表');
    await p.locator('#newArticleButton').click();
    await p.locator('#articleTitle').fill('日本の朝');
    await save(p);
    const id = new URL(p.url()).hash.split('/').at(-1);
    let article = await (await context.request.get(base + 'v1/articles/' + id)).json();
    assert.equal(article.text, '');
    assert.equal(article.revision, 1);
    const exact = '日本橋の朝。\n日本橋を歩く。\nか\u3099😀\n\n';
    await p.locator('#articleEditor').fill(exact);
    await save(p);
    article = await (await context.request.get(base + 'v1/articles/' + id)).json();
    assert.equal(article.text, exact);
    assert.equal(article.contentRevision, 2);
    await p.reload();
    await p.locator('#articleEditor').waitFor();
    assert.equal(await p.locator('#articleEditor').textContent(), exact);
    ok('真实PG空白创建/正文保存/组合字符与刷新恢复');
    await p.locator('#articleTitle').fill('😀'.repeat(120));
    await save(p);
    article = await (await context.request.get(base + 'v1/articles/' + id)).json();
    assert.equal([...article.title].length, 120);
    assert.equal(article.contentRevision, 2);
    ok('120 Unicode码点标题且标题不改正文版本');
    await p.locator('#articleTitle').fill('日本の朝 · 联调');
    await save(p);
    article = await (await context.request.get(base + 'v1/articles/' + id)).json();
    const external = await context.request.patch(base + 'v1/articles/' + id, {
      headers: await headers(),
      data: { title: '另一窗口保存', text: exact, expectedRevision: article.revision },
    });
    assert.equal(external.status(), 200);
    await p.locator('#articleTitle').fill('当前冲突草稿');
    await p.locator('#saveArticle').click();
    await p.getByText(/文章已在另一窗口更新/).waitFor();
    assert.equal(await p.locator('#articleTitle').inputValue(), '当前冲突草稿');
    await p.screenshot({ path: path.join(out, 'conflict.png'), fullPage: true });
    await p.getByRole('button', { name: '重新载入最新版本', exact: true }).click();
    await p.getByRole('button', { name: '放弃草稿并重新载入' }).click();
    await p.waitForFunction(
      () => document.querySelector('#articleTitle')?.value === '另一窗口保存',
    );
    ok('真实条件PATCH409与保留草稿/确认重载');
    await p.locator('[data-view="articles"]').click();
    article = await external.json();
    const later = await context.request.patch(base + 'v1/articles/' + id, {
      headers: await headers(),
      data: { title: '服务器最新标题', text: exact, expectedRevision: article.revision },
    });
    assert.equal(later.status(), 200);
    await p.locator('.article-title').first().click();
    await p.waitForFunction(
      () => document.querySelector('#articleTitle')?.value === '服务器最新标题',
    );
    ok('真实外部修改后重开不采用旧缓存');
    await p.locator('#articleTitle').fill('同账户恢复草稿');
    assert.equal(
      (await context.request.post(base + 'v1/auth/logout', { headers: await headers() })).status(),
      204,
    );
    await p.locator('#retryVoices').click();
    await p.locator('#authSubmit').waitFor();
    await signIn();
    await p.locator('#articleTitle').waitFor();
    assert.equal(await p.locator('#articleTitle').inputValue(), '同账户恢复草稿');
    assert(p.url().endsWith(id));
    await save(p);
    ok('真实会话失效后同账户恢复文章ID和草稿');
    await p.locator('[data-view="articles"]').click();
    await p.locator('#articleSearch').fill('同账户');
    await p.getByRole('button', { name: '搜索', exact: true }).click();
    await p.locator('.article-title').first().waitFor();
    assert.equal(await p.locator('.article-title').count(), 1);
    await p.screenshot({ path: path.join(out, 'articles-desktop.png'), fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('.article-title').first().click();
    await p.locator('#articleEditor').waitFor();
    await p.screenshot({ path: path.join(out, 'article-mobile.png'), fullPage: true });
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await p.locator('#generateButton').isDisabled());
    ok('真实标题搜索/移动端/无供应商禁用生成');
    await p.locator('[data-view="articles"]').click();
    await p.getByRole('button', { name: '删除文章：同账户恢复草稿' }).click();
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    await p.getByText(/还没有保存的文章|没有找到匹配的文章/).waitFor();
    assert.equal((await context.request.get(base + 'v1/articles/' + id)).status(), 404);
    ok('真实确认删除/服务器404/列表更新');
    await p.locator('[data-view="account"]').click();
    await p.locator('#logoutButton').click();
    await p.locator('#authSubmit').waitFor();
    assert.equal((await context.request.get(base + 'v1/auth/me')).status(), 401);
    ok('真实退出会话失效');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          origin: base,
          checks,
          errors,
          note: 'No HTTP interception. Isolated real API/PostgreSQL; created article removed; random account remains; no credentials recorded.',
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
