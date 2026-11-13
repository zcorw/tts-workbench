// Synthetic browser regression only. Every API response is intercepted; no real grants or accounts.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.BASE_URL || 'http://127.0.0.1:4384';
const parsed = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
  throw new Error('A loopback HTTP preview is required');
}
const out = process.env.QA_OUTPUT_DIR || '/tmp/zhiyue-connection-qa';
fs.mkdirSync(out, { recursive: true });
const account = { id: '00000000-0000-4000-8000-000000000001', login: 'synthetic', displayName: 'Synthetic owner' };
const binding = { id: '00000000-0000-4000-8000-000000000002', createdAt: '2026-11-12T00:00:00Z', expiresAt: '2026-11-13T00:00:00Z' };
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [], unexpected = [], mutations = [];
    let listMode = 'normal', listCalls = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== parsed.origin) { unexpected.push(req.url()); return route.abort(); }
      const reply = (json, status = 200) => route.fulfill({ status, json });
      if (url.pathname === '/site-config.json') return reply({ workbenchUrl: base, cmsUrl: base });
      if (!url.pathname.startsWith('/v1/')) return route.continue();
      if (url.pathname === '/v1/config') return reply({ registrationEnabled: false, maxText: 10000, maxBytes: 49152, maxArticles: 100 });
      if (url.pathname === '/v1/auth/me') return reply(account);
      if (url.pathname === '/v1/auth/csrf') return reply({ csrfToken: 'synthetic-csrf' });
      if (url.pathname === '/v1/cms/audio-batches') return reply({ items: [] });
      if (url.pathname === '/v1/zhiyue/account/bindings' && req.method() === 'GET') {
        listCalls++;
        assert.equal(url.searchParams.get('expected_account_id'), account.id);
        if (listMode === 'changed') return reply({ code: 'ACCOUNT_CHANGED', message: 'ACCOUNT_CHANGED' }, 409);
        if (listMode === 'disabled') return reply({ code: 'NOT_FOUND', message: 'NOT_FOUND' }, 404);
        return reply({ items: listMode === 'empty' ? [] : [binding] });
      }
      if (url.pathname === '/v1/zhiyue/account/approve' && req.method() === 'POST') {
        mutations.push(req.postDataJSON());
        assert.equal(req.headers()['x-csrf-token'], 'synthetic-csrf');
        return route.fulfill({ status: 204, body: '' });
      }
      unexpected.push(`${req.method()} ${url.pathname}`);
      return reply({ code: 'UNEXPECTED_SYNTHETIC_REQUEST' }, 500);
    });
    await page.goto(`${base}/connections/zhiyue`);
    await page.getByRole('heading', { name: '连接知阅', exact: true }).waitFor();
    await page.getByText('Synthetic owner', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '解除绑定', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认连接', exact: true }).isEnabled(), true);
    await page.getByLabel('眼镜配对码').fill('invalid');
    await page.getByRole('button', { name: '确认连接', exact: true }).click();
    await page.getByText('请输入眼镜显示的 8 位配对码。', { exact: true }).waitFor();
    assert.equal(mutations.length, 0);
    await page.getByLabel('眼镜配对码').fill('abcd-2345');
    await page.getByRole('button', { name: '确认连接', exact: true }).click();
    await page.getByText('已确认连接，请回到眼镜继续。', { exact: true }).waitFor();
    assert.deepEqual(mutations, [{ user_code: 'ABCD2345', expected_account_id: account.id }]);
    assert.equal(await page.getByLabel('眼镜配对码').inputValue(), '');
    listMode = 'empty';
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await page.getByText('还没有已绑定的设备。', { exact: true }).waitFor();
    listMode = 'changed';
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await page.getByText('知声登录账户已变更，请重新载入此页并核对账户。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认连接', exact: true }).count(), 0);
    listMode = 'disabled';
    await page.reload();
    await page.getByText('知阅绑定暂未启用。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认连接', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(out, 'connection-disabled.png'), fullPage: true });
    assert.ok(listCalls >= 4);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log('Synthetic connection-page checks passed: owner, list/refresh, validation, approval payload, account switch, disabled feature.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
