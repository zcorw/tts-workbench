import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { json, mutation } from '@workbench/api/http';
import { ErrorNotice, useServices } from '@workbench/components/shared';
import { messageOf, ServiceError, type Account } from '@workbench/types';

const root = '/v1/zhiyue/account';
const accountChanged = '知声登录账户已变更，请重新载入此页并核对账户。';
const formatDate = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

interface Binding {
  id: string;
  createdAt: string;
  expiresAt: string;
}

function hasCode(error: unknown, ...codes: string[]) {
  return error instanceof ServiceError && codes.includes(error.code);
}

export function ZhiyueConnectionPage({ account }: { account: Account }) {
  const { failed } = useServices();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'approve' | 'revoke' | null>(null);
  const [sessionChanged, setSessionChanged] = useState(false);
  const pending = useRef<symbol | null>(null);
  const expectedAccount = `expected_account_id=${encodeURIComponent(account.id)}`;
  const bindings = useQuery({
    queryKey: ['cms', account.id, 'zhiyue-bindings'],
    queryFn: async ({ signal }) => {
      const result = await json<{ items: Binding[] }>(`${root}/bindings?${expectedAccount}`);
      signal.throwIfAborted();
      return result;
    },
    gcTime: 0,
    retry: false,
  });
  const changed = sessionChanged || hasCode(bindings.error, 'ACCOUNT_CHANGED');
  const unavailable = hasCode(bindings.error, 'NOT_FOUND', 'HTTP_404');
  const canMutate = !changed && !unavailable && bindings.isSuccess;

  useLayoutEffect(
    () => () => {
      pending.current = null;
    },
    [account.id],
  );
  useEffect(() => {
    if (bindings.error) failed(bindings.error);
    if (changed) {
      setCode('');
      setNotice('');
    }
  }, [bindings.error, changed, failed]);

  async function changeBinding(kind: 'approve' | 'revoke', request: () => Promise<Response>) {
    if (pending.current || !canMutate) return;
    const operation = Symbol();
    pending.current = operation;
    setBusy(kind);
    setError('');
    setNotice('');

    try {
      await request();
      if (pending.current !== operation) return;
      if (kind === 'approve') setCode('');
      setNotice(kind === 'approve' ? '已确认连接，请回到眼镜继续。' : '连接已解除。');
      await bindings.refetch();
    } catch (cause) {
      if (pending.current !== operation) return;
      if (hasCode(cause, 'ACCOUNT_CHANGED')) setSessionChanged(true);
      else if (kind === 'approve' && hasCode(cause, 'INVALID_OR_EXPIRED_CODE')) {
        setError('配对码无效或已过期，请检查眼镜上的配对码后重试。');
      } else {
        setError(messageOf(cause));
        failed(cause);
      }
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setBusy(null);
      }
    }
  }

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !canMutate) return;
    const userCode = code.replace(/[\s-]/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase());
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(userCode)) {
      setNotice('');
      setError('请输入眼镜显示的 8 位配对码。');
      return;
    }
    void changeBinding('approve', () =>
      mutation(`${root}/approve`, 'POST', {
        user_code: userCode,
        expected_account_id: account.id,
      }),
    );
  }

  return (
    <section className="site-card" aria-labelledby="zhiyueTitle">
      <header>
        <p className="site-kicker">知声 · 知阅</p>
        <h1 id="zhiyueTitle">连接知阅</h1>
        <p>
          当前知声账户：<strong>{account.displayName}</strong>
          {account.displayName !== account.login && `（${account.login}）`}
        </p>
      </header>
      {changed ? (
        <ErrorNotice message={accountChanged} />
      ) : unavailable ? (
        <p role="status">知阅绑定暂未启用。</p>
      ) : (
        <>
          <p>确认后，眼镜上的知阅可以读取此账户有权访问的已发布文章和附带音频。</p>
          <form onSubmit={approve} noValidate aria-busy={busy === 'approve'}>
            <div className="site-field">
              <label htmlFor="zhiyueCode">眼镜配对码</label>
              <input
                id="zhiyueCode"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={32}
                required
                aria-describedby="zhiyueCodeHelp zhiyueActionError"
                disabled={!canMutate || busy !== null}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setError('');
                  setNotice('');
                }}
              />
              <small id="zhiyueCodeHelp">仅输入你手边眼镜显示的 8 位配对码。</small>
            </div>
            <button className="button primary" type="submit" disabled={!canMutate || busy !== null}>
              {busy === 'approve' ? '正在确认…' : '确认连接'}
            </button>
          </form>
          <ErrorNotice id="zhiyueActionError" message={error} />
          {notice && <p role="status">{notice}</p>}

          <section className="cms-panel" aria-labelledby="zhiyueBindingsTitle">
            <div className="cms-row">
              <h2 id="zhiyueBindingsTitle">我的设备绑定</h2>
              <button
                className="button secondary"
                type="button"
                disabled={bindings.isFetching || busy !== null}
                onClick={() => void bindings.refetch()}
              >
                刷新列表
              </button>
            </div>
            {bindings.isPending ? (
              <p role="status">正在载入设备绑定…</p>
            ) : bindings.isError ? (
              <ErrorNotice message={messageOf(bindings.error)} />
            ) : bindings.data.items.length === 0 ? (
              <p>还没有已绑定的设备。</p>
            ) : (
              <ul className="cms-items">
                {bindings.data.items.map((binding) => (
                  <li key={binding.id}>
                    <div>
                      <strong>知阅眼镜</strong>
                      <p>绑定时间：{formatDate.format(new Date(binding.createdAt))}</p>
                      <p>到期时间：{formatDate.format(new Date(binding.expiresAt))}</p>
                    </div>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void changeBinding('revoke', () =>
                          mutation(
                            `${root}/bindings/${encodeURIComponent(binding.id)}?${expectedAccount}`,
                            'DELETE',
                          ),
                        )
                      }
                    >
                      解除绑定
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
