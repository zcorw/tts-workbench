// UI regression tests use synthetic API responses only; no production data or TTS.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BASE_URL || 'http://127.0.0.1:4384';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw Error('Loopback preview required');
const out = process.env.QA_OUTPUT_DIR || '/tmp/cms-bulk-publish-qa';
fs.mkdirSync(out, { recursive: true });
const titles = [
  'どうして日本で働こうと思ったんですか。',
  '一番自信がある技術は何ですか。',
  'AI同時通訳システムについて説明してください。',
];
const make = () =>
  titles.map((title, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    title,
    revision: 3,
    contentRevision: 2,
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
    currentRuleVersion: 0,
    audio:
      i === 0
        ? { audioId: '00000000-0000-4000-8000-000000000011', voice: 'ja-JP-NanamiNeural', speed: 1 }
        : null,
    audioStale: false,
    cms: {
      revision: 5,
      slug: `interview-q0${i + 3}`,
      categoryId: null,
      tagIds: [],
      summary: '',
      publishedReleaseId: i === 2 ? 'previous-release' : null,
    },
  }));
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let items = make(),
      calls = [],
      conflict = true,
      delay = 120;
    await page.route('**/site-config.json', (r) =>
      r.fulfill({ json: { workbenchUrl: base, cmsUrl: base } }),
    );
    await page.route('**/v1/**', async (r) => {
      const req = r.request(),
        u = new URL(req.url()),
        p = u.pathname;
      const reply = (json, status = 200) => r.fulfill({ status, json });
      if (p === '/v1/config')
        return reply({
          registrationEnabled: false,
          maxText: 10000,
          maxBytes: 49152,
          maxArticles: 100,
        });
      if (p === '/v1/auth/me')
        return reply({ id: 'test-owner', displayName: '演示账户', login: 'preview' });
      if (p === '/v1/auth/csrf') return reply({ csrfToken: 'test-csrf' });
      if (p === '/v1/cms/taxonomy')
        return reply({ categories: [], tags: [], totalArticles: 3, uncategorizedCount: 3 });
      if (p === '/v1/cms/articles') return reply({ items, total: 3, offset: 0, limit: 20 });
      const release = /^\/v1\/cms\/articles\/([^/]+)\/releases$/.exec(p);
      if (release) {
        const id = release[1],
          data = req.postDataJSON();
        calls.push({ id, data });
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (conflict && id.endsWith('2')) return reply({ code: 'CMS_REVISION_CONFLICT' }, 409);
        const a = items.find((a) => a.id === id);
        a.cms = {
          ...a.cms,
          revision: a.cms.revision + 1,
          publishedReleaseId: 'release-' + calls.length,
        };
        return reply({ id: a.cms.publishedReleaseId });
      }
      const article = /^\/v1\/cms\/articles\/([^/]+)$/.exec(p);
      if (article) return reply(items.find((a) => a.id === article[1]));
      return reply({ code: 'NOT_FOUND' }, 404);
    });
    await page.goto(base + '/articles');
    await page.locator('#cmsSelectPage').check();
    await page.screenshot({ path: path.join(out, 'bulk-publish-list.png'), fullPage: true });
    await page.locator('#cmsPublishSelected').click();
    assert(await page.locator('#cmsBulkPublishSubmit').isDisabled());
    assert((await page.locator('#cmsBulkPublishConfirm').innerText()).includes('更新已上线版本'));
    await page.locator('#cmsBulkPublishConfirm').getByText('取消', { exact: true }).click();
    assert.equal(calls.length, 0);
    assert.equal(await page.locator('#cmsBulkPublishConfirm').count(), 0);
    await page.locator('#cmsPublishSelected').click();
    await page.locator('#cmsBulkPublishTextOnly').check();
    await page.screenshot({ path: path.join(out, 'bulk-publish-confirm.png'), fullPage: true });
    await page.locator('#cmsBulkPublishSubmit').click();
    assert(await page.locator('#cmsBulkPublishSubmit').isDisabled());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cmsBulkPublishConfirm').count(), 1);
    await page.locator('.cms-publish-results').waitFor();
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((x) => x.data.expectedCmsRevision),
      [5, 5, 5],
    );
    assert.equal(calls[0].data.expectedAudioId, '00000000-0000-4000-8000-000000000011');
    assert.equal(calls[1].data.expectedAudioId, null);
    assert((await page.locator('.cms-success').innerText()).includes('已上线 2 篇，未完成 1 篇'));
    assert.equal(await page.locator('.cms-selectable-items input:checked').count(), 1);
    assert(await page.locator('#cmsPublishSelected').isDisabled());
    await page.screenshot({ path: path.join(out, 'bulk-publish-partial.png'), fullPage: true });
    conflict = false;
    await page.locator('#cmsRefreshSelected').click();
    await page.waitForFunction(() => !document.querySelector('#cmsPublishSelected').disabled);
    assert.equal(calls.length, 3); // Refresh never publishes automatically.
    await page.locator('#cmsPublishSelected').click();
    await page.locator('#cmsBulkPublishTextOnly').check();
    await page.locator('#cmsBulkPublishSubmit').click();
    await page.waitForFunction(() =>
      document.querySelector('.cms-success')?.textContent.includes('已上线 1 篇，未完成 0 篇'),
    );
    assert.equal(calls.length, 4);
    assert.equal(await page.locator('.cms-selectable-items input:checked').count(), 0);
    // Back during an in-flight request must not leave or submit twice.
    await page.goto(base + '/articles?q=first');
    await page.goto(base + '/articles');
    await page.locator('#cmsSelectPage').check();
    await page.locator('#cmsPublishSelected').click();
    await page.locator('#cmsBulkPublishTextOnly').check();
    delay = 500;
    await page.locator('#cmsBulkPublishSubmit').click();
    await page.evaluate(() => history.back());
    await page.locator('#unsavedDialog').waitFor();
    assert((await page.locator('#unsavedDialog').innerText()).includes('操作尚未完成'));
    await page.waitForFunction(() => !document.querySelector('#cmsBulkPublishConfirm'));
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await page.locator('#unsavedDialog').count(), 0);
    // Mobile layout and text wrapping.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cmsSelectPage').check();
    await page.screenshot({ path: path.join(out, 'bulk-publish-mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // Closing the confirmation never writes; a fresh opening requires consent again.
    await page.locator('#cmsPublishSelected').click();
    assert(await page.locator('#cmsBulkPublishSubmit').isDisabled());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cmsBulkPublishConfirm').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS UI: selection, explicit audio consent, cancel, repeat lock, partial failure, version payloads, explicit retry, navigation guard, mobile, Escape',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
