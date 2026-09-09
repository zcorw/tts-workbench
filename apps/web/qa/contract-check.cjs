const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..'),meta=JSON.parse(fs.readFileSync(path.join(root,'src/api/contract.json'),'utf8'));
const source=path.resolve(root,meta.source),hash=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
if(hash!==meta.sha256)throw Error('OpenAPI changed: review contract, regenerate types, then update the approved fingerprint.');
const temporary=path.join(__dirname,'.schema-check.d.ts'),pkg=require('../node_modules/openapi-typescript/package.json');
try{const result=spawnSync(process.execPath,[path.resolve(root,'node_modules/openapi-typescript',pkg.bin['openapi-typescript']),source,'-o',temporary],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr);if(fs.readFileSync(temporary,'utf8')!==fs.readFileSync(path.join(root,'src/api/schema.d.ts'),'utf8'))throw Error('Generated API types differ. Run npm run generate:api.');console.log('PASS OpenAPI '+meta.version+' fingerprint and generated types');}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
