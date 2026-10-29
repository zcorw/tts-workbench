import { Link, useLocation } from 'react-router-dom';
import type { Services } from '@workbench/types';
import { CmsList } from './CmsList';
import { CmsEditor } from './CmsEditor';
import { CmsImport } from './CmsImport';
import { CmsTaxonomy } from './CmsTaxonomy';
import { CmsRead } from './CmsRead';
import { CmsHome } from './CmsHome';
import type { NavigationGuard } from './types';
import './cms.css';

export function CmsPage({
  accountId,
  services,
  failed,
  onGuardChange,
  allowNavigation,
}: {
  accountId: string;
  services: Services;
  failed: (e: unknown) => void;
  onGuardChange: (guard: NavigationGuard | undefined) => void;
  allowNavigation: () => void;
}) {
  const path = useLocation().pathname;
  const edit = /^\/articles\/([^/]+)$/.exec(path),
    read = /^\/read(?:\/([^/]+))?$/.exec(path);
  if (edit)
    return (
      <CmsEditor
        key={`${accountId}/${edit[1]}`}
        accountId={accountId}
        id={edit[1]}
        services={services}
        failed={failed}
        onGuardChange={onGuardChange}
        allowNavigation={allowNavigation}
      />
    );
  if (path === '/articles') return <CmsList accountId={accountId} />;
  if (path === '/import') return <CmsImport accountId={accountId} failed={failed} />;
  if (path === '/taxonomy') return <CmsTaxonomy accountId={accountId} failed={failed} />;
  if (read)
    return (
      <CmsRead
        key={`${accountId}/${read[1] || 'list'}`}
        accountId={accountId}
        articleId={read[1]}
      />
    );
  if (path === '/interfaces')
    return (
      <section>
        <p className="site-kicker">READ-ONLY ACCESS</p>
        <h1>AI 与 RSS 只读接口</h1>
        <p>
          接口只读取固定发布版本，不返回私人草稿，不允许写入或生成音频。默认使用登录会话；机器只读
          token 默认关闭，需维护者批准启用。此页不创建或保存密钥。
        </p>
        <dl className="cms-endpoints">
          <dt>文章列表</dt>
          <dd>
            <code>GET /v1/cms/read/articles</code>
          </dd>
          <dt>当前发布文章</dt>
          <dd>
            <code>GET /v1/cms/read/articles/:articleId</code>
          </dd>
          <dt>固定发布音频</dt>
          <dd>
            <code>GET /v1/cms/read/releases/:releaseId/audio</code>
          </dd>
          <dt>RSS</dt>
          <dd>
            <a href="/v1/cms/read/rss">GET /v1/cms/read/rss</a>
          </dd>
        </dl>
        <p>
          不要将编辑账户的 Cookie 或密码交给
          AI。只读凭证应限定读取范围、可撤销；配置方式由维护者提供。
        </p>
      </section>
    );
  if (path === '/') return <CmsHome accountId={accountId} />;
  return (
    <section>
      <h1>没有找到这个页面</h1>
      <p>可以返回内容库概览，继续整理文章。</p>
      <Link to="/">返回概览</Link>
    </section>
  );
}
