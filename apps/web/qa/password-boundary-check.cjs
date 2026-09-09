const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./contract-check.cjs');
const base = process.env.BASE_URL || 'http://127.0.0.1:4181/';
const meta = require('../src/api/contract.json');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [],
    submissions = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Test-only endpoints: exercise the actual served page without creating accounts
  // or sending test passwords to a real authentication service.
  await context.route('**/v1/**', (route) => {
    const request = route.request(),
      endpoint = new URL(request.url()).pathname;
    const reply = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (endpoint === '/v1/config')
      return reply(200, {
        registrationEnabled: true,
        language: 'ja-JP',
        maxVocabularyEntries: 500,
        maxInputCodePoints: 10000,
        maxInputBytes: 49152,
      });
    if (endpoint === '/v1/auth/me') return reply(401, { code: 'UNAUTHENTICATED', message: 'test' });
    if (endpoint === '/v1/auth/csrf')
      return reply(200, {
        csrfToken: 'password-boundary-test',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    if (endpoint === '/v1/auth/login' || endpoint === '/v1/auth/register') {
      submissions.push({ endpoint, passwordLength: request.postDataJSON().password.length });
      return reply(endpoint.endsWith('/login') ? 401 : 409, {
        code: endpoint.endsWith('/login') ? 'UNAUTHENTICATED' : 'ALREADY_EXISTS',
        message: 'test',
      });
    }
    throw Error(`Unexpected request: ${endpoint}`);
  });
  try {
    for (const mode of ['login', 'register']) {
      await page.goto(`${base}#/${mode}`);
      await page.locator('#authName').fill('password-boundary');
      if (mode === 'register') await page.locator('#registerName').fill('边界检查');
      const password = page.locator('#authPassword');
      assert.equal(await password.getAttribute('minlength'), '8');
      assert.equal(await password.getAttribute('maxlength'), '128');
      assert.equal(await password.getAttribute('pattern'), null);
      assert.equal(await password.getAttribute('placeholder'), '至少 8 位字符');
      await password.fill('1234567');
      if (mode === 'register') await page.locator('#confirmPassword').fill('1234567');
      const before = submissions.length;
      await page.locator('#authSubmit').click();
      await page.waitForFunction(() =>
        document.querySelector('#authError').textContent.includes('密码至少 8 位'),
      );
      assert.equal(
        submissions.length,
        before,
        '7 characters must not reach the authentication endpoint',
      );
      assert.equal(await password.evaluate((e) => e.validity.tooShort), true);
      await password.fill('Eight123');
      if (mode === 'register') await page.locator('#confirmPassword').fill('Eight123');
      assert.equal(
        await password.evaluate((e) => e.checkValidity()),
        true,
        '8 characters must satisfy native browser validity',
      );
      const sent = page.waitForRequest((r) => new URL(r.url()).pathname === `/v1/auth/${mode}`);
      await page.locator('#authSubmit').click();
      await sent;
      await page.waitForFunction(() => !document.querySelector('#authSubmit').disabled);
      assert.equal(submissions.at(-1).passwordLength, 8);
      assert(!/12/.test(await page.locator('#authError').innerText()));
    }
    assert.deepEqual(errors, []);
    const result = {
      date: new Date().toISOString(),
      base,
      contract: meta.version,
      sha256: meta.sha256,
      checks: [
        'Login and registration HTML minlength=8, maxlength=128, no conflicting pattern',
        '7-character input rejected by schema and native validity without authentication request',
        '8-character input is natively valid and submits from both actual served forms',
      ],
      submissions,
      errors,
    };
    const directory = path.join(__dirname, 'password-artifacts');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${new URL(base).port || '80'}-results.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(`PASS password 7/8 boundary on ${base} (login and registration)`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
