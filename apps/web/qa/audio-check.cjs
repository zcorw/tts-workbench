const { chromium } = require('playwright');
const { fixture, deferred } = require('./articles-check.cjs');
const { bytes } = require('./saved-audio-fixture.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BASE_URL || 'http://127.0.0.1:4181/';
const out = path.join(__dirname, 'audio-artifacts');
const checks = [],
  errors = [];
const ok = (text) => {
  checks.push(text);
  console.log('PASS', text);
};
const ready = (p) => p.waitForFunction(() => !document.querySelector('#generateButton')?.disabled);
const id = (p) => p.locator('#audioResult').getAttribute('data-audio-id');
const waitAudio = (p, value) =>
  p.waitForFunction(
    (value) => document.querySelector('#audioResult')?.dataset.audioId === value,
    value,
  );
async function save(p) {
  await p.locator('#saveArticle').click();
  await p.waitForFunction(
    () => document.querySelector('#articleSaveStatus')?.textContent === '已保存到我的文章',
  );
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    const state = await fixture(context),
      a = state.make('音频持久测试', '日本橋の朝。'),
      b = state.make('另一篇文章', '京都の夜。');
    state.rows.push(a, b);
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    const posts = () =>
      state.requests.filter(
        (r) => r.method === 'POST' && /\/articles\/[^/]+\/audio$/.test(r.endpoint),
      ).length;
    const gets = () =>
      state.requests.filter(
        (r) => r.method === 'GET' && /\/articles\/[^/]+\/audio$/.test(r.endpoint),
      ).length;
    async function generate() {
      const previous = a.audio?.audioId;
      await p.locator('#generateButton').click();
      await p.waitForFunction((previous) => {
        const r = document.querySelector('#audioResult');
        return (
          r && r.dataset.audioId !== previous && !document.querySelector('#generateButton').disabled
        );
      }, previous);
    }
    await p.goto(base + '#/articles/' + a.id);
    await ready(p);
    await p.locator('#speedRange').fill('1.23');
    await generate();
    assert.equal(posts(), 1);
    assert.equal(gets(), 1);
    assert.equal(await id(p), a.audio.audioId);
    assert.equal(a.audio.speed, 1.23);
    assert.deepEqual(Object.keys(state.requests.find((r) => r.method === 'POST').body).sort(), [
      'expectedRevision',
      'speed',
      'voice',
    ]);
    const download = p.waitForEvent('download');
    await p.locator('#downloadButton').click();
    assert.deepEqual(fs.readFileSync(await (await download).path()), bytes);
    ok('POST仅版本参数→JSON记录→带ID完整MP3下载');
    await p.reload();
    await waitAudio(p, a.audio.audioId);
    assert.equal(posts(), 1);
    assert.equal(await p.locator('#speedRange').inputValue(), '1.23');
    await p.locator('#playButton').click();
    await p.waitForFunction(() => document.querySelector('#playState').textContent === '正在播放');
    await p.locator('#stopButton').click();
    ok('刷新不重新计费且恢复参数和可播放音频');
    await p.locator('#articleTitle').fill('仅改标题');
    assert(!(await p.locator('#staleBanner').isVisible()));
    await save(p);
    assert(!(await p.locator('#staleBanner').isVisible()));
    await p.locator('#articleEditor').fill('正文新内容。');
    assert(await p.locator('#staleBanner').isVisible());
    await save(p);
    assert(await p.locator('#staleBanner').isVisible());
    await generate();
    assert(!(await p.locator('#staleBanner').isVisible()));
    ok('标题不误过期、正文草稿及保存版本改变会过期');
    const snapshotPlan = { gate: deferred(), arrived: deferred() };
    state.audioPlans = [snapshotPlan];
    await p.locator('#generateButton').click();
    await snapshotPlan.arrived.promise;
    state.version++;
    snapshotPlan.gate.resolve();
    await p.waitForFunction(() => !document.querySelector('#generateButton').disabled);
    assert(await p.locator('#staleBanner').isVisible());
    assert.equal(a.audio.ruleVersion, 0);
    await generate();
    assert.equal(a.audio.ruleVersion, 1);
    assert(!(await p.locator('#staleBanner').isVisible()));
    ok('在途读法变化绑定实际快照并提示过期');
    const held = await id(p),
      heldUrl = await p.locator('#downloadButton').getAttribute('href');
    state.audioFail = true;
    const count = posts();
    await p.locator('#generateButton').click();
    await p.locator('#generationError').waitFor();
    assert.equal(await id(p), held);
    assert.equal(a.audio.audioId, held);
    assert.equal(posts(), count + 1);
    state.audioFail = false;
    ok('合成失败保留旧成功音频、无自动POST重试');
    for (const flag of [
      'badId',
      'badRevision',
      'badVersion',
      'badLength',
      'badAudio',
      'badFilename',
    ]) {
      state[flag] = true;
      await p.locator('#reloadAudio').click();
      await p.waitForFunction(() => !document.querySelector('#reloadAudio').disabled);
      assert.match(await p.locator('#generationError').innerText(), /不完整|不一致/);
      assert.equal(await p.locator('#downloadButton').getAttribute('href'), heldUrl);
      state[flag] = false;
    }
    ok('GET错误ID/正文版本/读法版本/长度/MIME均拒绝且保留可播放结果');
    const beforeReplacePosts = posts(),
      beforeGets = gets();
    a.audio.speed = 0.85;
    a.audio.voice = 'old-voice';
    state.replacementVoice = 'qa-ja';
    state.replaceOnGet = 1;
    await p.reload();
    await p.locator('#audioResult').waitFor();
    assert.equal(gets() - beforeGets, 2);
    assert.equal(posts(), beforeReplacePosts);
    assert.equal(await id(p), a.audio.audioId);
    assert.equal(await p.locator('#voiceSelect').inputValue(), 'qa-ja');
    assert.equal(await p.locator('#speedRange').inputValue(), '1.23');
    assert(!(await p.locator('#staleBanner').isVisible()));
    ok('首次恢复404换ID最多补取一次并恢复最新参数');
    state.replaceOnGet = 2;
    const repeatedGets = gets();
    await p.reload();
    await p.locator('#generationError').waitFor();
    assert.equal(gets() - repeatedGets, 2);
    assert.equal(posts(), beforeReplacePosts);
    assert.equal(await p.locator('#audioResult').count(), 0);
    await p.locator('#reloadAudio').click();
    await waitAudio(p, a.audio.audioId);
    ok('连续404停止读取，不循环也不自动重新合成');
    const preferencePlan = { gate: deferred(), arrived: deferred() };
    state.audioGetPlan = preferencePlan;
    await p.reload();
    await preferencePlan.arrived.promise;
    await p.locator('#speedRange').fill('1.8');
    preferencePlan.gate.resolve();
    await p.locator('#audioResult').waitFor();
    assert.equal(await p.locator('#speedRange').inputValue(), '1.8');
    assert(await p.locator('#staleBanner').isVisible());
    await p.locator('#reloadAudio').click();
    await p.waitForFunction(() => !document.querySelector('#reloadAudio').disabled);
    assert.equal(await p.locator('#speedRange').inputValue(), '1.8');
    ok('迟到恢复不覆盖用户设置，手动重载保留当前选择');
    const editPlan = { gate: deferred(), arrived: deferred() };
    state.audioPlans = [editPlan];
    const editHeld = await id(p);
    await p.locator('#generateButton').click();
    await editPlan.arrived.promise;
    await p.locator('#articleEditor').fill('在途生成时继续编辑。');
    editPlan.gate.resolve();
    await p.getByText(/音频已生成，但正文又有修改/).waitFor();
    assert.equal(await id(p), editHeld);
    assert.equal(await p.locator('#articleEditor').textContent(), '在途生成时继续编辑。');
    await save(p);
    ok('正文编辑代次隔离迟到生成，不覆盖草稿或当前播放器');
    const lostPlan = { lost: true };
    state.audioPlans = [lostPlan];
    await p.locator('#generateButton').click();
    await p.locator('#generationError').waitFor();
    const committed = a.audio.audioId;
    assert.notEqual(committed, await id(p));
    const lostPosts = posts();
    await p.locator('#reloadAudio').click();
    await waitAudio(p, committed);
    assert.equal(posts(), lostPosts);
    ok('POST响应丢失后只读恢复服务器已提交音频');
    const switchPlan = { gate: deferred(), arrived: deferred() };
    state.audioPlans = [switchPlan];
    await p.locator('#generateButton').click();
    await switchPlan.arrived.promise;
    await p.locator('[data-view="articles"]').click();
    await p.getByRole('link', { name: b.title, exact: true }).click();
    await p.locator('#articleTitle').waitFor();
    switchPlan.gate.resolve();
    await p.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/audio'),
    );
    assert.equal(await p.locator('#articleTitle').inputValue(), b.title);
    assert.equal(await p.locator('#audioResult').count(), 0);
    ok('离开后生成仍可提交，但迟到响应不污染另一篇文章');
    state.voices = [];
    await p.locator('[data-view="articles"]').click();
    await p.getByRole('link', { name: a.title, exact: true }).click();
    await p.reload();
    await waitAudio(p, a.audio.audioId);
    assert(await p.locator('#generateButton').isDisabled());
    assert.equal(await p.locator('#voiceSelect').inputValue(), a.audio.voice);
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
    await p.setViewportSize({ width: 390, height: 844 });
    await p.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await p.screenshot({ path: path.join(out, 'restored-mobile.png'), fullPage: true });
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    ok('当前音色不可用仍能恢复播放下载及移动布局');
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          checks,
          errors,
          note: 'Deterministic HTTP boundary fixture and playable tone; not a real provider or pronunciation acceptance.',
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
