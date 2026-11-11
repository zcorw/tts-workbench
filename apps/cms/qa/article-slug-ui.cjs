// Real browser with loopback synthetic responses only. Never uses production or TTS.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const base = (process.env.BASE_URL || 'http://127.0.0.1:4384').replace(/\/$/, '');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw Error('Loopback preview required');
const out = process.env.QA_OUTPUT_DIR || path.join(os.tmpdir(), 'cms-article-slug-qa');
fs.mkdirSync(out, { recursive: true });
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const canonical = (value) => (value || '').trim();
function fixture() {
  return {
    articles: new Map(),
    releases: new Map(),
    releaseDeletes: [],
    createRequests: [],
    patches: [],
    reads: [],
    otherWrites: [],
    taken: new Set(),
    rejectNext: null,
    abortNext: '',
    delay: 0,
  };
}
function automaticSlug(state, articleId) {
  const stem = 'article-' + articleId.replaceAll('-', '').slice(0, 12).toLowerCase();
  let candidate = stem,
    suffix = 2;
  while (
    [...state.articles.values()].some((a) => a.id !== articleId && a.cms.slug === candidate) ||
    state.taken.has(candidate)
  )
    candidate = `${stem}-${suffix++}`;
  return candidate;
}
function makeArticle(articleId, title, text, slug, revision = 1, cmsRevision = 1) {
  return {
    id: articleId,
    title,
    text,
    revision,
    contentRevision: 1,
    currentRuleVersion: 0,
    audio: null,
    audioStale: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    cms: {
      revision: cmsRevision,
      slug,
      summary: '',
      categoryId: null,
      tagIds: [],
      publishedReleaseId: null,
    },
  };
}
function sameCreate(article, input) {
  return (
    article.revision === 1 &&
    article.cms.revision === 1 &&
    article.title === input.title &&
    article.text === input.text &&
    article.cms.slug === (canonical(input.cms.slug) || article.cms.slug) &&
    article.cms.summary === input.cms.summary &&
    article.cms.categoryId === input.cms.categoryId &&
    JSON.stringify(article.cms.tagIds) === JSON.stringify(input.cms.tagIds)
  );
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
      return reply({ id: id(900), login: 'synthetic-preview', displayName: '虚构演示账户' });
    if (p === '/v1/auth/csrf') return reply({ csrfToken: 'synthetic-csrf-only' });
    if (p === '/v1/voices') return reply({ items: [] });
    if (p === '/v1/cms/audio-batches') return reply({ items: [] });
    if (p === '/v1/cms/taxonomy')
      return reply({
        categories: [],
        tags: [],
        totalArticles: state.articles.size,
        uncategorizedCount: state.articles.size,
      });
    if (p === '/v1/cms/articles' && method === 'GET')
      return reply({
        items: [...state.articles.values()],
        total: state.articles.size,
        offset: 0,
        limit: 20,
      });
    if (p === '/v1/cms/articles' && method === 'POST') {
      const input = request.postDataJSON();
      state.createRequests.push(structuredClone(input));
      assert(uuid.test(input.requestId), 'Create needs one stable UUID requestId');
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
      if (state.rejectNext) {
        const rejection = state.rejectNext;
        state.rejectNext = null;
        return reply({ code: rejection.code }, rejection.status);
      }
      if (state.abortNext === 'before') {
        state.abortNext = '';
        return r.abort('failed');
      }
      const previous = state.articles.get(input.requestId);
      if (previous)
        return sameCreate(previous, input)
          ? reply(previous, 201)
          : reply({ code: 'CREATE_REQUEST_CONFLICT' }, 409);
      const custom = canonical(input.cms.slug);
      if (custom && (custom.length > 120 || !slugPattern.test(custom)))
        return reply({ code: 'INVALID_REQUEST' }, 400);
      if (
        custom &&
        (state.taken.has(custom) || [...state.articles.values()].some((a) => a.cms.slug === custom))
      )
        return reply({ code: 'SLUG_CONFLICT' }, 409);
      const value = makeArticle(
        input.requestId,
        input.title,
        input.text,
        custom || automaticSlug(state, input.requestId),
      );
      value.cms = {
        ...value.cms,
        summary: input.cms.summary,
        categoryId: input.cms.categoryId,
        tagIds: input.cms.tagIds,
      };
      state.articles.set(value.id, value);
      if (state.abortNext === 'after') {
        state.abortNext = '';
        return r.abort('failed');
      }
      return reply(value, 201);
    }
    const releases = /^\/v1\/cms\/articles\/([^/]+)\/releases$/.exec(p);
    if (releases && method === 'GET')
      return reply({ items: state.releases.get(releases[1]) || [] });
    const releaseDelete = /^\/v1\/cms\/articles\/([^/]+)\/releases\/([^/]+)$/.exec(p);
    if (releaseDelete && method === 'DELETE') {
      const article = state.articles.get(releaseDelete[1]);
      if (!article) return reply({ code: 'NOT_FOUND' }, 404);
      if (Number(url.searchParams.get('expectedCmsRevision')) !== article.cms.revision)
        return reply({ code: 'CMS_REVISION_CONFLICT' }, 409);
      if (releaseDelete[2] === article.cms.publishedReleaseId)
        return reply({ code: 'RELEASE_IS_CURRENT' }, 409);
      state.releaseDeletes.push({ articleId: article.id, releaseId: releaseDelete[2] });
      state.releases.set(
        article.id,
        (state.releases.get(article.id) || []).filter((release) => release.id !== releaseDelete[2]),
      );
      article.cms.revision += 1;
      return r.fulfill({ status: 204 });
    }
    const match = /^\/v1\/cms\/articles\/([^/]+)$/.exec(p);
    if (match && method === 'GET') {
      state.reads.push(match[1]);
      const value = state.articles.get(match[1]);
      return value ? reply(value) : reply({ code: 'NOT_FOUND' }, 404);
    }
    if (match && method === 'PATCH') {
      const input = request.postDataJSON(),
        previous = state.articles.get(match[1]);
      state.patches.push({ id: match[1], input: structuredClone(input) });
      if (!previous) return reply({ code: 'NOT_FOUND' }, 404);
      if (
        previous.revision !== input.expectedRevision ||
        previous.cms.revision !== input.cms.expectedRevision
      )
        return reply({ code: 'CMS_REVISION_CONFLICT' }, 409);
      const custom = canonical(input.cms.slug);
      if (custom && (custom.length > 120 || !slugPattern.test(custom)))
        return reply({ code: 'INVALID_REQUEST' }, 400);
      if (
        custom &&
        (state.taken.has(custom) ||
          [...state.articles.values()].some((a) => a.id !== previous.id && a.cms.slug === custom))
      )
        return reply({ code: 'SLUG_CONFLICT' }, 409);
      const slug = custom || previous.cms.slug || automaticSlug(state, previous.id);
      const value = {
        ...previous,
        title: input.title,
        text: input.text,
        revision: previous.revision + 1,
        cms: { ...previous.cms, ...input.cms, revision: previous.cms.revision + 1, slug },
      };
      delete value.cms.expectedRevision;
      state.articles.set(value.id, value);
      return reply(value);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) state.otherWrites.push({ path: p, method });
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
async function advanced(page, prefix = 'cms', key = 'Enter') {
  const summary = page.locator(`#${prefix}Advanced > summary`);
  await summary.press(key);
  await page.waitForFunction((id) => document.getElementById(id)?.open, `${prefix}Advanced`);
}
async function assertClosed(page, prefix = 'cms') {
  await page.waitForFunction((id) => {
    const details = document.getElementById(id);
    return details && !details.open;
  }, `${prefix}Advanced`);
  assert.equal(await page.locator(`#${prefix}Advanced`).getAttribute('open'), null);
  assert(await page.locator(`#${prefix}Slug`).isHidden());
}
async function fillArticle(page, title, text = 'これは動作確認用の架空の日文本文です。') {
  await page.locator('#cmsTitle').fill(title);
  await page.locator('#cmsText').fill(text);
}
async function savedRoute(page, articleId) {
  await page.waitForURL((url) => url.pathname === `/articles/${articleId}`);
  await page.locator('#cmsTitle').waitFor();
  await page.waitForFunction(() => !document.querySelector('#cmsSave')?.disabled);
}
async function hasEditorError(page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.cms-editor [role="alert"]')].some(
      (node) => !node.hidden && node.textContent.trim(),
    ),
  );
}
async function pending(page, state) {
  await page.locator('#cmsCreatePending').waitFor();
  assert((await page.locator('#cmsSave').innerText()).includes('核对并恢复这次保存'));
  assert(await page.locator('#cmsTitle').isDisabled());
  assert(await page.locator('#cmsText').isDisabled());
  assert(await page.locator('#cmsSlug').isDisabled());
  assert.equal(state.createRequests.length, 1);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: process.platform === 'win32' ? [] : ['--no-sandbox'],
  });
  const contexts = new Set(),
    allStates = [],
    errors = [];
  async function createCase(state = fixture(), route = '/articles/new') {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    contexts.add(context);
    allStates.push(state);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await install(page, state);
    await page.goto(base + route);
    await page.locator('#cmsTitle').waitFor();
    return {
      state,
      page,
      async close() {
        await context.close();
        contexts.delete(context);
      },
    };
  }
  try {
    // Chinese and Japanese titles both save without exposing or filling a slug.
    for (const title of ['中文标题无需填写链接标识', '日本語の見出しだけで保存できます。']) {
      const run = await createCase(),
        { page, state } = run;
      await assertClosed(page);
      await fillArticle(page, title);
      if (title.startsWith('中文'))
        await page.screenshot({
          path: path.join(out, '01-new-article-simple.png'),
          fullPage: false,
        });
      await page.locator('#cmsSave').click();
      await waitUntil(() => state.createRequests.length === 1, 'Auto-slug create missing');
      const articleId = state.createRequests[0].requestId;
      await savedRoute(page, articleId);
      assert.equal(state.articles.size, 1);
      assert.equal(state.articles.get(articleId).title, title);
      assert.match(state.articles.get(articleId).cms.slug, /^article-[a-f0-9]{12}(?:-[a-z0-9]+)?$/);
      assert(!canonical(state.createRequests[0].cms.slug));
      await assertClosed(page);
      const stable = state.articles.get(articleId).cms.slug;
      await page.locator('#cmsTitle').fill(title + ' · 修改标题');
      await page.locator('#cmsSave').click();
      await waitUntil(
        () =>
          state.patches.length === 1 && state.articles.get(articleId).title.endsWith('修改标题'),
        'Title patch missing',
      );
      await page.waitForFunction(() => !document.querySelector('#cmsSave').disabled);
      assert.equal(state.articles.get(articleId).cms.slug, stable);
      await advanced(page);
      assert.equal(await page.locator('#cmsSlug').inputValue(), stable);
      await page.locator('.cms-editor > .cms-row a[href="/articles"]').click();
      await page.waitForURL((url) => url.pathname === '/articles');
      await page.locator(`a[href="/articles/${articleId}"]`).first().click();
      await page.locator('#cmsTitle').waitFor();
      await assertClosed(page);
      await run.close();
    }

    // Native advanced controls support keyboard; invalid custom values never POST.
    const customRun = await createCase(),
      { page: custom, state: customState } = customRun;
    await fillArticle(custom, '自定义标识演示');
    await advanced(custom);
    assert((await custom.locator('#cmsAdvanced').innerText()).includes('自动'));
    assert.equal(await custom.locator('#cmsSlug').getAttribute('maxlength'), '120');
    await custom.locator('#cmsAdvanced > summary').press('Space');
    await assertClosed(custom);
    await advanced(custom, 'cms', 'Space');
    for (const value of [
      '日本語',
      'MixedCase',
      'bad--slug',
      'bad_slug',
      'contains space',
      '-leading',
    ]) {
      await custom.locator('#cmsSlug').fill(value);
      await custom.locator('#cmsSave').click();
      await hasEditorError(custom);
      assert.equal(customState.createRequests.length, 0);
      assert(!(await custom.locator('#cmsTitle').isDisabled()));
    }
    await custom.locator('#cmsSlug').fill('  my-custom-slug-2026  ');
    await custom.screenshot({ path: path.join(out, '02-advanced-slug.png'), fullPage: false });
    await custom.locator('#cmsSave').click();
    await waitUntil(() => customState.createRequests.length === 1, 'Custom create missing');
    await savedRoute(custom, customState.createRequests[0].requestId);
    await assertClosed(custom);
    assert.equal(customState.createRequests[0].cms.slug, 'my-custom-slug-2026');
    assert.equal([...customState.articles.values()][0].cms.slug, 'my-custom-slug-2026');
    await customRun.close();

    // Known rejections allow field correction while keeping the original key.
    for (const code of ['SLUG_CONFLICT', 'INVALID_REQUEST']) {
      const state = fixture();
      if (code === 'SLUG_CONFLICT') state.taken.add('already-taken');
      else state.rejectNext = { code, status: 400 };
      const run = await createCase(state),
        { page } = run;
      await fillArticle(page, '确定拒绝后修改标识');
      await advanced(page);
      await page.locator('#cmsSlug').fill('already-taken');
      await page.locator('#cmsSave').click();
      await hasEditorError(page);
      await waitUntil(() => state.createRequests.length === 1, 'Known rejection missing');
      await page.waitForFunction(() => !document.querySelector('#cmsTitle').disabled);
      assert.equal(await page.locator('#cmsCreatePending').count(), 0);
      assert.equal(state.articles.size, 0);
      const originalKey = state.createRequests[0].requestId;
      await page.locator('#cmsSlug').fill('available-' + code.toLowerCase().replaceAll('_', '-'));
      await page.locator('#cmsSave').click();
      await savedRoute(page, originalKey);
      assert.equal(state.createRequests.length, 2);
      assert.equal(state.createRequests[1].requestId, originalKey);
      assert.equal(state.articles.size, 1);
      await run.close();
    }

    // Blank PATCH auto-fills legacy articles without metadata, but preserves an
    // existing saved slug instead of regenerating it from the new title.
    for (const previousSlug of ['', 'legacy-stable']) {
      const state = fixture(),
        articleId = id(previousSlug ? 32 : 31);
      state.articles.set(
        articleId,
        makeArticle(
          articleId,
          '旧文章',
          'これは旧記事です。',
          previousSlug,
          3,
          previousSlug ? 5 : 0,
        ),
      );
      const run = await createCase(state, `/articles/${articleId}`),
        { page } = run;
      await assertClosed(page);
      await page.locator('#cmsTitle').fill('旧文章的新标题');
      await advanced(page);
      await page.locator('#cmsSlug').fill('');
      await page.locator('#cmsSave').click();
      await waitUntil(
        () => state.patches.length === 1 && !!state.articles.get(articleId).cms.slug,
        'Blank legacy patch missing',
      );
      await page.waitForFunction(() => !document.querySelector('#cmsSave').disabled);
      const saved = state.articles.get(articleId).cms.slug;
      assert.equal(saved, previousSlug || automaticSlug(state, articleId));
      assert.equal(await page.locator('#cmsSlug').inputValue(), saved);
      assert.equal(state.createRequests.length, 0);
      await run.close();
    }

    // Lost responses do not create a second article; explicit recovery keeps the
    // frozen key and payload. A pre-create 503 behaves the same way.
    for (const mode of ['created-response-lost', 'pre-create-503']) {
      const state = fixture();
      if (mode === 'created-response-lost') state.abortNext = 'after';
      else state.rejectNext = { code: 'DEPENDENCY_UNAVAILABLE', status: 503 };
      const run = await createCase(state),
        { page } = run;
      await fillArticle(page, '保存响应恢复演示');
      await page.locator('#cmsSave').click();
      await pending(page, state);
      assert.equal(state.articles.size, mode === 'created-response-lost' ? 1 : 0);
      const input = structuredClone(state.createRequests[0]);
      await page.locator('#cmsSave').click();
      await savedRoute(page, input.requestId);
      assert.equal(state.articles.size, 1);
      assert(state.createRequests.length >= 1 && state.createRequests.length <= 2);
      for (const attempt of state.createRequests) assert.deepEqual(attempt, input);
      assert.equal(state.articles.get(input.requestId).title, '保存响应恢复演示');
      await assertClosed(page);
      await run.close();
    }

    // If the same key now denotes different remote content, GET for comparison
    // never silently patches it or discards the local draft.
    const conflict = fixture();
    conflict.abortNext = 'after';
    const conflictRun = await createCase(conflict),
      conflictPage = conflictRun.page;
    await fillArticle(conflictPage, '本地保留的标题');
    await conflictPage.locator('#cmsSave').click();
    await pending(conflictPage, conflict);
    const original = structuredClone(conflict.createRequests[0]),
      remote = conflict.articles.get(original.requestId);
    remote.title = '服务器后来修改的标题';
    remote.revision += 1;
    remote.cms.revision += 1;
    remote.cms.publishedReleaseId = id(90);
    const fixedCurrent = {
      id: id(90),
      articleId: remote.id,
      createdAt: '2026-11-01T00:00:00Z',
      articleRevision: remote.revision,
      contentRevision: 1,
      cmsRevision: remote.cms.revision,
      title: '固定发布正文（虚构）',
      text: 'これは固定された架空の本文です。',
      cms: { slug: remote.cms.slug, summary: '', category: null, tags: [] },
      audio: null,
    };
    conflict.releases.set(remote.id, [
      structuredClone(fixedCurrent),
      { ...structuredClone(fixedCurrent), id: id(91), title: '较早固定版本（虚构）' },
    ]);
    await conflictPage.locator('#cmsSave').click();
    await conflictPage.locator('#cmsConflictDialog').waitFor();
    assert.equal(conflict.articles.size, 1);
    assert.equal(conflict.patches.length, 0);
    assert(conflict.reads.includes(original.requestId));
    assert.equal(await conflictPage.locator('#cmsMergedTitle').inputValue(), '本地保留的标题');
    await assertClosed(conflictPage, 'cmsMerged');
    await advanced(conflictPage, 'cmsMerged');
    await conflictPage
      .locator('#cmsConflictDialog')
      .getByRole('button', { name: '保留草稿并继续编辑', exact: true })
      .click();
    assert.equal(await conflictPage.locator('#cmsTitle').inputValue(), '本地保留的标题');
    assert.equal(conflict.articles.get(original.requestId).title, '服务器后来修改的标题');
    assert.equal(conflict.patches.length, 0);
    // A permitted metadata action must not remove the unresolved comparison
    // entry or allow the next ordinary Save to overwrite the remote article.
    await conflictPage.getByRole('button', { name: '删除历史', exact: true }).click();
    await conflictPage
      .locator('#cmsDeleteRelease')
      .getByRole('button', { name: '确认删除历史', exact: true })
      .click();
    await conflictPage.waitForFunction(() => !document.querySelector('#cmsDeleteRelease'));
    assert.deepEqual(conflict.releaseDeletes, [{ articleId: remote.id, releaseId: id(91) }]);
    assert.deepEqual(conflict.releases.get(remote.id), [fixedCurrent]);
    assert(await conflictPage.locator('#cmsCompare').isVisible());
    assert.equal(await conflictPage.locator('#cmsTitle').inputValue(), '本地保留的标题');
    const beforeResolution = conflict.createRequests.length;
    await conflictPage.locator('#cmsSave').click();
    await conflictPage.locator('#cmsConflictDialog').waitFor();
    assert.equal(conflict.createRequests.length, beforeResolution);
    assert.equal(conflict.patches.length, 0);
    assert.equal(await conflictPage.locator('#cmsMergedTitle').inputValue(), '本地保留的标题');
    await conflictPage.locator('#cmsConflictDiscard').click();
    await conflictPage.waitForFunction(() => !document.querySelector('#cmsConflictDialog'));
    assert.equal(await conflictPage.locator('#cmsTitle').inputValue(), '服务器后来修改的标题');
    assert.equal(conflict.patches.length, 0);
    for (const attempt of conflict.createRequests) assert.deepEqual(attempt, original);
    await conflictRun.close();

    // A failed ownership lookup after request conflict cannot prove creation was
    // rejected. Keep the frozen payload instead of unlocking a fresh write.
    const missing = fixture();
    missing.rejectNext = { code: 'DEPENDENCY_UNAVAILABLE', status: 503 };
    const missingRun = await createCase(missing),
      missingPage = missingRun.page;
    await fillArticle(missingPage, '查询失败仍保留待核对保存');
    await missingPage.locator('#cmsSave').click();
    await pending(missingPage, missing);
    const missingInput = structuredClone(missing.createRequests[0]);
    missing.rejectNext = { code: 'CREATE_REQUEST_CONFLICT', status: 409 };
    await missingPage.locator('#cmsSave').click();
    await waitUntil(
      () => missing.reads.includes(missingInput.requestId),
      'Recovery did not check the original article',
    );
    await missingPage.waitForFunction(() => !document.querySelector('#cmsSave').disabled);
    assert(await missingPage.locator('#cmsCreatePending').isVisible());
    assert(await missingPage.locator('#cmsTitle').isDisabled());
    assert.equal(missing.articles.size, 0);
    assert.equal(missing.createRequests.length, 2);
    for (const attempt of missing.createRequests) assert.deepEqual(attempt, missingInput);
    assert.equal(missing.patches.length, 0);
    await missingRun.close();

    // New-editor inputs and native advanced settings remain usable at 320/390.
    const mobileRun = await createCase(),
      { page: mobile } = mobileRun;
    await fillArticle(mobile, '手机端的新文章', 'これはスマートフォン向けの架空の本文です。');
    for (const width of [320, 390]) {
      await mobile.setViewportSize({ width, height: 844 });
      await assertClosed(mobile);
      assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 390) {
        await mobile.locator('#cmsTitle').click();
        await mobile.screenshot({
          path: path.join(out, '03-mobile-new-article.png'),
          fullPage: false,
        });
      }
      await advanced(mobile);
      assert(await mobile.locator('#cmsSlug').isVisible());
      await mobile.locator('#cmsSlug').fill('mobile-sample');
      assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await mobile.locator('#cmsAdvanced > summary').press('Space');
      await assertClosed(mobile);
    }
    await mobileRun.close();
    assert(allStates.every((state) => state.otherWrites.length === 0));
    assert.deepEqual(errors, []);
    console.log(
      'PASS UI: optional collapsed slug, Chinese/Japanese auto create, custom trim/lowercase-only validation/duplicate correction, stable title rename, blank legacy patch compatibility, frozen idempotent response/503 recovery, remote conflict comparison, native keyboard and 320/390; no TTS, 0 page errors',
    );
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
