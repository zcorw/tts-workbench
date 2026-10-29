// Loopback-only origin/CSRF verification using the existing synthetic preview identity.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const base = process.env.BASE_URL || 'http://127.0.0.1:4384/';
const workbench = process.env.WORKBENCH_URL || 'http://127.0.0.1:4382/';
const out = process.env.QA_OUTPUT_DIR;
if (!out || !process.env.CMS_TEST_ACCOUNT_FILE) throw Error('Explicit output and synthetic test identity required');
for (const url of [base, workbench]) if (!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw Error('Loopback only');
const identity = JSON.parse(fs.readFileSync(process.env.CMS_TEST_ACCOUNT_FILE, 'utf8'));
if (!identity.testOnly) throw Error('Synthetic identity required');
const cookies = new Map(), checks = [];
function rawStatus(rawPath, origin) {
  return new Promise((resolve,reject)=>{
    const req=http.request(new URL(base),{path:rawPath,method:'POST',headers:{Origin:origin,'Content-Type':'application/json'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});
    req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Raw request timed out')));req.end('{}');
  });
}
async function request(url, method = 'GET', headers = {}, data) {
  const r = await fetch(url, { method, headers: { Cookie: [...cookies].map(([k,v])=>`${k}=${v}`).join('; '), ...(data ? {'Content-Type':'application/json'} : {}), ...headers }, ...(data ? {body:JSON.stringify(data)} : {}), redirect:'manual', signal:AbortSignal.timeout(10000) });
  for (const value of r.headers.getSetCookie()) { const entry=value.split(';')[0], split=entry.indexOf('='); cookies.set(entry.slice(0,split),entry.slice(split+1)); }
  return r;
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  let csrf=(await (await request(base+'v1/auth/csrf')).json()).csrfToken;
  let r=await request(base+'v1/auth/login','POST',{Origin:new URL(base).origin,'X-CSRF-Token':csrf},{login:identity.login,password:identity.password});
  assert.equal(r.status,200,'Legitimate CMS-origin login must work');
  csrf=(await (await request(base+'v1/auth/csrf')).json()).csrfToken;
  const body={source:'standalone-origin-check',items:[{externalId:'readonly-preview',title:'Origin test',text:'隔離テスト。',slug:'origin-test'}]};
  const cases=[
    ['Exact CMS origin allowed',base,new URL(base).origin,{},true,200],
    ['Missing Origin rejected',base,undefined,{},true,403],
    ['Foreign Origin rejected',base,'https://untrusted.example',{},true,403],
    ['Null Origin rejected',base,'null',{},true,403],
    ['Canonical API origin rejected at CMS entry',base,new URL(workbench).origin,{},true,403],
    ['Origin suffix rejected',base,new URL(base).origin+'.untrusted.example',{},true,403],
    ['Forwarded headers do not invent an Origin',base,undefined,{'X-Forwarded-Origin':new URL(base).origin,'X-Forwarded-Host':new URL(base).host,'X-Forwarded-Proto':'http'},true,403],
    ['Forwarded headers do not override foreign Origin',base,'https://untrusted.example',{'X-Forwarded-Origin':new URL(base).origin},true,403],
    ['Cross-site fetch metadata rejected',base,new URL(base).origin,{'Sec-Fetch-Site':'cross-site'},true,403],
    ['Correct Origin still requires CSRF',base,new URL(base).origin,{},false,403],
    ['Direct API rejects CMS Origin',workbench,new URL(base).origin,{},true,403],
    ['Direct API retains its canonical Origin',workbench,new URL(workbench).origin,{},true,200],
  ];
  for(const [name,target,origin,extra,useCsrf,expected]of cases){
    r=await request(target+'v1/cms/import/preview','POST',{...(origin===undefined?{}:{Origin:origin}),...(useCsrf?{'X-CSRF-Token':csrf}:{}),...extra},body);
    assert.equal(r.status,expected,name);checks.push({name,status:r.status});console.log('PASS',name);
  }
  r=await request(base+'v1/cms/taxonomy','GET',{Origin:'https://untrusted.example'});
  assert.equal(r.status,403);checks.push({name:'Foreign Origin GET rejected by CMS proxy',status:r.status});
  r=await request(base+'health/live');assert.equal(r.status,200);checks.push({name:'No-Origin safe GET allowed',status:r.status});
  for(const rawPath of ['/v1/../outside','/v1/%2e%2e/outside']){
    const status=await rawStatus(rawPath,'https://untrusted.example');assert.equal(status,403);checks.push({name:'Raw proxy path Origin guard '+rawPath,status});
    const legitimate=await rawStatus(rawPath,new URL(base).origin);assert.equal(legitimate,400);checks.push({name:'Ambiguous raw path rejected before forwarding '+rawPath,status:legitimate});
  }
  for(const target of ['@fs/app/apps/api/src/config.ts','@fs/app/vendor/tts-gateway-0.1.1.tgz']){
    r=await request(base+target);const text=await r.text();assert(r.status===403||r.status===404||(r.status===200&&text.toLowerCase().includes('<!doctype html')),'Preview leaked a non-frontend file');
    checks.push({name:'Static preview does not serve '+target,status:r.status});
  }
  fs.writeFileSync(path.join(out,'proxy-security.json'),JSON.stringify({date:new Date().toISOString(),base,workbench,checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
