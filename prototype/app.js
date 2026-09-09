'use strict';

// Standalone interaction prototype. No account service or Gateway requests.
const $ = id => document.getElementById(id);
const STORAGE_KEY = 'yomi-prototype-v1';
const samples = [
  { title: '京都、朝の散歩', text: '朝の京都は、まだ静けさに包まれている。\n鴨川のほとりを歩くと、水面に柔らかな光が揺れていた。橋の向こうから、焼きたてのパンの香りがする。\n\n小さな喫茶店でコーヒーを注文し、窓の外を眺める。何気ない風景の中に、旅の楽しさが隠れている。もう少しだけ、京都の朝を歩いてみよう。\n\n次の旅では、東京の日本橋を訪ねたい。\n古い建物と新しい街並みが出会う日本橋で、また違った朝の景色を見つけられるだろう。' },
  { title: '旅の記憶', text: '日本橋に着いたのは、よく晴れた日曜日だった。\n橋を渡りながら、以前訪れた京都のことを思い出す。\n\n鴨川で聞いた水の音と、日本橋で感じた街のにぎわい。違う場所で過ごした時間が、一冊のノートの中でつながっていく。\n\nまた旅に出よう。まだ知らない景色と、新しい言葉に出会うために。' }
];
function seed() {
  return { schema: 1, current: 'demo-lin', accounts: [
    { id: 'demo-lin', name: '林', version: 1, rules: [
      { id: 'kyoto', word: '京都', reading: 'きょうと', revision: 1 },
      { id: 'kamo', word: '鴨川', reading: 'かもがわ', revision: 1 }
    ] }, { id: 'demo-sato', name: '佐藤', version: 0, rules: [] }
  ] };
}
function readStored() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (data.schema !== 1 || !Array.isArray(data.accounts)) throw new Error('本地演示数据无法读取。');
  return data;
}
let db;
let storageNotice = '';
try { db = readStored() || seed(); localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
catch { db = seed(); storageNotice = '浏览器本地存储不可用，规则保存可能失败；请允许此站点使用本地存储。'; }
const state = {
  title: samples[0].title, text: samples[0].text, voice: 'calm', speed: 1,
  result: null, busy: false, selected: null, modalRule: null, deleting: null,
  pendingSelection: null, authMode: 'login', playing: false, paused: false, dirty: false
};
const account = () => db.accounts.find(a => a.id === db.current);
const rules = () => account()?.rules || [];
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => globalThis.crypto?.randomUUID?.() || `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const signature = () => JSON.stringify([state.text, state.voice, state.speed, db.current, account()?.version || 0]);
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
function error(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
function consumeScenario(name) { if ($('scenarioSelect').value !== name) return false; $('scenarioSelect').value = 'normal'; return true; }

// Literal, leftmost-longest, single-pass matching. The original string is never replaced.
function applyRules(text, entries = rules()) {
  const ordered = entries.filter(r => r.word).slice().sort((a, b) => b.word.length - a.word.length);
  const matches = [];
  let output = '', cursor = 0;
  while (cursor < text.length) {
    const rule = ordered.find(r => text.startsWith(r.word, cursor));
    if (rule) { matches.push({ start: cursor, end: cursor + rule.word.length, rule }); output += rule.reading; cursor += rule.word.length; }
    else { output += text[cursor]; cursor++; }
  }
  return { matches, output };
}
function literalCount(word) { return word ? state.text.split(word).length - 1 : 0; }
function renderEditor() {
  const { matches } = applyRules(state.text);
  let html = '', cursor = 0;
  for (const m of matches) {
    html += escapeHTML(state.text.slice(cursor, m.start));
    html += `<mark data-rule-id="${escapeHTML(m.rule.id)}" title="个人读法：${escapeHTML(m.rule.reading)}；点击编辑">${escapeHTML(state.text.slice(m.start, m.end))}</mark>`;
    cursor = m.end;
  }
  // A terminal BR makes the empty last line a real caret destination in Chromium.
  $('articleEditor').innerHTML = html + escapeHTML(state.text.slice(cursor)) + (state.text.endsWith('\n') ? '<br data-editor-tail="true">' : '');
  $('articleTitle').textContent = state.title;
  $('characterCount').textContent = `${Array.from(state.text).length} 字符`;
  $('matchSummary').textContent = `${matches.length} 处命中 · ${new Set(matches.map(m => m.rule.id)).size} 条规则`;
}
function selectionOffsets() {
  const selection = window.getSelection(), root = $('articleEditor');
  if (!selection.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0), prefix = range.cloneRange();
  prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
  return { start: prefix.toString().length, end: prefix.toString().length + range.toString().length };
}
function selectOffsets(start, end = start) {
  const root = $('articleEditor'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const points = []; let node, count = 0;
  while ((node = walker.nextNode())) { points.push({ node, start: count, end: count + node.length }); count += node.length; }
  if (!points.length) { root.focus(); return; }
  const point = offset => { const p = points.find(p => offset <= p.end) || points.at(-1); return [p.node, Math.max(0, Math.min(offset - p.start, p.node.length))]; };
  const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end));
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}
function captureSelection() {
  const offsets = selectionOffsets();
  if (!offsets || offsets.start === offsets.end) { $('selectionToolbar').hidden = true; return; }
  const word = state.text.slice(offsets.start, offsets.end);
  if (!word.trim() || /[\r\n]/.test(word) || Array.from(word).length > 100) { $('selectionToolbar').hidden = true; return; }
  state.pendingSelection = { ...offsets, word, source: state.text };
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  $('selectionPreview').textContent = word.length > 10 ? `${word.slice(0, 10)}…` : word;
  $('selectionToolbar').hidden = false;
  $('selectionToolbar').style.left = `${Math.max(12, Math.min(window.innerWidth - $('selectionToolbar').offsetWidth - 12, rect.left))}px`;
  $('selectionToolbar').style.top = `${Math.max(12, Math.min(window.innerHeight - 60, rect.bottom + 9))}px`;
}
function snapshotRule(word) {
  const existing = rules().find(r => r.word === word);
  return { id: existing?.id || null, revision: existing?.revision || 0, word, accountId: db.current };
}
function openReading(word) {
  if (!requireAccount()) return;
  state.selected = snapshotRule(word);
  const existing = rules().find(r => r.word === word);
  $('selectedWord').value = word; $('readingInput').value = existing?.reading || '';
  $('occurrenceCount').textContent = literalCount(word);
  $('existingRuleNotice').textContent = existing ? `已有读法「${existing.reading}」。保存将更新这条个人规则，影响当前及以后文章。` : '保存成功后，正文中的同词会显示个人读法标记。';
  $('deleteRuleButton').hidden = !existing;
  $('wordMode').textContent = existing ? '编辑已有个人规则' : '来自正文选区';
  $('selectionEmpty').hidden = true; $('readingForm').hidden = false;
  $('selectionToolbar').hidden = true; error('saveError');
  if (window.innerWidth <= 950) $('pronunciationCard').scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('readingInput').focus({ preventScroll: true });
}
function closeReading() { state.selected = null; $('selectionEmpty').hidden = false; $('readingForm').hidden = true; error('saveError'); }
function articleChanged() {
  state.dirty = true; $('selectionToolbar').hidden = true; closeReading(); renderRules(); renderAudio();
}
let composing = false;
function commitEditorInput() {
  if (composing) return;
  const root = $('articleEditor'), selection = getSelection();
  let offsets = null;
  // Native editing can produce BR/DIV nodes. Boundary tokens let innerText
  // preserve those line breaks without losing the caret's logical position.
  if (selection.rangeCount && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
    const range = selection.getRangeAt(0), begin = range.cloneRange(), finish = range.cloneRange();
    const token = uid(), left = document.createTextNode(`\uE000${token}S\uE001`), right = document.createTextNode(`\uE000${token}E\uE001`);
    finish.collapse(false); finish.insertNode(right); begin.collapse(true); begin.insertNode(left);
    root.querySelector('[data-editor-tail]')?.remove();
    const tagged = root.innerText;
    offsets = { start: tagged.indexOf(left.data), end: tagged.indexOf(right.data) - left.length };
    state.text = tagged.replace(left.data, '').replace(right.data, '').replace(/\r\n/g, '\n');
    left.remove(); right.remove();
  } else state.text = root.innerText.replace(/\r\n/g, '\n');
  renderEditor(); if (offsets) selectOffsets(offsets.start, offsets.end);
  articleChanged();
}
function insertPlainText(text) {
  const offsets = selectionOffsets(); if (!offsets) return;
  state.text = state.text.slice(0, offsets.start) + text + state.text.slice(offsets.end);
  renderEditor(); selectOffsets(offsets.start + text.length); articleChanged();
}
$('articleEditor').addEventListener('input', commitEditorInput);
$('articleEditor').addEventListener('compositionstart', () => composing = true);
$('articleEditor').addEventListener('compositionend', () => { composing = false; commitEditorInput(); });
$('articleEditor').addEventListener('beforeinput', e => {
  if (['insertParagraph', 'insertLineBreak'].includes(e.inputType)) { e.preventDefault(); insertPlainText('\n'); }
});
$('articleEditor').addEventListener('paste', e => { e.preventDefault(); insertPlainText(e.clipboardData.getData('text/plain').replace(/\r\n/g, '\n')); });
$('articleEditor').addEventListener('mouseup', captureSelection);
$('articleEditor').addEventListener('keyup', captureSelection);
$('articleEditor').addEventListener('click', e => {
  const mark = e.target.closest('mark');
  if (mark && window.getSelection().isCollapsed) { const rule = rules().find(r => r.id === mark.dataset.ruleId); if (rule) openReading(rule.word); }
});
$('selectionToolbar').addEventListener('mousedown', e => e.preventDefault());
$('editSelectionButton').onclick = () => { if (state.pendingSelection?.source === state.text) openReading(state.pendingSelection.word); else toast('正文已变化，请重新选择词汇。'); };
$('exampleSelect').onclick = () => {
  const word = state.text.includes('日本橋') ? '日本橋' : rules().find(r => state.text.includes(r.word))?.word;
  if (!word) { toast('请在正文中拖选要修改读法的词汇。'); $('articleEditor').focus(); return; }
  selectOffsets(state.text.indexOf(word), state.text.indexOf(word) + word.length); openReading(word);
};
$('cancelRuleButton').onclick = closeReading;
document.addEventListener('mousedown', e => { if (!$('selectionToolbar').contains(e.target) && !$('articleEditor').contains(e.target)) $('selectionToolbar').hidden = true; });
window.addEventListener('scroll', () => $('selectionToolbar').hidden = true, { passive: true });

function validateRule(word, reading) {
  if (!word.trim() || !reading.trim()) throw new Error('词汇和读法都不能为空。');
  if (Array.from(word).length > 100 || Array.from(reading).length > 100) throw new Error('词汇和读法各限 100 个字符（原型建议上限）。');
  if (/[<>\u0000-\u001f\u007f]/u.test(word + reading)) throw new Error('请使用单行纯文本，不含控制字符或 XML 标记。');
}
async function mutateRules(intent, kind, word = '', reading = '') {
  if (!intent || intent.accountId !== db.current || !account()) throw new Error('登录状态已改变，请重新登录后操作。');
  if (kind === 'save') validateRule(word, reading);
  const fail = consumeScenario('save-error');
  await delay(550);
  if (fail) throw new Error(`演示：${kind === 'save' ? '保存' : '删除'}失败，原规则未改变。请重试。`);
  if (intent.accountId !== db.current || !account()) throw new Error('登录已过期，本次操作未保存。请重新登录。');
  let latest;
  try { latest = readStored() || structuredClone(db); } catch { throw new Error('无法读取本地演示数据，规则未修改。'); }
  const target = latest.accounts.find(a => a.id === intent.accountId);
  if (!target) throw new Error('账户数据已变化，请刷新页面后重试。');
  const current = target.rules.find(r => r.id === intent.id);
  if ((intent.id && (!current || current.revision !== intent.revision)) || (!intent.id && target.rules.some(r => r.word === word))) {
    db = latest; renderAll(); throw new Error('规则已在其他窗口变更。本次未保存；请重新打开规则，核对最新读法后修改。');
  }
  if (kind === 'save') {
    if (target.rules.some(r => r.word === word && r.id !== intent.id)) throw new Error('此词已有个人规则，请编辑已有规则，避免覆盖。');
    if (!current && target.rules.length >= 500) throw new Error('原型建议每个账户最多保存 500 条规则。');
    if (current) Object.assign(current, { word, reading, revision: current.revision + 1 });
    else target.rules.push({ id: uid(), word, reading, revision: 1 });
  } else target.rules = target.rules.filter(r => r.id !== intent.id);
  target.version++;
  latest.current = db.current;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(latest)); } catch { throw new Error('本地存储写入失败，规则未保存。请检查浏览器存储权限或空间后重试。'); }
  db = latest; renderAll();
}
$('readingForm').onsubmit = async e => {
  e.preventDefault(); if ($('saveRuleButton').disabled) return;
  const intent = state.selected && { ...state.selected }, word = $('selectedWord').value, reading = $('readingInput').value.trim();
  error('saveError'); $('saveRuleButton').disabled = true; $('saveRuleButton').textContent = '正在保存…';
  try { await mutateRules(intent, 'save', word, reading); openReading(word); toast('已保存个人规则，当前及以后的文章都会使用。'); }
  catch (err) { error('saveError', err.message); }
  finally { $('saveRuleButton').disabled = false; $('saveRuleButton').textContent = '保存个人规则'; }
};

function renderRules() {
  const query = $('ruleSearch').value.trim().toLowerCase(), all = rules();
  const visible = all.filter(r => (r.word + r.reading).toLowerCase().includes(query));
  const matches = applyRules(state.text).matches;
  $('ruleTotal').textContent = all.length; $('navRuleCount').textContent = all.length;
  $('rulesCountNote').textContent = `${visible.length} / ${all.length} 条 · ${account() ? `个人规则 v${account().version}` : '请先登录'}`;
  $('rulesEmpty').hidden = visible.length !== 0;
  $('rulesTableBody').innerHTML = visible.map(r => `<tr><td lang="ja"><strong>${escapeHTML(r.word)}</strong></td><td lang="ja">${escapeHTML(r.reading)}</td><td><span class="scope-pill">个人 · 跨文章</span></td><td>${matches.filter(m => m.rule.id === r.id).length} 处</td><td><div class="table-actions"><button class="text-button" data-rule-action="preview" data-id="${escapeHTML(r.id)}">试听</button><button class="text-button" data-rule-action="edit" data-id="${escapeHTML(r.id)}">编辑</button><button class="text-button danger" data-rule-action="delete" data-id="${escapeHTML(r.id)}">删除</button></div></td></tr>`).join('');
}
function openRuleModal(id) {
  if (!requireAccount()) return;
  const entry = rules().find(r => r.id === id);
  state.modalRule = snapshotRule(entry?.word || '');
  $('ruleDialogTitle').textContent = entry ? '编辑个人规则' : '添加个人规则';
  $('modalWord').value = entry?.word || ''; $('modalReading').value = entry?.reading || '';
  error('modalRuleError'); $('ruleDialog').showModal();
}
$('addRuleButton').onclick = () => openRuleModal();
$('cancelModalRule').onclick = () => $('ruleDialog').close();
$('ruleSearch').oninput = renderRules;
$('modalRuleForm').onsubmit = async e => {
  e.preventDefault(); if ($('modalSave').disabled) return;
  const intent = { ...state.modalRule }, word = $('modalWord').value, reading = $('modalReading').value.trim();
  $('modalSave').disabled = true; $('modalSave').textContent = '正在保存…'; error('modalRuleError');
  try { await mutateRules(intent, 'save', word, reading); $('ruleDialog').close(); closeReading(); toast('个人规则已保存，后续合成会使用新的读法。'); }
  catch (err) { error('modalRuleError', err.message); }
  finally { $('modalSave').disabled = false; $('modalSave').textContent = '保存个人规则'; }
};
function confirmDelete(id) {
  const entry = rules().find(r => r.id === id); if (!entry) return;
  state.deleting = snapshotRule(entry.word);
  $('deleteDescription').textContent = `删除「${entry.word} → ${entry.reading}」后，当前文章及以后文章将不再应用这条指定读法。`;
  error('deleteError'); $('confirmDialog').showModal();
}
$('deleteRuleButton').onclick = () => confirmDelete(state.selected?.id);
$('cancelDelete').onclick = () => $('confirmDialog').close();
$('confirmDelete').onclick = async () => {
  if ($('confirmDelete').disabled) return;
  $('confirmDelete').disabled = true; error('deleteError');
  try { await mutateRules({ ...state.deleting }, 'delete'); $('confirmDialog').close(); closeReading(); toast('已删除个人规则。原文保留，后续合成不再使用此读法。'); }
  catch (err) { error('deleteError', err.message); }
  finally { $('confirmDelete').disabled = false; }
};
$('rulesTableBody').onclick = e => {
  const button = e.target.closest('[data-rule-action]'); if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.ruleAction === 'edit') openRuleModal(id);
  if (button.dataset.ruleAction === 'delete') confirmDelete(id);
  if (button.dataset.ruleAction === 'preview') { const rule = rules().find(r => r.id === id); if (rule) speak(applyRules(rule.word).output, state.speed, false); }
};

function renderAudio() {
  const result = state.result, stale = result && result.signature !== signature();
  $('audioEmpty').hidden = !!result; $('audioResult').hidden = !result;
  $('staleBanner').hidden = !stale;
  $('audioStatus').textContent = state.busy ? '正在生成演示…' : !result ? '等待生成' : stale ? '旧结果 · 需重新生成' : '演示结果就绪';
  $('audioStatus').style.background = stale ? '#f8e9e1' : '';
  $('audioStatus').style.color = stale ? '#a34b35' : '';
  $('generateLabel').textContent = state.busy ? '生成演示结果中…' : stale ? '重新生成语音演示' : '生成语音演示';
  $('generateButton').disabled = state.busy;
  if (result) {
    $('appliedText').textContent = result.appliedText;
    $('resultInfo').textContent = `${Array.from(result.originalText).length} 字符 · ${result.matches.length} 处读法 · 规则 v${result.rulesVersion}`;
    $('resultTime').textContent = `提交于 ${result.time}`;
  }
}
function stopSpeech() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  state.playing = false; state.paused = false; $('playButton').textContent = '▶'; $('waveform').classList.remove('playing');
  $('playState').textContent = '浏览器试听 · 非 Gateway 音频';
}
function availableVoices() { return 'speechSynthesis' in window ? speechSynthesis.getVoices().filter(v => /^ja(?:[-_]|$)/i.test(v.lang) && v.localService) : []; }
function voiceNotice() {
  const voices = availableVoices();
  $('voiceNotice').textContent = voices.length ? `试听使用本机日文系统音色「${voices[0].name}」。概念音色不代表供应商音色。` : '此浏览器没有可用的本地日文音色。仍可检查读法文本；实际音频需接入日文 Gateway。';
  return voices;
}
function speak(text, rate, isResult) {
  const voices = voiceNotice();
  if (!voices.length) { toast('未发现本地日文音色；可展开“读法文本”核对应用结果。'); return; }
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP'; utterance.voice = voices[(isResult ? state.result.voice : state.voice) === 'bright' && voices.length > 1 ? 1 : 0]; utterance.rate = rate;
  utterance.onstart = () => { state.playing = true; if (isResult) { $('playButton').textContent = 'Ⅱ'; $('waveform').classList.add('playing'); $('playState').textContent = '正在使用本地日文音色试听'; } else toast('正在试听此词的个人读法。'); };
  utterance.onend = () => stopSpeech();
  utterance.onerror = e => { if (!['interrupted', 'canceled'].includes(e.error)) toast('浏览器试听失败，可检查读法文本或再次主动试听。'); state.playing = false; $('waveform').classList.remove('playing'); $('playButton').textContent = '▶'; };
  state.utterance = utterance; speechSynthesis.speak(utterance);
}
$('playButton').onclick = () => {
  if (!state.result) return;
  if (state.playing && state.utterance?.text === state.result.appliedText) {
    if (state.paused) { speechSynthesis.resume(); state.paused = false; $('playButton').textContent = 'Ⅱ'; $('waveform').classList.add('playing'); $('playState').textContent = '正在使用本地日文音色试听'; }
    else { speechSynthesis.pause(); state.paused = true; $('playButton').textContent = '▶'; $('waveform').classList.remove('playing'); $('playState').textContent = '已暂停浏览器试听'; }
  } else speak(state.result.appliedText, state.result.speed, true);
};
$('generateButton').onclick = async () => {
  if (state.busy || !requireAccount()) return;
  error('generationError');
  if (!state.text.trim()) { error('generationError', '请先输入一段日文正文。'); $('articleEditor').focus(); return; }
  if (Array.from(state.text).length > 10000) { error('generationError', '原型演示最多支持 10,000 个字符，请缩短正文。真实限制以日文音色能力为准。'); return; }
  const applied = applyRules(state.text), owner = db.current;
  const result = { signature: signature(), title: state.title, originalText: state.text, appliedText: applied.output, matches: applied.matches.map(m => ({ word: m.rule.word, reading: m.rule.reading, start: m.start, end: m.end })), voice: state.voice, speed: state.speed, language: 'ja-JP', rulesVersion: account().version, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), requestId: `demo-${uid().slice(0, 8)}`, prototypeOnly: true };
  const fail = consumeScenario('generate-error'); state.busy = true; renderAudio();
  await delay(1000);
  state.busy = false;
  if (owner !== db.current) { error('generationError', '登录状态已变化，演示结果未载入。重新登录后请主动生成。'); renderAudio(); return; }
  if (fail) { error('generationError', `演示合成失败，保留输入与旧结果。请主动重试。请求 ID：${result.requestId}`); renderAudio(); return; }
  stopSpeech(); state.result = result; renderAudio(); voiceNotice();
  toast(result.signature === signature() ? '演示结果已生成，可检查读法或尝试本地日文试听。' : '演示结果已返回；提交后内容有变化，此结果已标为旧结果。');
};
$('voiceSelect').onchange = e => { state.voice = e.target.value; renderAudio(); };
$('speedRange').oninput = e => { state.speed = Number(e.target.value); $('speedValue').textContent = `${state.speed.toFixed(2)}×`; renderAudio(); };
$('downloadButton').onclick = () => {
  if (!state.result) return;
  const { signature: unused, ...result } = state.result;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ notice: 'HTML 原型的读法应用说明，不是音频文件。', ...result }, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'yomi-synthesis-demo.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('copyButton').onclick = async () => {
  try { await navigator.clipboard.writeText(state.text); toast('已复制原文，个人读法不会改写文字。'); }
  catch { selectOffsets(0, state.text.length); toast('浏览器不允许自动复制。已选中原文，请按 Ctrl+C。'); }
};

function switchView(view) {
  if (!['workbench', 'rules', 'requirements'].includes(view)) view = 'workbench';
  for (const name of ['workbench', 'rules', 'requirements']) $(`${name}View`).hidden = name !== view;
  document.querySelectorAll('.nav-item').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'); });
  $('pageLabel').textContent = { workbench: '语音工作台', rules: '个人读法规则', requirements: '产品需求说明' }[view];
  $('selectionToolbar').hidden = true; history.replaceState(null, '', `#${view}`); window.scrollTo({ top: 0 });
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => switchView(b.dataset.view));
document.querySelector('.brand').onclick = e => { e.preventDefault(); switchView('workbench'); };
window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
function fillSample(index) { $('newArticleTitle').value = samples[index].title; $('newArticleText').value = samples[index].text; }
$('newArticleButton').onclick = () => { fillSample(1); $('articleDialog').showModal(); };
$('loadSampleOne').onclick = () => fillSample(0); $('loadSampleTwo').onclick = () => fillSample(1);
$('loadBlank').onclick = () => { $('newArticleTitle').value = ''; $('newArticleText').value = ''; $('newArticleText').focus(); };
$('cancelArticle').onclick = () => $('articleDialog').close();
$('applyArticle').onclick = () => { state.text = $('newArticleText').value; state.title = $('newArticleTitle').value.trim() || '未命名文章'; $('articleDialog').close(); renderEditor(); articleChanged(); toast('已切换文章，个人读法规则继续使用。'); };
$('guideButton').onclick = () => $('guideDialog').showModal();
$('startGuide').onclick = () => { $('guideDialog').close(); switchView('workbench'); $('generateButton').focus(); };

