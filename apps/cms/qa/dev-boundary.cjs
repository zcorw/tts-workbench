// Executes inside this task's isolated preview image. No host credentials or files are mounted.
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const http=require('node:http');
function rawStatus(path){return new Promise((resolve,reject)=>{const r=http.request('http://127.0.0.1:4385',{path,method:'POST',headers:{Origin:'https://untrusted.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);r.end('{}');})}
(async()=>{
  const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4385','--strictPort'],{cwd:'/app/apps/cms',stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  const checks=[];
  try {
    let ready=false;
    for(let i=0;i<60;i++){
      if(child.exitCode!==null)throw Error('CMS dev server exited: '+log);
      try{const r=await fetch('http://127.0.0.1:4385/');if(r.status===200){ready=true;break}}catch{}
      await new Promise(r=>setTimeout(r,200));
    }
    assert(ready,'CMS dev server did not start');
    const allowed=await fetch('http://127.0.0.1:4385/src/App.tsx');
    assert.equal(allowed.status,200);assert((await allowed.text()).includes('function App'));
    checks.push({name:'CMS dev serves its allowed source',status:200});
    const health=await fetch('http://127.0.0.1:4385/health/live');assert.equal(health.status,200);checks.push({name:'CMS dev permits safe no-Origin GET',status:200});
    const targets=['/@fs/app/apps/api/src/config.ts','/@fs/app/vendor/tts-gateway-0.1.1.tgz'];
    for(const target of targets){
      const r=await fetch('http://127.0.0.1:4385'+target);assert.equal(r.status,403,target+' must be outside dev fs.allow');
      await r.body.cancel();checks.push({name:'CMS dev blocks '+target,status:r.status});
    }
    for(const origin of [undefined,'https://untrusted.example','http://127.0.0.1:4382']){
      const r=await fetch('http://127.0.0.1:4385/v1/cms/import/preview',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'});
      assert.equal(r.status,403);checks.push({name:'CMS dev rejects write Origin '+(origin||'(missing)'),status:r.status});
    }
    for(const target of ['/v1/../outside','/v1/%2e%2e/outside']){const status=await rawStatus(target);assert.equal(status,403);checks.push({name:'CMS dev guards raw proxy path '+target,status});}
    console.log(JSON.stringify({checks,serverLog:log},null,2));
  }finally{
    if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}
  }
})().catch(e=>{console.error(e);process.exitCode=1});
