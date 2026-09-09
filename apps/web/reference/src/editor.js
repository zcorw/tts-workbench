import {applyRules as match, escapeHTML} from './model.js';
export function createEditor({state, rules, openReading, articleChanged, toast}) {
const $ = id => document.getElementById(id);
const applyRules = text => match(text, rules());
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
  $('editSelected').disabled = true;
  const offsets = selectionOffsets();
  if (!offsets || offsets.start === offsets.end) { $('selectionToolbar').hidden = true; return; }
  const word = state.text.slice(offsets.start, offsets.end);
  if (!word.trim() || /[\r\n]/.test(word) || Array.from(word).length > 100) { $('selectionToolbar').hidden = true; return; }
  state.pendingSelection = { ...offsets, word, source: state.text };
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  $('selectionPreview').textContent = word.length > 10 ? `${word.slice(0, 10)}…` : word;
  $('selectionToolbar').hidden = false; $('editSelected').disabled = false;
  $('selectionToolbar').style.left = `${Math.max(12, Math.min(window.innerWidth - $('selectionToolbar').offsetWidth - 12, rect.left))}px`;
  $('selectionToolbar').style.top = `${Math.max(12, Math.min(window.innerHeight - 60, rect.bottom + 9))}px`;
}
let composing = false;
// Serialize native contenteditable blocks structurally. innerText adds an extra
// newline for <div><br></div> under pre-wrap, so it cannot be the source of truth.
function readDOM(root) {
  let text = ''; const positions = new WeakMap();
  const block = n => n.nodeType === 1 && /^(DIV|P)$/.test(n.tagName);
  function walk(node) {
    if (node.nodeType === 3) { positions.set(node, text.length); text += node.data; return; }
    const children = [...node.childNodes], boundaries = [];
    children.forEach((child, i) => {
      if (i && (block(child) || block(children[i - 1]))) text += '\n';
      boundaries[i] = text.length;
      if (child.nodeName === 'BR') {
        const placeholder = child.hasAttribute('data-editor-tail') || children.length === 1;
        positions.set(child, [text.length]); if (!placeholder) text += '\n';
      } else walk(child);
    });
    boundaries[children.length] = text.length; positions.set(node, boundaries);
  }
  walk(root);
  const point = (node, offset) => { const p = positions.get(node); return typeof p === 'number' ? p + offset : p?.[offset] ?? text.length; };
  return { text, point };
}
function commitEditorInput() {
  if (composing) return;
  const root = $('articleEditor'), selection = getSelection(), value = readDOM(root);
  let offsets = null;
  if (selection.rangeCount && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
    const range = selection.getRangeAt(0);
    offsets = {start:value.point(range.startContainer,range.startOffset),end:value.point(range.endContainer,range.endOffset)};
  }
  state.text = value.text.replace(/\r\n/g, '\n');
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

$('editSelected').onclick = $('editSelectionButton').onclick;
document.addEventListener('selectionchange', () => { if (!composing && document.activeElement === $('articleEditor')) captureSelection(); });
return {render() {
  if (composing) return;
  const selected = document.activeElement === $('articleEditor') ? selectionOffsets() : null;
  renderEditor(); if (selected) selectOffsets(selected.start, selected.end);
}, select: selectOffsets, capture: captureSelection};
}