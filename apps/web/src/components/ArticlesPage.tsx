import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ServiceError, type ArticleSummary } from '../types';
import { ErrorNotice, Modal, PageHeading, useAction, useServices } from './shared';

export function ArticlesPage({
  accountId,
  maxArticles,
  currentRuleVersion,
}: {
  accountId: string;
  maxArticles: number;
  currentRuleVersion?: number;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { services, failed, notify } = useServices(),
    client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const number = Number(params.get('page') || 1);
  const page = Number.isSafeInteger(number) && number > 0 ? number : 1;
  const limit = 20;
  const [search, setSearch] = useState(q),
    [deleting, setDeleting] = useState<ArticleSummary | null>(null);
  const [conflict, setConflict] = useState(false);
  const action = useAction();
  const query = useQuery({
    queryKey: ['articles', accountId, q, page],
    queryFn: () => services.articles({ q, offset: (page - 1) * limit, limit }),
  });
  useEffect(() => {
    setSearch(q);
  }, [q]);
  useEffect(() => {
    if (query.error) failed(query.error);
  }, [query.error, failed]);
  useEffect(() => {
    if (query.data && page > 1 && query.data.items.length === 0) {
      const last = Math.max(1, Math.ceil(query.data.total / limit));
      setParams({ ...(q ? { q } : {}), page: String(last) }, { replace: true });
    }
  }, [query.data, page, q, setParams]);
  const turn = (next: number) => setParams({ ...(q ? { q } : {}), page: String(next) });
  return (
    <section id="articlesView" className="view">
      <PageHeading
        kicker="MY ARTICLES"
        title="我的文章"
        action={
          <Link id="newArticleButton" className="button primary" to="/articles/new">
            ＋ 新文章
          </Link>
        }
      >
        保存日文原文，随时继续编辑。每个账户最多保存 {maxArticles} 篇文章。
      </PageHeading>
      <form
        className="article-search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(search.trim() ? { q: search.trim(), page: '1' } : {});
        }}
      >
        <label htmlFor="articleSearch">搜索文章标题</label>
        <input
          id="articleSearch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="输入标题关键词"
        />
        <button className="button secondary">搜索</button>
        {q && (
          <button type="button" className="text-button" onClick={() => setParams({})}>
            清除搜索
          </button>
        )}
      </form>
      <ErrorNotice message={query.error ? '文章列表加载失败，请重试。' : ''} />
      {query.error && (
        <button className="button secondary" onClick={() => void query.refetch()}>
          重新加载文章列表
        </button>
      )}
      {query.isPending ? (
        <p role="status">正在加载文章…</p>
      ) : (
        query.data && (
          <>
            <p className="small-note" role="status">
              共 {query.data.total} 篇{q ? '匹配文章' : '文章'}
            </p>
            {query.data.items.length === 0 ? (
              <div className="article-empty">
                <h2>{q ? '没有找到匹配的文章' : '还没有保存的文章'}</h2>
                <p>{q ? '换个标题关键词试试。' : '新建一篇文章，空白正文也可以先保存。'}</p>
              </div>
            ) : (
              <ul className="article-list">
                {query.data.items.map((a) => (
                  <li key={a.id} data-article-id={a.id}>
                    <div className="article-summary">
                      <Link to={`/articles/${a.id}`} className="article-title">
                        {a.title}
                      </Link>
                      <div className="small-note">
                        最后修改{' '}
                        <time dateTime={a.updatedAt}>
                          {new Date(a.updatedAt).toLocaleString('zh-CN')}
                        </time>
                      </div>
                      <span className="article-audio-state">
                        {a.audio
                          ? a.audioStale ||
                            (currentRuleVersion !== undefined &&
                              a.audio.ruleVersion !== currentRuleVersion)
                            ? '音频需重新生成'
                            : '已有音频'
                          : '无已保存音频'}
                      </span>
                    </div>
                    <div className="article-row-actions">
                      <Link className="button secondary compact" to={`/articles/${a.id}`}>
                        打开
                      </Link>
                      <button
                        className="text-button danger"
                        aria-label={`删除文章：${a.title}`}
                        onClick={() => {
                          action.setError();
                          setConflict(false);
                          setDeleting(a);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {query.data.total > limit && (
              <nav className="article-pagination" aria-label="文章分页">
                <button
                  className="button secondary"
                  disabled={page <= 1}
                  onClick={() => turn(page - 1)}
                >
                  上一页
                </button>
                <span>
                  第 {page} / {Math.max(1, Math.ceil(query.data.total / limit))} 页
                </span>
                <button
                  className="button secondary"
                  disabled={page * limit >= query.data.total}
                  onClick={() => turn(page + 1)}
                >
                  下一页
                </button>
              </nav>
            )}
          </>
        )
      )}
      {deleting && (
        <Modal
          id="deleteArticleDialog"
          title="删除这篇文章？"
          busy={action.busy}
          onClose={() => setDeleting(null)}
        >
          <p>“{deleting.title}”及其音频将被删除，无法恢复。个人读法仍会保留。</p>
          <ErrorNotice
            message={
              conflict ? '文章已在另一窗口修改，本次未删除。请刷新列表后重新确认。' : action.error
            }
          />
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={action.busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            {conflict ? (
              <button
                className="button primary"
                onClick={() => {
                  setDeleting(null);
                  void query.refetch();
                }}
              >
                刷新列表
              </button>
            ) : (
              <button
                className="button danger"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    try {
                      await services.deleteArticle(deleting.id, deleting.revision);
                    } catch (e) {
                      if (!alive.current) return;
                      if (e instanceof ServiceError && e.code === 'REVISION_CONFLICT')
                        setConflict(true);
                      throw e;
                    }
                    client.removeQueries({ queryKey: ['article', accountId, deleting.id] });
                    await client.invalidateQueries({ queryKey: ['articles', accountId] });
                    if (!alive.current) return;
                    setDeleting(null);
                    notify('文章已删除。');
                  })
                }
              >
                确认删除
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
