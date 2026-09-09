import {config} from './config.js';
import {accountService,ruleService,speechService} from './services.js';
import {samples,applyRules,escapeHTML as esc,validateRule} from './model.js';
import {createEditor} from './editor.js';
const $=id=>document.getElementById(id);
const state={...samples[0],user:null,voice:'',speed:1,result:null,busy:false,playing:false,paused:false,voices:[],selected:null,pendingSelection:null};
const rules=()=>state.user?.rules||[];
const signature=()=>JSON.stringify([state.text,state.voice,state.speed,state.user?.id,state.user?.version]);
let toastTimer, authMode='login', returnView='workbench', operation=0;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
function error(id,message=''){$(id).textContent=message;$(id).hidden=!message;}
function showDialog(id){if(!$(id).open)$(id).showModal();}
function failure(id,e){error(id,e.message+(e.requestId?` 请求编号：${e.requestId}`:''));if(e.code==='SESSION')expire();}
async function action(button,errorId,fn){const b=$(button);if(b.disabled)return;b.disabled=true;const label=b.textContent;b.textContent='处理中…';error(errorId);try{await fn();}catch(e){failure(errorId,e);}finally{b.disabled=false;b.textContent=label;}}
function stop(){operation++;speechService.stop();state.busy=false;state.playing=false;state.paused=false;renderAudio();}
function expire(){stop();state.user=null;state.result=null;document.querySelectorAll('dialog[open]').forEach(d=>d.close());error('sessionNotice','登录已失效，请重新登录。当前正文仍保留在此页面。');location.hash='login';renderRoute();}
async function refreshUser(){const user=await accountService.current();if(!user){expire();return false;}state.user=user;return true;}
function snapshot(word){const r=rules().find(r=>r.word===word);return {owner:state.user.id,id:r?.id,revision:r?.revision,word};}
function openReading(word){
  state.selected=snapshot(word);const r=rules().find(r=>r.word===word);
  $('selectedWord').value=word;$('readingInput').value=r?.reading||'';
  $('occurrenceCount').textContent=applyRules(state.text,[{word,reading:word}]).matches.length;
  $('existingRuleNotice').textContent=r?`已有读法：${r.reading}。保存后将替换这个词的个人默认读法。`:'';
  $('deleteRuleButton').hidden=!r;$('selectionToolbar').hidden=true;error('saveError');showDialog('readingDialog');$('readingInput').focus();
}
function articleChanged(){state.pendingSelection=null;$('editSelected').disabled=true;$('selectionToolbar').hidden=true;renderRules();renderAudio();}
const editor=createEditor({state,rules,openReading,articleChanged,toast});
function renderRules(){
  const all=rules(),q=$('ruleSearch').value.trim().toLowerCase(),filtered=all.filter(r=>(r.word+r.reading).toLowerCase().includes(q)),matches=applyRules(state.text,all).matches;
  $('navRuleCount').textContent=all.length;$('ruleTotal').textContent=all.length;
  $('rulesCountNote').textContent=`${filtered.length} / ${all.length} 条`;$('rulesEmpty').hidden=!!filtered.length;
  $('rulesEmpty').textContent=q?'没有找到匹配的读法，试试其他词汇。':'还没有个人读法。从正文选一个词，或添加第一条规则。';
  $('rulesTableBody').innerHTML=filtered.map(r=>`<tr><td lang="ja"><strong>${esc(r.word)}</strong></td><td lang="ja">${esc(r.reading)}</td><td><span class="scope-pill">当前及以后文章</span></td><td>${matches.filter(m=>m.rule.id===r.id).length} 处</td><td><div class="table-actions"><button class="text-button" data-action="preview" data-id="${r.id}" ${state.voices.length?'':'disabled title="暂无日文音色"'}>试听</button><button class="text-button" data-action="edit" data-id="${r.id}" aria-label="编辑 ${esc(r.word)}">编辑</button><button class="text-button danger" data-action="delete" data-id="${r.id}" aria-label="删除 ${esc(r.word)}">删除</button></div></td></tr>`).join('');
  $('matchedRules').innerHTML=[...new Set(matches.map(m=>m.rule.id))].map(id=>{const r=all.find(r=>r.id===id);return `<button data-word="${esc(r.word)}" class="reading-chip"><span lang="ja">${esc(r.word)}</span><small lang="ja">${esc(r.reading)}</small></button>`;}).join('');
}
function renderAudio(){
  const r=state.result,stale=r&&r.signature!==signature();
  $('audioEmpty').hidden=!!r;$('audioResult').hidden=!r;$('staleBanner').hidden=!stale;
  $('audioStatus').textContent=state.busy?'正在启动朗读…':stale?'旧结果 · 需重新生成':r?'朗读已就绪':'等待生成';
  $('generateLabel').textContent=state.busy?'正在启动…':stale?'重新生成并朗读':'生成并朗读';
  const count=[...state.text].length;
  $('generateButton').disabled=state.busy||!state.voices.length||!state.text.trim()||count>config.maxText;
  $('inputNotice').textContent=count>config.maxText?`正文超过 ${config.maxText.toLocaleString()} 字符，请缩短后再试。`:!state.text.trim()?'先输入一段日文文章。':'使用本机日文系统音色';
  $('playButton').textContent=state.playing&&!state.paused?'Ⅱ':'▶';$('playButton').setAttribute('aria-label',state.playing&&!state.paused?'暂停':'播放');
  $('playButton').disabled=state.busy||!state.voices.some(v=>v.id===r?.voice);
  $('stopButton').disabled=!state.playing&&!state.busy;
  $('waveform').classList.toggle('playing',state.playing&&!state.paused);
  $('playState').textContent=state.playing?(state.paused?'已暂停':'正在朗读'):'已停止';
  if(r){$('resultInfo').textContent=`${r.count} 字符 · ${r.matches} 处个人读法 · ${r.speed.toFixed(2)}×`;$('resultTime').textContent=r.time;}
  $('previewReading').disabled=!state.voices.length;
  $('downloadButton').disabled=!r?.downloadUrl;
  $('downloadNotice').textContent=r?.downloadUrl?'下载本次生成的音频文件。':'系统朗读不提供音频文件下载。';
}
function renderAll(){
  editor.render();renderRules();renderAudio();
  const u=state.user;if(!u)return;
  $('accountName').textContent=u.name;$('accountSub').textContent='本机账户';$('avatar').textContent=[...u.name][0];
  $('profileName').textContent=u.name;$('profileLogin').textContent=u.login;$('profileAvatar').textContent=[...u.name][0];$('displayName').value=u.name;$('profileRules').textContent=`${u.rules.length} 条`;
}
function renderRoute(){
  let view=location.hash.slice(1)||'workbench';
  if(!['login','register','workbench','rules','account'].includes(view))view='workbench';
  if(!state.user){if(!['login','register'].includes(view)){returnView=view;view='login';}authMode=view==='register'?'register':'login';}
  else if(['login','register'].includes(view))view=returnView;
  const auth=!state.user;
  $('authView').hidden=!auth;document.querySelector('.sidebar').hidden=auth;document.querySelector('.app-shell').hidden=auth;
  document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==`${view}View`);
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);if(b.classList.contains('nav-item'))b.setAttribute('aria-current',b.dataset.view===view?'page':'false');});
  $('selectionToolbar').hidden=true;
  if(auth){
    const register=authMode==='register',closed=register&&!config.registrationOpen;
    $('authTitle').textContent=closed?'账户创建暂未开放':register?'创建你的空间':'欢迎回来';
    $('authLead').textContent=closed?'请联系维护者开通账户。':register?'创建本机账户，保存自己的词汇读法。':'登录本机账户，继续你的朗读。';
    $('authForm').hidden=closed;$('registerNameField').hidden=!register;$('confirmField').hidden=!register;
    $('registerName').required=register;$('confirmPassword').required=register;$('authPassword').autocomplete=register?'new-password':'current-password';
    $('authSubmit').textContent=register?'创建账户':'登录';
    $('authSwitch').innerHTML=register?'<a href="#login">已有账户？返回登录 →</a>':config.registrationOpen?'<a href="#register">还没有账户？创建账户 →</a>':'暂未开放注册，请联系维护者开通账户。';
  }else{$('pageLabel').textContent={workbench:'语音工作台',rules:'个人读法规则',account:'账户与设置'}[view];}
  document.title=`${auth?$('authTitle').textContent:$('pageLabel').textContent} · YOMI`;
}
document.querySelector('.skip-link').onclick=e=>{e.preventDefault();(state.user?$('mainContent'):$('authName')).focus();};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{location.hash=b.dataset.view;});
window.addEventListener('hashchange',()=>{error('authError');renderRoute();window.scrollTo(0,0);});
$('accountButton').onclick=()=>{location.hash='account';};
$('authForm').onsubmit=e=>{e.preventDefault();action('authSubmit','authError',async()=>{
  const login=$('authName').value,password=$('authPassword').value;
  if(authMode==='register'){
    if(password!==$('confirmPassword').value)throw Error('两次输入的密码不一致。');
    await accountService.register(login,password,$('registerName').value);
    $('authPassword').value='';$('confirmPassword').value='';location.hash='login';toast('本机账户已创建，请登录。');return;
  }
  const user=await accountService.login(login,password);if(state.previousOwner&&state.previousOwner!==user.id){state.text='';state.title='新文章';state.result=null;}
  state.user=user;state.previousOwner=user.id;$('authPassword').value='';error('sessionNotice');location.hash=returnView;renderAll();renderRoute();
});};
$('togglePassword').onclick=()=>{const show=$('authPassword').type==='password';$('authPassword').type=show?'text':'password';$('togglePassword').textContent=show?'隐藏':'显示';$('togglePassword').setAttribute('aria-label',show?'隐藏密码':'显示密码');};
$('logoutButton').onclick=async()=>{await accountService.logout();stop();state.user=null;state.result=null;state.text='';state.title='新文章';$('ruleSearch').value='';location.hash='login';renderRoute();toast('已退出登录。');};
$('profileForm').onsubmit=e=>{e.preventDefault();action('profileSave','profileError',async()=>{state.user=await accountService.update($('displayName').value);renderAll();toast('资料已保存。');});};
async function mutate(intent,kind,word,reading){state.user=await ruleService.mutate(intent,kind,word,reading);renderAll();}
$('readingForm').onsubmit=e=>{e.preventDefault();const intent={...state.selected},word=$('selectedWord').value,reading=$('readingInput').value.trim();action('saveRuleButton','saveError',async()=>{await mutate(intent,'save',word,reading);$('readingDialog').close();toast('个人读法已保存，将用于当前及以后的文章。');});};
$('cancelRuleButton').onclick=()=>$('readingDialog').close();
function openRule(id){const r=rules().find(r=>r.id===id);state.modalRule=snapshot(r?.word||'');$('ruleDialogTitle').textContent=r?'编辑个人规则':'添加个人规则';$('modalWord').value=r?.word||'';$('modalReading').value=r?.reading||'';error('modalRuleError');showDialog('ruleDialog');}
$('addRuleButton').onclick=()=>openRule();$('cancelModalRule').onclick=()=>$('ruleDialog').close();$('ruleSearch').oninput=renderRules;
$('modalRuleForm').onsubmit=e=>{e.preventDefault();const intent={...state.modalRule},word=$('modalWord').value,reading=$('modalReading').value.trim();action('modalSave','modalRuleError',async()=>{await mutate(intent,'save',word,reading);$('ruleDialog').close();toast('个人读法已保存。');});};
function confirmDelete(id){const r=rules().find(r=>r.id===id);if(!r)return;state.deleting=snapshot(r.word);$('deleteDescription').textContent=`删除「${r.word} → ${r.reading}」后，当前及以后文章将恢复音色的默认读法。`;error('deleteError');showDialog('confirmDialog');}
$('deleteRuleButton').onclick=()=>confirmDelete(state.selected.id);$('cancelDelete').onclick=()=>$('confirmDialog').close();
$('confirmDelete').onclick=()=>action('confirmDelete','deleteError',async()=>{await mutate({...state.deleting},'delete');$('confirmDialog').close();$('readingDialog').close();toast('个人读法已删除。');});
$('rulesTableBody').onclick=e=>{const b=e.target.closest('[data-action]');if(!b)return;const r=rules().find(r=>r.id===b.dataset.id);if(b.dataset.action==='edit')openRule(r.id);if(b.dataset.action==='delete')confirmDelete(r.id);if(b.dataset.action==='preview')preview(applyRules(r.word,rules()).output);};
$('matchedRules').onclick=e=>{const b=e.target.closest('[data-word]');if(b)openReading(b.dataset.word);};
async function loadVoices(){
  $('retryVoices').disabled=true;$('voiceNotice').textContent='正在查找日文音色…';
  try{state.voices=await speechService.voices();if(!state.voices.some(v=>v.id===state.voice))state.voice=state.voices[0]?.id||'';
    $('voiceSelect').innerHTML=state.voices.length?state.voices.map(v=>`<option value="${esc(v.id)}">${esc(v.name)}</option>`).join(''):'<option value="">暂无可用日文音色</option>';
    $('voiceSelect').value=state.voice;$('voiceSelect').disabled=!state.voices.length;
    $('voiceNotice').textContent=state.voices.length?'使用设备上的日文系统音色。':'未找到本机日文音色。安装系统日文语音后刷新，或使用支持日文朗读的浏览器。';
  }catch(e){state.voices=[];$('voiceSelect').disabled=true;$('voiceSelect').innerHTML='<option value="">音色加载失败</option>';error('voiceNotice','音色加载失败，请刷新重试。');}finally{$('retryVoices').disabled=false;renderRules();renderAudio();}
}
$('retryVoices').onclick=loadVoices;globalThis.speechSynthesis?.addEventListener('voiceschanged',loadVoices);
$('voiceSelect').onchange=e=>{state.voice=e.target.value;renderAudio();};$('speedRange').oninput=e=>{state.speed=Number(e.target.value);$('speedValue').textContent=`${state.speed.toFixed(2)}×`;renderAudio();};
async function speakResult(result){
  if(!await refreshUser())return;
  stop();const token=++operation;state.busy=true;error('generationError');renderAudio();
  try{speechService.start(result,{onStart:media=>{if(token!==operation)return;state.result={...result,...media};state.busy=false;state.playing=true;renderAudio();},onEnd:()=>{if(token!==operation)return;state.busy=false;state.playing=false;state.paused=false;renderAudio();},onError:e=>{if(token!==operation)return;state.busy=false;state.playing=false;error('generationError',e.message);renderAudio();}});}catch(e){state.busy=false;error('generationError',e.message);renderAudio();}
}
$('generateButton').onclick=async()=>{if(state.busy)return;try{if(!await refreshUser())return;renderAll();const applied=applyRules(state.text,rules());await speakResult({signature:signature(),text:applied.output,voice:state.voice,speed:state.speed,count:[...state.text].length,matches:applied.matches.length,time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})});}catch(e){failure('generationError',e);}};
$('playButton').onclick=()=>{if(state.playing){state.paused=!state.paused;state.paused?speechService.pause():speechService.resume();renderAudio();}else if(state.result)speakResult(state.result).catch(e=>failure('generationError',e));};$('stopButton').onclick=stop;
async function preview(text){try{if(!await refreshUser())return;stop();const token=++operation;speechService.start({text,voice:state.voice,speed:state.speed},{onStart:()=>toast('正在试听读法。'),onEnd:()=>{if(token===operation)toast('试听结束。');},onError:e=>toast(e.message)});}catch(e){toast(e.message);}}
$('previewReading').onclick=()=>{try{validateRule($('selectedWord').value,$('readingInput').value);preview($('readingInput').value);}catch(e){error('saveError',e.message);}};
$('downloadButton').onclick=()=>{if(!state.result?.downloadUrl)return;const a=document.createElement('a');a.href=state.result.downloadUrl;a.download='yomi-audio.mp3';a.click();};
$('copyButton').onclick=async()=>{try{await navigator.clipboard.writeText(state.text);toast('原文已复制。');}catch{editor.select(0,state.text.length);toast('已选中原文，请按 Ctrl+C 复制。');}};
function fillSample(i){$('newArticleTitle').value=samples[i].title;$('newArticleText').value=samples[i].text;}
$('newArticleButton').onclick=()=>{$('newArticleTitle').value='';$('newArticleText').value='';showDialog('articleDialog');};
$('loadSampleOne').onclick=()=>fillSample(0);$('loadSampleTwo').onclick=()=>fillSample(1);$('loadBlank').onclick=()=>{$('newArticleTitle').value='';$('newArticleText').value='';};
$('cancelArticle').onclick=()=>$('articleDialog').close();$('applyArticle').onclick=()=>{state.title=$('newArticleTitle').value.trim()||'新文章';state.text=$('newArticleText').value;articleChanged();renderAll();$('articleDialog').close();$('articleEditor').focus();};
$('guideButton').onclick=()=>showDialog('guideDialog');
document.addEventListener('pointerdown',e=>{if(!$('articleEditor').contains(e.target)&&!$('selectionToolbar').contains(e.target))$('selectionToolbar').hidden=true;});
window.addEventListener('scroll',()=>{if(document.activeElement===$('articleEditor'))requestAnimationFrame(editor.capture);else $('selectionToolbar').hidden=true;},{passive:true,capture:true});
document.querySelectorAll('dialog').forEach(d=>{if(!d.hasAttribute('aria-label')&&!d.hasAttribute('aria-labelledby')){const h=d.querySelector('h2');if(h){h.id||=`${d.id}Title`;d.setAttribute('aria-labelledby',h.id);}}d.addEventListener('close',()=>{$('selectionToolbar').hidden=true;});});
window.addEventListener('storage',async e=>{if(e.key!=='yomi-web-v1'||!state.user)return;try{if(await refreshUser())renderAll();}catch(e){toast(e.message);}});
window.addEventListener('focus',async()=>{if(state.user)try{const previous=JSON.stringify(state.user);if(await refreshUser()&&previous!==JSON.stringify(state.user))renderAll();}catch(e){toast(e.message);}});
setInterval(async()=>{if(state.user)try{if(!await accountService.current())expire();}catch{}},15000);
$('waveform').innerHTML=Array.from({length:45},(_,i)=>`<i style="height:${12+(i*17%32)}px"></i>`).join('');
try{state.user=await accountService.current();state.previousOwner=state.user?.id;}catch(e){error('sessionNotice',e.message);}
renderAll();renderRoute();loadVoices();
