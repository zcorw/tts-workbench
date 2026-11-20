import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../dist/migrate.js';
import { ZhiyueDeviceService } from '../dist/zhiyue-device.js';

const db = process.env.ZHIYUE_TEST_DATABASE_URL;
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('同一安装重新配对保持一条记录，跨日续期、账号隔离和撤销互不混淆', { skip: !db }, async () => {
  const target = new URL(db);
  assert.equal(target.pathname, '/zhiyue_integration_test');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  await migrate(db);
  const pool = new Pool({ connectionString: db });
  const accounts = [randomUUID(), randomUUID()];
  const devices = new ZhiyueDeviceService(pool);
  try {
    for (const id of accounts) await pool.query(
      "INSERT INTO ac_accounts(id,login,display_name,password_hash,status) VALUES($1,$2,'Synthetic device','not-a-real-password','active')",
      [id, `device-test-${id}`],
    );
    const pair = async (owner, id) => {
      const request = await devices.start(id);
      await devices.approve(owner, request.user_code);
      const grant = await devices.claim(request.device_code);
      await devices.confirm(grant.refresh_token);
      return grant;
    };
    const id = randomUUID();
    let grant = await pair(accounts[0], id);
    const originalBinding = grant.binding_id;
    for (let i = 0; i < 3; i += 1) {
      const previous = grant;
      grant = await pair(accounts[0], id);
      assert.equal(grant.binding_id, originalBinding);
      assert.equal((await devices.list(accounts[0])).items.length, 1);
      await assert.rejects(devices.renew(previous.refresh_token, false, id), { error: 'invalid_grant' });
    }
    const listed = (await devices.list(accounts[0])).items[0];
    assert.equal(listed.deviceId, id);
    assert.equal(listed.renewable, true);
    assert.equal(listed.confirmationRequired, false);
    await pool.query("UPDATE wb_zhiyue_bindings SET created_at=now()-interval '400 days',expires_at=now()-interval '300 days' WHERE id=$1", [originalBinding]);
    await devices.cleanupExpired();
    const restarted = new ZhiyueDeviceService(pool);
    grant = await restarted.renew(grant.refresh_token, false, id);
    assert.equal(grant.binding_id, originalBinding);
    assert.equal((await restarted.identify(grant.access_token)).accountId, accounts[0]);
    await assert.rejects(restarted.renew(grant.refresh_token, false, randomUUID()), { error: 'invalid_grant' });
    assert.equal((await pair(accounts[0], randomUUID())).account.id, accounts[0]);
    assert.equal((await devices.list(accounts[0])).items.length, 2, '不同眼镜不能按相同显示名称合并');
    const otherAccount = await pair(accounts[1], id);
    assert.equal((await devices.list(accounts[1])).items.length, 1);
    assert.equal((await devices.list(accounts[0])).items.length, 2);
    const legacy = await pair(accounts[0], undefined);
    await pool.query('UPDATE wb_zhiyue_bindings SET refresh_hash=NULL WHERE id=$1', [legacy.binding_id]);
    const upgraded = await devices.renew(legacy.access_token, true, randomUUID());
    assert.equal(upgraded.binding_id, legacy.binding_id);
    assert.ok((await devices.list(accounts[0])).items.find((item) => item.id === legacy.binding_id).deviceId);
    await assert.rejects(pool.query(
      `INSERT INTO wb_zhiyue_bindings(id,account_id,token_hash,created_at,expires_at,confirmed_at,device_id)
       VALUES($1,$2,$3,now(),now()+interval '1 day',now(),$4)`,
      [randomUUID(), accounts[0], hash('duplicate-test-token'), id],
    ), { code: '23505' });
    await pool.query("UPDATE ac_accounts SET password_hash='another-synthetic-password' WHERE id=$1", [accounts[0]]);
    assert.equal((await devices.list(accounts[0])).items.length, 0);
    await assert.rejects(devices.renew(grant.refresh_token, false, id), { error: 'invalid_grant' });
    assert.equal((await devices.renew(otherAccount.refresh_token, false, id)).account.id, accounts[1]);
  } finally {
    await pool.query('DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])', [accounts]);
    await pool.end();
  }
});
