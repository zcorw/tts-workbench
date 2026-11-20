import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../dist/app.js';
import { readConfig } from '../dist/config.js';
import { migrate } from '../dist/migrate.js';

const db = process.env.ZHIYUE_TEST_DATABASE_URL;

test('真实HTTP/PG：标题部分匹配与精确优先跨页、分类候选、权限及无匹配', { skip: !db }, async (t) => {
  const target = new URL(db);
  assert.equal(target.pathname, '/zhiyue_integration_test');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  await migrate(db);
  const cmsDist = await mkdtemp(join(tmpdir(), 'zhiyue-fuzzy-cms-'));
  await writeFile(join(cmsDist, 'index.html'), '<!doctype html><title>synthetic search fixture</title>');
  const origin = 'https://zhiyue-fuzzy.test';
  const ids = [];
  const runtime = await createApplication(readConfig({ DATABASE_URL: db,
    SESSION_SECRET: 'zhiyue-fuzzy-synthetic-session-secret-20261120', NODE_ENV: 'test',
    REGISTRATION_ENABLED: 'true', CMS_ZHIYUE_ENABLED: 'true', CMS_PUBLIC_ORIGIN: origin,
    CMS_DIST: cmsDist, PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }));
  t.after(async () => {
    try { if (ids.length) await runtime.pool.query('DELETE FROM ac_accounts WHERE id=ANY($1::uuid[])', [ids]); }
    finally { await runtime.close(); await rm(cmsDist, { recursive: true }); }
  });
  runtime.cmsServer.listen(0, '127.0.0.1');
  await once(runtime.cmsServer, 'listening');
  const base = 'http://127.0.0.1:' + runtime.cmsServer.address().port;
  async function call(path, { method='GET', body, headers={} }={}) {
    const response = await fetch(base + path, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.headers.get('Content-Type')?.includes('json') ? await response.json() : await response.text();
    return { response, data };
  }
  const ok = (result, status=200) => { assert.equal(result.response.status, status, JSON.stringify(result.data)); return result.data; };
  async function browser() {
    let cookie='', csrf='';
    const request = async (path, method='GET', body) => {
      const result = await call(path, { method, body, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf } });
      const cookies = result.response.headers.getSetCookie();
      if (cookies.length) cookie=cookies.map((value)=>value.split(';')[0]).join('; ');
      if (result.data?.csrfToken) csrf=result.data.csrfToken;
      return result;
    };
    ok(await request('/v1/auth/csrf'));
    const login='fuzzy-'+randomUUID(), password='Synthetic8!';
    const account=ok(await request('/v1/auth/register','POST',{login,password,displayName:'Synthetic fuzzy fixture'}),201);
    ids.push(account.id);
    ok(await request('/v1/auth/login','POST',{login,password}));
    ok(await request('/v1/auth/csrf'));
    return { account, request };
  }
  const a=await browser(), b=await browser();
  const category = async (owner,name) => ok(await owner.request('/v1/cms/categories','POST', {name,slug:'fuzzy-'+randomUUID()}),201);
  const exactCategory=await category(a,'科技'), partialCategory=await category(a,'科技资讯');
  const privateCategory=await category(b,'科技私人');
  async function article(owner,title,categoryId=null,text='合成测试正文', publish=true) {
    const item=ok(await owner.request('/v1/cms/articles','POST',{title,text,cms:{slug:'fuzzy-'+randomUUID(),summary:'',categoryId,tagIds:[]}}),201);
    if (!publish) return item;
    const detail=ok(await owner.request('/v1/cms/articles/'+item.id));
    return ok(await owner.request('/v1/cms/articles/'+item.id+'/releases','POST',{
      expectedRevision:detail.revision,expectedCmsRevision:detail.cms.revision,expectedAudioId:null}),201);
  }
  const exact=await article(a,'星空',exactCategory.id);
  for (let i=0;i<14;i++) await article(a,'星空观察'+i,partialCategory.id);
  await article(a,'正文专有词',null,'星空只在正文出现');
  const widthExact=await article(a,'ＳＴＡＲ');
  await article(a,'Star Stories');
  await article(a,'草稿星空',null,'草稿',false);
  const privateArticle=await article(b,'星空私人',privateCategory.id);
  async function pair(owner) {
    const pending=ok(await call('/v1/zhiyue/device/authorize',{method:'POST',body:{}}),201);
    ok(await owner.request('/v1/zhiyue/account/approve','POST',{user_code:pending.user_code,expected_account_id:owner.account.id}),204);
    const grant=ok(await call('/v1/zhiyue/device/token',{method:'POST',body:{device_code:pending.device_code}}));
    ok(await call('/v1/zhiyue/device/confirm',{method:'POST',body:{refresh_token:grant.refresh_token}}),204);
    return grant;
  }
  const grant=await pair(a), secondGrant=await pair(b);
  const device=(grant,path,text) => call('/v1/zhiyue'+path,{method:text===undefined?'GET':'POST',
    body:text===undefined?undefined:{text},headers:{Authorization:'Bearer '+grant.access_token}});
  const first=ok(await device(grant,'/read/search','查找文章星空'));
  assert.equal(first.total,15);
  assert.equal(first.items[0].id,exact.articleId);
  assert.equal(first.filters.q,'星空');
  const next=ok(await device(grant,'/read/articles?limit=12&offset=12&q='+encodeURIComponent(first.filters.q)));
  assert.equal(next.items.length,3);
  assert.equal(new Set([...first.items,...next.items].map((item)=>item.id)).size,15);
  assert.ok(![...first.items,...next.items].some((item)=>item.id===privateArticle.articleId));
  const candidates=ok(await device(grant,'/read/search','查看科技分类'));
  assert.equal(candidates.kind,'category');
  assert.equal(candidates.categoryQuery,'科技');
  assert.equal(candidates.noMatch,false);
  assert.equal(candidates.total,0);
  assert.deepEqual(candidates.filters,{q:'',category:''});
  assert.deepEqual(candidates.categoryCandidates.map((item)=>[item.id,item.articleCount]),[[exactCategory.id,1],[partialCategory.id,14]]);
  const selected=ok(await device(grant,'/read/articles?limit=12&offset=0&category='+partialCategory.id));
  assert.equal(selected.total,14);
  assert.ok(selected.items.every((item)=>item.category.id===partialCategory.id));
  const single=ok(await device(grant,'/read/search','查看资讯分类'));
  assert.equal(single.filters.category,partialCategory.id);
  assert.equal(single.total,14);
  assert.equal(single.categoryQuery,'资讯');
  const unknown=ok(await device(grant,'/read/search','查看不存在分类'));
  assert.equal(unknown.noMatch,true);
  assert.equal(unknown.total,0);
  assert.equal(unknown.categoryQuery,'不存在');
  assert.equal(ok(await device(grant,'/read/search','查找文章不存在')).total,0);
  assert.equal(ok(await device(grant,'/read/search','查找文章只在正文出现')).total,0);
  assert.equal(ok(await a.request('/v1/cms/read/articles?q='+encodeURIComponent('只在正文出现'))).total,1);
  const other=ok(await device(secondGrant,'/read/search','查找文章星空'));
  assert.deepEqual(other.items.map((item)=>item.id),[privateArticle.articleId]);
  assert.equal((await device(grant,'/read/articles?category='+privateCategory.id)).data.total,0);
  assert.equal((await device({access_token:'invalid'},'/read/search','查看科技分类')).response.status,401);
  const width=ok(await device(grant,'/read/search','查找文章star'));
  assert.equal(width.total,2);
  assert.equal(width.items[0].id,widthExact.articleId);
  const unclassified=ok(await device(grant,'/read/search','查看未分类'));
  assert.equal(unclassified.filters.category,'uncategorized');
  assert.equal(unclassified.total,3);
  ok(await call('/v1/zhiyue/device/binding',{method:'DELETE',headers:{Authorization:'Bearer '+grant.access_token}}),204);
  assert.equal((await device(grant,'/read/search','查看科技分类')).response.status,401);
});
