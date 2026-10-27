import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorNotice } from '@workbench/components/shared';
import { messageOf } from '@workbench/types';
import { cmsHttp } from './http';

export function CmsHome({ accountId }: { accountId: string }) {
  const query = useQuery({
    queryKey: ['cms', accountId, 'overview'],
    queryFn: async () => {
      const [recent, published, taxonomy] = await Promise.all([
        cmsHttp.articles({ limit: 5, offset: 0 }),
        cmsHttp.articles({ status: 'published', limit: 1, offset: 0 }),
        cmsHttp.taxonomy(),
      ]);
      return {
        recent,
        published: published.total,
        categories: taxonomy.categories.length,
        tags: taxonomy.tags.length,
      };
    },
  });
  return (
    <div className="site-overview" id="cmsHome">
      <section className="site-home-hero">
        <div>
          <p className="site-kicker">YOUR CONTENT, WELL KEPT</p>
          <h1>
            让每篇内容，
            <br />
            都有自己的位置。
          </h1>
          <p>保存日文原文，整理栏目与标签。写作、导入、阅读和发布，从这里开始。</p>
          <div className="cms-actions">
            <Link className="button primary" id="cmsHomeNew" to="/articles/new">
              ＋ 写一篇文章
            </Link>
            <Link className="button secondary" to="/import">
              导入已有内容
            </Link>
          </div>
        </div>
        <div className="site-hero-note" aria-hidden="true">
          <span>文</span>
          <strong>记录 → 整理 → 发布</strong>
          <small>原文留存，声音随行。</small>
        </div>
      </section>
      <ErrorNotice message={query.error ? messageOf(query.error) : ''} />
      <section className="site-metrics" aria-label="内容概览">
        <Link to="/articles">
          <span>保存的文章</span>
          <strong>{query.data?.recent.total ?? '—'}</strong>
          <small>继续编辑与整理 →</small>
        </Link>
        <Link to="/read">
          <span>已发布文章</span>
          <strong>{query.data?.published ?? '—'}</strong>
          <small>前往本人阅读库 →</small>
        </Link>
        <Link to="/taxonomy">
          <span>栏目 / 标签</span>
          <strong>{query.data ? `${query.data.categories} / ${query.data.tags}` : '—'}</strong>
          <small>管理内容归属 →</small>
        </Link>
      </section>
      <section className="site-recent">
        <div className="cms-row">
          <div>
            <p className="site-kicker">CONTINUE WHERE YOU LEFT OFF</p>
            <h2>最近编辑</h2>
          </div>
          <Link to="/articles">查看全部 →</Link>
        </div>
        {query.isPending ? (
          <p role="status">正在载入内容…</p>
        ) : query.data?.recent.items.length ? (
          <ul className="cms-items">
            {query.data.recent.items.map((a) => (
              <li key={a.id}>
                <div>
                  <Link to={`/articles/${a.id}`}>{a.title}</Link>
                  <p className="small-note">
                    {a.cms.publishedReleaseId ? '已有固定发布' : '草稿'} ·{' '}
                    {new Date(a.updatedAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                <Link className="button secondary compact" to={`/articles/${a.id}`}>
                  继续编辑
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="site-empty">
            <h3>从第一篇文章开始</h3>
            <p>可以直接写作，也可以预览 JSON 后批量导入。保存草稿不会自动发布或生成音频。</p>
            <Link to="/articles/new">新建文章 →</Link>
          </div>
        )}
      </section>
    </div>
  );
}