function renderAccount() {
  const a = account();
  $('avatar').textContent = a ? Array.from(a.name)[0] : '○';
  $('accountName').textContent = a ? `${a.name} · 演示账户` : '未登录';
  $('accountSub').textContent = a ? '个人工作空间' : '点击模拟登录';
  $('modalAvatar').textContent = a ? Array.from(a.name)[0] : '○';
  $('modalAccountName').textContent = a?.name || '';
}
function openAccount(showAuth = false) {
  $('currentAccountPanel').hidden = !account() || showAuth;
  $('authForm').hidden = !!account() && !showAuth;
  error('authError'); $('authPassword').value = '';
  if (!$('accountDialog').open) $('accountDialog').showModal();
}
function requireAccount() { if (account()) return true; openAccount(true); error('authError', '请先模拟登录，之后手动继续操作。'); return false; }
function setSession(id) {
  stopSpeech(); db.current = id; state.result = null; closeReading(); $('selectionToolbar').hidden = true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { toast('登录状态仅在本次页面有效，本地存储不可用。'); }
  renderAll();
}
$('accountButton').onclick = () => openAccount();
$('switchAccount').onclick = () => openAccount(true);
$('logoutButton').onclick = () => { setSession(null); $('accountDialog').close(); toast('已退出演示账户。文章暂留本页，个人规则已隐藏。'); };
$('expireButton').onclick = () => { setSession(null); openAccount(true); error('authError', '演示：登录已过期。重新登录后请手动继续，系统不会自动重新合成。'); };
function setAuthMode(mode) {
  state.authMode = mode; error('authError');
  $('loginTab').classList.toggle('active', mode === 'login'); $('registerTab').classList.toggle('active', mode === 'register');
  $('authSubmit').textContent = mode === 'login' ? '模拟登录' : '创建演示账户';
}
$('loginTab').onclick = () => setAuthMode('login'); $('registerTab').onclick = () => setAuthMode('register');
$('authForm').onsubmit = e => {
  e.preventDefault(); error('authError');
  const name = $('authName').value.trim().normalize('NFC'), password = $('authPassword').value;
  if (!name || Array.from(name).length > 24 || password.length < 8) { error('authError', '请输入 1–24 字的演示名称，以及任意至少 8 位的演示密码。'); return; }
  let existing = db.accounts.find(a => a.name === name);
  if (state.authMode === 'login' && !existing) { error('authError', '演示账户不可用。可使用“林”或“佐藤”，或创建一个演示账户。'); return; }
  if (state.authMode === 'register' && existing) { error('authError', '该演示名称已使用，请换一个名称。'); return; }
  if (!existing) { existing = { id: uid(), name, version: 0, rules: [] }; db.accounts.push(existing); }
  $('authPassword').value = ''; setSession(existing.id); $('accountDialog').close(); toast(`已进入 ${existing.name} 的演示工作空间。`);
};
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY) return;
  try {
    const fresh = readStored(); if (!fresh) { toast('本地演示数据被清除，请刷新页面。'); return; }
    // Keep each tab's demo session; rule revisions still come from shared storage.
    fresh.current = db.current; db = fresh; renderAll(); toast('检测到其他窗口修改，已刷新个人规则；未保存表单保留，请核对版本。');
  } catch { toast('其他窗口的本地数据无法读取，请刷新后核对。'); }
});
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

