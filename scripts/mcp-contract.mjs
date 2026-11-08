// REST/OAuth transport documentation. tools/list remains the MCP tool contract.
export function addMcpContract(api) {
  api.info.version = '1.5.0';
  api.info.description += ' 知声 MCP is opt-in at the CMS origin /mcp, using dedicated OAuth authorization-code/PKCE grants, not browser cookies or existing read tokens. Browser consent/management still requires Session/Origin/CSRF. See docs/CMS_MCP.md for immutable batch IDs and operational boundaries.';
  const str = (extra = {}) => ({type:'string',...extra});
  const ref = (name) => ({$ref:`#/components/schemas/${name}`});
  const obj = (properties,required=Object.keys(properties)) => ({type:'object',additionalProperties:false,properties,required});
  const array = (items) => ({type:'array',items});
  const open = {type:'object',additionalProperties:true};
  const uuid = str({format:'uuid'}), time=str({format:'date-time'});
  const requestId = str({pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'});
  const schema=api.components.schemas;
  schema.McpAuthorization = obj({response_type:str({enum:['code']}),client_id:str(),redirect_uri:str({format:'uri'}),resource:str({format:'uri'}),scope:str(),state:str({maxLength:512}),code_challenge:str({pattern:'^[A-Za-z0-9_-]{43}$'}),code_challenge_method:str({enum:['S256']})},['response_type','client_id','redirect_uri','resource','scope','code_challenge','code_challenge_method']);
  schema.McpConfig = obj({clientId:str(),resource:str({format:'uri'})});
  schema.McpAuthorizationView = obj({clientId:str(),redirectUri:str({format:'uri'}),scopes:array(str()),resource:str({format:'uri'})});
  schema.McpConsent = obj({authorization:ref('McpAuthorization'),approve:{type:'boolean'}});
  schema.McpRedirect = obj({redirectUrl:str({format:'uri',description:'Exact allowlisted callback; includes short-lived authorization code or access_denied, issuer and original state. Never log the URL.'})});
  schema.McpGrant = obj({id:uuid,clientId:str(),scopes:array(str()),createdAt:time,expiresAt:time,revokedAt:{...time,nullable:true}});
  schema.McpGrantPage = obj({items:array(ref('McpGrant'))});
  schema.McpDraftInput = obj({requestId,title:schema.ArticleInput.properties.title,text:schema.ArticleInput.properties.text,summary:str({maxLength:1000}),categoryId:{...uuid,nullable:true},tagIds:{...array(uuid),maxItems:50,uniqueItems:true}},['requestId','title','text']);
  schema.McpBatchInput = obj({batchId:requestId,items:{...array(ref('McpDraftInput')),minItems:1,maxItems:20}});
  schema.McpItemResult = obj({requestId,status:str({enum:['created','error','pending']}),articleId:uuid,slug:str(),revision:{type:'integer'},cmsRevision:{type:'integer'},code:str(),retryable:{type:'boolean'},editUrl:str({format:'uri'})},['requestId','status']);
  schema.McpBatchResult = obj({batchId:requestId,items:array(ref('McpItemResult')),created:{type:'integer'},failed:{type:'integer'},pending:{type:'integer'}});
  schema.McpTokenRequest = obj({grant_type:str({enum:['authorization_code','refresh_token']}),client_id:str(),resource:str(),code:str(),redirect_uri:str(),code_verifier:str(),refresh_token:str()},['grant_type','client_id','resource']);
  schema.McpTokenResponse = obj({access_token:str(),refresh_token:str(),token_type:str({enum:['Bearer']}),expires_in:{type:'integer',maximum:900},scope:str()});
  schema.McpOAuthError = obj({error:str()});
  schema.McpRpcRequest = obj({jsonrpc:str({enum:['2.0']}),id:{oneOf:[str(),{type:'integer'}]},method:str(),params:open},['jsonrpc','method']);
  schema.McpRpcResponse = {type:'object',additionalProperties:true,description:'SDK JSON-RPC response. tools/call returns content and structuredContent; domain failures set isError. Tool arguments and annotations are discovered through tools/list. Batch receipts use McpBatchResult.'};
  api.components.securitySchemes.cmsMcpOAuth={type:'oauth2',description:'Dedicated owner-scoped MCP grant; never accepted as a Session/REST/read bearer.',flows:{authorizationCode:{authorizationUrl:'/mcp/oauth/authorize',tokenUrl:'/mcp/oauth/token',scopes:{'cms:read':'Read own article drafts and taxonomy','cms:drafts:create':'Create private drafts and query batch receipts'}}}};
  const json=(value,description='Success')=>({description,content:{'application/json':{schema:typeof value==='string'?ref(value):value}}});
  const errors=Object.fromEntries(['400','401','403','404','409','413','415','429','503'].map(status=>[status,json('Error','Feature disabled/not owned, validation, authorization, conflict, limits or dependency failure; content is never echoed.')]));
  const body=(value,type='application/json')=>({required:true,content:{[type]:{schema:ref(value)}}});
  const browser=(path,method,id,response,{input,parameters,status='200'}={})=>{
    api.paths[path]??={};api.paths[path][method]={operationId:id,summary:'知声 MCP owner consent / connections',description:'Default disabled (404). Current Session required; all mutations require matching Origin and X-CSRF-Token. No token plaintext in management responses. All responses no-store.',security:[method==='get'?{sessionCookie:[]}:{sessionCookie:[],csrfHeader:[]}],...(input?{requestBody:body(input)}:{}),...(parameters?{parameters}:{}),responses:{[status]:response,...errors}};
  };
  browser('/v1/cms/mcp/config','get','cmsMcpConfig',json('McpConfig'));
  const query=Object.entries(schema.McpAuthorization.properties).map(([name,value])=>({name,in:'query',required:schema.McpAuthorization.required.includes(name),schema:value}));
  browser('/v1/cms/mcp/authorization','get','cmsMcpAuthorization',json('McpAuthorizationView'),{parameters:query});
  browser('/v1/cms/mcp/authorize','post','cmsMcpConsent',json('McpRedirect'),{input:'McpConsent'});
  browser('/v1/cms/mcp/grants','get','cmsMcpGrants',json('McpGrantPage'));
  browser('/v1/cms/mcp/grants/{id}','delete','cmsMcpRevokeGrant',{description:'Owned grant revoked; subsequent MCP calls fail immediately.'},{parameters:[{name:'id',in:'path',required:true,schema:uuid}],status:'204'});
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server'])
    api.paths[path]={get:{operationId:path.endsWith('authorization-server')?'cmsMcpOAuthMetadata':path.endsWith('/mcp')?'cmsMcpResourceMetadata':'cmsMcpResourceMetadataRoot',summary:'知声 OAuth discovery',security:[],responses:{'200':json(open),'404':errors['404'],'403':errors['403']}}};
  api.paths['/mcp/oauth/authorize']={get:{operationId:'cmsMcpBeginAuthorization',summary:'Validate predefined public client and PKCE, then open browser consent',security:[],parameters:query,responses:{'302':{description:'Redirect to same-origin /connections/mcp; login then explicit consent required.',headers:{Location:{schema:str()}}},'400':json('McpOAuthError'),'404':errors['404']}}};
  for(const [path,id,value,response] of [['/mcp/oauth/token','cmsMcpExchangeToken','McpTokenRequest','McpTokenResponse'],['/mcp/oauth/revoke','cmsMcpRevokeToken',null,null]]) {
    const request=value?ref(value):obj({token:str(),client_id:str()});
    api.paths[path]={post:{operationId:id,summary:'知声 OAuth public-client token endpoint',description:'Dedicated OAuth protocol endpoint (8 KiB), not Session/CSRF. Exact client/resource binding, PKCE S256, rotating refresh credentials; no administrator key. Invalid grants return sanitized OAuth errors. Never log request/response bodies.',security:[],requestBody:{required:true,content:{'application/x-www-form-urlencoded':{schema:request},'application/json':{schema:request}}},responses:{'200':response?json(response):{description:'Token grant revoked or unknown token ignored.'},'400':json('McpOAuthError'),'503':json('McpOAuthError'),'404':errors['404']}}};
  }
  api.paths['/mcp']={post:{operationId:'cmsMcpMessage',summary:'知声 stateless Streamable HTTP MCP',description:'CMS listener only in dual-entry mode. Requires dedicated OAuth bearer on every request; browser cookies and read tokens never authorize. 1 MiB JSON envelope, 20 drafts, one batch/account and two batches/process, 120 requests/IP/minute. Uses SDK 1.32.2, protocol negotiation through 2025-11-25. No SSE GET stream; GET/DELETE return 405. Notifications return 202. tools/list is authoritative for tool schemas.',security:[{cmsMcpOAuth:[]}],parameters:[{name:'Accept',in:'header',required:true,schema:str({example:'application/json, text/event-stream'})},{name:'MCP-Protocol-Version',in:'header',schema:str()}],requestBody:body('McpRpcRequest'),responses:{'200':json('McpRpcResponse'),'202':{description:'Notification accepted, no body'},'400':json('McpRpcResponse'),'401':{...json('McpOAuthError'),headers:{'WWW-Authenticate':{schema:str()}}},'403':errors['403'],'404':errors['404'],'405':{description:'POST only'},'413':errors['413'],'415':errors['415'],'429':errors['429'],'503':json('McpOAuthError')}}};
}
