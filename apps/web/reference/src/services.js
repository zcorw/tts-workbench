import {config} from './config.js';
import {validateRule} from './model.js';
const KEY='yomi-web-v1', SESSION='yomi-session-v1';
const read=()=>{try {const raw=localStorage.getItem(KEY);const db=raw?JSON.parse(raw):{accounts:[]};if(!Array.isArray(db.accounts))throw Error();return db;}catch{throw Error('无法读取本机数据，请检查浏览器存储权限。');}};
const write=db=>{try{localStorage.setItem(KEY,JSON.stringify(db));}catch{throw Error('未能保存，请检查浏览器存储权限或可用空间后重试。');}};
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function hash(password,salt){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:120000,hash:'SHA-256'},key,256));}
const safe=a=>a?{id:a.id,name:a.name,login:a.login,rules:structuredClone(a.rules),version:a.version}:null;
function session(){try{return JSON.parse(sessionStorage.getItem(SESSION));}catch{return null;}}
function current(){const s=session();return s&&s.until>Date.now()?read().accounts.find(a=>a.id===s.id):null;}
function required(){const a=current();if(!a)throw Object.assign(Error('登录已失效，请重新登录后继续。'),{code:'SESSION'});return a;}
function exclusive(fn){return navigator.locks?navigator.locks.request(KEY,fn):Promise.resolve().then(fn);}
export const accountService={
  async current(){return safe(current());},
  async login(login,password){const normalized=login.trim().toLowerCase();const a=read().accounts.find(a=>a.login===normalized);const digest=await hash(password,a?.salt||'not-an-account');if(!a||digest!==a.hash)throw Error('账户名称或密码不正确。');sessionStorage.setItem(SESSION,JSON.stringify({id:a.id,until:Date.now()+config.sessionMs}));return safe(a);},
  async register(login,password,name){
    if(!config.registrationOpen)throw Error('暂未开放创建账户，请联系维护者开通。');
    login=login.trim().toLowerCase();name=name.trim();
    if(login.length<2||login.length>40||!name||name.length>40||password.length<8||password.length>128)throw Error('请填写有效的账户名称、显示名称及至少 8 位密码。');
    const salt=hex(crypto.getRandomValues(new Uint8Array(16))),digest=await hash(password,salt);
    return exclusive(()=>{const db=read();if(db.accounts.some(a=>a.login===login))throw Error('该账户名称不可用，请换一个名称。');const a={id:crypto.randomUUID(),login,name,salt,hash:digest,rules:[],version:0};db.accounts.push(a);write(db);return safe(a);});
  },
  async update(name){return exclusive(()=>{const a=required();if(!name.trim()||name.trim().length>40)throw Error('显示名称须为 1 至 40 个字符。');const db=read();const target=db.accounts.find(x=>x.id===a.id);target.name=name.trim();write(db);return safe(target);});},
  async logout(){sessionStorage.removeItem(SESSION);}
};
export const ruleService={
  async mutate(intent,kind,word='',reading=''){
    if(kind==='save')validateRule(word,reading);
    return exclusive(()=>{const a=required();if(a.id!==intent.owner)throw Object.assign(Error('账户已切换，请重新操作。'),{code:'SESSION'});
      const db=read(),target=db.accounts.find(x=>x.id===a.id),existing=target.rules.find(r=>r.id===intent.id);
      if(intent.id&&(!existing||existing.revision!==intent.revision))throw Error('规则已在另一窗口更新。本次未保存，请关闭后重新打开规则。');
      if(kind==='save'){
        if(target.rules.some(r=>r.word===word&&r.id!==intent.id))throw Error('此词已有个人读法，请编辑现有规则。');
        if(!existing&&target.rules.length>=500)throw Error('最多可保存 500 条个人读法。');
        if(existing)Object.assign(existing,{word,reading,revision:existing.revision+1});
        else target.rules.push({id:crypto.randomUUID(),word,reading,revision:1});
      }else target.rules=target.rules.filter(r=>r.id!==intent.id);
      target.version++;write(db);return safe(target);
    });
  }
};
// Replace this adapter with an HTTP/Blob implementation when the host API is ready.
// System speech cannot produce downloadable bytes. Success is reported only on onstart.
export const speechService={
  async voices(){return (globalThis.speechSynthesis?.getVoices()||[]).filter(v=>/^ja(?:[-_]|$)/i.test(v.lang)&&v.localService).map(v=>({id:v.voiceURI,name:v.name}));},
  start(snapshot,{onStart,onEnd,onError}){
    const voice=globalThis.speechSynthesis?.getVoices().find(v=>v.voiceURI===snapshot.voice&&v.localService&&/^ja(?:[-_]|$)/i.test(v.lang));
    if(!voice)throw Error('日文音色不可用，请刷新音色后重试。');
    speechService.stop();const u=new SpeechSynthesisUtterance(snapshot.text);u.voice=voice;u.lang='ja-JP';u.rate=snapshot.speed;
    let started=false;const timer=setTimeout(()=>{speechService.stop();onError(Error('朗读未能启动，请检查系统音色后重试。'));},15000);
    u.onstart=()=>{started=true;clearTimeout(timer);onStart({kind:'system',downloadUrl:null});};
    u.onend=()=>{clearTimeout(timer);onEnd();};
    u.onerror=e=>{clearTimeout(timer);if(!['canceled','interrupted'].includes(e.error))onError(Error('朗读失败，请检查音色后重试。'));else if(!started)onEnd();};
    this.utterance=u;this.timer=timer;speechSynthesis.speak(u);
  },
  stop(){clearTimeout(this.timer);if(this.utterance){this.utterance.onstart=null;this.utterance.onend=null;this.utterance.onerror=null;}globalThis.speechSynthesis?.cancel();},
  pause(){globalThis.speechSynthesis?.pause();},resume(){globalThis.speechSynthesis?.resume();}
};
