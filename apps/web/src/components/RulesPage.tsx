import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Rule, RuleSet } from '../types';
import { applyRules } from '../domain';
import { ErrorNotice, PageHeading } from './shared';
export function RulesPage({
  set,
  text,
  onEdit,
  onAdd,
  onDelete,
  onPreview,
  canPreview,
  loading,
  error,
  onRetry,
}: {
  set: RuleSet;
  text: string;
  onEdit: (r: Rule) => void;
  onAdd: () => void;
  onDelete: (r: Rule) => void;
  onPreview: (r: Rule) => void;
  canPreview: boolean;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const filtered = set.items.filter((r) =>
    (r.word + r.reading).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pageSize = 20;
  const current = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const visible = filtered.slice(current * pageSize, (current + 1) * pageSize),
    matches = applyRules(text, set.items).matches;
  return (
    <section id="rulesView" className="view">
      <PageHeading
        kicker="YOUR PRONUNCIATION LIBRARY"
        title="每个词，都有你的读法"
        action={
          <button
            id="addRuleButton"
            className="button primary"
            onClick={onAdd}
            disabled={loading || !!error}
          >
            ＋ 添加个人规则
          </button>
        }
      >
        正文中的修改会自动出现在这里，并持续应用于你的日文文章。
      </PageHeading>
      <div className="rules-summary">
        <div>
          <span className="metric-number" id="ruleTotal">
            {set.total}
          </span>
          <span>条个人规则</span>
        </div>
        <div>
          <span className="summary-check">✓</span>
          <span>
            保存后立即用于后续合成
            <br />
            <small>个人偏好，随下一次朗读生效。</small>
          </span>
        </div>
        <div>
          <span className="tiny-label">RULE SCOPE</span>
          <strong>当前文章 + 以后文章</strong>
        </div>
      </div>
      <div className="rules-toolbar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            id="ruleSearch"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="搜索词汇或读法"
            aria-label="搜索个人规则"
          />
        </label>
        <span className="small-note" id="rulesCountNote">
          {filtered.length} / {set.total} 条
        </span>
      </div>
      <ErrorNotice message={error} />
      {error && (
        <button className="button secondary" onClick={onRetry}>
          重新加载读法
        </button>
      )}
      <div className="table-wrap" aria-busy={loading}>
        <table className="rules-table">
          <thead>
            <tr>
              <th>日文词汇</th>
              <th>指定读法</th>
              <th>应用范围</th>
              <th>当前文章</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="rulesTableBody">
            {visible.map((r) => (
              <tr key={r.id}>
                <td lang="ja">
                  <strong>{r.word}</strong>
                </td>
                <td lang="ja">{r.reading}</td>
                <td>
                  <span className="scope-pill">当前及以后文章</span>
                </td>
                <td>{matches.filter((m) => m.rule.id === r.id).length} 处</td>
                <td>
                  <div className="table-actions">
                    <button
                      className="text-button"
                      disabled={!canPreview}
                      onClick={() => onPreview(r)}
                    >
                      试听
                    </button>
                    <button
                      className="text-button"
                      data-action="edit"
                      aria-label={`编辑 ${r.word}`}
                      onClick={() => onEdit(r)}
                    >
                      编辑
                    </button>
                    <button
                      className="text-button danger"
                      data-action="delete"
                      aria-label={`删除 ${r.word}`}
                      onClick={() => onDelete(r)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!visible.length || loading) && (
          <div id="rulesEmpty" className="table-empty" role="status">
            {loading
              ? '正在加载个人读法…'
              : error
                ? '个人读法尚未载入。'
                : query
                  ? '没有找到匹配的读法，试试其他词汇。'
                  : '还没有个人读法。从正文选一个词，或添加第一条规则。'}
          </div>
        )}
      </div>
      {filtered.length > pageSize && (
        <div className="rules-footer">
          <button
            className="button secondary"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </button>
          <span>
            第 {current + 1} / {Math.ceil(filtered.length / pageSize)} 页
          </span>
          <button
            className="button secondary"
            disabled={(current + 1) * pageSize >= filtered.length}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </div>
      )}
      <div className="rules-footer">
        <span>原文不会被改写。只对实际朗读应用你的读法。</span>
        <Link className="text-button" to="/workbench">
          回到正文修正发音 →
        </Link>
      </div>
    </section>
  );
}
