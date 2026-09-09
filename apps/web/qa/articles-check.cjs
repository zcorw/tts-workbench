const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { savedAudio } = require('./saved-audio-fixture.cjs');
require('./contract-check.cjs');
const base = process.env.BASE_URL || 'http://127.0.0.1:4181/';
const out = path.join(__dirname, 'articles-artifacts');
const checks = [],
  errors = [];
const ok = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture(context) {
  const account = { id: randomUUID(), login: 'reader', displayName: '文章测试', status: 'active' };
  const state = {
    account,
    current: account,
    rows: [],
    requests: [],
    rules: [],
    version: 0,
    fail: '',
    gate: null,
    arrived: null,
  };
  const make = (title, text = '') => ({
    id: randomUUID(),
    title,
    text,
    revision: 1,
    contentRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentRuleVersion: 0,
    audio: null,
    audioStale: false,
  });
  state.make = make;
  await context.route('**/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      endpoint = url.pathname,
      method = request.method();
    const body = request.postDataJSON(),
      requestId = randomUUID();
    state.requests.push({ endpoint, method, body });
    const send = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
        headers: { 'X-Request-Id': requestId },
      });
    const error = (code, status) => send({ code, message: code, requestId }, status);
    if (endpoint === '/v1/config')
      return send({
        registrationEnabled: true,
        language: 'ja-JP',
        maxVocabularyEntries: 500,
        maxInputCodePoints: 10000,
        maxInputBytes: 49152,
        maxArticles: 100,
      });
    if (endpoint === '/v1/auth/csrf')
      return send({
        csrfToken: 'qa-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    if (endpoint === '/v1/auth/login') {
      state.current = state.account;
      return send(state.current);
    }
    if (endpoint === '/v1/auth/logout') {
      state.current = null;
      return route.fulfill({ status: 204 });
    }
    if (!state.current) return error('UNAUTHENTICATED', 401);
    if (method !== 'GET') {
      assert.equal(request.headers()['x-csrf-token'], 'qa-token');
      assert.equal(request.headers().origin, new URL(base).origin);
    }
    if (state.fail === method + ':' + endpoint) {
      state.fail = '';
      return error('DEPENDENCY_UNAVAILABLE', 503);
    }
    if (endpoint === '/v1/auth/me') return send(state.current);
    if (endpoint === '/v1/voices')
      return send({ items: state.voices || [{ id: 'qa-ja', name: '测试日文音色', language: 'ja-JP' }] });
    if (endpoint === '/v1/vocabulary' && method === 'GET')
      return send({
        items: state.rules,
        total: state.rules.length,
        offset: 0,
        limit: 500,
        internalVersion: state.version,
      });
    if (endpoint === '/v1/vocabulary' && method === 'POST') {
      const entry = {
        id: randomUUID(),
        text: body.text,
        reading: body.reading,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.rules.push(entry);
      return send({ entry, internalVersion: ++state.version }, 201);
    }
    if (endpoint.startsWith('/v1/audio/')) {
      const bytes = fs.readFileSync(path.join(__dirname, 'tone.mp3'));
      return route.fulfill({
        status: 200,
        body: bytes,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(bytes.length),
          'Content-Disposition': 'inline; filename="temporary.mp3"',
          'X-Pronunciation-Version': String(state.version),
          'X-Request-Id': requestId,
        },
      });
    }
    if (endpoint === '/v1/articles' && method === 'GET') {
      const q = url.searchParams.get('q') || '',
        offset = Number(url.searchParams.get('offset')),
        limit = Number(url.searchParams.get('limit'));
      const rows = state.rows.filter((a) => a.title.includes(q));
      return send({
        items: rows.slice(offset, offset + limit).map(({ text, ...a }) => a),
        total: rows.length,
        offset,
        limit,
      });
    }
    if (endpoint === '/v1/articles' && method === 'POST') {
      if (state.rows.length >= 100) return error('ARTICLE_LIMIT', 409);
      const a = make(body.title.trim(), body.text);
      state.rows.unshift(a);
      return send(a, 201);
    }
    if (/^\/v1\/articles\/[^/]+\/audio$/.test(endpoint)) return savedAudio({route,state,article:state.rows.find(a=>a.id===endpoint.split('/')[3]),body,method,url,send,error,version:state.version});
    if (endpoint.startsWith('/v1/articles/')) {
      const a = state.rows.find((a) => a.id === endpoint.split('/').at(-1));
      if (!a) return error('NOT_FOUND', 404);
      if (method === 'GET') {
        if (state.getGate?.id === a.id) {
          const pending = state.getGate;
          state.getGate = null;
          pending.arrived.resolve();
          await pending.gate.promise;
        }
        return send(a);
      }
      const revision =
        method === 'DELETE'
          ? Number(url.searchParams.get('expectedRevision'))
          : body.expectedRevision;
      if (revision !== a.revision) return error('REVISION_CONFLICT', 409);
      if (method === 'DELETE') {
        state.rows = state.rows.filter((row) => row !== a);
        return route.fulfill({ status: 204 });
      }
      if (state.gate) {
        const gate = state.gate;
        state.gate = null;
        state.arrived?.resolve();
        await gate.promise;
      }
      if (a.text !== body.text) a.contentRevision++;
      if (a.text !== body.text || a.title !== body.title.trim()) a.revision++;
      a.title = body.title.trim();
      a.text = body.text;
      a.updatedAt = new Date().toISOString();
      return send(a);
    }
    throw Error(`Unexpected ${method} ${endpoint}`);
  });
  return state;
}
async function text(p, value) {
  await p.locator('#articleEditor').fill(value);
}
async function saved(p) {
  await p.waitForFunction(
    () => document.querySelector('#articleSaveStatus')?.textContent === '已保存到我的文章',
  );
}
async function shot(p, name) {
  await p.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
}
async function chooseWord(p, word) {
  await p.locator('#articleEditor').focus();
  await p.evaluate((word) => {
    const root = document.querySelector('#articleEditor'),
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + word.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      break;
    }
  }, word);
  await p.locator('#editSelected').click();
}
if (require.main === module) (async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    const state = await fixture(context),
      p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + '#/articles');
    await p.getByText('还没有保存的文章').waitFor();
    ok('空列表、配置文章上限与加载');
    await p.locator('#newArticleButton').click();
    await p.locator('#articleTitle').fill('   ');
    await p.locator('#saveArticle').click();
    await p.getByText('请填写文章标题。', { exact: true }).waitFor();
    assert.equal(state.rows.length, 0);
    await p.locator('#articleTitle').fill('空白草稿');
    await p.locator('#saveArticle').click();
    await saved(p);
    const first = state.rows[0];
    assert.equal(first.text, '');
    assert(p.url().endsWith('/articles/' + first.id));
    ok('标题校验、空正文创建、服务器ID路由');
    await text(p, '日本橋を歩く。\n日本橋の朝。');
    await p.locator('#saveArticle').click();
    await saved(p);
    await p.reload();
    await saved(p);
    assert.equal(await p.locator('#articleEditor').textContent(), first.text);
    ok('保存原字符换行与刷新恢复');
    await chooseWord(p, '日本橋');
    await p.locator('#readingInput').fill('にほんばし');
    await p.locator('#previewReading').click();
    await p.waitForFunction(() => !document.querySelector('#previewReading').disabled);
    assert.equal(state.rules.length, 0);
    await p.locator('#saveRuleButton').click();
    await p.locator('#readingDialog').waitFor({ state: 'hidden' });
    assert.equal(await p.locator('#articleEditor mark').count(), 2);
    assert(first.text.includes('日本橋'));
    ok('原字选词、同词规则、候选试听不保存');
    await p.locator('#generateButton').click();
    await p.locator('#audioResult').waitFor();
    assert(first.audio?.audioId);
    assert(await p.getByText('每篇保留最后一次成功生成的音频', { exact: false }).isVisible());
    const download = p.waitForEvent('download');
    await p.locator('#downloadButton').click();
    await download;
    ok('已保存MP3下载');
    await p.locator('#articleTitle').fill('未保存标题');
    await p.locator('[data-view="articles"]').click();
    await p.locator('#unsavedDialog').waitFor();
    await p.getByRole('button', { name: '继续编辑', exact: true }).click();
    await p.locator('#unsavedDialog').waitFor({ state: 'hidden' });
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    assert.equal(await p.locator('#articleTitle').inputValue(), '未保存标题');
    await p.locator('.brand').click();
    await p.locator('#unsavedDialog').waitFor();
    await p.getByRole('button', { name: '保存并离开', exact: true }).click();
    await p.locator('#articlesView').waitFor();
    assert.equal(first.title, '未保存标题');
    ok('按钮与路由链接阻塞、继续编辑、保存并离开');
    await p.locator('.article-title').first().click();
    await saved(p);
    await p.locator('#articleTitle').fill('返回不应丢失');
    await p.goBack();
    await p.locator('#unsavedDialog').waitFor();
    await shot(p, 'unsaved-navigation');
    await p.getByRole('button', { name: '继续编辑', exact: true }).click();
    await p.locator('#unsavedDialog').waitFor({ state: 'hidden' });
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    assert.equal(await p.locator('#articleTitle').inputValue(), '返回不应丢失');
    await p.goBack();
    await p.locator('#unsavedDialog').waitFor();
    await p.getByRole('button', { name: '放弃更改', exact: true }).click();
    await p.locator('#articlesView').waitFor();
    await p.goForward();
    await saved(p);
    assert.equal(await p.locator('#articleTitle').inputValue(), first.title);
    ok('浏览器返回阻塞/放弃及前进恢复');
    await p.locator('[data-view="rules"]').click();
    await p.locator('#rulesView').waitFor();
    await p.goBack();
    await saved(p);
    await p.locator('#articleTitle').fill('前进也要保护');
    await p.goForward();
    await p.locator('#unsavedDialog').waitFor();
    await p.getByRole('button', { name: '继续编辑', exact: true }).click();
    await p.locator('#unsavedDialog').waitFor({ state: 'hidden' });
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    assert.equal(await p.locator('#articleTitle').inputValue(), '前进也要保护');
    ok('浏览器前进脏草稿阻塞');
    await p.locator('#articleTitle').fill('刷新保护');
    const unload = p.waitForEvent('dialog');
    const reload = p.reload({ timeout: 1500 }).catch(() => {});
    const dialog = await unload;
    assert.equal(dialog.type(), 'beforeunload');
    await dialog.dismiss();
    await reload;
    assert.equal(await p.locator('#articleTitle').inputValue(), '刷新保护');
    ok('真实浏览器刷新beforeunload可取消');
    state.fail = 'PATCH:/v1/articles/' + first.id;
    await p.locator('#saveArticle').click();
    await p.getByText(/服务暂不可用/).waitFor();
    assert.equal(await p.locator('#articleTitle').inputValue(), '刷新保护');
    assert.notEqual(first.title, '刷新保护');
    ok('保存503保留草稿与旧内容');
    const gate = deferred();
    state.gate = gate;
    state.arrived = deferred();
    await p.locator('#articleTitle').fill('提交时标题');
    await p.locator('#saveArticle').click();
    await state.arrived.promise;
    await p.locator('#articleTitle').fill('保存中继续编辑');
    gate.resolve();
    await p.getByText(/已保存提交时的内容/).waitFor();
    assert.equal(first.title, '提交时标题');
    assert.equal(await p.locator('#articleTitle').inputValue(), '保存中继续编辑');
    await p.locator('#saveArticle').click();
    await saved(p);
    ok('保存中编辑保持脏状态、后续保存使用新revision');
    const speechCount = state.requests.filter((r) => r.method === 'POST' && r.endpoint.endsWith('/audio')).length;
    await text(p, '生成前先保存。');
    const generateGate = deferred();
    state.gate = generateGate;
    state.arrived = deferred();
    await p.locator('#generateButton').click();
    await state.arrived.promise;
    await text(p, '保存期间继续编辑，不应生成旧文字。');
    generateGate.resolve();
    await p.getByText(/已保存提交时的内容/).waitFor();
    assert.equal(
      state.requests.filter((r) => r.method === 'POST' && r.endpoint.endsWith('/audio')).length,
      speechCount,
    );
    await p.locator('#saveArticle').click();
    await saved(p);
    ok('生成前串行保存、保存中再编辑则停止合成');
    first.title = '其他窗口标题';
    first.revision++;
    await p.locator('#articleTitle').fill('冲突草稿');
    await p.locator('#saveArticle').click();
    await p.getByText(/文章已在另一窗口更新/).waitFor();
    assert.equal(await p.locator('#articleTitle').inputValue(), '冲突草稿');
    await shot(p, 'save-conflict');
    await p.getByRole('button', { name: '重新载入最新版本', exact: true }).click();
    await p.getByRole('button', { name: '放弃草稿并重新载入' }).click();
    await saved(p);
    assert.equal(await p.locator('#articleTitle').inputValue(), '其他窗口标题');
    ok('409保留草稿与明确确认后重新载入');
    await p.locator('[data-view="articles"]').click();
    first.title = '重开必须最新';
    first.revision++;
    await p.locator('.article-title').first().click();
    await saved(p);
    assert.equal(await p.locator('#articleTitle').inputValue(), '重开必须最新');
    ok('重开已缓存文章等待服务器最新读取');
    await p.locator('#articleTitle').fill('会话中断草稿');
    state.current = null;
    await p.locator('#saveArticle').click();
    await p.locator('#authSubmit').waitFor();
    await p.locator('#authName').fill('reader');
    await p.locator('#authPassword').fill('Eight123');
    await p.locator('#authSubmit').click();
    await p.locator('#articleTitle').waitFor();
    assert.equal(await p.locator('#articleTitle').inputValue(), '会话中断草稿');
    assert(p.url().endsWith(first.id));
    await p.locator('#saveArticle').click();
    await saved(p);
    ok('401同账户重登保留文章ID与未保存草稿');
    await p.locator('[data-view="articles"]').click();
    state.rows.push(...Array.from({ length: 20 }, (_, i) => state.make(`分页文章${i}`)));
    await p.reload();
    await p.getByRole('button', { name: '下一页' }).click();
    await p.getByText('第 2 / 2 页').waitFor();
    const last = state.rows.at(-1);
    await p.getByRole('button', { name: '删除文章：' + last.title }).click();
    state.fail = 'DELETE:/v1/articles/' + last.id;
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    await p.getByText(/服务暂不可用/).waitFor();
    assert(state.rows.includes(last));
    last.revision++;
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    await p.getByText(/本次未删除/).waitFor();
    assert(state.rows.includes(last));
    await p.getByRole('button', { name: '刷新列表', exact: true }).click();
    await p.getByRole('button', { name: '删除文章：' + last.title }).click();
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    await p.waitForURL('**page=1');
    assert.equal(state.rows.length, 20);
    ok('条件删除409与删除末页最后项回退');
    state.fail = 'GET:/v1/articles';
    await p.reload();
    await p.getByText('文章列表加载失败，请重试。', { exact: true }).waitFor();
    await p.getByRole('button', { name: '重新加载文章列表' }).click();
    await p.locator('.article-title').first().waitFor();
    ok('列表加载失败重试与删除503保留');
    const delayed = { id: first.id, gate: deferred(), arrived: deferred() };
    state.getGate = delayed;
    await p.locator('.article-title').first().click();
    await delayed.arrived.promise;
    await p.locator('[data-view="articles"]').click();
    await p.locator('.article-title').nth(1).click();
    await saved(p);
    const openedTitle = await p.locator('#articleTitle').inputValue();
    delayed.gate.resolve();
    await p.waitForResponse((r) => new URL(r.url()).pathname === '/v1/articles/' + first.id);
    assert.equal(await p.locator('#articleTitle').inputValue(), openedTitle);
    await p.locator('[data-view="articles"]').click();
    ok('跨文章迟到读取不能覆盖当前编辑页');
    await p.locator('#articleSearch').fill('不存在');
    await p.getByRole('button', { name: '搜索', exact: true }).click();
    await p.getByText('没有找到匹配的文章').waitFor();
    await p.getByRole('button', { name: '清除搜索' }).click();
    await p.locator('.article-title').first().waitFor();
    await shot(p, 'articles-desktop');
    await p.setViewportSize({ width: 390, height: 844 });
    await shot(p, 'articles-mobile');
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.locator('.article-title').first().click();
    await saved(p);
    await shot(p, 'article-mobile');
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.setViewportSize({ width: 320, height: 760 });
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    ok('标题搜索空结果、390/320响应式无横向溢出');
    await p.locator('#articleTitle').fill('另一账户不可看到');
    state.current = null;
    await p.locator('#saveArticle').click();
    await p.locator('#authSubmit').waitFor();
    state.account = {
      id: randomUUID(),
      login: 'second',
      displayName: '第二账户',
      status: 'active',
    };
    state.rows = [];
    state.rules = [];
    await p.locator('#authName').fill('second');
    await p.locator('#authPassword').fill('Eight123');
    await p.locator('#authSubmit').click();
    await p.getByText('还没有保存的文章').waitFor();
    await p.locator('#newArticleButton').click();
    assert.equal(await p.locator('#articleTitle').inputValue(), '新文章');
    assert.equal(await p.locator('#articleEditor').textContent(), '');
    ok('换账户清除草稿与文章查询隔离');
    await text(p, '新文章保存并生成。');
    await p.locator('#generateButton').click();
    await p.locator('#audioResult').waitFor();
    assert.equal(state.rows.length, 1);
    ok('新文章一次点击先创建再持久生成');
    state.rows.push(...Array.from({ length: 99 }, (_, i) => state.make('配额' + i)));
    await p.locator('#newArticleButton').click();
    await p.waitForURL('**/#/articles/new');
    await p.waitForFunction(
      () => document.querySelector('#articleSaveStatus')?.textContent === '尚未创建',
    );
    await p.locator('#articleTitle').fill('达到上限仍保留');
    await p.locator('#saveArticle').click();
    await p.getByText(/文章数量已达到上限/).waitFor();
    assert.equal(await p.locator('#articleTitle').inputValue(), '达到上限仍保留');
    assert.equal(state.rows.length, 100);
    ok('ARTICLE_LIMIT提示且保留新文章草稿');
    assert(!state.requests.some((r) => r.endpoint === '/v1/audio/speech'));
    assert.equal(await p.evaluate(() => localStorage.length), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          checks,
          errors,
          note: 'HTTP contract doubles; MP3 tone tests temporary player, not supplier Japanese speech acceptance.',
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

module.exports = {fixture,deferred,chooseWord};
