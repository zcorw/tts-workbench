// Interaction acceptance checks for the standalone HTML prototype.
// Run with NODE_PATH pointing to a Playwright installation; BASE_URL is optional.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = process.env.BASE_URL || 'http://127.0.0.1:4178/prototype/';
const output = path.join(__dirname, 'artifacts');
fs.mkdirSync(output, { recursive: true });
const checks = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    const nav = view => page.locator(`.nav-item[data-view="${view}"]`).click();
    const saveReading = async value => {
      await page.locator('#readingInput').fill(value);
      await page.locator('#saveRuleButton').click();
      await page.waitForFunction(() => !document.querySelector('#saveRuleButton').disabled);
    };
    const source = () => page.locator('#articleEditor').textContent();
    await page.goto(base);
    await page.locator('#articleEditor mark').first().waitFor();
    const original = await source();
    assert.equal(await page.locator('#navRuleCount').textContent(), '2');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

    // Select real body text with a Range, then use the contextual toolbar.
    await page.evaluate(() => {
      const root = document.querySelector('#articleEditor');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) {
        const index = node.textContent.indexOf('日本橋'); if (index < 0) continue;
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 3);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); break;
      }
    });
    await page.locator('#editSelectionButton').click();
    await saveReading('にほんばし');
    assert.equal(await source(), original);
    assert.equal(await page.locator('#navRuleCount').textContent(), '3');
    assert.equal(await page.locator('#articleEditor mark').filter({ hasText: '日本橋' }).count(), 2);
    checks.push('正文实际选区保存；原文不变；同词两处标记');
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(output, 'reading-editor.png'), fullPage: true });

    await page.locator('#generateButton').click();
    await page.locator('#audioResult').waitFor();
    assert.ok((await page.locator('#appliedText').textContent()).includes('にほんばし'));
    assert.equal(await page.locator('#staleBanner').isVisible(), false);
    await page.locator('#playButton').click();
    assert.match(await page.locator('#voiceNotice').textContent(), /日文/);
    await saveReading('ニホンバシ');
    assert.equal(await page.locator('#staleBanner').isVisible(), true);
    assert.ok((await page.locator('#appliedText').textContent()).includes('にほんばし'));
    checks.push('生成快照使用读法；规则变化标记旧结果并保留旧提交');

    await nav('requirements');
    assert.equal(await page.locator('#specTableBody tr').count(), 19);
    await page.locator('#scenarioSelect').selectOption('save-error');
    await nav('workbench');
    await saveReading('にっぽんばし');
    assert.equal(await page.locator('#readingInput').inputValue(), 'にっぽんばし');
    assert.match(await page.locator('#saveError').textContent(), /失败/);
    assert.match(await page.locator('#articleEditor mark').filter({ hasText: '日本橋' }).first().getAttribute('title'), /ニホンバシ/);
    checks.push('保存失败保留表单和旧规则，没有假成功');

    await page.reload();
    assert.equal(await page.locator('#navRuleCount').textContent(), '3');
    await page.locator('#newArticleButton').click();
    await page.locator('#applyArticle').click();
    assert.equal(await page.locator('#articleEditor mark').filter({ hasText: '日本橋' }).count(), 2);
    await page.locator('#generateButton').click();
    await page.locator('#speedRange').fill('1.25');
    await page.locator('#audioResult').waitFor();
    assert.equal(await page.locator('#staleBanner').isVisible(), true);
    checks.push('刷新持久化；新文章复用；生成期间修改参数，返回旧快照');

    await nav('requirements');
    await page.locator('#scenarioSelect').selectOption('generate-error');
    await nav('workbench');
    const oldResult = await page.locator('#appliedText').textContent();
    await page.locator('#generateButton').click();
    await page.locator('#generationError').waitFor();
    assert.equal(await page.locator('#appliedText').textContent(), oldResult);
    assert.match(await page.locator('#generationError').textContent(), /请求 ID/);
    checks.push('合成失败保留旧结果，展示请求 ID');

    await nav('rules');
    await page.locator('#ruleSearch').fill('日本橋');
    await page.locator('[data-rule-action="delete"]').click();
    await page.locator('#cancelDelete').click();
    assert.equal(await page.locator('#navRuleCount').textContent(), '3');
    await page.locator('[data-rule-action="delete"]').click();
    await page.locator('#confirmDelete').click();
    await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#navRuleCount').textContent(), '2');
    await nav('workbench');
    assert.equal(await page.locator('#articleEditor mark').filter({ hasText: '日本橋' }).count(), 0);
    assert.ok((await source()).includes('日本橋'));
    checks.push('删除先确认；取消保留；成功移除所有投影但保留原文');

    // Independent window writes must not silently overwrite a stale edit form.
    await page.locator('#articleEditor mark').filter({ hasText: '京都' }).click();
    const other = await context.newPage(); await other.goto(base);
    await other.locator('#articleEditor mark').filter({ hasText: '京都' }).first().click();
    await other.locator('#readingInput').fill('キョウト'); await other.locator('#saveRuleButton').click();
    await other.waitForFunction(() => !document.querySelector('#saveRuleButton').disabled);
    await saveReading('きょーと');
    assert.match(await page.locator('#saveError').textContent(), /其他窗口/);
    assert.match(await page.locator('#articleEditor mark').filter({ hasText: '京都' }).getAttribute('title'), /キョウト/);
    await other.close();
    checks.push('另一窗口已更新时拒绝旧版本覆盖');

    // Plain-text editing including newline and emoji retains original characters.
    await page.locator('#articleEditor').fill('京都🙂\n日本橋');
    await page.locator('#articleEditor').press('End');
    await page.locator('#articleEditor').press('Enter');
    await page.locator('#articleEditor').pressSequentially('ABC');
    assert.equal(await source(), '京都🙂\n日本橋\nABC');
    checks.push('正文换行、汉字与 emoji 编辑不丢失字符');

    await page.locator('#accountButton').click(); await page.locator('#switchAccount').click();
    await page.locator('#registerTab').click(); await page.locator('#authName').fill('原型测试账户');
    await page.locator('#authPassword').fill('test1234'); await page.locator('#authSubmit').click();
    assert.equal(await page.locator('#navRuleCount').textContent(), '0');
    assert.equal(await page.locator('#articleEditor mark').count(), 0);
    assert.ok(!(await page.evaluate(() => localStorage.getItem('yomi-prototype-v1'))).includes('test1234'));
    await nav('requirements'); await page.locator('#expireButton').click();
    assert.match(await page.locator('#authError').textContent(), /过期/);
    await page.locator('#accountDialog .dialog-heading button').click();
    await nav('workbench'); await page.locator('#generateButton').click();
    assert.equal(await page.locator('#accountDialog').isVisible(), true);
    checks.push('演示账户隔离；密码不落本地存储；登录过期阻止合成');
    await page.locator('#accountDialog .dialog-heading button').click();

    const visual = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', isMobile: true, deviceScaleFactor: 1 });
    const mobile = await visual.newPage(); await mobile.goto(base);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobile.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    await mobile.locator('#exampleSelect').click(); await mobile.locator('#readingInput').fill('にほんばし');
    await mobile.locator('#saveRuleButton').click();
    await mobile.waitForFunction(() => !document.querySelector('#saveRuleButton').disabled);
    assert.equal(await mobile.locator('#navRuleCount').textContent(), '3');
    await mobile.locator('.nav-item[data-view="requirements"]').click();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobile.evaluate(() => document.querySelector('#toast').hidden = true);
    await mobile.screenshot({ path: path.join(output, 'requirements-mobile.png'), fullPage: true });
    checks.push('390px 手机布局无页面横向溢出，完整完成选词保存');
    assert.deepEqual(errors, []);
    checks.push('浏览器无 JavaScript 未捕获异常');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, checks, screenshots: output }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
