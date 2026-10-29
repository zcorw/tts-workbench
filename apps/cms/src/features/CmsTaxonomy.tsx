import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Modal } from '@workbench/components/shared';
import { messageOf, ServiceError } from '@workbench/types';
import { cmsHttp } from './http';
import { categoryDescendants, categoryEntries } from './categoryTree';
import type { Category, CategoryInput, Taxon } from './types';

const empty = (parentId: string | null = null): CategoryInput => ({
  name: '',
  slug: '',
  parentId,
  sortOrder: 0,
});
const errorOf = (e: unknown) =>
  e instanceof ServiceError && e.code === 'CATEGORY_CYCLE'
    ? '不能把分类放到自身或子孙分类下面。输入已保留，请重新选择父级。'
    : e instanceof ServiceError && e.code === 'REVISION_CONFLICT'
      ? '这个分类已在另一窗口修改。输入已保留；请刷新列表，核对后重新编辑。'
      : e instanceof ServiceError && e.code === 'TAXONOMY_IN_USE'
        ? '此分类仍有文章或子分类。请先移动文章、调整子分类，再删除。'
        : messageOf(e);
export function CmsTaxonomy({
  accountId,
  failed,
}: {
  accountId: string;
  failed: (e: unknown) => void;
}) {
  const client = useQueryClient(),
    alive = useRef(true),
    nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: ['cms', accountId, 'taxonomy'],
    queryFn: cmsHttp.taxonomy,
  });
  const [editing, setEditing] = useState<Category | undefined>(),
    [draft, setDraft] = useState<CategoryInput>(empty);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [deleting, setDeleting] = useState<Category | null>(null);
  const categories = query.data?.categories ?? [],
    entries = categoryEntries(categories);
  const excluded = editing ? categoryDescendants(categories, editing.id) : new Set<string>();
  const invalidate = () => client.invalidateQueries({ queryKey: ['cms', accountId] });
  const begin = (item?: Category, parentId: string | null = null) => {
    setEditing(item);
    setDraft(
      item
        ? {
            name: item.name,
            slug: item.slug,
            parentId: item.parentId,
            sortOrder: item.sortOrder,
          }
        : empty(parentId),
    );
    setError('');
    setNotice('');
    nameInput.current?.focus();
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await cmsHttp.saveCategory(draft, editing);
      if (!alive.current) return;
      setEditing(undefined);
      setDraft(empty());
      setNotice(`已保存分类“${saved.name}”。`);
      await invalidate();
    } catch (e) {
      if (alive.current) {
        setError(errorOf(e));
        failed(e);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="cms-category-manager">
      <div className="cms-row">
        <div>
          <p className="site-kicker">ORGANIZE CONTENT</p>
          <h1>分类管理</h1>
        </div>
        <Link to="/articles" className="button secondary">
          返回文章列表
        </Link>
      </div>
      <p>
        建立父子分类，整理文章归属。每个分类的篇数只计直接归属文章；调整分类不会改写已发布快照。
      </p>
      <div className="cms-category-overview">
        <Link to="/articles">
          <strong>{query.data?.totalArticles ?? '—'}</strong>
          <span>全部文章</span>
        </Link>
        <Link id="cmsUncategorizedLink" to="/articles?category=uncategorized">
          <strong>{query.data?.uncategorizedCount ?? '—'}</strong>
          <span>未分类文章 →</span>
        </Link>
        <div>
          <strong>{categories.length}</strong>
          <span>个分类</span>
        </div>
      </div>
      <ErrorNotice message={query.error ? messageOf(query.error) : ''} />
      <div className="cms-category-layout">
        <section className="cms-category-panel" aria-labelledby="cmsCategoryTreeHeading">
          <div className="cms-row">
            <h2 id="cmsCategoryTreeHeading">分类层级</h2>
            <button
              id="cmsCategoryNew"
              className="button secondary compact"
              disabled={busy}
              onClick={() => begin()}
            >
              新建顶级分类
            </button>
          </div>
          <p className="small-note">
            同级按排序值从小到大排列，值相同按名称排列。点击名称查看该分类文章。
          </p>
          {query.isPending ? (
            <p role="status">正在载入分类…</p>
          ) : !categories.length ? (
            <div className="cms-empty">
              <h3>还没有分类</h3>
              <p>先建立一个顶级分类，也可以从未分类文章开始整理。</p>
            </div>
          ) : (
            <ul id="cmsCategoryTree" className="cms-category-tree">
              {entries.map(({ category: c, depth, path }) => (
                <li
                  key={c.id}
                  data-category-id={c.id}
                  style={{ '--category-depth': Math.min(depth, 5) } as CSSProperties}
                >
                  <div className="cms-category-tree-main">
                    <Link
                      to={`/articles?category=${encodeURIComponent(c.id)}`}
                      aria-label={`查看分类 ${path.join(' / ')} 的文章`}
                    >
                      <strong>{c.name}</strong>
                    </Link>
                    <span className="small-note cms-category-path">
                      {path.length > 1 ? path.slice(0, -1).join(' / ') : '顶级分类'} · 排序{' '}
                      {c.sortOrder}
                    </span>
                    <span className="cms-category-counts">
                      <span data-article-count={c.articleCount}>{c.articleCount} 篇文章</span>
                      <span>{c.childrenCount} 个子分类</span>
                    </span>
                  </div>
                  <div className="cms-actions">
                    <button
                      className="button secondary compact"
                      aria-label={`编辑分类 ${c.name}`}
                      disabled={busy}
                      onClick={() => begin(c)}
                    >
                      编辑
                    </button>
                    <button
                      className="text-button"
                      aria-label={`添加子分类 ${c.name}`}
                      disabled={busy}
                      onClick={() => begin(undefined, c.id)}
                    >
                      添加子分类
                    </button>
                    <button
                      className="text-button danger"
                      aria-label={`删除分类 ${c.name}`}
                      disabled={busy}
                      onClick={() => {
                        setDeleting(c);
                        setError('');
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section
          className="cms-category-panel cms-category-form"
          aria-labelledby="cmsCategoryFormHeading"
        >
          <h2 id="cmsCategoryFormHeading">
            {editing ? `编辑“${editing.name}”` : draft.parentId ? '新建子分类' : '新建分类'}
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="cms-field">
              名称
              <input
                id="cmsTaxonName"
                ref={nameInput}
                required
                maxLength={80}
                value={draft.name}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="cms-field">
              链接标识
              <input
                id="cmsTaxonSlug"
                required
                maxLength={120}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="例如 japanese-reading"
                value={draft.slug}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
              />
            </label>
            <label className="cms-field">
              父级分类
              <select
                id="cmsCategoryParent"
                value={draft.parentId ?? ''}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, parentId: e.target.value || null })}
              >
                <option value="">无父级（顶级分类）</option>
                {entries
                  .filter(({ category }) => !excluded.has(category.id))
                  .map(({ category, path }) => (
                    <option key={category.id} value={category.id}>
                      {path.join(' / ')}
                    </option>
                  ))}
              </select>
            </label>
            {editing && <p className="small-note">父级选择中已排除当前分类及其全部子孙分类。</p>}
            <label className="cms-field">
              同级排序
              <input
                id="cmsCategoryOrder"
                type="number"
                min={0}
                max={2147483647}
                step={1}
                required
                value={draft.sortOrder}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
              />
            </label>
            <p className="small-note">
              数值越小越靠前。更改父级会连同子分类调整层级，文章归属保持不变。
            </p>
            {!deleting && <ErrorNotice message={error} />}
            {notice && (
              <p role="status" className="cms-success">
                {notice}
              </p>
            )}
            <div className="cms-actions">
              <button
                id="cmsTaxonSave"
                className="button primary"
                disabled={busy || query.isPending}
              >
                {busy ? '正在保存…' : editing ? '保存分类修改' : '添加分类'}
              </button>
              {editing && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => begin()}
                >
                  取消编辑
                </button>
              )}
            </div>
            {!!error && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void query.refetch()}
              >
                刷新分类列表（保留输入）
              </button>
            )}
          </form>
        </section>
      </div>
      <TagManager accountId={accountId} tags={query.data?.tags ?? []} failed={failed} />
      {deleting && (
        <Modal
          id="cmsDeleteTaxon"
          title="删除分类？"
          busy={busy}
          onClose={() => {
            setDeleting(null);
            setError('');
          }}
        >
          <p>
            确认删除“{deleting.name}”？目前有 {deleting.articleCount} 篇直接归属文章、
            {deleting.childrenCount} 个子分类。
          </p>
          <p>
            有文章或子分类时不能删除。请先移动文章，并调整子分类的父级。已发布的名称和归属快照会保留。
          </p>
          <ErrorNotice message={error} />
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setDeleting(null);
                setError('');
              }}
            >
              取消
            </button>
            <button
              id="cmsCategoryDeleteConfirm"
              className="button danger"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await cmsHttp.deleteTaxon('categories', deleting);
                    if (!alive.current) return;
                    setDeleting(null);
                    if (editing?.id === deleting.id) begin();
                    await invalidate();
                  } catch (e) {
                    if (alive.current) {
                      setError(errorOf(e));
                      failed(e);
                    }
                  } finally {
                    if (alive.current) setBusy(false);
                  }
                })()
              }
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function TagManager({
  accountId,
  tags,
  failed,
}: {
  accountId: string;
  tags: Taxon[];
  failed: (e: unknown) => void;
}) {
  const client = useQueryClient(),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [editing, setEditing] = useState<Taxon | undefined>(),
    [name, setName] = useState(''),
    [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState<Taxon | null>(null);
  const reset = () => {
    setEditing(undefined);
    setName('');
    setSlug('');
    setError('');
  };
  const reload = () => client.invalidateQueries({ queryKey: ['cms', accountId] });
  return (
    <section className="cms-panel" aria-labelledby="cmsTagsHeading">
      <h2 id="cmsTagsHeading">标签管理</h2>
      <p className="small-note">标签补充文章主题，每篇文章可选择多个标签。</p>
      <form
        className="cms-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            setBusy(true);
            setError('');
            try {
              await cmsHttp.saveTaxon('tags', { name, slug }, editing);
              if (!alive.current) return;
              reset();
              await reload();
            } catch (e) {
              if (alive.current) {
                setError(messageOf(e));
                failed(e);
              }
            } finally {
              if (alive.current) setBusy(false);
            }
          })();
        }}
      >
        <label>
          标签名称
          <input
            id="cmsTagName"
            required
            maxLength={80}
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          标签链接标识
          <input
            id="cmsTagSlug"
            required
            maxLength={120}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            disabled={busy}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <button id="cmsTagSave" className="button primary" disabled={busy}>
          {editing ? '保存标签' : '添加标签'}
        </button>
        {editing && (
          <button type="button" className="button secondary" disabled={busy} onClick={reset}>
            取消编辑
          </button>
        )}
      </form>
      {!deleting && <ErrorNotice message={error} />}{' '}
      {!tags.length && <p>还没有标签，可以在上方添加。</p>}
      <ul className="cms-items">
        {tags.map((t) => (
          <li key={t.id}>
            <div>
              <strong>{t.name}</strong>
              <span className="small-note"> /{t.slug}</span>
            </div>
            <div className="cms-actions">
              <button
                className="button secondary compact"
                aria-label={`编辑标签 ${t.name}`}
                disabled={busy}
                onClick={() => {
                  setEditing(t);
                  setName(t.name);
                  setSlug(t.slug);
                  setError('');
                }}
              >
                编辑
              </button>
              <button
                className="text-button danger"
                aria-label={`删除标签 ${t.name}`}
                disabled={busy}
                onClick={() => {
                  setDeleting(t);
                  setError('');
                }}
              >
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {deleting && (
        <Modal
          id="cmsDeleteTag"
          title="删除标签？"
          busy={busy}
          onClose={() => {
            setDeleting(null);
            setError('');
          }}
        >
          <p>
            确认删除“{deleting.name}
            ”？被文章使用的标签不能删除，已发布快照保留。
          </p>
          <ErrorNotice message={error} />
          <div className="dialog-footer">
            <button className="button secondary" disabled={busy} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await cmsHttp.deleteTaxon('tags', deleting);
                    if (!alive.current) return;
                    setDeleting(null);
                    if (editing?.id === deleting.id) reset();
                    await reload();
                  } catch (e) {
                    if (alive.current) {
                      setError(messageOf(e));
                      failed(e);
                    }
                  } finally {
                    if (alive.current) setBusy(false);
                  }
                })()
              }
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
