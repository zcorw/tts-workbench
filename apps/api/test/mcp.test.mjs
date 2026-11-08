import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApplication} from '../dist/app.js';
import {readConfig} from '../dist/config.js';
import {migrate} from '../dist/migrate.js';
import {McpBatchService} from '../dist/mcp-batch.js';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url = process.env.TEST_DATABASE_URL;
const settings = {SESSION_SECRET: 'zhisheng-mcp-isolation-only-session-secret', PUBLIC_ORIGIN: 'http://127.0.0.1:4381', NODE_ENV: 'test', REGISTRATION_ENABLED: 'true'};
const callback = 'https://chatgpt.com/aip/fixture-only/oauth/callback';
test('MCP defaults off and rejects incomplete/unsafe activation', () => {
  const env = {...settings, DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture'};
  assert.equal(readConfig(env).CMS_MCP_ENABLED, false);
  assert.throws(() => readConfig({...env, CMS_MCP_ENABLED:'true'}));
  for (const redirect of ['https://chatgpt.com/*', 'http://chatgpt.com/callback', 'https://user:pass@chatgpt.com/callback', 'https://chatgpt.com/callback#fragment'])
    assert.throws(() => readConfig({...env, CMS_PUBLIC_ORIGIN:env.PUBLIC_ORIGIN, CMS_MCP_ENABLED:'true', CMS_MCP_CLIENT_ID:'fixture', CMS_MCP_REDIRECT_URIS:redirect}));
});

test('知声 MCP: isolated HTTP, official SDK, OAuth and durable draft receipts', {skip:!url}, async (t) => {
  const target = new URL(url);
  // Also accept the repository's existing loopback CI database so npm test
  // exercises the new suite without changing the deployment workflow.
  assert.match(target.pathname, /^\/(?:zhisheng_mcp_test_20261105[a-z0-9_]*|cms_reading_test_20261027)$/);
  assert.ok(['127.0.0.1','localhost','mcp-qa-db'].includes(target.hostname), 'MCP tests require a dedicated local fixture database');
  await migrate(url); await migrate(url);
  const config = readConfig({...settings, DATABASE_URL:url, CMS_PUBLIC_ORIGIN:settings.PUBLIC_ORIGIN, CMS_MCP_ENABLED:'true', CMS_MCP_CLIENT_ID:'fixture-chatgpt', CMS_MCP_REDIRECT_URIS:callback, MAX_ARTICLES:'100'});
  let runtime = await createApplication(config), base;
  const owners = [], clients = [];
  const start = async () => {await runtime.app.listen(0,'127.0.0.1'); base=await runtime.app.getUrl();};
  const http = async (path, {method='GET', body, token, cookie, csrf, origin, headers={}}={}) => {
    const response=await fetch(base+path,{method, headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(token?{Authorization:`Bearer ${token}`} : {}), ...(cookie?{Cookie:cookie}:{}), ...(csrf?{'X-CSRF-Token':csrf}:{}), ...(origin?{Origin:origin}:{}), ...headers}, ...(body === undefined ? {} : {body:typeof body==='string'?body:JSON.stringify(body)}), redirect:'manual'});
    const text=await response.text(); let data;
    try {data=JSON.parse(text);} catch {data=text;}
    return {status:response.status,data,headers:response.headers};
  };
  const browser=async () => {
    let cookie='',csrf='';
    const call=async (path,method='GET',body,valid=true) => {
      const r=await http(path,{method,body,cookie,csrf:valid?csrf:'bad',origin:config.PUBLIC_ORIGIN});
      const cookies=r.headers.getSetCookie(); if(cookies.length)cookie=cookies.map(x=>x.split(';')[0]).join('; ');
      if(r.data?.csrfToken)csrf=r.data.csrfToken;
      return r;
    };
    await call('/v1/auth/csrf');
    const login=`mcp-${randomUUID()}`,password='Fixture9!';
    const account=await call('/v1/auth/register','POST',{login,password,displayName:'知声 MCP 虚构验收'});
    assert.equal(account.status,201);owners.push(account.data.id);
    assert.equal((await call('/v1/auth/login','POST',{login,password})).status,200);
    await call('/v1/auth/csrf');
    return {call,owner:account.data.id,cookie:()=>cookie};
  };
  const authorization=(scope='cms:read cms:drafts:create') => {
    const verifier=randomBytes(32).toString('base64url');
    return {verifier,params:{response_type:'code',client_id:'fixture-chatgpt',redirect_uri:callback,resource:`${config.CMS_PUBLIC_ORIGIN}/mcp`,scope,state:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}};
  };
  const consent=async (a,scope) => {
    const auth=authorization(scope);
    const result=await a.call('/v1/cms/mcp/authorize','POST',{authorization:auth.params,approve:true});
    assert.equal(result.status,200);
    const redirect=new URL(result.data.redirectUrl);
    assert.equal(redirect.searchParams.get('state'),auth.params.state);
    assert.equal(redirect.searchParams.get('iss'),config.CMS_PUBLIC_ORIGIN);
    return {...auth,code:redirect.searchParams.get('code')};
  };
  const exchange=(auth,changes={}) => http('/mcp/oauth/token',{method:'POST',body:{grant_type:'authorization_code',client_id:auth.params.client_id,resource:auth.params.resource,redirect_uri:callback,code:auth.code,code_verifier:auth.verifier,...changes}});
  const mint=async (a,scope) => {const auth=await consent(a,scope);const r=await exchange(auth);assert.equal(r.status,200);return r.data;};
  const rpc=(token,method,params={},headers={})=>http('/mcp',{method:'POST',token,headers:{Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...headers},body:{jsonrpc:'2.0',id:randomUUID(),method,params}});
  const call=async (token,name,args={}) => (await rpc(token,'tools/call',{name,arguments:args})).data;
  const item=(requestId,changes={})=>({requestId,title:'日文の面接',text:'日本語\nか\u3099😀\t原文は変えない。',...changes});
  let a,b,tokens,foreignCategory,articleId;
  try {
    await start();a=await browser();b=await browser();
    await t.test('Discovery, origin rejection, session cookies and existing read credentials cannot authorize MCP',async()=>{
      const metadata=await http('/.well-known/oauth-protected-resource/mcp');
      assert.equal(metadata.status,200);assert.equal(metadata.data.resource,config.CMS_PUBLIC_ORIGIN+'/mcp');
      const as=(await http('/.well-known/oauth-authorization-server')).data;
      assert.deepEqual(as.code_challenge_methods_supported,['S256']);assert.deepEqual(as.token_endpoint_auth_methods_supported,['none']);assert.equal(as.registration_endpoint,undefined);
      const denied=await http('/mcp',{method:'POST',body:{},cookie:a.cookie()});
      assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/resource_metadata=/);
      assert.equal((await http('/mcp',{method:'POST',body:{},token:'old-read-credential'})).status,401);
      assert.equal((await http('/mcp',{method:'POST',body:{},origin:'https://evil.example'})).status,403);
      assert.equal((await http('/mcp/misspelled')).status,404);
    });
    await t.test('Authorize requires session and CSRF; exact callbacks, resource, PKCE and scopes are enforced',async()=>{
      const auth=authorization();
      assert.equal((await http('/v1/cms/mcp/authorize',{method:'POST',body:{authorization:auth.params,approve:true},origin:config.PUBLIC_ORIGIN})).status,403);
      assert.equal((await a.call('/v1/cms/mcp/authorize','POST',{authorization:auth.params,approve:true},false)).status,403);
      for(const changes of [{redirect_uri:'https://evil.example/callback'},{resource:'https://evil.example/mcp'},{code_challenge_method:'plain'},{scope:'cms:publish'},{client_id:'other'}])
        assert.equal((await a.call('/v1/cms/mcp/authorize','POST',{authorization:{...auth.params,...changes},approve:true})).status,400);
      const denied=await a.call('/v1/cms/mcp/authorize','POST',{authorization:auth.params,approve:false});
      assert.equal(new URL(denied.data.redirectUrl).searchParams.get('error'),'access_denied');
      const approved=await consent(a);
      assert.equal((await exchange(approved,{code_verifier:'a'.repeat(43)})).status,400);
      assert.equal((await exchange(approved,{resource:'https://evil.example/mcp'})).status,400);
      assert.equal((await exchange(approved,{redirect_uri:'https://evil.example/callback'})).status,400);
      const good=await exchange(approved);assert.equal(good.status,200);
      assert.equal((await exchange(approved)).status,400);
      assert.equal((await rpc(good.data.access_token,'ping')).status,401,'Code replay revokes issued tokens');
      tokens=await mint(a);
      assert.equal((await rpc(tokens.access_token,'ping')).status,200);
      assert.equal((await http('/v1/cms/articles',{token:tokens.access_token})).status,403,'MCP access token cannot authorize REST/session APIs');
    });
    await t.test('Official SDK initializes, lists tools and receives structured results',async()=>{
      const client=new Client({name:'zhisheng-fixture',version:'1.0'});
      await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
      clients.push(client);
      const list=await client.listTools();assert.equal(list.tools.length,4);
      assert.equal(list.tools.find(x=>x.name==='create_article_drafts').annotations.readOnlyHint,false);
      assert.equal(list.tools.find(x=>x.name==='get_article').annotations.readOnlyHint,true);
      assert.equal(list.tools[0]._meta.securitySchemes[0].type,'oauth2');
      const result=await client.callTool({name:'list_categories',arguments:{}});
      assert.ok(Array.isArray(result.structuredContent.categories));
      assert.equal((await rpc(tokens.access_token,'unknown/method')).data.error.code,-32601);
      assert.equal((await call(tokens.access_token,'unknown_tool')).error.code,-32602);
    });
    await t.test('Scopes are enforced by the server and errors contain an OAuth challenge',async()=>{
      const read=await mint(a,'cms:read');
      const result=await call(read.access_token,'create_article_drafts',{batchId:'no-scope',items:[item('no-scope')]});
      assert.equal(result.result.isError,true);assert.equal(result.result.structuredContent.code,'INSUFFICIENT_SCOPE');
      assert.match(result.result._meta['mcp/www_authenticate'][0],/insufficient_scope/);
    });
    await t.test('Batch partial success retains exact text, auto slug, ownership and private drafts without TTS',async()=>{
      foreignCategory=(await b.call('/v1/cms/categories','POST',{name:'他人',slug:'foreign'})).data.id;
      const result=(await call(tokens.access_token,'create_article_drafts',{batchId:'partial',items:[item('one'),item('bad',{categoryId:foreignCategory}),item('empty',{title:''}),item('no-publish',{publish:true})]})).result.structuredContent;
      assert.equal(result.created,1);assert.equal(result.failed,3);assert.equal(result.pending,0);
      articleId=result.items[0].articleId;assert.match(result.items[0].slug,/^article-/);
      assert.equal(result.items[0].editUrl,`${config.CMS_PUBLIC_ORIGIN}/articles/${articleId}`);
      const article=(await a.call(`/v1/cms/articles/${articleId}`)).data;
      assert.equal(article.text,item('one').text);assert.equal(article.cms.publishedReleaseId,null);assert.equal(article.audio,null);
      assert.equal((await b.call(`/v1/cms/articles/${articleId}`)).status,404);
      const viaMcp=(await call(tokens.access_token,'get_article',{articleId})).result.structuredContent;
      assert.equal(viaMcp.text,article.text);assert.equal(viaMcp.id,articleId);
      const bt=await mint(b);
      assert.equal((await call(bt.access_token,'get_article',{articleId})).result.structuredContent.code,'NOT_FOUND');
      assert.equal((await call(bt.access_token,'get_draft_batch',{batchId:'partial'})).result.structuredContent.code,'NOT_FOUND');
      assert.equal((await runtime.pool.query('SELECT count(*) FROM wb_article_audio au JOIN wb_articles a ON a.id=au.article_id WHERE a.account_id=$1',[a.owner])).rows[0].count,'0');
      const status=(await call(tokens.access_token,'get_draft_batch',{batchId:'partial'})).result.structuredContent;
      assert.equal(status.created,1);assert.equal(status.failed,3);
    });
    await t.test('Owned taxonomy, 20-item boundary and existing article capacity rules are preserved',async()=>{
      const category=(await a.call('/v1/cms/categories','POST',{name:'面接',slug:'interview'})).data;
      const tag=(await a.call('/v1/cms/tags','POST',{name:'練習',slug:'practice'})).data;
      const taxonomy=(await call(tokens.access_token,'list_categories')).result.structuredContent;
      assert.ok(taxonomy.categories.some(x=>x.id===category.id));assert.ok(!taxonomy.categories.some(x=>x.id===foreignCategory));
      const boundary=(await call(tokens.access_token,'create_article_drafts',{batchId:'twenty',items:Array.from({length:20},(_,i)=>item(`twenty-${i}`,{categoryId:category.id,tagIds:[tag.id]}))})).result.structuredContent;
      assert.equal(boundary.created,20);
      const saved=(await a.call(`/v1/cms/articles/${boundary.items[0].articleId}`)).data;
      assert.equal(saved.cms.categoryId,category.id);assert.deepEqual(saved.cms.tagIds,[tag.id]);
      const original=runtime.state.articles.maxArticles;
      try {
        runtime.state.articles.maxArticles=1;
        const capacity=await runtime.state.mcpBatch.create(b.owner,{batchId:'capacity',items:[item('capacity-1'),item('capacity-2')]});
        assert.equal(capacity.created,1);assert.equal(capacity.items[1].code,'ARTICLE_LIMIT');
      } finally {runtime.state.articles.maxArticles=original;}
    });
    await t.test('Retries are immutable, cross-batch item IDs deduplicate, and manual edits are preserved',async()=>{
      const original={batchId:'partial',items:[item('one'),item('bad',{categoryId:foreignCategory}),item('empty',{title:''}),item('no-publish',{publish:true})]};
      const current=(await a.call(`/v1/articles/${articleId}`)).data;
      assert.equal((await a.call(`/v1/articles/${articleId}`,'PATCH',{title:'手動編集',text:'最新の本文',expectedRevision:current.revision})).status,200);
      assert.equal((await call(tokens.access_token,'create_article_drafts',original)).result.structuredContent.items[0].articleId,articleId);
      assert.equal((await a.call(`/v1/articles/${articleId}`)).data.text,'最新の本文');
      assert.equal((await call(tokens.access_token,'create_article_drafts',{batchId:'partial',items:[item('one')]})).result.structuredContent.code,'IDEMPOTENCY_CONFLICT');
      const other=(await call(tokens.access_token,'create_article_drafts',{batchId:'next',items:[item('one'),item('fixed')]})).result.structuredContent;
      assert.equal(other.items[0].articleId,articleId);assert.equal(other.created,2);
      const conflict=(await call(tokens.access_token,'create_article_drafts',{batchId:'changed-item',items:[item('one',{text:'different'})]})).result.structuredContent;
      assert.equal(conflict.items[0].code,'IDEMPOTENCY_CONFLICT');
      assert.equal((await call(tokens.access_token,'get_draft_batch',{batchId:'changed-item'})).result.structuredContent.items[0].code,'IDEMPOTENCY_CONFLICT');
    });
    await t.test('Input and size limits reject malformed envelopes and report per-item errors without content leakage',async()=>{
      for(const input of [{batchId:'empty',items:[]},{batchId:'many',items:Array.from({length:21},(_,i)=>item('many-'+i))},{batchId:'dup',items:[item('dup'),item('dup')]},{batchId:'id',items:[item('!invalid')]}])
        assert.equal((await call(tokens.access_token,'create_article_drafts',input)).result.isError,true);
      const invalid=(await call(tokens.access_token,'create_article_drafts',{batchId:'invalid-content',items:[item('long-title',{title:'😀'.repeat(121)}),item('long-body',{text:'x'.repeat(10001)}),item('control',{text:'sensitive\u0000body'}),item('wrong-account',{accountId:b.owner})]})).result;
      assert.equal(invalid.structuredContent.failed,4);assert.ok(!JSON.stringify(invalid).includes('sensitive'));
      assert.equal((await http('/mcp',{method:'POST',token:tokens.access_token,body:'{bad',headers:{Accept:'application/json, text/event-stream'}})).status,400);
      assert.equal((await http('/mcp',{method:'POST',token:tokens.access_token,body:'x'.repeat(1048577)})).status,413);
      const wrong=await http('/mcp',{method:'POST',token:tokens.access_token,body:'{}',headers:{'Content-Type':'text/plain',Accept:'application/json, text/event-stream'}});
      assert.equal(wrong.status,415);
      assert.equal((await rpc(tokens.access_token,'ping',{}, {'MCP-Protocol-Version':'unsupported'})).status,400);
    });
    await t.test('Concurrent requests across instances create one draft and one durable receipt',async()=>{
      const second=new McpBatchService(runtime.pool,runtime.state.articles,runtime.state.cms);
      const input={batchId:'concurrent',items:[item('race')]};
      const results=await Promise.all([runtime.state.mcpBatch.create(a.owner,input),second.create(a.owner,input)]);
      assert.equal(results[0].items[0].articleId,results[1].items[0].articleId);
      assert.equal((await runtime.pool.query('SELECT count(*) FROM wb_cms_mcp_items WHERE account_id=$1 AND request_id=$2',[a.owner,'race'])).rows[0].count,'1');
    });
    await t.test('Admission bounds per-account and process concurrency without opening extra pool connections',async()=>{
      const service=runtime.state.mcpBatch;
      const original=runtime.state.articles.transaction.bind(runtime.state.articles);
      let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
      runtime.state.articles.transaction=async(...args)=>{enter();await gate;return original(...args);};
      const pending=service.create(a.owner,{batchId:'held',items:[item('held')]});
      await entered;
      const third=await browser();
      const other=service.create(b.owner,{batchId:'held-b',items:[item('held-b')]});
      try {
        await assert.rejects(service.create(a.owner,{batchId:'busy',items:[item('busy')]}),e=>e.code==='MCP_BUSY');
        await assert.rejects(service.create(third.owner,{batchId:'busy-c',items:[item('busy-c')]}),e=>e.code==='MCP_BUSY');
      } finally {release();await Promise.all([pending,other]);runtime.state.articles.transaction=original;}
    });
    await t.test('A lost commit acknowledgement is recoverable and never creates a duplicate',async()=>{
      const original=runtime.state.articles.transaction.bind(runtime.state.articles);let calls=0;
      runtime.state.articles.transaction=async(...args)=>{const value=await original(...args);if(++calls===2)throw new Error('simulated committed response loss');return value;};
      const input={batchId:'uncertain',items:[item('uncertain')]};
      const result=await runtime.state.mcpBatch.create(a.owner,input);
      runtime.state.articles.transaction=original;
      assert.equal(result.items[0].code,'OUTCOME_UNKNOWN');
      const known=await runtime.state.mcpBatch.status(a.owner,'uncertain');assert.equal(known.created,1);
      const retried=await runtime.state.mcpBatch.create(a.owner,input);assert.deepEqual(retried,known);
    });
    await t.test('A pre-commit dependency failure rolls back and permits the original request to resume',async()=>{
      const original=runtime.state.cms.createInTransaction.bind(runtime.state.cms);let fail=true;
      runtime.state.cms.createInTransaction=async(...args)=>{const value=await original(...args);if(fail){fail=false;throw new Error('isolated fixture DB failure');}return value;};
      const input={batchId:'rollback',items:[item('rollback')]};
      const first=await runtime.state.mcpBatch.create(a.owner,input);assert.equal(first.pending,1);
      assert.equal((await runtime.state.mcpBatch.status(a.owner,'rollback')).pending,1);
      const second=await runtime.state.mcpBatch.create(a.owner,input);assert.equal(second.created,1);
      runtime.state.cms.createInTransaction=original;
    });
    await t.test('Deleted articles retain tombstone receipts and cannot be recreated on retry',async()=>{
      const input={batchId:'delete',items:[item('delete')]};const saved=await runtime.state.mcpBatch.create(a.owner,input);
      const id=saved.items[0].articleId;
      assert.equal((await a.call(`/v1/articles/${id}?expectedRevision=1`,'DELETE')).status,204);
      assert.deepEqual(await runtime.state.mcpBatch.create(a.owner,input),saved);
      assert.equal((await a.call(`/v1/articles/${id}`)).status,404);
    });
    await t.test('Cancellation leaves remaining items pending and original input resumes safely',async()=>{
      const input={batchId:'cancelled',items:[item('cancel-1'),item('cancel-2')]};let checked=0;
      const first=await runtime.state.mcpBatch.create(a.owner,input,()=>++checked>1);
      assert.equal(first.created,1);assert.equal(first.pending,1);
      const second=await runtime.state.mcpBatch.create(a.owner,input);
      assert.equal(second.created,2);assert.equal(second.items[0].articleId,first.items[0].articleId);
    });
    await t.test('Refresh rotates tokens; replay revokes grant, and expiry/disabled accounts fail closed',async()=>{
      const value=await mint(a);
      const refresh={grant_type:'refresh_token',client_id:'fixture-chatgpt',resource:config.CMS_PUBLIC_ORIGIN+'/mcp',refresh_token:value.refresh_token};
      const rotated=await http('/mcp/oauth/token',{method:'POST',body:new URLSearchParams(refresh).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
      assert.equal(rotated.status,200);assert.notEqual(rotated.data.refresh_token,value.refresh_token);
      assert.equal((await http('/mcp/oauth/token',{method:'POST',body:refresh})).status,400);
      assert.equal((await rpc(rotated.data.access_token,'ping')).status,401);
      const expired=await mint(a);
      await runtime.pool.query("UPDATE wb_cms_mcp_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[createHash('sha256').update(expired.access_token).digest('hex')]);
      assert.equal((await rpc(expired.access_token,'ping')).status,401);
      await runtime.pool.query("UPDATE ac_accounts SET status='disabled' WHERE id=$1",[a.owner]);
      assert.equal((await rpc(tokens.access_token,'ping')).status,401);
      await runtime.pool.query("UPDATE ac_accounts SET status='active' WHERE id=$1",[a.owner]);
    });
    await t.test('Owner-only grant revocation invalidates access immediately and stores only token digests',async()=>{
      const grant=(await a.call('/v1/cms/mcp/grants')).data.items.find(x=>!x.revokedAt);
      assert.equal((await b.call(`/v1/cms/mcp/grants/${grant.id}`,'DELETE')).status,404);
      assert.equal((await a.call(`/v1/cms/mcp/grants/${grant.id}`,'DELETE',undefined,false)).status,403);
      assert.equal((await a.call(`/v1/cms/mcp/grants/${grant.id}`,'DELETE')).status,204);
      const rows=(await runtime.pool.query('SELECT token_hash FROM wb_cms_mcp_tokens')).rows;
      assert.ok(rows.every(x=>/^[0-9a-f]{64}$/.test(x.token_hash)));
      assert.ok(!JSON.stringify(rows).includes(tokens.access_token));
      const receipts=(await runtime.pool.query('SELECT * FROM wb_cms_mcp_items WHERE account_id=$1',[a.owner])).rows;
      assert.ok(!JSON.stringify(receipts).includes('原文は変えない'));
      const fresh=await mint(a);
      assert.equal((await http('/mcp/oauth/revoke',{method:'POST',body:{token:fresh.access_token,client_id:'fixture-chatgpt'}})).status,200);
      assert.equal((await rpc(fresh.access_token,'ping')).status,401);
    });
    await t.test('Concurrent refresh replay cannot issue two usable token pairs',async()=>{
      const value=await mint(a);
      const body={grant_type:'refresh_token',client_id:'fixture-chatgpt',resource:config.CMS_PUBLIC_ORIGIN+'/mcp',refresh_token:value.refresh_token};
      const results=await Promise.all([http('/mcp/oauth/token',{method:'POST',body}),http('/mcp/oauth/token',{method:'POST',body})]);
      assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);
      const issued=results.find(x=>x.status===200);
      assert.equal((await rpc(issued.data.access_token,'ping')).status,401);
    });
    await t.test('Dual-entry MCP exists only on the CMS listener and reserved paths never become SPA HTML',async()=>{
      const root=await mkdtemp(join(tmpdir(),'zhisheng-mcp-entry-'));
      await mkdir(join(root,'web'));await mkdir(join(root,'cms'));
      await writeFile(join(root,'web','index.html'),'<h1>Workbench fixture</h1>');
      await writeFile(join(root,'cms','index.html'),'<h1>知声 fixture</h1>');
      const dual=await createApplication({...config,WEB_DIST:join(root,'web'),CMS_DIST:join(root,'cms'),PORT:0,CMS_PORT:0});
      try {
        await dual.listen();
        const web=await dual.app.getUrl(),cms=`http://127.0.0.1:${dual.cmsServer.address().port}`;
        assert.equal((await fetch(web+'/mcp')).status,404);
        assert.equal((await fetch(web+'/.well-known/oauth-protected-resource/mcp')).status,404);
        assert.equal((await fetch(cms+'/mcp')).status,401);
        assert.equal((await fetch(cms+'/.well-known/oauth-protected-resource/mcp')).status,200);
        assert.equal((await fetch(cms+'/mcp',{headers:{Authorization:`Bearer ${tokens.access_token}`}})).status,405);
        const missing=await fetch(cms+'/mcp/misspelled',{headers:{Accept:'text/html'}});
        assert.equal(missing.status,404);assert.match(missing.headers.get('content-type'),/json/);
        assert.equal((await fetch(cms+'/connections/mcp',{headers:{Accept:'text/html'}})).status,200);
      } finally {await dual.close();await rm(root,{recursive:true,force:true});}
    });
    await t.test('Restart preserves receipts; feature-off endpoints reject tokens and browser management',async()=>{
      await Promise.all(clients.splice(0).map(x=>x.close()));
      await runtime.close();runtime=await createApplication(config);await start();
      const known=await runtime.state.mcpBatch.status(a.owner,'uncertain');assert.equal(known.created,1);
      await runtime.close();runtime=await createApplication({...config,CMS_MCP_ENABLED:false});await start();
      assert.equal((await http('/mcp',{method:'POST',body:{},token:tokens.access_token})).status,404);
      assert.equal((await http('/.well-known/oauth-protected-resource')).status,404);
      assert.equal((await a.call('/v1/cms/mcp/config')).status,404);
    });
  } finally {
    await Promise.all(clients.map(x=>x.close()));
    for(const owner of owners) await runtime.pool.query('DELETE FROM ac_accounts WHERE id=$1',[owner]);
    await runtime.close();
  }
});
