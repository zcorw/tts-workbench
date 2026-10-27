import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Modal, useServices } from '@workbench/components/shared';
import { messageOf, ServiceError } from '@workbench/types';
import { cmsHttp } from './http';
import { categoryEntries } from './categoryTree';
import type { CmsSummary } from './types';
import { workbenchHref } from '../links';
export function CmsList({ accountId }: { accountId: string }) {
  const [params, setParams] = useSearchParams(),
    client = useQueryClient(),
    { failed } = useServices();
  const q = params.get('q') || '',
    category = params.get('category') || '',
    tag = params.get('tag') || '',
    status = params.get('status') || '';
  const n = Number(params.get('page') || 1),
    page = Number.isSafeInteger(n) && n > 0 ? n : 1,
    key = JSON.stringify([q, category, tag, status, page]);
  const [search, setSearch] = useState(q),
    [selected, setSelected] = useState<Record<string, CmsSummary>>({});
  const [target, setTarget] = useState(''),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setSearch(q);
    setSelected({});
    setConfirm(false);
    setError('');
    setNotice('');
    setNeedsRefresh(false);
  }, [key, q]);
  const taxonomy = useQuery({
    queryKey: ['cms', accountId, 'taxonomy'],
    queryFn: cmsHttp.taxonomy,
  });
  const query = useQuery({
    queryKey: ['cms', accountId, 'articles', q, category, tag, status, page],
    queryFn: () =>
      cmsHttp.articles({
        q,
        category,
        tag,
        status,
        limit: 20,
        offset: (page - 1) * 20,
      }),
  });
  const entries = categoryEntries(taxonomy.data?.categories ?? []),
    items = query.data?.items ?? [],
    chosen = Object.values(selected);
  const categoryName =
    category === 'uncategorized'
      ? '未分类'
      : entries.find((e) => e.category.id === category)?.path.join(' / ') || '全部文章';
  const targetName = target
    ? entries.find((e) => e.category.id === target)?.path.join(' / ') || '已删除的分类'
    : '未分类';
  const all = !!items.length && items.every((a) => !!selected[a.id]);
  const filter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(name, value) : next.delete(name);
    next.delete('page');
    setParams(next);
  };
  const refreshVersions = async () => {
    setBusy(true);
    setError('');
    try {
      const [data, latest] = await Promise.all([
        query.refetch(),
        Promise.all(Object.keys(selected).map((id) => cmsHttp.article(id))),
      ]);
      if (data.error) throw data.error;
      if (!alive.current) return;
      setSelected(Object.fromEntries(latest.map((article) => [article.id, article])));
      setNeedsRefresh(false);
      setNotice(
        '已载入所选文章的最新版本；即使归属或排序已变化，选择仍保留。请核对标题和目标分类，再确认移动。未自动提交。',
      );
      await taxonomy.refetch();
    } catch (e) {
      if (alive.current) {
        setError(
          e instanceof ServiceError && e.code === 'NOT_FOUND'
            ? '有文章已被删除或无法读取，选择已保留。请清除选择后重新选择可用文章，或稍后再试。'
            : `未能载入最新版本，选择已保留。${messageOf(e)}`,
        );
        failed(e);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const move = async () => {
    setBusy(true);
    setError('');
    try {
      await cmsHttp.moveCategory(target || null, chosen);
      if (!alive.current) return;
      setConfirm(false);
      setSelected({});
      setNeedsRefresh(false);
      setNotice(`已将 ${chosen.length} 篇文章移入“${targetName}”。已发布版本保持原归属。`);
      await client.invalidateQueries({ queryKey: ['cms', accountId] });
    } catch (e) {
      if (alive.current) {
        setConfirm(false);
        setNeedsRefresh(true);
        setError(
          e instanceof ServiceError &&
            (e.code === 'REVISION_CONFLICT' || e.code === 'CMS_REVISION_CONFLICT')
            ? '所选文章已被另一编辑器修改，本次全部未移动。选择已保留；请载入最新版本，核对后重新确认。'
            : `未能确认移动结果：${messageOf(e)} 选择已保留，请载入最新版本核对。`,
        );
        failed(e);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="cms-list">
      <div className="cms-row">
        <div>
          <p className="site-kicker">CONTENT LIBRARY</p>
          <h1>文章与分类</h1>
        </div>
        <Link id="cmsNew" to="/articles/new" className="button primary">
          手工新建文章
        </Link>
      </div>
      <div className="cms-article-layout">
        <aside
          className="cms-category-panel cms-category-sidebar"
          aria-labelledby="cmsArticleCategoriesHeading"
        >
          <div className="cms-row">
            <h2 id="cmsArticleCategoriesHeading">按分类浏览</h2>
            <Link to="/taxonomy">管理</Link>
          </div>
          <nav id="cmsCategoryNavigation" aria-label="文章分类">
            <button
              className={!category ? 'is-active' : ''}
              aria-current={!category ? 'page' : undefined}
              disabled={busy}
              onClick={() => filter('category', '')}
            >
              <span>全部文章</span>
              <span>{taxonomy.data?.totalArticles ?? '—'}</span>
            </button>
            <button
              id="cmsUncategorizedFilter"
              className={category === 'uncategorized' ? 'is-active' : ''}
              aria-current={category === 'uncategorized' ? 'page' : undefined}
              disabled={busy}
              onClick={() => filter('category', 'uncategorized')}
            >
              <span>未分类</span>
              <span>{taxonomy.data?.uncategorizedCount ?? '—'}</span>
            </button>
            <ul>
              {entries.map(({ category: c, depth, path }) => (
                <li key={c.id} style={{ '--category-depth': Math.min(depth, 5) } as CSSProperties}>
                  <button
                    data-category-id={c.id}
                    className={category === c.id ? 'is-active' : ''}
                    aria-current={category === c.id ? 'page' : undefined}
                    aria-label={`${path.join(' / ')}，${c.articleCount} 篇文章`}
                    disabled={busy}
                    onClick={() => filter('category', c.id)}
                  >
                    <span>{c.name}</span>
                    <span>{c.articleCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {!taxonomy.isPending && !entries.length && (
            <p className="small-note">
              还没有分类。<Link to="/taxonomy">建立分类</Link>
              ，再选择文章移动归属。
            </p>
          )}
          <p className="small-note">篇数为直接归属，不包含子分类。列表还受搜索、标签和状态筛选。</p>
        </aside>
        <div className="cms-list-content">
          <h2 id="cmsCurrentCategory">{categoryName}</h2>
          <form
            className="cms-filters"
            onSubmit={(e) => {
              e.preventDefault();
              filter('q', search.trim());
            }}
          >
            <label>
              搜索标题、正文或摘要
              <input
                id="cmsArticleSearch"
                value={search}
                disabled={busy}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              标签
              <select value={tag} disabled={busy} onChange={(e) => filter('tag', e.target.value)}>
                <option value="">全部标签</option>
                {taxonomy.data?.tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              发布状态
              <select
                value={status}
                disabled={busy}
                onChange={(e) => filter('status', e.target.value)}
              >
                <option value="">全部状态</option>
                <option value="draft">未发布</option>
                <option value="published">已发布</option>
              </select>
            </label>
            <button className="button secondary" disabled={busy}>
              搜索
            </button>
          </form>
          <ErrorNotice
            message={
              error ||
              (query.error
                ? messageOf(query.error)
                : taxonomy.error
                  ? messageOf(taxonomy.error)
                  : '')
            }
          />
          {notice && (
            <p className="cms-success" role="status">
              {notice}
            </p>
          )}
          <div className="cms-bulk-toolbar" aria-label="批量分类操作">
            <label className="cms-check">
              <input
                id="cmsSelectPage"
                type="checkbox"
                checked={all}
                disabled={busy || !items.length || query.isPending}
                onChange={() =>
                  setSelected(all ? {} : Object.fromEntries(items.map((a) => [a.id, a])))
                }
              />
              选择本页
            </label>
            <span role="status">已选 {chosen.length} 篇</span>
            <label>
              移动到
              <select
                id="cmsMoveCategory"
                aria-label="移动到分类"
                value={target}
                disabled={busy}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">未分类</option>
                {entries.map(({ category: c, path }) => (
                  <option key={c.id} value={c.id}>
                    {path.join(' / ')}
                  </option>
                ))}
              </select>
            </label>
            <button
              id="cmsMoveSelected"
              className="button secondary"
              disabled={busy || !chosen.length || needsRefresh || taxonomy.isPending}
              onClick={() => setConfirm(true)}
            >
              移动所选文章…
            </button>
            {chosen.length > 0 && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setSelected({});
                  setNeedsRefresh(false);
                  setError('');
                }}
              >
                清除选择
              </button>
            )}
            {needsRefresh && (
              <button
                id="cmsRefreshSelected"
                className="button secondary"
                disabled={busy}
                onClick={() => void refreshVersions()}
              >
                载入所选文章最新版本
              </button>
            )}
          </div>
          {query.isPending ? (
            <p role="status">正在载入内容…</p>
          ) : (
            query.data && (
              <>
                <p className="small-note">
                  当前筛选共 {query.data.total}{' '}
                  篇。移动只调整草稿分类，正文、读法、音频和固定发布归属保持不变。
                </p>
                {!items.length && (
                  <div className="cms-empty">
                    <h3>这个范围还没有文章</h3>
                    <p>
                      {category
                        ? '可从全部文章中选择内容，移动到此分类。'
                        : '可以手工新建，也可以通过结构化导入保存文章。'}
                    </p>
                    <button className="button secondary" onClick={() => filter('category', '')}>
                      查看全部分类
                    </button>
                  </div>
                )}
                <ul className="cms-items cms-selectable-items">
                  {items.map((a) => (
                    <li key={a.id} data-article-id={a.id}>
                      <input
                        type="checkbox"
                        aria-label={`选择文章 ${a.title}`}
                        checked={!!selected[a.id]}
                        disabled={busy || (!selected[a.id] && chosen.length >= 20)}
                        onChange={(e) =>
                          setSelected((previous) => {
                            const next = { ...previous };
                            if (e.target.checked) next[a.id] = a;
                            else delete next[a.id];
                            return next;
                          })
                        }
                      />
                      <div className="cms-article-summary">
                        <Link to={`/articles/${a.id}`}>{a.title}</Link>
                        <p className="small-note">
                          {entries
                            .find((c) => c.category.id === a.cms.categoryId)
                            ?.path.join(' / ') || '未分类'}{' '}
                          · {a.cms.publishedReleaseId ? '已发布' : '草稿'} ·{' '}
                          {a.audio ? (a.audioStale ? '音频需更新' : '有音频') : '无音频'}
                        </p>
                      </div>
                      <a
                        className="button secondary compact"
                        href={workbenchHref(a.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        语音工作台精细编辑 ↗
                      </a>
                    </li>
                  ))}
                </ul>
                <div className="cms-row">
                  <button
                    className="button secondary"
                    disabled={page === 1 || busy}
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set('page', String(page - 1));
                      setParams(next);
                    }}
                  >
                    上一页
                  </button>
                  <span>第 {page} 页</span>
                  <button
                    className="button secondary"
                    disabled={page * 20 >= query.data.total || busy}
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set('page', String(page + 1));
                      setParams(next);
                    }}
                  >
                    下一页
                  </button>
                </div>
              </>
            )
          )}
        </div>
      </div>
      {confirm && (
        <Modal
          id="cmsMoveCategoryConfirm"
          title="移动所选文章的分类？"
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <p>
            将 {chosen.length} 篇文章统一移入“{targetName}
            ”。按当前载入版本检查，任一文章已变化时本次全部取消。
          </p>
          <p>不会改动正文、读法、音频或已发布版本。切换分类或页面会清除本页选择。</p>
          <ul className="cms-move-titles" aria-label="本次移动的文章">
            {chosen.map((article) => (
              <li key={article.id}>{article.title}</li>
            ))}
          </ul>
          <div className="dialog-footer">
            <button className="button secondary" disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              id="cmsMoveCategoryConfirmSubmit"
              className="button primary"
              disabled={busy}
              onClick={() => void move()}
            >
              {busy ? '正在移动…' : '确认移动'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
