// Real browser with synthetic loopback responses only. No real articles or TTS.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const base = (process.env.BASE_URL || 'http://127.0.0.1:4384').replace(/\/$/, '');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw Error('Loopback preview required');
const out = process.env.QA_OUTPUT_DIR || path.join(os.tmpdir(), 'cms-category-move-qa');
fs.mkdirSync(out, { recursive: true });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const categories = [
  {
    id: id(51),
    kind: 'category',
    name: '日本語学習',
    slug: 'japanese',
    parentId: null,
    sortOrder: 0,
    revision: 1,
  },
  {
    id: id(52),
    kind: 'category',
    name: '仕事と面接',
    slug: 'interview',
    parentId: id(51),
    sortOrder: 0,
    revision: 1,
  },
];
const items = ['自己紹介を練習します。', '仕事の経験を説明します。', '面接の準備をします。'].map(
  (title, i) => ({
    id: id(i + 1),
    title,
    text: title + '\nこれは架空の記事です。',
    revision: i + 3,
    contentRevision: 2,
    currentRuleVersion: 4,
    audioStale: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    audio: i === 1 ? null : { audioId: id(i + 21), voice: 'ja-synthetic', speed: 1.15 },
    cms: {
      revision: i + 5,
      slug: `sample-${i + 1}`,
      categoryId: i === 2 ? null : categories[i].id,
      tagIds: [],
      summary: '',
      publishedReleaseId: i === 2 ? id(90) : null,
    },
  }),
);
const state = {
  items,
  moves: [],
  otherMutations: [],
  articleReads: [],
  lookups: 0,
  delay: 0,
  rejectNext: null,
};
const protectedFields = () =>
  state.items.map((a) => ({
    id: a.id,
    title: a.title,
    text: a.text,
    contentRevision: a.contentRevision,
    currentRuleVersion: a.currentRuleVersion,
    audio: a.audio,
    audioStale: a.audioStale,
    publishedReleaseId: a.cms.publishedReleaseId,
  }));
const protectedBefore = structuredClone(protectedFields());
const expectedMove = (articles, categoryId) => ({
  categoryId,
  items: articles.map((a) => ({
    articleId: a.id,
    expectedRevision: a.revision,
    expectedCmsRevision: a.cms.revision,
  })),
});

