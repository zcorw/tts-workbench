import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { json, mutation } from '@workbench/api/http';
import { ErrorNotice, useServices } from '@workbench/components/shared';
import { messageOf } from '@workbench/types';

const root = '/v1/cms/mcp';
interface Grant {
  id: string;
  clientId: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
}
interface Authorization {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
}
const scopeName = (scope: string) =>
  scope === 'cms:read' ? '读取本人全部文章草稿、栏目和标签' : '批量创建文章草稿、查询创建结果';

export function CmsMcp({ accountId }: { accountId: string }) {
  const location = useLocation();
  const { failed } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const consent = location.search.length > 1;
  const configuration = useQuery({
    queryKey: ['cms', accountId, 'mcp-config'],
    queryFn: () => json<{ clientId: string; resource: string }>(`${root}/config`),
    retry: false,
  });
  const authorization = useQuery({
    queryKey: ['cms', accountId, 'mcp-authorization', location.search],
    queryFn: () => json<Authorization>(`${root}/authorization${location.search}`),
    enabled: consent && configuration.isSuccess,
    retry: false,
  });
  const grants = useQuery({
    queryKey: ['cms', accountId, 'mcp-grants'],
    queryFn: () => json<{ items: Grant[] }>(`${root}/grants`),
    enabled: configuration.isSuccess,
  });
  const approve = async (value: boolean) => {
    if (busy || !authorization.data) return;
    setBusy(true);
    setError('');
    try {
      const response = await mutation(`${root}/authorize`, 'POST', {
        authorization: Object.fromEntries(new URLSearchParams(location.search)),
        approve: value,
      });
      const data: { redirectUrl: string } = await response.json();
      // Only the server's exact allowlisted callback can receive the code.
      const target = new URL(data.redirectUrl);
      const expected = new URL(authorization.data.redirectUri);
      if (target.origin !== expected.origin || target.pathname !== expected.pathname)
        throw new Error('授权回调不匹配，请重新连接。');
      window.location.assign(target.href);
    } catch (e) {
      setError(messageOf(e));
      failed(e);
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await mutation(`${root}/grants/${encodeURIComponent(id)}`, 'DELETE');
      await grants.refetch();
    } catch (e) {
      setError(messageOf(e));
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="cmsMcp">
      <p className="site-kicker">CHATGPT · MCP</p>
      <h1>连接知声</h1>
      {configuration.isError ? (
        <p role="status">MCP 尚未启用或暂时无法连接。启用前需由维护者配置回调地址与访问范围。</p>
      ) : configuration.isPending ? (
        <p role="status">正在检查连接…</p>
      ) : (
        <>
          <p>在 ChatGPT 会话中保存文章草稿。每批最多 20 篇，保存后可在知声继续编辑。</p>
          {consent && (
            <div className="site-empty" aria-label="MCP 授权请求">
              <h2>允许此客户端访问你的知声账户？</h2>
              {authorization.isPending ? <p role="status">正在核对授权请求…</p> : null}
              {authorization.isError ? (
                <p role="alert">授权请求无效，请从客户端重新发起连接。</p>
              ) : null}
              {authorization.data && (
                <>
                  <p>客户端：{authorization.data.clientId}</p>
                  <ul>
                    {authorization.data.scopes.map((scope) => (
                      <li key={scope}>{scopeName(scope)}</li>
                    ))}
                  </ul>
                  <p>本次授权最长 7 天，可随时撤销。创建的文章保持草稿，不会自动发布或生成音频。</p>
                  <p>授权后返回：{new URL(authorization.data.redirectUri).origin}</p>
                  <p>客户端读取的内容会进入其会话，撤销后无法收回已读取的数据。</p>
                  <div className="cms-actions">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => void approve(true)}
                    >
                      允许连接
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void approve(false)}
                    >
                      拒绝
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <h2>连接信息</h2>
          <p>
            在 ChatGPT 中添加自定义 MCP 服务，选择 OAuth，并使用维护者提供的预注册客户端 ID
            与回调配置。
          </p>
          <p>
            服务地址：<code>{configuration.data.resource}</code>
          </p>
          <p>
            客户端 ID：<code>{configuration.data.clientId}</code>
          </p>
          <h2>已授权连接</h2>
          <ErrorNotice message={grants.error ? messageOf(grants.error) : ''} />
          {grants.isPending ? (
            <p role="status">正在载入…</p>
          ) : grants.data?.items.length ? (
            <ul className="cms-items">
              {grants.data.items.map((grant) => (
                <li key={grant.id}>
                  <div>
                    <strong>{grant.clientId}</strong>
                    <p>{grant.scopes.map(scopeName).join('；')}</p>
                    <p>
                      到期：{new Date(grant.expiresAt).toLocaleString('zh-CN')} ·{' '}
                      {grant.revokedAt ? '已撤销' : '已授权'}
                    </p>
                  </div>
                  {!grant.revokedAt && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void revoke(grant.id)}
                    >
                      撤销连接
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>还没有授权连接。</p>
          )}
        </>
      )}
      <ErrorNotice message={error} />
    </section>
  );
}
