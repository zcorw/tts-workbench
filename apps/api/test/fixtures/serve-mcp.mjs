import {createApplication} from '../../dist/app.js';
import {readConfig} from '../../dist/config.js';
import {migrate} from '../../dist/migrate.js';
import {AccountService} from '@tts-workbench/account-core';

const database=process.env.TEST_DATABASE_URL;
if (!database || !/^\/zhisheng_mcp_test_20261105[a-z0-9_]*$/.test(new URL(database).pathname) || !['mcp-qa-db','127.0.0.1','localhost'].includes(new URL(database).hostname))
  throw new Error('Dedicated MCP fixture database required');
globalThis.fetch=async()=>{throw new Error('MCP browser fixture forbids external/provider fetches');};
await migrate(database);
const runtime=await createApplication(readConfig({
  DATABASE_URL:database,SESSION_SECRET:'zhisheng-mcp-browser-fixture-only-secret',NODE_ENV:'test',
  PUBLIC_ORIGIN:'http://127.0.0.1:4391',CMS_PUBLIC_ORIGIN:'http://127.0.0.1:4392',HOST:'0.0.0.0',PORT:'4391',CMS_PORT:'4392',
  WEB_DIST:'/app/apps/web/dist',CMS_DIST:'/app/apps/cms/dist',REGISTRATION_ENABLED:'true',
  CMS_MCP_ENABLED:'true',CMS_MCP_CLIENT_ID:'fixture-chatgpt',CMS_MCP_REDIRECT_URIS:'https://chatgpt.com/aip/fixture-only/oauth/callback',
}));
const credentials={login:'zhisheng-mcp-ui-fixture',password:'Fixture9!'};
const accounts=runtime.app.get(AccountService);
let account;
try {account=await accounts.authenticateCredentials(credentials);}
catch {account=await accounts.createAccount({...credentials,displayName:'知声验收 · 虚构账户'});}
await runtime.state.mcpBatch.create(account.id,{batchId:'ui-fixture',items:[{requestId:'ui-fixture',title:'面接の自己紹介',text:'はじめまして。\n本日はよろしくお願いいたします。\n日本語の面接を練習しています。'}]});
await runtime.listen();
console.log(JSON.stringify({ready:true,workbench:'http://127.0.0.1:4391',cms:'http://127.0.0.1:4392',fixtureOnly:true}));
for(const event of ['SIGINT','SIGTERM'])process.on(event,async()=>{await runtime.close();process.exit(0);});
