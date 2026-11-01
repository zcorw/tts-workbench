// Real browser, synthetic loopback API fixtures only. Never sends TTS or production requests.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const base = (process.env.BASE_URL || 'http://127.0.0.1:4384').replace(/\/$/, '');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw Error('Loopback preview required');
const out = process.env.QA_OUTPUT_DIR || path.join(os.tmpdir(), 'cms-audio-batch-qa');
fs.mkdirSync(out, { recursive: true });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const titles = [
  '日本語の自己紹介を練習します。',
  '新しい仕事について話します。',
  '保存された朗読を確認します。',
];
const makeArticles = () =>
  titles.map((title, i) => ({
    id: id(i + 1),
    title,
    text: title + '\nこれはテスト用の本文です。',
    revision: 3,
    contentRevision: 2,
    currentRuleVersion: 4,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    audio:
      i === 1 ? null : { audioId: id(i + 21), voice: 'ja-saved', speed: i === 0 ? 1.25 : 0.85 },
    audioStale: i === 2,
    cms: {
      revision: 5,
      slug: `sample-${i + 1}`,
      categoryId: null,
      tagIds: [],
      summary: '',
      publishedReleaseId: i === 2 ? id(90) : null,
    },
  }));
function fixture() {
  return {
    articles: makeArticles(),
    batches: [],
    creates: [],
    cancels: [],
    articleReads: [],
    jobsGets: 0,
    createDelay: 0,
    abortNext: '',
    rejectNext: null,
    rejectListNext: null,
    afterCreateStatuses: null,
  };
}
function makeBatch(state, input) {
  const items = input.items.map((item) => ({
    ...item,
    title: state.articles.find((a) => a.id === item.articleId)?.title || '合成記事',
    status: input.existingAudio === 'skip' && item.expectedAudioId ? 'skipped' : 'queued',
  }));
  if (state.afterCreateStatuses)
    items.forEach((item, i) => {
      item.status = state.afterCreateStatuses[i] || item.status;
    });
  return {
    id: id(100 + state.creates.length),
    requestId: input.requestId,
    status: items.some((item) => ['queued', 'running'].includes(item.status))
      ? 'running'
      : 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items,
  };
}
function finish(state, batch, statuses) {
  batch.items.forEach((item, i) => {
    item.status = statuses[i];
    if (item.status === 'failed') item.errorCode = 'REVISION_CONFLICT';
    if (item.status === 'uncertain') item.errorCode = 'WORKER_INTERRUPTED';
    if (item.status === 'succeeded') {
      item.audioId = id(200 + i + state.creates.length * 10);
      const article = state.articles.find((a) => a.id === item.articleId);
      article.audio = { audioId: item.audioId, voice: item.voice, speed: item.speed };
      article.audioStale = false;
    }
  });
  batch.status = batch.items.some((item) => ['queued', 'running'].includes(item.status))
    ? 'running'
    : 'completed';
}
async function install(page, state) {
  await page.route('**/site-config.json', (r) =>
    r.fulfill({ json: { workbenchUrl: base, cmsUrl: base } }),
  );
  await page.route('**/v1/**', async (r) => {
    const request = r.request(),
      url = new URL(request.url()),
      p = url.pathname,
      method = request.method();
    const reply = (json, status = 200) => r.fulfill({ status, json });
    if (p === '/v1/config')
      return reply({
        registrationEnabled: false,
        maxInputCodePoints: 10000,
        maxInputBytes: 49152,
        maxArticles: 100,
      });
    if (p === '/v1/auth/me')
      return reply({ id: id(900), displayName: '虚构演示账户', login: 'synthetic-preview' });
    if (p === '/v1/auth/csrf') return reply({ csrfToken: 'synthetic-csrf-only' });
    if (p === '/v1/voices')
      return reply({
        items: [
          { id: 'ja-primary', name: '日语演示声音', language: 'ja-JP' },
          { id: 'ja-saved', name: '已保存声音', language: 'ja-JP' },
        ],
      });
    if (p === '/v1/cms/taxonomy')
      return reply({
        categories: [],
        tags: [],
        totalArticles: state.articles.length,
        uncategorizedCount: state.articles.length,
      });
    if (p === '/v1/cms/articles')
      return reply({ items: state.articles, total: state.articles.length, offset: 0, limit: 20 });
    if (p === '/v1/cms/read/categories')
      return reply({ items: [], totalArticles: 0, uncategorizedCount: 0 });
    if (p === '/v1/cms/read/articles')
      return reply({
        items: [],
        total: 0,
        offset: 0,
        limit: 20,
        navigation: { categories: [], totalArticles: 0, uncategorizedCount: 0 },
      });
    if (p === '/v1/cms/audio-batches' && method === 'GET') {
      state.jobsGets++;
      if (state.rejectListNext) {
        const rejection = state.rejectListNext;
        state.rejectListNext = null;
        return reply({ code: rejection.code }, rejection.status);
      }
      return reply({ items: state.batches });
    }
    if (p === '/v1/cms/audio-batches' && method === 'POST') {
      const input = request.postDataJSON();
      state.creates.push(structuredClone(input));
      if (state.rejectNext) {
        const rejection = state.rejectNext;
        state.rejectNext = null;
        return reply({ code: rejection.code }, rejection.status);
      }
      if (state.createDelay) await new Promise((resolve) => setTimeout(resolve, state.createDelay));
      const existing = state.batches.find((b) => b.requestId === input.requestId);
      if (existing) return reply(existing, 202);
      const batch = makeBatch(state, input);
      if (state.abortNext === 'unsaved') {
        state.abortNext = '';
        return r.abort('failed');
      }
      state.batches.unshift(batch);
      if (state.abortNext === 'saved') {
        state.abortNext = '';
        return r.abort('failed');
      }
      return reply(batch, 202);
    }
    const cancel = /^\/v1\/cms\/audio-batches\/([^/]+)\/cancel$/.exec(p);
    if (cancel && method === 'POST') {
      state.cancels.push({ id: cancel[1], body: request.postDataJSON() });
      const batch = state.batches.find((b) => b.id === cancel[1]);
      for (const item of batch.items)
        if (item.status === 'queued') {
          item.status = 'cancelled';
          item.errorCode = 'CANCELLED_BEFORE_START';
        }
      return reply(batch);
    }
    const article = /^\/v1\/cms\/articles\/([^/]+)$/.exec(p);
    if (article) {
      state.articleReads.push(article[1]);
      return reply(state.articles.find((a) => a.id === article[1]));
    }
    return reply({ code: 'NOT_FOUND' }, 404);
  });
}
async function refresh(page) {
  await page.locator('#cmsAudioBatchRefresh').click();
  await page.waitForFunction(() => !document.querySelector('#cmsAudioBatchRefresh').disabled);
}
async function open(page) {
  await page.locator('#cmsSelectPage').check();
  await page.locator('#cmsGenerateSelected').click();
  await page.locator('#cmsAudioBatchConfirm').waitFor();
  await page.waitForFunction(() => !document.querySelector('#cmsAudioVoice').disabled);
}
async function waitUntil(fn, message) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: process.platform === 'win32' ? [] : ['--no-sandbox'],
  });
  const contexts = [];
  const errors = [];
  async function createPage(state, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => errors.push(e.message));
    await install(page, state);
    await page.goto(base + '/articles');
    await page.waitForFunction(
      () =>
        document.querySelector('#cmsSelectPage') &&
        !document.querySelector('#cmsAudioBatchRefresh')?.disabled,
    );
    return page;
  }
  try {
    const state = fixture();
    const page = await createPage(state);
    // Only checked articles enter the confirmation. Opening or cancelling never creates work.
    await page.locator('.cms-selectable-items input').nth(0).check();
    await page.locator('.cms-selectable-items input').nth(1).check();
    await page.locator('#cmsGenerateSelected').click();
    await page.waitForFunction(() => !document.querySelector('#cmsAudioVoice').disabled);
    assert.equal(
      await page.locator('#cmsAudioBatchConfirm .cms-audio-confirm-items li').count(),
      2,
    );
    assert.equal(await page.locator('#cmsAudioExistingMode').inputValue(), 'skip');
    assert(await page.locator('#cmsAudioSubmit').isDisabled());
    assert((await page.locator('#cmsAudioBatchConfirm').innerText()).includes('不发布正文'));
    await page
      .locator('#cmsAudioBatchConfirm')
      .getByRole('button', { name: '取消', exact: true })
      .click();
    assert.equal(state.creates.length, 0);
    // Explicit replacement preserves old parameters and uses chosen fallback for the new article.
    await page.locator('#cmsSelectPage').check();
    await page.locator('#cmsGenerateSelected').click();
    await page.locator('#cmsAudioExistingMode').selectOption('replace');
    await page.locator('#cmsAudioSpeed').fill('1.15');
    await page.locator('#cmsAudioConsent').check();
    await page.screenshot({ path: path.join(out, '01-audio-batch-confirm.png'), fullPage: false });
    state.createDelay = 300;
    await page.evaluate(() => {
      const button = document.querySelector('#cmsAudioSubmit');
      button.click();
      button.click();
    });
    await page.waitForFunction(() => !document.querySelector('#cmsAudioBatchConfirm'));
    assert.equal(state.creates.length, 1);
    assert.deepEqual(
      state.creates[0].items.map((i) => [i.articleId, i.voice, i.speed]),
      [
        [id(1), 'ja-saved', 1.25],
        [id(2), 'ja-primary', 1.15],
        [id(3), 'ja-saved', 0.85],
      ],
    );
    assert.equal(state.creates[0].items[0].expectedAudioId, id(21));
    assert.equal(state.creates[0].items[0].expectedRuleVersion, 4);
    assert.equal(await page.locator('#cmsPublishSelected').count(), 1);
    assert(await page.locator('#cmsGenerateSelected').isDisabled());
    assert(await page.locator('#cmsAudioBatchDetails').isHidden());
    assert.equal(await page.locator('#cmsAudioBatchToggle').getAttribute('aria-expanded'), 'false');
    finish(state, state.batches[0], ['succeeded', 'failed', 'uncertain']);
    await refresh(page);
    await page.waitForFunction(() => document.querySelector('#cmsAudioBatchProgress')?.value === 3);
    assert(await page.locator('#cmsAudioBatchDetails').isHidden());
    assert.equal(
      await page.getByRole('progressbar', { name: '批量音频处理进度' }).getAttribute('value'),
      '3',
    );
    assert((await page.locator('#cmsAudioBatchSummary').innerText()).includes('失败 1 篇'));
    assert((await page.locator('#cmsAudioBatchSummary').innerText()).includes('结果不确定 1 篇'));
    assert(await page.locator('#cmsAudioBatchRetry').isVisible());
    await page.locator('#cmsAudioBatchToggle').press('Enter');
    assert.equal(await page.locator('#cmsAudioBatchItems [data-audio-status=failed]').count(), 1);
    assert((await page.locator('#cmsAudioBatchItems').innerText()).includes('结果可能已产生费用'));
    await page.screenshot({ path: path.join(out, '02-audio-batch-results.png'), fullPage: false });
    // Only failed item is read afresh and retried; uncertainty and success never auto-retry.
    state.articles[1].revision = 6;
    state.articles[1].currentRuleVersion = 8;
    await page.locator('#cmsAudioBatchRetry').click();
    await page.locator('#cmsAudioBatchConfirm').waitFor();
    assert.equal(state.creates.length, 1);
    assert.equal(
      await page.locator('#cmsAudioBatchConfirm .cms-audio-confirm-items li').count(),
      1,
    );
    assert((await page.locator('#cmsAudioBatchConfirm').innerText()).includes('正文 v6'));
    assert.deepEqual(state.articleReads, [id(2)]);
    await page.locator('#cmsAudioConsent').check();
    await page.locator('#cmsAudioSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#cmsAudioBatchConfirm'));
    assert.equal(state.creates.length, 2);
    assert.equal(state.creates[1].items.length, 1);
    assert.equal(state.creates[1].items[0].expectedRevision, 6);
    assert.equal(state.creates[1].items[0].expectedRuleVersion, 8);
    // A backend task remains visible across SPA navigation and a full reload.
    const taskId = state.batches[0].id;
    await page.locator('#cmsRead').click();
    await page.waitForURL((u) => u.pathname === '/read');
    assert(await page.locator('#cmsAudioBatchDetails').isHidden());
    await page.locator('#cmsAudioBatchToggle').click();
    assert.equal(await page.locator('#cmsAudioBatchItems li').count(), 1);
    await page.reload();
    await page.locator('#cmsAudioBatchToggle').waitFor();
    assert(await page.locator('#cmsAudioBatchDetails').isHidden());
    await page.locator('#cmsAudioBatchToggle').click();
    await page.locator('#cmsAudioBatchItems li').waitFor();
    assert.equal(state.batches[0].id, taskId);
    assert.equal(state.creates.length, 2);
    // Stop affects queued rows only; the in-flight row remains running.
    const queued = fixture();
    const input = {
      requestId: id(800),
      existingAudio: 'replace',
      items: queued.articles.map((a) => ({
        articleId: a.id,
        expectedRevision: a.revision,
        expectedAudioId: a.audio?.audioId || null,
        expectedRuleVersion: a.currentRuleVersion,
        voice: 'ja-primary',
        speed: 1,
      })),
    };
    queued.batches = [makeBatch(queued, input)];
    queued.batches[0].items[0].status = 'running';
    const pendingPage = await createPage(queued);
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    assert.equal(await pendingPage.locator('#cmsAudioBatchProgress').getAttribute('value'), '0');
    assert.equal(await pendingPage.locator('#cmsAudioBatchProgress').getAttribute('max'), '3');
    const hiddenNote = await pendingPage.locator('#cmsAudioCancelNote').boundingBox();
    assert(hiddenNote.width <= 1 && hiddenNote.height <= 1);
    assert((await pendingPage.locator('#cmsAudioBatchPanel').boundingBox()).height < 220);
    await pendingPage.screenshot({
      path: path.join(out, '01-compact-audio-progress.png'),
      fullPage: false,
    });
    await pendingPage.locator('#cmsAudioBatchToggle').press('Enter');
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isVisible());
    assert.equal(
      await pendingPage.locator('#cmsAudioBatchToggle').getAttribute('aria-controls'),
      'cmsAudioBatchDetails',
    );
    await pendingPage.screenshot({
      path: path.join(out, '02-expanded-audio-details.png'),
      fullPage: false,
    });
    await pendingPage.locator('#cmsAudioBatchToggle').press('Space');
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    await pendingPage.screenshot({
      path: path.join(out, '03-audio-batch-progress.png'),
      fullPage: false,
    });
    await pendingPage.locator('#cmsAudioBatchCancel').click();
    await pendingPage.waitForFunction(
      () => document.querySelectorAll('[data-audio-status=cancelled]').length === 2,
    );
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    assert.equal(await pendingPage.locator('#cmsAudioBatchProgress').getAttribute('value'), '2');
    await refresh(pendingPage);
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    await pendingPage.locator('#cmsAudioBatchToggle').click();
    assert.equal(await pendingPage.locator('[data-audio-status=running]').count(), 1);
    assert.deepEqual(queued.cancels[0].body, {});
    assert(
      (await pendingPage.locator('#cmsAudioBatchPanel').innerText()).includes(
        '已经产生的费用不能撤回',
      ),
    );
    // Polling stops while hidden and returning checks server state.
    await pendingPage.waitForFunction(
      () => !document.querySelector('#cmsAudioBatchRefresh').disabled,
    );
    await pendingPage.clock.install();
    await pendingPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const beforeHidden = queued.jobsGets;
    await pendingPage.clock.fastForward(8000);
    await pendingPage.waitForTimeout(100);
    assert.equal(queued.jobsGets, beforeHidden);
    await pendingPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitUntil(() => queued.jobsGets > beforeHidden, 'Visible task did not refresh');
    await pendingPage.locator('#cmsAudioBatchToggle').click();
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    finish(queued, queued.batches[0], ['succeeded', 'cancelled', 'cancelled']);
    await refresh(pendingPage);
    await pendingPage.waitForFunction(
      () => document.querySelector('#cmsAudioBatchProgress')?.value === 3,
    );
    assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    assert.equal(await pendingPage.locator('#cmsAudioBatchProgress').getAttribute('value'), '3');
    assert((await pendingPage.locator('#cmsAudioBatchSummary').innerText()).includes('处理结束'));
    assert(await pendingPage.locator('#cmsAudioBatchToggle').isVisible());
    for (const width of [320, 390]) {
      await pendingPage.setViewportSize({ width, height: 844 });
      assert(await pendingPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 390)
        await pendingPage.screenshot({
          path: path.join(out, '03-mobile-audio-progress.png'),
          fullPage: false,
        });
      await pendingPage.locator('#cmsAudioBatchToggle').press('Enter');
      assert(await pendingPage.locator('#cmsAudioBatchDetails').isVisible());
      assert(await pendingPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await pendingPage.locator('#cmsAudioBatchToggle').press('Space');
      assert(await pendingPage.locator('#cmsAudioBatchDetails').isHidden());
    }
    // Lost create responses restore persisted work without automatically charging another batch.
    const uncertain = fixture();
    uncertain.abortNext = 'saved';
    const uncertainPage = await createPage(uncertain);
    await open(uncertainPage);
    await uncertainPage.locator('#cmsAudioConsent').check();
    await uncertainPage.locator('#cmsAudioSubmit').click();
    await uncertainPage.locator('#cmsAudioRecover').waitFor();
    assert.equal(uncertain.creates.length, 1);
    await uncertainPage.locator('#cmsAudioRecover').click();
    await uncertainPage.waitForFunction(() => !document.querySelector('#cmsAudioBatchConfirm'));
    assert.equal(uncertain.creates.length, 1);
    assert.equal(uncertain.batches[0].requestId, uncertain.creates[0].requestId);
    const unsaved = fixture();
    unsaved.abortNext = 'unsaved';
    const unsavedPage = await createPage(unsaved);
    await open(unsavedPage);
    await unsavedPage.locator('#cmsAudioConsent').check();
    await unsavedPage.locator('#cmsAudioSubmit').click();
    await unsavedPage.locator('#cmsAudioRecover').waitFor();
    assert.equal(unsaved.creates.length, 1);
    await unsavedPage.locator('#cmsAudioRecover').click();
    await unsavedPage.waitForFunction(() => !document.querySelector('#cmsAudioBatchConfirm'));
    assert.equal(unsaved.creates.length, 2);
    assert.deepEqual(unsaved.creates[1], unsaved.creates[0]);
    // A definite preflight conflict did not create work; it unlocks the retained
    // draft and requires fresh snapshots and new consent, without automatic POST.
    const rejected = fixture();
    rejected.rejectNext = { code: 'REVISION_CONFLICT', status: 409 };
    const rejectedPage = await createPage(rejected);
    await open(rejectedPage);
    await rejectedPage.locator('#cmsAudioConsent').check();
    await rejectedPage.locator('#cmsAudioSubmit').click();
    await rejectedPage
      .locator('#cmsAudioSubmitError')
      .filter({ hasText: '正文版本已变化' })
      .waitFor();
    assert.equal(rejected.creates.length, 1);
    assert.equal(rejected.batches.length, 0);
    assert.equal(await rejectedPage.locator('#cmsAudioRecover').count(), 0);
    assert(!(await rejectedPage.locator('#cmsAudioConsent').isChecked()));
    assert(await rejectedPage.locator('#cmsAudioSubmit').isDisabled());
    assert(
      !(await rejectedPage
        .locator('#cmsAudioBatchConfirm')
        .getByRole('button', { name: '取消', exact: true })
        .isDisabled()),
    );
    for (const article of rejected.articles) {
      article.revision = 6;
      article.currentRuleVersion = 8;
    }
    await rejectedPage.locator('#cmsAudioRefreshDraft').click();
    await rejectedPage.locator('#cmsAudioDraftNotice').waitFor();
    assert.equal(rejected.creates.length, 1);
    assert.deepEqual(rejected.articleReads, [id(1), id(2), id(3)]);
    assert((await rejectedPage.locator('#cmsAudioBatchConfirm').innerText()).includes('正文 v6'));
    assert(!(await rejectedPage.locator('#cmsAudioConsent').isChecked()));
    await rejectedPage.locator('#cmsAudioConsent').check();
    await rejectedPage.locator('#cmsAudioSubmit').click();
    await rejectedPage.waitForFunction(() => !document.querySelector('#cmsAudioBatchConfirm'));
    assert.equal(rejected.creates.length, 2);
    assert.equal(rejected.batches.length, 1);
    assert.notEqual(rejected.creates[1].requestId, rejected.creates[0].requestId);
    assert(
      rejected.creates[1].items.every(
        (item) => item.expectedRevision === 6 && item.expectedRuleVersion === 8,
      ),
    );
    // Unknown database/dependency errors retain the frozen key and do not resend.
    const databaseUnknown = fixture();
    databaseUnknown.rejectNext = { code: 'DEPENDENCY_UNAVAILABLE', status: 503 };
    const databasePage = await createPage(databaseUnknown);
    await open(databasePage);
    await databasePage.locator('#cmsAudioConsent').check();
    await databasePage.locator('#cmsAudioSubmit').click();
    await databasePage.locator('#cmsAudioRecover').waitFor();
    assert.equal(databaseUnknown.creates.length, 1);
    assert.equal(await databasePage.locator('#cmsAudioRefreshDraft').count(), 0);
    // A failed lookup cannot prove that the original create was rejected.
    databaseUnknown.rejectListNext = { code: 'NOT_FOUND', status: 404 };
    await databasePage.locator('#cmsAudioRecover').click();
    await databasePage.locator('#cmsAudioSubmitError').filter({ hasText: '仍未确认' }).waitFor();
    assert.equal(databaseUnknown.creates.length, 1);
    assert.equal(await databasePage.locator('#cmsAudioRefreshDraft').count(), 0);
    await databasePage.locator('#cmsAudioRecover').click();
    await databasePage.waitForFunction(() => !document.querySelector('#cmsAudioBatchConfirm'));
    assert.equal(databaseUnknown.creates.length, 2);
    assert.deepEqual(databaseUnknown.creates[1], databaseUnknown.creates[0]);
    // Narrow views keep both the selection toolbar and the confirmation usable.
    const mobile = await createPage(fixture());
    for (const width of [320, 390]) {
      await mobile.setViewportSize({ width, height: 844 });
      await open(mobile);
      assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await mobile.locator('#cmsAudioConsent').check();
      assert(!(await mobile.locator('#cmsAudioSubmit').isDisabled()));
      if (width === 390)
        await mobile.screenshot({
          path: path.join(out, '04-audio-batch-mobile.png'),
          fullPage: false,
        });
      await mobile
        .locator('#cmsAudioBatchConfirm')
        .getByRole('button', { name: '取消', exact: true })
        .click();
      assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS UI: compact default progress, keyboard expand/collapse, preserved collapsed state after refresh/cancel/completion, visible failure/uncertainty counts, 320/390 compact/details layouts; selected scope, skip/replace consent, version payloads, duplicate lock, failed-only fresh retry, conflict confirmation, uncertainty recovery, navigation/reload, cancel queued, hidden/visible polling; 0 page errors',
    );
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
