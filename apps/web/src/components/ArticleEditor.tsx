import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyRules, escapeHTML } from '../domain';
import type { Rule } from '../types';
type Offsets = { start: number; end: number };
function offsets(root: HTMLElement): Offsets | null {
  const s = getSelection();
  if (!s?.rangeCount || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return null;
  const r = s.getRangeAt(0),
    p = r.cloneRange();
  p.selectNodeContents(root);
  p.setEnd(r.startContainer, r.startOffset);
  return { start: p.toString().length, end: p.toString().length + r.toString().length };
}
function restore(root: HTMLElement, { start, end }: Offsets) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    points: { node: Node; start: number; end: number }[] = [];
  let n: Node | null,
    c = 0;
  while ((n = w.nextNode())) {
    points.push({ node: n, start: c, end: c + (n.textContent?.length || 0) });
    c += n.textContent?.length || 0;
  }
  if (!points.length) return;
  const point = (i: number): [Node, number] => {
    const p = points.find((p) => i <= p.end) || points.at(-1)!;
    return [p.node, Math.max(0, Math.min(i - p.start, p.end - p.start))];
  };
  const r = document.createRange();
  r.setStart(...point(start));
  r.setEnd(...point(end));
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(r);
}
// Structural serialization avoids innerText's extra newline for empty DIVs.
function readDOM(root: HTMLElement) {
  let text = '';
  const positions = new WeakMap<Node, number | number[]>();
  const block = (n: Node) => n instanceof HTMLElement && /^(DIV|P)$/.test(n.tagName);
  function walk(n: Node) {
    if (n.nodeType === 3) {
      positions.set(n, text.length);
      text += n.textContent;
      return;
    }
    const children = [...n.childNodes],
      boundaries: number[] = [];
    children.forEach((child, i) => {
      if (i && (block(child) || block(children[i - 1]))) text += '\n';
      boundaries[i] = text.length;
      if (child instanceof HTMLBRElement) {
        positions.set(child, [text.length]);
        if (!child.hasAttribute('data-editor-tail') && children.length !== 1) text += '\n';
      } else walk(child);
    });
    boundaries[children.length] = text.length;
    positions.set(n, boundaries);
  }
  walk(root);
  return {
    text,
    point(n: Node, i: number) {
      const p = positions.get(n);
      return typeof p === 'number' ? p + i : (p?.[i] ?? text.length);
    },
  };
}
export function ArticleEditor({
  text,
  title,
  rules,
  onChange,
  onSelect,
  onCopy,
}: {
  text: string;
  title: string;
  rules: Rule[];
  onChange: (v: string) => void;
  onSelect: (word: string) => void;
  onCopy: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    composing = useRef(false),
    pendingCaret = useRef<Offsets | null>(null),
    latest = useRef(text);
  const [selection, setSelection] = useState<{
    word: string;
    source: string;
    left: number;
    top: number;
  } | null>(null);
  const [floating, setFloating] = useState(false);
  const draw = useCallback(
    (value: string) => {
      const el = root.current;
      if (!el || composing.current) return;
      const selected = pendingCaret.current ?? (document.activeElement === el ? offsets(el) : null);
      pendingCaret.current = null;
      const matched = applyRules(value, rules);
      let html = '',
        c = 0;
      for (const m of matched.matches) {
        html +=
          escapeHTML(value.slice(c, m.start)) +
          `<mark data-word="${escapeHTML(m.rule.word)}" title="个人读法：${escapeHTML(m.rule.reading)}；点击编辑">${escapeHTML(m.rule.word)}</mark>`;
        c = m.end;
      }
      el.innerHTML =
        html +
        escapeHTML(value.slice(c)) +
        (value.endsWith('\n') ? '<br data-editor-tail="true">' : '');
      if (selected) restore(el, selected);
    },
    [rules],
  );
  useLayoutEffect(() => {
    latest.current = text;
    draw(text);
    setSelection(null);
    setFloating(false);
  }, [text, draw]);
  function commit() {
    if (composing.current || !root.current) return;
    const el = root.current,
      value = readDOM(el),
      s = getSelection();
    if (s?.rangeCount && el.contains(s.anchorNode) && el.contains(s.focusNode)) {
      const r = s.getRangeAt(0);
      pendingCaret.current = {
        start: value.point(r.startContainer, r.startOffset),
        end: value.point(r.endContainer, r.endOffset),
      };
    }
    latest.current = value.text;
    draw(value.text);
    onChange(value.text);
    setSelection(null);
  }
  function insert(value: string) {
    const el = root.current;
    if (!el) return;
    const s = offsets(el);
    if (!s) return;
    const next = latest.current.slice(0, s.start) + value + latest.current.slice(s.end);
    pendingCaret.current = { start: s.start + value.length, end: s.start + value.length };
    latest.current = next;
    draw(next);
    onChange(next);
    setSelection(null);
  }
  const capture = useCallback(() => {
    const el = root.current;
    if (!el || composing.current) return;
    const s = offsets(el);
    if (!s || s.start === s.end) {
      setFloating(false);
      return;
    }
    const word = latest.current.slice(s.start, s.end);
    if (!word.trim() || /[\r\n]/.test(word) || [...word].length > 100) {
      setSelection(null);
      return;
    }
    const rect = getSelection()!.getRangeAt(0).getBoundingClientRect();
    setSelection({
      word,
      source: latest.current,
      left: Math.max(12, Math.min(innerWidth - 220, rect.left)),
      top: Math.max(12, Math.min(innerHeight - 65, rect.bottom + 8)),
    });
    setFloating(true);
  }, []);
  useEffect(() => {
    const handler = () => {
      if (document.activeElement === root.current) capture();
    };
    document.addEventListener('selectionchange', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      document.removeEventListener('selectionchange', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [capture]);
  // Native beforeinput keeps paragraphs and paste plain, including IME-safe editing.
  const insertRef = useRef(insert);
  insertRef.current = insert;
  useEffect(() => {
    const el = root.current!;
    const handler = (e: InputEvent) => {
      if (['insertParagraph', 'insertLineBreak'].includes(e.inputType)) {
        e.preventDefault();
        insertRef.current('\n');
      }
    };
    el.addEventListener('beforeinput', handler);
    return () => el.removeEventListener('beforeinput', handler);
  }, []);
  const edit = () => {
    if (selection?.source === text) {
      setFloating(false);
      onSelect(selection.word);
    }
  };
  const matches = applyRules(text, rules).matches;
  return (
    <section className="editor-card" aria-label="文章编辑">
      <div className="editor-toolbar">
        <div>
          <span className="document-dot" />
          <strong id="articleTitle">{title}</strong>
          <span className="subtle-tag">未保存的文章</span>
        </div>
        <button className="text-button" id="copyButton" onClick={onCopy}>
          复制原文 ⧉
        </button>
      </div>
      <div className="paper-kicker">
        <span>日本語の文章</span>
        <span id="characterCount">{[...text].length} 字符</span>
      </div>
      <div
        ref={root}
        id="articleEditor"
        className="article-editor"
        role="textbox"
        aria-label="日文正文，可直接编辑和选词"
        aria-multiline="true"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        lang="ja"
        onInput={commit}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          commit();
        }}
        onPaste={(e) => {
          e.preventDefault();
          insert(e.clipboardData.getData('text/plain').replace(/\r\n/g, '\n'));
        }}
        onMouseUp={capture}
        onKeyUp={capture}
        onBlur={() => setFloating(false)}
        onClick={(e) => {
          const mark = (e.target as HTMLElement).closest<HTMLElement>('mark');
          if (mark && getSelection()?.isCollapsed) onSelect(mark.dataset.word!);
        }}
      />
      <div className="editor-bottom">
        <span>
          <i className="legend-dot" />
          有标记的词汇已应用个人读法
        </span>
        <span id="matchSummary">
          {matches.length} 处命中 · {new Set(matches.map((m) => m.rule.id)).size} 条规则
        </span>
      </div>
      <div className="selection-hint">
        <span className="hint-cursor">↖</span>
        <span>拖选词汇后点击“修改读法”，或直接点击已有标记。</span>
        <button
          className="text-button"
          id="editSelected"
          disabled={!selection || selection.source !== text}
          onClick={edit}
        >
          修改所选词汇
        </button>
      </div>
      {selection && floating && (
        <div
          id="selectionToolbar"
          className="selection-toolbar"
          style={{ left: selection.left, top: selection.top }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <span id="selectionPreview">{selection.word.slice(0, 12)}</span>
          <button id="editSelectionButton" onClick={edit}>
            修改读法 ↗
          </button>
        </div>
      )}
    </section>
  );
}
