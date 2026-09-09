import {writeFileSync} from 'node:fs';
import YAML from 'yaml';
const ref = n => ({$ref:`#/components/schemas/${n}`});
const str = (extra={}) => ({type:'string',...extra});
const int = (min=0) => ({type:'integer',minimum:min});
const obj = (properties,required=Object.keys(properties)) => ({type:'object',additionalProperties:false,required,properties});
const uuid = str({format:'uuid'}), version=int(0), name=str({minLength:1,maxLength:40});
const term=str({minLength:1,maxLength:100,description:'NFC normalized, non-whitespace; no angle brackets or control characters. Length in Unicode code points.'});
const schema={
 Error:obj({code:str({example:'REVISION_CONFLICT'}),message:str(),requestId:uuid}),
 Account:obj({id:uuid,login:str(),displayName:name,status:str({enum:['active','disabled']})}),
 Credentials:obj({login:str({minLength:3,maxLength:120,pattern:'^[A-Za-z0-9@._+-]+$',description:'Trimmed and lowercased; stable login identifier, not necessarily email.'}),password:str({minLength:8,maxLength:128,format:'password'})}),
 Register:obj({login:str({minLength:3,maxLength:120,pattern:'^[A-Za-z0-9@._+-]+$'}),password:str({minLength:8,maxLength:128,format:'password'}),displayName:name}),
 Csrf:obj({csrfToken:str(),expiresAt:str({format:'date-time'})}),
 Config:obj({registrationEnabled:{type:'boolean'},language:str({enum:['ja-JP']}),maxVocabularyEntries:int(1),maxInputCodePoints:int(1),maxInputBytes:int(1)}),
 VocabularyInput:obj({text:term,reading:term}),
 VocabularyPatch:obj({text:term,reading:term,expectedRevision:int(1)}),
 Vocabulary:obj({id:uuid,text:term,reading:term,revision:int(1),createdAt:str({format:'date-time'}),updatedAt:str({format:'date-time'})}),
 VocabularyResult:obj({entry:ref('Vocabulary'),internalVersion:version}),
 VocabularyPage:obj({items:{type:'array',items:ref('Vocabulary')},total:int(),offset:int(),limit:int(1),internalVersion:version}),
 Voice:obj({id:str(),name:str(),language:str({enum:['ja-JP']}),provider:str({enum:['azure-speech','amazon-polly']})}),
 Voices:obj({items:{type:'array',items:ref('Voice'),description:'Empty when no Japanese provider is configured; no demo voice is returned.'}}),
 Speech:obj({input:str({minLength:1,maxLength:10000,example:'今日は日本語を勉強します。'}),voice:str({minLength:1,description:'ID from getVoices, not a provider voice identifier.'}),speed:{type:'number',minimum:0.5,maximum:2,multipleOf:0.01,default:1},language:str({enum:['ja-JP'],default:'ja-JP'}),inputType:str({enum:['text'],default:'text'}),format:str({enum:['mp3'],default:'mp3'})},['input','voice']),
 Preview:obj({text:term,reading:term,voice:str({minLength:1}),speed:{type:'number',minimum:0.5,maximum:2,multipleOf:0.01,default:1}},['text','reading','voice']),
 Health:obj({status:str({enum:['ok']})})
};
const headers={'X-Request-Id':{schema:uuid},'Cache-Control':{schema:str({enum:['no-store']})}};
const json=(s,description='Success')=>({description,headers,content:{'application/json':{schema:typeof s==='string'?ref(s):s}}});
const err=(description)=>json('Error',description);
const errors={'400':err('INVALID_REQUEST: invalid fields, JSON or unknown properties'),'401':err('UNAUTHENTICATED: absent, invalid, expired or revoked session / invalid credentials'),'403':err('FORBIDDEN / CSRF_INVALID / REGISTRATION_DISABLED'),'404':err('NOT_FOUND: absent or not owned'),'409':err('REVISION_CONFLICT / ALREADY_EXISTS / VOCABULARY_LIMIT'),'413':err('PAYLOAD_TOO_LARGE'),'415':err('UNSUPPORTED_MEDIA_TYPE'),'429':{...err('RATE_LIMITED; retry after indicated seconds'),headers:{...headers,'Retry-After':{schema:int(1)}}},'503':err('DEPENDENCY_UNAVAILABLE / TTS_UNAVAILABLE'),'502':err('TTS_PROVIDER_ERROR'),'504':err('TTS_TIMEOUT')};
const body=n=>({required:true,content:{'application/json':{schema:ref(n)}}});
const paths={};
function op(path,method,id,summary,response,{input,auth=true,write=false,description='',parameters=[],extra={},status='200'}={}){
 paths[path]??={};paths[path][method]={operationId:id,summary,description,security:auth?[write?{sessionCookie:[],csrfHeader:[]}:{sessionCookie:[]}]:write?[{csrfHeader:[]}]:[],...(input?{requestBody:body(input)}:{}),...(parameters.length?{parameters}:{}),responses:{[status]:response,...Object.fromEntries((auth?['400','401','403','429','503']:['400','403','429','503']).map(k=>[k,errors[k]])),...(write?{'415':errors['415'],'413':errors['413']}:{}),...extra}};
}
op('/v1/config','get','getConfig','Public UI capabilities',json('Config'),{auth:false});
op('/v1/auth/csrf','get','getCsrf','Get browser-bound CSRF token',json('Csrf'),{auth:false,description:'Sets HttpOnly csrf binding cookie (Path=/, SameSite=Lax, Secure in production). Token valid for 1 hour; repeated calls reuse binding. Send returned token in X-CSRF-Token for every POST/PATCH/DELETE including anonymous login/register. Login/logout invalidate binding: fetch again after success. GET accepts a missing Origin (normal same-origin browser GET); when present it must equal configured public origin. Strict required Origin applies only to POST/PATCH/DELETE.'});
op('/v1/auth/register','post','register','Create account; does not log in',json('Account'),{input:'Register',auth:false,write:true,status:'201',extra:{'409':errors['409']},description:'Disabled by default; 403 REGISTRATION_DISABLED. Display name is trimmed. Login is immutable and case-insensitively unique. After 201, use login endpoint.'});
op('/v1/auth/login','post','login','Log in', {...json('Account'),headers:{...headers,'Set-Cookie':{schema:str(),description:'wb_session=<opaque>; HttpOnly; SameSite=Lax; Path=/; Secure in production. CSRF binding is cleared.'}}},{input:'Credentials',auth:false,write:true,extra:{'401':errors['401']},description:'Generic 401 for unknown login/wrong password/disabled account. Session idle expiry 24 hours, absolute expiry 7 days. Fetch fresh CSRF after success.'});
op('/v1/auth/logout','post','logout','Revoke current session',{description:'Revoked, cookies cleared; fetch new CSRF before next mutation',headers},{auth:false,write:true,status:'204',description:'Idempotent for absent/expired session, but requires valid CSRF and same origin.'});
op('/v1/auth/me','get','getCurrentAccount','Current account',json('Account'));
schema.AccountPatch=obj({displayName:name});
op('/v1/auth/me','patch','updateCurrentAccount','Update display name',json('Account'),{input:'AccountPatch',write:true,description:'Only displayName is editable; login/password changes are outside this release.'});
const query=(n,s)=>({name:n,in:'query',schema:s});
op('/v1/vocabulary','get','listVocabulary','List personal reading rules',json('VocabularyPage'),{parameters:[query('limit',{...int(1),maximum:500,default:50}),query('offset',{...int(),default:0}),query('q',str({maxLength:100}))],description:'Substring search on text or reading, case-sensitive after NFC normalization; stable createdAt then id ascending. total counts filtered rows; internalVersion represents whole personal set. Each page is one consistent DB snapshot. Use limit=500 without q for complete article projection (account cap 500); do not combine differing versions across pages.'});
op('/v1/vocabulary','post','createVocabulary','Save personal reading for current and future articles',json('VocabularyResult'),{input:'VocabularyInput',write:true,status:'201',extra:{'409':errors['409']},description:'NFC-normalized text is unique within account. Commit increments set internalVersion atomically. No publish step. Does not modify original article.'});
const idparam={name:'id',in:'path',required:true,schema:uuid};
op('/v1/vocabulary/{id}','get','getVocabulary','Get owned entry',json('VocabularyResult'),{parameters:[idparam],extra:{'404':errors['404']}});
op('/v1/vocabulary/{id}','patch','updateVocabulary','Conditionally update personal reading',json('VocabularyResult'),{input:'VocabularyPatch',write:true,parameters:[idparam],extra:{'404':errors['404'],'409':errors['409']},description:'Both text and reading required; expectedRevision must match. 409 leaves server state unchanged; refetch entry/list before resolving conflict. Successful update increments entry revision and set version.'});
op('/v1/vocabulary/{id}','delete','deleteVocabulary','Conditionally delete personal reading',{description:'Deleted from current/future rule set',headers:{...headers,'X-Pronunciation-Version':{schema:version}}},{write:true,status:'204',parameters:[idparam,{...query('expectedRevision',int(1)),required:true}],extra:{'404':errors['404'],'409':errors['409']},description:'Revision is a required query parameter, not a DELETE body. Affects all matching occurrences and future articles. Refetch list after success; missing/not-owned entry gives 404.'});
op('/v1/voices','get','getVoices','Configured Japanese voices',json('Voices'),{description:'Only voices authorized for the current identity with ja-JP, MP3 and alias reading support are returned. Unknown voice is 400; a configured but unauthorized voice is 403 on speech/preview.'});
const audio={description:'Complete MP3, max 8388608 bytes; buffered before headers. No JSON envelope or automatic retry. Browser must consume complete response before playback.',headers:{...headers,'Content-Length':{schema:int(1)},'Content-Disposition':{schema:str({example:'inline; filename="speech.mp3"'})},'X-Pronunciation-Version':{schema:version,description:'Version of the personal snapshot actually used for this response, never a later DB lookup.'}},content:{'audio/mpeg':{schema:str({format:'binary'})}}};
op('/v1/audio/speech','post','synthesizeSpeech','Synthesize Japanese article with personal rules',audio,{input:'Speech',write:true,extra:{'502':errors['502'],'504':errors['504']},description:'Plain text only, must contain non-whitespace; reject U+0000–U+0008, U+000B–U+001F and U+007F–U+009F (tab and LF allowed). Rules are NFC-normalized at save, but article input is never normalized or rewritten. Match saved rules against original input using case-sensitive literal matching, leftmost then longest match, ties by stable createdAt/id rule order, single pass with no recursive replacement. Read one immutable snapshot before the provider call; subsequent writes cannot alter it. At most 10000 Unicode code points AND 49152 UTF-8 bytes, JSON body at most 65536 bytes. Server selects owned rules from authenticated identity; actor/owner/dictionaryIds/SSML/positions are rejected. One immutable personal snapshot per request; no persisted article/audio. Saving while synthesis is in flight does not change its snapshot. Unconfigured TTS returns 503, unknown voice 400. No automatic billable retries.'});
op('/v1/audio/preview','post','previewReading','Preview unsaved word reading',audio,{input:'Preview',write:true,extra:{'502':errors['502'],'504':errors['504']},description:'Synthesize text as a single word using reading as temporary highest-priority alias in the same Gateway pipeline. No persistence/version increment, no article positions. X-Pronunciation-Version describes the base personal snapshot, not a saved draft. May incur provider usage; never automatically called on typing.'});
// API 1.1.0 article planning contract. Runtime implementation follows in F1/F2.
schema.Config.properties.maxArticles = {...int(1),default:100,description:'Maximum saved articles per account. Deployment MAX_ARTICLES defaults to 100; creation and capacity checks are atomic. Deletion releases a slot.'};
schema.Config.required.push('maxArticles');
const articleTitle = str({minLength:1,maxLength:120,description:'Trim before validation/storage; 1–120 Unicode code points. No unique-title constraint.'});
const articleText = str({maxLength:10000,description:'Original text, never trimmed, normalized or rewritten. 0–10000 Unicode code points AND at most 49152 UTF-8 bytes. Empty/whitespace drafts may be saved. Reject U+0000–U+0008, U+000B–U+001F and U+007F–U+009F; tab and LF allowed. Synthesis separately requires non-whitespace.'});
const time = str({format:'date-time'});
const articleSpeed = {type:'number',minimum:0.5,maximum:2,multipleOf:0.01,default:1};
schema.ArticleAudio = obj({
 audioId:uuid,contentRevision:int(1),ruleVersion:version,
 voice:str({minLength:1,description:'Public voice alias actually used; never a credential or private provider configuration.'}),
 speed:articleSpeed,language:str({enum:['ja-JP']}),format:str({enum:['mp3']}),mimeType:str({enum:['audio/mpeg']}),
 byteLength:{...int(1),maximum:8388608},characterCount:{...int(1),maximum:10000},
 filename:str({description:'Safe download filename, also supplied through Content-Disposition.'}),createdAt:time
});
schema.ArticleAudio.description = 'Only the last successfully committed audio is retained. contentRevision and ruleVersion identify the saved text and immutable personal snapshot actually synthesized. An audioId identifies exactly one set of bytes; replacement removes the previous ID. No history endpoint.';
const articleFields = {
 id:uuid,title:articleTitle,
 revision:{...int(1),description:'Starts at 1. Increments exactly once when a successful PATCH changes trimmed title or exact text. No-op PATCH does not increment; generation does not increment. Required precondition for PATCH, DELETE and generation admission.'},
 contentRevision:{...int(1),description:'Starts at 1, increments only when exact saved text changes. Title-only edits and generation do not change it.'},
 createdAt:time,updatedAt:{...time,description:'Time of last actual title/text update, initially createdAt. Generating audio does not reorder the article list.'},
 currentRuleVersion:{...version,description:'Current personal rule-set version at response snapshot; not the historical version used for audio.'},
 audio:{...schema.ArticleAudio,nullable:true},
 audioStale:{type:'boolean',description:'False without audio. Otherwise true if audio.contentRevision differs from current contentRevision or audio.ruleVersion differs from currentRuleVersion. Client also marks stale against unsaved text and selected voice/speed. Title-only edits do not stale audio.'}
};
schema.ArticleSummary = obj(articleFields);
schema.ArticleSummary.description = 'Owned article list projection; excludes body text and audio bytes. No owner field accepted from clients.';
schema.ArticleDetail = obj({...articleFields,text:articleText});
schema.ArticleInput = obj({title:articleTitle,text:articleText});
schema.ArticlePatch = obj({title:articleTitle,text:articleText,expectedRevision:int(1)});
schema.ArticlePage = obj({items:{type:'array',items:ref('ArticleSummary')},total:int(),offset:int(),limit:{...int(1),maximum:100}});
schema.ArticleSynthesis = obj({expectedRevision:int(1),voice:str({minLength:1}),speed:articleSpeed},['expectedRevision','voice']);
schema.ArticleAudioResult = obj({articleId:uuid,revision:int(1),contentRevision:int(1),currentRuleVersion:version,audio:ref('ArticleAudio'),audioStale:{type:'boolean'}});
schema.ArticleAudioResult.description = 'Metadata snapshot from the successful audio commit, not a promise that a concurrent later request cannot replace it. Fetch bytes using this audioId. No binary or base64 in this JSON response.';
const article404 = err('NOT_FOUND: absent/not owned article, absent audio or audioId no longer matches. Same response for ownership failure; no historical audio access.');
const revision409 = err('REVISION_CONFLICT: expectedRevision differs from current article revision; no modification or billable synthesis started. Refetch metadata and let user resolve; keep unsaved client text.');
op('/v1/articles','get','listArticles','List owned saved articles',json('ArticlePage'),{
 parameters:[query('limit',{...int(1),maximum:100,default:20}),query('offset',{...int(),default:0}),query('q',str({maxLength:120,default:''}))],
 description:'Authenticated account only. q is a trimmed, case-insensitive literal title substring (not SQL wildcard syntax), no body search. Stable updatedAt DESC then id DESC. total is filtered count. Count/items/rule version are read in one consistent DB snapshot; separate offset pages may move under concurrent edits, refetch after mutations. No audio bytes or full body in list. No automatic persistence of unsaved browser drafts.'
});
op('/v1/articles','post','createArticle','Create an owned article draft',json('ArticleDetail'),{
 input:'ArticleInput',write:true,status:'201',extra:{'409':err('ARTICLE_LIMIT: per-account maxArticles reached; no article created.')},
 description:'Owner comes only from authenticated session. Atomically enforce maxArticles with concurrent creations (deployment default 100). Initial revision/contentRevision=1, audio=null, audioStale=false. Titles need not be unique. Empty original text allowed; no audio generation. Only latest saved title/text is retained.'
});
op('/v1/articles/{id}','get','getArticle','Read owned article and last audio metadata',json('ArticleDetail'),{
 parameters:[idparam],extra:{'404':article404},description:'One consistent snapshot of article, last successful audio metadata and current personal rule version. Body is exact latest saved text. Audio bytes are fetched separately by audioId; no text/audio history.'
});
op('/v1/articles/{id}','patch','updateArticle','Save latest title and original text conditionally',json('ArticleDetail'),{
 input:'ArticlePatch',write:true,parameters:[idparam],extra:{'404':article404,'409':revision409},
 description:'Both title and text required. Lock/check owner and expectedRevision atomically. Actual title/text changes increment revision and updatedAt once; only changed text increments contentRevision. No-op retains all versions. Preserve last successful audio, which becomes stale after changed text; a title-only edit does not stale it. No history, provider call or automatic regeneration. 409 must not silently overwrite another editor.'
});
op('/v1/articles/{id}','delete','deleteArticle','Delete owned article and its last audio conditionally',{description:'Article and last audio deleted atomically; account capacity released.',headers},{
 write:true,status:'204',parameters:[idparam,{...query('expectedRevision',int(1)),required:true}],extra:{'404':article404,'409':revision409},
 description:'Required expectedRevision query parameter, no DELETE body. Atomic owner/revision check, cascade audio deletion and release article slot. Subsequent reads return404; repeated deletion returns404. In-flight synthesis must recheck existence and cannot recreate deleted rows or their audio. No deletion of personal vocabulary rules.'
});
op('/v1/articles/{id}/audio','post','generateArticleAudio','Generate and atomically retain last successful article audio',json('ArticleAudioResult'),{
 input:'ArticleSynthesis',write:true,parameters:[idparam],extra:{'404':article404,'409':err('REVISION_CONFLICT at admission; ARTICLE_CONTENT_CHANGED if contentRevision changed before commit; AUDIO_SUPERSEDED if a later-started generation already committed successfully. Discarded audio is not returned as a saved success.'),'502':errors['502'],'504':errors['504']},
 description:'F2: synthesize only server-loaded saved original text, never client-supplied input/owner/dictionaryIds/SSML. Client must save first; blank saved text is400 INVALID_REQUEST. Check owner and expectedRevision before any provider call and allocate monotonic per-article generationSeq in a short transaction. Call existing Japanese Gateway outside DB transaction using one immutable personal-rule snapshot. Shared billable rate-limit pool with /v1/audio/speech and /v1/audio/preview, same CSRF/Origin/voice permissions and cancellation; never automatically retry. Buffer complete valid MP3 <=8388608 bytes before commit. Commit transaction locks existing article, rechecks active account/ownership, contentRevision and stored successful generationSeq. Deleted/not-owned returns404. Changed content returns409 ARTICLE_CONTENT_CHANGED, including changed-then-reverted text; title-only edits after admission are allowed. If newer-started generation already succeeded, discard older result with409 AUDIO_SUPERSEDED. If newer generation failed/pending, older success may commit and newer success may replace it later. Replace bytes and metadata atomically, assign fresh audioId; no prior audio row retained. Failure/cancellation/DB failure never clears previous audio; cancellation cannot undo a commit that already happened. Rule changes in flight do not rewrite the actual snapshot: commit the result with actual ruleVersion and audioStale based on current version. Return JSON metadata only after persistence. A successful commit followed by lost HTTP response is recovered through getArticle, never automatic re-synthesis. Article editing revision/updatedAt are unchanged by generation.'
});
op('/v1/articles/{id}/audio','get','getArticleAudio','Read exact current audio bytes by audioId',{
 ...audio,description:'Complete saved MP3 corresponding exactly to required audioId. Max8388608 bytes, no history, no provider call.',
 headers:{...audio.headers,'X-Audio-Id':{schema:uuid},'X-Article-Content-Revision':{schema:int(1)}}
},{parameters:[idparam,{...query('audioId',uuid),required:true}],extra:{'404':article404},
 description:'F2: authenticate owner and match both article ID and required audioId in one consistent read. Return404 NOT_FOUND for another owner, deleted/missing article, no audio or replaced audioId; missing/malformed audioId is400 INVALID_REQUEST. Read bytes/metadata from same row snapshot, so a concurrent replacement after read may finish delivering that already-selected audio consistently. Content-Type audio/mpeg, exact Content-Length, Content-Disposition with metadata filename, X-Audio-Id and X-Article-Content-Revision identify stored bytes; X-Pronunciation-Version is stored actual ruleVersion. Cache-Control no-store. No Range streaming guarantee; client loads complete response as Blob. Frontend may refetch article metadata after404 and retry GET with its new audioId at most once; never auto POST generation. Download stale audio remains allowed.'
});
op('/health/live','get','liveness','Process liveness',json('Health'),{auth:false});
op('/health/ready','get','readiness','Database and runtime readiness',json('Health'),{auth:false,description:'No paid synthesis. DB must be reachable. TTS may be intentionally unconfigured; getVoices is then empty and synthesis returns 503.'});
const api={openapi:'3.0.3',info:{title:'Japanese TTS Workbench API',version:'1.1.0',description:'Same-origin browser API. All schemas reject unknown fields and null unless explicitly nullable (ArticleSummary/ArticleDetail.audio may be null). All responses include X-Request-Id and Cache-Control: no-store. Public host Nginx terminates HTTPS, proxies a single 127.0.0.1 Compose port. Do not trust caller-supplied identity or forwarded headers. Fetch with credentials same-origin. Every mutation uses JSON (except bodyless logout/delete), Origin verification and X-CSRF-Token; registration is opt-in. No local-position override.'},servers:[{url:'/'}],paths,components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'wb_session'},csrfHeader:{type:'apiKey',in:'header',name:'X-CSRF-Token'}},schemas:schema}};
writeFileSync('docs/openapi.yaml',YAML.stringify(api,{lineWidth:110,aliasDuplicateObjects:false}));
