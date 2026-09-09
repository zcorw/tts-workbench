const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BASE_URL || 'http://127.0.0.1:4182/';
const out = path.join(__dirname, 'audio-integration-artifacts');
const controlPath = path.resolve(__dirname, '../../../runtime/f2-provider-control.json');
const checks = [],
  errors = [],
  responses = [],
  created = [];
const control = (value) => fs.writeFileSync(controlPath, JSON.stringify(value));
const ok = (text) => {
  checks.push(text);
  console.log('PASS', text);
};
const saved = (p) =>
  p.waitForFunction(
    () => document.querySelector('#articleSaveStatus')?.textContent === '已保存到我的文章',
  );
const audioId = (p) => p.locator('#audioResult').getAttribute('data-audio-id');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  control({});
  const browser = await chromium.launch({ headless: true }),
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('response', (r) => {
    if (r.url().includes('/v1/'))
      responses.push({
        path: new URL(r.url()).pathname,
        method: r.request().method(),
        status: r.status(),
      });
  });
  const login = 'audio-' + randomUUID().slice(0, 12),
    password = randomUUID() + 'A1';
  const postCount = () =>
    responses.filter((r) => r.method === 'POST' && /\/articles\/[^/]+\/audio$/.test(r.path)).length;
  async function headers() {
    const csrf = await (await context.request.get(base + 'v1/auth/csrf')).json();
    return { Origin: new URL(base).origin, 'X-CSRF-Token': csrf.csrfToken };
  }
  async function generate(expectedStatus = 200) {
    const response = p.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/articles\/[^/]+\/audio$/.test(new URL(r.url()).pathname),
    );
    await p.locator('#generateButton').click();
    const r = await response;
    assert.equal(r.status(), expectedStatus);
    return r;
  }
  try {
    await p.goto(base + '#/register');
    await p.locator('#registerName').fill('持久音频联调');
    await p.locator('#authName').fill(login);
    await p.locator('#authPassword').fill(password);
    await p.locator('#confirmPassword').fill(password);
    await p.locator('#authSubmit').click();
    await p.waitForURL('**/#/login');
    await p.locator('#authName').fill(login);
    await p.locator('#authPassword').fill(password);
    await p.locator('#authSubmit').click();
    await p.locator('#articlesView').waitFor();
    await p.locator('#newArticleButton').click();
    await p.locator('#articleTitle').fill('日本橋 · 已保存音频');
    await p.locator('#articleEditor').fill('日本橋の朝。\n日本橋を歩く。');
    await p.waitForFunction(() => !document.querySelector('#generateButton').disabled);
    await p.locator('#speedRange').fill('1.15');
    const firstResponse = await generate();
    const first = await firstResponse.json();
    created.push(first.articleId);
    await p.waitForFunction(
      (value) => document.querySelector('#audioResult')?.dataset.audioId === value,
      first.audio.audioId,
    );
    assert.equal(first.audio.speed, 1.15);
    assert.equal(first.audio.voice, 'ja-jp-primary');
    await saved(p);
    ok('真实新文章一次保存生成，合法1.15语速及JSON→GET音频');
    const download = p.waitForEvent('download');
    await p.locator('#downloadButton').click();
    const downloaded = fs.readFileSync(await (await download).path());
    const expected = fs.readFileSync(path.join(__dirname, 'tone.mp3'));
    assert.equal(downloaded.length, 40585);
    assert.equal(
      createHash('sha256').update(downloaded).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
    );
    ok('真实下载完整MP3与可控transport字节一致');
    const beforeReload = postCount();
    await p.reload();
    await p.waitForFunction(
      (value) => document.querySelector('#audioResult')?.dataset.audioId === value,
      first.audio.audioId,
    );
    assert.equal(postCount(), beforeReload);
    assert.equal(await p.locator('#speedRange').inputValue(), '1.15');
    await p.locator('#playButton').click();
    await p.waitForFunction(() => document.querySelector('#playState').textContent === '正在播放');
    await p.locator('#stopButton').click();
    await p.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await p.screenshot({ path: path.join(out, 'restored-desktop.png'), fullPage: true });
    ok('真实PG刷新恢复音频/参数/播放且没有付费重试');
    await p.locator('#articleTitle').fill('日本橋 · 标题修改');
    await p.locator('#saveArticle').click();
    await saved(p);
    assert(!(await p.locator('#staleBanner').isVisible()));
    await p.locator('#articleEditor').fill('日本橋の新しい朝。');
    assert(await p.locator('#staleBanner').isVisible());
    await p.locator('#saveArticle').click();
    await saved(p);
    const next = await (await generate()).json();
    await p.waitForFunction(
      (value) => document.querySelector('#audioResult')?.dataset.audioId === value,
      next.audio.audioId,
    );
    assert.notEqual(next.audio.audioId, first.audio.audioId);
    assert.equal(
      (
        await context.request.get(
          base + `v1/articles/${first.articleId}/audio?audioId=${first.audio.audioId}`,
        )
      ).status(),
      404,
    );
    assert(!(await p.locator('#staleBanner').isVisible()));
    ok('真实标题不误过期、正文过期与成功替换使旧audioId404');
    control({ fail: true });
    const failureResponse = p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/audio'),
    );
    await p.locator('#generateButton').click();
    assert((await failureResponse).status() >= 400);
    await p.locator('#generationError').waitFor();
    assert.equal(await audioId(p), next.audio.audioId);
    assert.equal(
      (await (await context.request.get(base + 'v1/articles/' + first.articleId)).json()).audio
        .audioId,
      next.audio.audioId,
    );
    ok('真实transport失败保留数据库与播放器旧成功音频');
    control({ oversize: true });
    const oversizeResponse = p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/audio'),
    );
    await p.locator('#generateButton').click();
    assert((await oversizeResponse).status() >= 400);
    await p.waitForFunction(() => !document.querySelector('#generateButton').disabled);
    assert.equal(await audioId(p), next.audio.audioId);
    ok('真实超8MiB响应不替换旧音频');
    control({ delayMs: 2000 });
    const inFlight = p.waitForRequest(
      (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/audio'),
    );
    const delayed = p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/audio'),
    );
    await p.locator('#generateButton').click();
    await inFlight;
    await p.locator('#articleEditor').fill('日本橋の草稿を編集中。');
    const delayedMetadata = await (await delayed).json();
    await p.getByText(/音频已生成，但正文又有修改/).waitFor();
    assert.equal(await audioId(p), next.audio.audioId);
    assert.equal(await p.locator('#articleEditor').textContent(), '日本橋の草稿を編集中。');
    control({});
    const beforeRecover = postCount();
    await p.locator('#reloadAudio').click();
    await p.waitForFunction(
      (value) => document.querySelector('#audioResult')?.dataset.audioId === value,
      delayedMetadata.audio.audioId,
    );
    assert.equal(postCount(), beforeRecover);
    assert(await p.locator('#staleBanner').isVisible());
    ok('真实在途草稿隔离与只读恢复服务器成功音频');
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await p.screenshot({ path: path.join(out, 'stale-mobile.png'), fullPage: true });
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.locator('#saveArticle').click();
    await saved(p);
    await p.locator('[data-view="articles"]').click();
    await p.getByRole('button', { name: '删除文章：日本橋 · 标题修改' }).click();
    await p.getByRole('button', { name: '确认删除', exact: true }).click();
    await p.getByText('还没有保存的文章').waitFor();
    assert.equal(
      (await context.request.get(base + 'v1/articles/' + first.articleId)).status(),
      404,
    );
    assert.equal(
      (
        await context.request.get(
          base + `v1/articles/${first.articleId}/audio?audioId=${delayedMetadata.audio.audioId}`,
        )
      ).status(),
      404,
    );
    ok('真实删除文章及唯一音频、移动端过期状态');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          origin: base,
          checks,
          errors,
          responses,
          note: 'Real HTTP/PostgreSQL with isolated in-process playable tone transport. No browser interception, external provider, payment, or pronunciation acceptance. Control restored and article cleaned.',
        },
        null,
        2,
      ),
    );
  } finally {
    control({});
    for (const id of created) {
      const response = await context.request.get(base + 'v1/articles/' + id);
      if (response.ok()) {
        const article = await response.json();
        await context.request.delete(
          base + `v1/articles/${id}?expectedRevision=${article.revision}`,
          { headers: await headers() },
        );
      }
    }
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