async function install(page) {
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
      return reply({ id: id(900), login: 'synthetic-preview', displayName: '虚构演示账户' });
    if (p === '/v1/auth/csrf') return reply({ csrfToken: 'synthetic-csrf-only' });
    if (p === '/v1/cms/audio-batches' && method === 'GET') return reply({ items: [] });
    if (p === '/v1/cms/taxonomy')
      return reply({
        categories: categories.map((c) => ({
          ...c,
          articleCount: state.items.filter((a) => a.cms.categoryId === c.id).length,
          childCount: categories.filter((child) => child.parentId === c.id).length,
        })),
        tags: [],
        totalArticles: state.items.length,
        uncategorizedCount: state.items.filter((a) => !a.cms.categoryId).length,
      });
    if (p === '/v1/cms/articles' && method === 'GET') {
      state.lookups++;
      return reply({ items: state.items, total: state.items.length, offset: 0, limit: 20 });
    }
    if (p === '/v1/cms/articles/move-category' && method === 'POST') {
      const input = request.postDataJSON();
      state.moves.push(structuredClone(input));
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
      if (state.rejectNext) {
        const rejection = state.rejectNext;
        state.rejectNext = null;
        return reply({ code: rejection.code, requestId: id(999) }, rejection.status);
      }
      assert.deepEqual(Object.keys(input).sort(), ['categoryId', 'items']);
      if (input.categoryId !== null && !categories.some((c) => c.id === input.categoryId))
        return reply({ code: 'INVALID_REQUEST' }, 400);
      for (const selected of input.items) {
        assert.deepEqual(Object.keys(selected).sort(), [
          'articleId',
          'expectedCmsRevision',
          'expectedRevision',
        ]);
        const article = state.items.find((a) => a.id === selected.articleId);
        if (
          !article ||
          article.revision !== selected.expectedRevision ||
          article.cms.revision !== selected.expectedCmsRevision
        )
          return reply({ code: 'CMS_REVISION_CONFLICT' }, 409);
      }
      for (const selected of input.items) {
        const article = state.items.find((a) => a.id === selected.articleId);
        article.cms = {
          ...article.cms,
          categoryId: input.categoryId,
          revision: article.cms.revision + 1,
        };
      }
      return reply({
        items: input.items.map((selected) => state.items.find((a) => a.id === selected.articleId)),
      });
    }
    const article = /^\/v1\/cms\/articles\/([^/]+)$/.exec(p);
    if (article && method === 'GET') {
      state.articleReads.push(article[1]);
      return reply(state.items.find((a) => a.id === article[1]));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method))
      state.otherMutations.push({ path: p, method });
    return reply({ code: 'NOT_FOUND' }, 404);
  });
}
async function waitUntil(check, message) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function openMove(page, keyboard = false) {
  const button = page.locator('#cmsMoveSelected');
  if (keyboard) await button.press('Enter');
  else await button.click();
  await page.locator('#cmsMoveCategoryConfirm').waitFor();
  assert.equal(await page.locator('#cmsMoveCategory').inputValue(), '');
  assert(await page.locator('#cmsMoveCategoryConfirmSubmit').isDisabled());
  await page.waitForFunction(() =>
    document.querySelector('#cmsMoveCategoryConfirm')?.contains(document.activeElement),
  );
}
async function waitClosed(page) {
  await page.waitForFunction(() => !document.querySelector('#cmsMoveCategoryConfirm'));
}
async function cancelMove(page, escape = false) {
  if (escape) await page.keyboard.press('Escape');
  else
    await page
      .locator('#cmsMoveCategoryConfirm')
      .getByRole('button', { name: '取消', exact: true })
      .click();
  await waitClosed(page);
  await page.waitForFunction(() => document.activeElement?.id === 'cmsMoveSelected');
}
async function refreshSelected(page, previousPosts) {
  await page.locator('#cmsRefreshSelected').click();
  await page.waitForFunction(() => !document.querySelector('#cmsRefreshSelected'));
  assert.equal(state.moves.length, previousPosts);
  assert(!(await page.locator('#cmsMoveSelected').isDisabled()));
}
async function selectItems(page, indexes) {
  for (const index of indexes) await page.locator('.cms-selectable-items input').nth(index).check();
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: process.platform === 'win32' ? [] : ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await install(page);
    await page.goto(base + '/articles');
    await waitUntil(() => state.lookups > 0, 'Article list did not load');
    await page.waitForFunction(
      () =>
        document.querySelector('#cmsSelectPage') &&
        !document.querySelector('#cmsSelectPage').disabled,
    );
    assert(await page.locator('#cmsMoveSelected').isDisabled());
    assert.equal(await page.locator('#cmsMoveCategory').count(), 0);
    assert.equal(await page.locator('.cms-bulk-toolbar select').count(), 0);

    // Selection is retained on cancellation. No destination is inferred.
    await selectItems(page, [0]);
    await openMove(page);
    assert.equal(await page.locator('#cmsMoveCategoryConfirm .cms-move-titles li').count(), 1);
    await page.locator('#cmsMoveCategory').selectOption(categories[1].id);
    assert(!(await page.locator('#cmsMoveCategoryConfirmSubmit').isDisabled()));
    await cancelMove(page);
    assert.equal(state.moves.length, 0);
    assert.equal(await page.locator('.cms-selectable-items input:checked').count(), 1);
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption('uncategorized');
    await cancelMove(page, true);
    assert.equal(state.moves.length, 0);

    // Single-item confirmation uses both fixed versions; choosing is not a write.
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption(categories[1].id);
    assert.equal(state.moves.length, 0);
    const singleExpected = expectedMove([state.items[0]], categories[1].id);
    await page.locator('#cmsMoveCategoryConfirmSubmit').click();
    await waitClosed(page);
    assert.equal(state.moves.length, 1);
    assert.deepEqual(state.moves[0], singleExpected);
    assert.equal(state.items[0].cms.categoryId, categories[1].id);
    assert.equal(await page.locator('.cms-selectable-items input:checked').count(), 0);
    assert.equal(await page.locator('#cmsMoveCategory').count(), 0);

    // Bulk action displays the clean toolbar and a destination-only confirmation.
    await page.locator('#cmsSelectPage').check();
    await page.locator('h1').click();
    await page.screenshot({ path: path.join(out, '01-after-toolbar.png'), fullPage: false });
    await openMove(page);
    assert.equal(await page.locator('#cmsMoveCategoryConfirm .cms-move-titles li').count(), 3);
    await page.locator('#cmsMoveCategory').selectOption(categories[0].id);
    await page.screenshot({
      path: path.join(out, '02-move-destination-confirm.png'),
      fullPage: false,
    });
    const bulkExpected = expectedMove(state.items, categories[0].id),
      beforeBulk = state.moves.length;
    state.delay = 500;
    await page.evaluate(() => {
      const button = document.querySelector('#cmsMoveCategoryConfirmSubmit');
      button.click();
      button.click();
    });
    await waitUntil(() => state.moves.length > beforeBulk, 'Bulk move did not reach the API');
    assert.equal(state.moves.length, beforeBulk + 1);
    assert(await page.locator('#cmsMoveCategoryConfirmSubmit').isDisabled());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cmsMoveCategoryConfirm').count(), 1);
    await waitClosed(page);
    state.delay = 0;
    assert.equal(state.moves.length, beforeBulk + 1);
    assert.deepEqual(state.moves.at(-1), bulkExpected);
    assert(state.items.every((a) => a.cms.categoryId === categories[0].id));
    assert.deepEqual(protectedFields(), protectedBefore);

    // The explicit uncategorized option maps to null, never the placeholder.
    await selectItems(page, [1]);
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption('uncategorized');
    await page.locator('#cmsMoveCategoryConfirmSubmit').click();
    await waitClosed(page);
    assert.equal(state.moves.at(-1).categoryId, null);
    assert.equal(state.items[1].cms.categoryId, null);

    // A conflict retains selection and requires a fresh, explicit confirmation.
    await selectItems(page, [0, 2]);
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption(categories[1].id);
    state.rejectNext = { code: 'CMS_REVISION_CONFLICT', status: 409 };
    const beforeConflict = state.moves.length;
    await page.locator('#cmsMoveCategoryConfirmSubmit').click();
    await waitClosed(page);
    assert.equal(state.moves.length, beforeConflict + 1);
    assert.equal(await page.locator('.cms-selectable-items input:checked').count(), 2);
    assert(await page.locator('#cmsMoveSelected').isDisabled());
    assert((await page.locator('.cms-list').innerText()).includes('选择已保留'));
    state.items[0].revision += 1;
    state.items[0].cms.revision += 2;
    const beforeReads = state.articleReads.length;
    await refreshSelected(page, beforeConflict + 1);
    assert.deepEqual(state.articleReads.slice(beforeReads).sort(), [id(1), id(3)]);
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption(categories[1].id);
    const freshExpected = expectedMove([state.items[0], state.items[2]], categories[1].id);
    await page.locator('#cmsMoveCategoryConfirmSubmit').click();
    await waitClosed(page);
    assert.deepEqual(state.moves.at(-1), freshExpected);

    // Unknown service failures cannot be silently retried with stale selections.
    await selectItems(page, [1]);
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption(categories[0].id);
    state.rejectNext = { code: 'DEPENDENCY_UNAVAILABLE', status: 503 };
    const beforeFailure = state.moves.length;
    await page.locator('#cmsMoveCategoryConfirmSubmit').click();
    await waitClosed(page);
    assert.equal(state.moves.length, beforeFailure + 1);
    assert.equal(await page.locator('.cms-selectable-items input:checked').count(), 1);
    assert(await page.locator('#cmsMoveSelected').isDisabled());
    await refreshSelected(page, beforeFailure + 1);
    await openMove(page);
    await page.locator('#cmsMoveCategory').selectOption(categories[0].id);
    await page.locator('#cmsMoveCategoryConfirmSubmit').click();
    await waitClosed(page);
    assert.equal(state.moves.length, beforeFailure + 2);

    // Native destination controls and focus work with Enter/ArrowDown/Escape.
    await selectItems(page, [0]);
    const beforeMobile = state.moves.length;
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await openMove(page, true);
      await page.locator('#cmsMoveCategory').focus();
      await page.locator('#cmsMoveCategory').press('ArrowDown');
      await page.locator('#cmsMoveCategory').press('Tab');
      assert.notEqual(await page.locator('#cmsMoveCategory').inputValue(), '');
      assert(!(await page.locator('#cmsMoveCategoryConfirmSubmit').isDisabled()));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await page.locator('#cmsMoveCategoryConfirm').boundingBox();
      assert(box.width <= width && box.x >= 0);
      if (width === 390)
        await page.screenshot({
          path: path.join(out, '03-mobile-move-confirm.png'),
          fullPage: false,
        });
      await cancelMove(page, true);
      assert.equal(await page.locator('#cmsMoveCategory').count(), 0);
      assert.equal(await page.locator('.cms-bulk-toolbar select').count(), 0);
    }
    assert.equal(state.moves.length, beforeMobile);
    assert.deepEqual(protectedFields(), protectedBefore);
    assert.deepEqual(state.otherMutations, []);
    assert.deepEqual(errors, []);
    console.log(
      'PASS UI: no resident destination selector, explicit placeholder, selected single/bulk scope, cancel/Escape zero writes, exact version payloads, duplicate lock, explicit uncategorized null, conflict/failure retained selection and fresh confirmation, unchanged body/audio/published references, 320/390 keyboard/focus; 0 page errors',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
