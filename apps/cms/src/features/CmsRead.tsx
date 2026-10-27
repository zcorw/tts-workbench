import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorNotice, useServices } from '@workbench/components/shared';
import { messageOf } from '@workbench/types';
import { cmsHttp } from './http';
import { ReadingAudioControls, useReadingAudio } from './readingAudio';
import type { CmsRelease, ReadPage } from './types';

export function CmsRead({ accountId, articleId }: { accountId: string; articleId?: string }) {
  const [params, setParams] = useSearchParams(),
    { failed } = useServices();
  const category = params.get('category') || '';
  const n = Number(params.get('page') || 1),
    page = Number.isSafeInteger(n) && n > 0 && Number.isSafeInteger(n * 20) ? n : 1;
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width:650px)').matches),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const match = window.matchMedia('(max-width:650px)'),
      changed = () => setCompact(match.matches);
    changed();
    match.addEventListener('change', changed);
    return () => match.removeEventListener('change', changed);
  }, []);
  const query = useQuery<CmsRelease | ReadPage>({
    queryKey: ['cms', accountId, 'read', articleId, category, page],
    queryFn: () =>
      articleId
        ? cmsHttp.readArticle(articleId)
        : cmsHttp.readArticles({ category, limit: 20, offset: (page - 1) * 20 }),
  });
  const data = query.data,
    list = data && 'items' in data ? data : undefined,
    detail = data && 'text' in data ? data : undefined;
  const releaseScope = list ? list.items.map((r) => r.id).join(',') : detail?.id || '';
  const player = useReadingAudio(
    JSON.stringify([accountId, articleId, category, page, releaseScope]),
    failed,
  );
  useEffect(() => {
    if (query.error) {
      player.clear();
      failed(query.error);
    }
  }, [query.error, player.clear, failed]);
  const navigation = list?.navigation,
    currentCategory = navigation?.categories.find((c) => c.id === category);
  const categoryName =
    category === 'uncategorized'
      ? '未分类'
      : category
        ? currentCategory?.name || '所选分类'
        : '全部文章';
  const listHref = `/read${params.toString() ? '?' + params.toString() : ''}`;
  const changeCategory = (value: string) => {
    player.clear();
    setExpanded(false);
    const next = new URLSearchParams(params);
    value ? next.set('category', value) : next.delete('category');
    next.delete('page');
    setParams(next);
  };
  const changePage = (value: number) => {
    player.clear();
    const next = new URLSearchParams(params);
    value > 1 ? next.set('page', String(value)) : next.delete('page');
    setParams(next);
  };
  const reset = () => {
    player.clear();
    setExpanded(false);
    setParams({});
  };
  return (
    <section className="cms-reading-library">
      {player.element}
      <div className="cms-row">
        <div>
          <p className="site-kicker">PUBLISHED LIBRARY</p>
          <h1>{articleId ? '阅读全文' : '本人阅读库'}</h1>
        </div>
        <a href="/v1/cms/read/rss" className="button secondary">
          RSS
        </a>
      </div>
      <p className="small-note">
        这里展示固定发布版本。分类按发布时的直接归属展示，不包含子分类文章；草稿分类的后续调整不改写这些内容。
      </p>
      <ErrorNotice message={query.error ? messageOf(query.error) : ''} />
      {query.error && (
        <div className="cms-actions">
          <button className="button secondary" onClick={() => void query.refetch()}>
            重新载入
          </button>
          <button className="text-button" onClick={reset}>
            重置阅读库筛选
          </button>
        </div>
      )}
      {query.isPending && <p role="status">正在载入发布内容…</p>}
      {!articleId && (
        <div className="cms-reading-layout">
          <aside className="cms-reading-category-panel" aria-label="已发布分类">
            <h2 className="cms-reading-desktop-heading">已发布分类</h2>
            <button
              id="cmsReadCategoryToggle"
              className="cms-reading-category-toggle"
              aria-expanded={expanded}
              aria-controls="cmsReadCategoryLinks"
              onClick={() => setExpanded((value) => !value)}
            >
              <span>
                分类：{categoryName} · {list?.total ?? '—'} 篇
              </span>
              <span aria-hidden="true">{expanded ? '−' : '+'}</span>
            </button>
            <nav id="cmsReadCategoryLinks" aria-label="阅读库分类" hidden={compact && !expanded}>
              <button
                id="cmsReadAllCategories"
                className={!category ? 'is-active' : ''}
                aria-current={!category ? 'page' : undefined}
                onClick={() => changeCategory('')}
              >
                <span>全部文章</span>
                <span>{navigation?.totalArticles ?? '—'}</span>
              </button>
              <button
                id="cmsReadUncategorized"
                className={category === 'uncategorized' ? 'is-active' : ''}
                aria-current={category === 'uncategorized' ? 'page' : undefined}
                onClick={() => changeCategory('uncategorized')}
              >
                <span>未分类</span>
                <span>{navigation?.uncategorizedCount ?? '—'}</span>
              </button>
              <ul>
                {navigation?.categories.map((c) => (
                  <li key={c.id}>
                    <button
                      data-read-category-id={c.id}
                      className={category === c.id ? 'is-active' : ''}
                      aria-current={category === c.id ? 'page' : undefined}
                      onClick={() => changeCategory(c.id)}
                    >
                      <span>{c.name}</span>
                      <span>{c.articleCount}</span>
                    </button>
                    {c.names.length > 1 && (
                      <p className="cms-reading-category-alias">
                        其他已发布名称：{c.names.filter((name) => name !== c.name).join(' / ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {navigation && !navigation.categories.length && (
                <p className="small-note">当前没有已发布的命名分类。</p>
              )}
              <p className="small-note">
                只列有已发布文章的分类，篇数为直接归属，不展开管理分类树。
              </p>
            </nav>
          </aside>
          <div className="cms-reading-results">
            <div className="cms-row">
              <h2 id="cmsReadCurrentCategory">{categoryName}</h2>
              <span id="cmsReadArticleCount" className="small-note" role="status">
                {list ? `${list.total} 篇文章` : '正在载入…'}
              </span>
            </div>
            {list && (
              <>
                <ul id="cmsReadingList" className="cms-reading-cards">
                  {list.items.map((release) => (
                    <li
                      key={release.id}
                      data-release-id={release.id}
                      data-article-id={release.articleId}
                    >
                      <article className="cms-reading-card">
                        <h3>
                          <Link
                            className="cms-read-full-title"
                            to={`/read/${release.articleId}${params.toString() ? '?' + params.toString() : ''}`}
                            onClick={player.clear}
                          >
                            {release.title}
                          </Link>
                        </h3>
                        <p className="cms-reading-card-meta">
                          {release.cms.category?.name || '未分类'} ·{' '}
                          {new Date(release.createdAt).toLocaleDateString('zh-CN')}
                        </p>
                        <p className="cms-reading-preview" lang="ja">
                          {release.text}
                        </p>
                        <ReadingAudioControls release={release} player={player} />
                        <Link
                          className="cms-read-full"
                          to={`/read/${release.articleId}${params.toString() ? '?' + params.toString() : ''}`}
                          onClick={player.clear}
                        >
                          阅读全文 →
                        </Link>
                      </article>
                    </li>
                  ))}
                </ul>
                {!list.items.length && (
                  <div className="cms-empty">
                    <h3>{category ? '此分类暂无已发布文章' : '尚未发布文章'}</h3>
                    <p>
                      {category
                        ? '分类可能已无发布内容，或不在当前可读范围。可以返回全部文章。'
                        : '在内容管理中发布文章后，就可以在这里阅读和播放。'}
                    </p>
                    <button id="cmsReadReset" className="button secondary" onClick={reset}>
                      查看全部文章
                    </button>
                  </div>
                )}
                <div className="cms-row cms-reading-pagination">
                  <button
                    id="cmsReadPrevious"
                    className="button secondary"
                    disabled={page === 1}
                    onClick={() => changePage(page - 1)}
                  >
                    上一页
                  </button>
                  <span id="cmsReadPage">第 {page} 页</span>
                  <button
                    id="cmsReadNext"
                    className="button secondary"
                    disabled={page * 20 >= list.total}
                    onClick={() => changePage(page + 1)}
                  >
                    下一页
                  </button>
                </div>
                {!list.items.length && page > 1 && (
                  <button className="text-button" onClick={() => changePage(1)}>
                    返回此分类第一页
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {detail && (
        <article className="cms-reading-detail">
          <Link id="cmsReadBack" to={listHref} onClick={player.clear}>
            ← 返回原分类和页码
          </Link>
          <h2>{detail.title}</h2>
          <p className="small-note">
            {detail.cms.category?.name || '未分类'} ·{' '}
            {detail.cms.tags.map((t) => t.name).join(' / ')} · 发布于{' '}
            {new Date(detail.createdAt).toLocaleString('zh-CN')}
          </p>
          {detail.cms.summary && <p>{detail.cms.summary}</p>}
          <ReadingAudioControls release={detail} player={player} />
          <div className="cms-prose" lang="ja">
            {detail.text}
          </div>
        </article>
      )}
    </section>
  );
}