const requirements = [
  ['ACC-01', '账户创建', '建立唯一账户；是否公开注册、登录标识待确认。原型只模拟账户开通。'],
  ['ACC-02', '登录与身份验证', '有效身份可进入工作空间；失效或伪造凭据不能调用受保护接口。'],
  ['ACC-03', '退出及登录态失效', '退出、账户禁用后不可继续合成；过期后主动登录，不自动重放请求。'],
  ['ACC-04', '当前账户', '展示最小账户资料；不返回密码散列、密钥等内部数据。'],
  ['TTS-01', '日文音色目录', '展示经过授权与能力验证的日文音色。原型中的 Nagi / Haru 是概念名称。'],
  ['TTS-02', '日文文章合成', '正文、日文音色与语速生成可听 MP3；空输入和超限在上游请求前拒绝。'],
  ['TTS-03', '播放、下载及错误', '支持播放、暂停与下载；处理中防重复提交，错误可主动重试并带请求 ID。'],
  ['DICT-01', '个人读法规则', '列表、搜索、添加、修改与删除；保存即用于后续合成，无手动发布步骤。'],
  ['DICT-02', '指定读法试听', '正文或个人规则页可试听；使用与整段合成相同的读法编译规则。'],
  ['DICT-03', '跨文章应用', '当前同词与以后文章自动使用已保存读法；仅使用当前账户的规则。'],
  ['EDIT-01', '正文内修正发音', '选词 → 填写读法 → 保存个人规则；服务端确认后更新标记，原文保持不变。'],
  ['EDIT-02', '标记与旧音频状态', '编辑正文后重新匹配；正文、规则或参数改变，旧结果保留并提示重新生成。'],
  ['JPN-01', 'Gateway 日文能力', 'ja-JP 契约、规则快照、音色与供应商适配贯通，并通过真实日文音频验收。'],
  ['INT-01', '独立账户工程', '单独构建、测试、打包、版本维护；最小 NestJS 宿主能通过公开包完成账户流程。'],
  ['INT-02', 'Gateway 包集成', '公开目录与合成能力；真实注入身份和个人规则 reader，不依赖测试覆盖。'],
  ['INT-03', '组合应用生命周期', '认证、解析器、异常处理与资源关闭正确组合，不影响宿主其他模块。'],
  ['SEC-01', '账户数据隔离', '他人规则不可读写；客户端不可指定他人身份或集合。原型本地隔离不等于安全实现。'],
  ['DATA-01', '数据保留边界', '个人规则持久化；正文及音频默认临时使用。删除、备份及日志政策需在上线前明确。'],
  ['OPS-01', '运行与排障', '关键配置缺失明确失败，健康检查不产生付费合成，请求 ID 不暴露正文和密钥。']
];
$('specTableBody').innerHTML = requirements.map(([id, scope, result]) => `<tr><td><code>${id}</code></td><td>${scope}</td><td>${result}</td></tr>`).join('');
$('waveform').innerHTML = Array.from({ length: 65 }, (_, i) => `<i style="height:${8 + ((i * 17 + i * i) % 35)}px;animation-delay:${(i % 9) * -0.12}s"></i>`).join('');
function renderAll() { renderAccount(); renderEditor(); renderRules(); renderAudio(); }
renderAll(); voiceNotice(); switchView(location.hash.slice(1));
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', voiceNotice);
if (storageNotice) toast(storageNotice);
