import { useCallback, useEffect, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Modal, ServiceContext } from '@workbench/components/shared';
import {
  ServiceError,
  messageOf,
  type Account,
  type PublicConfig,
  type Services,
} from '@workbench/types';
import type { NavigationGuard } from './features/types';
import { CmsPage } from './features/CmsPage';
import { CmsLayout } from './CmsLayout';
import { AuthPage } from './AuthPage';
import { AccountPage } from './AccountPage';

const defaultConfig: PublicConfig = {
  registrationOpen: false,
  maxText: 10000,
  maxBytes: 49152,
  maxArticles: 100,
};
export function App({ services }: { services: Services }) {
  const location = useLocation(),
    navigate = useNavigate(),
    client = useQueryClient();
  const [guard, setGuard] = useState<NavigationGuard | undefined>();
  const [notice, setNotice] = useState(''),
    [toast, setToast] = useState('');
  const liveGuard = useRef(guard),
    bypass = useRef(false),
    returnTo = useRef('/'),
    owner = useRef<string | null>(null);
  const currentPath = useRef(location.pathname + location.search);
  currentPath.current = location.pathname + location.search;
  liveGuard.current = guard;
  const authPath = location.pathname === '/login' || location.pathname === '/register';
  const configuration = useQuery({ queryKey: ['config'], queryFn: () => services.configuration() });
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => services.session(),
    enabled: configuration.isSuccess,
    refetchInterval: 60000,
  });
  const account = session.data ?? null;
  const allowNavigation = useCallback(() => {
    bypass.current = true;
  }, []);
  const onGuardChange = useCallback((value: NavigationGuard | undefined) => setGuard(value), []);
  const clearPrivate = useCallback(() => {
    for (const prefix of ['cms', 'article', 'articles', 'rules', 'voices'])
      client.removeQueries({ queryKey: [prefix] });
  }, [client]);
  const expire = useCallback(() => {
    if (!owner.current) return;
    if (currentPath.current !== '/login' && currentPath.current !== '/register')
      returnTo.current = currentPath.current;
    owner.current = null;
    void client.cancelQueries({ queryKey: ['session'] });
    client.setQueryData(['session'], null);
    clearPrivate();
    setNotice('登录已失效，请重新登录。未保存的文章草稿仍保留在本次页面内存中。');
    bypass.current = true;
    navigate('/login', { replace: true });
  }, [client, clearPrivate, navigate]);
  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof ServiceError && e.code === 'SESSION') expire();
    },
    [expire],
  );
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (account) {
      if (owner.current && owner.current !== account.id) clearPrivate();
      owner.current = account.id;
    } else if (session.isSuccess && owner.current) expire();
  }, [account, session.isSuccess, clearPrivate, expire]);
  useEffect(() => {
    if (configuration.isPending || session.isPending) return;
    if (!account && !authPath) {
      returnTo.current = location.pathname + location.search;
      bypass.current = true;
      navigate('/login', { replace: true });
    } else if (account && authPath) {
      bypass.current = true;
      navigate(returnTo.current, { replace: true });
    }
  }, [
    account,
    authPath,
    configuration.isPending,
    session.isPending,
    location.pathname,
    location.search,
    navigate,
  ]);
  useEffect(() => {
    if (location.pathname === '/cms' || location.pathname.startsWith('/cms/')) {
      bypass.current = true;
      navigate((location.pathname.slice(4) || '/articles') + location.search, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);
  useEffect(() => {
    document.title = `${authPath ? '登录' : location.pathname.startsWith('/read') ? '阅读库' : '内容管理'} · 内容库`;
  }, [authPath, location.pathname]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypass.current) {
      bypass.current = false;
      return false;
    }
    const value = liveGuard.current;
    return !!value && (value.dirty || value.saving) && currentLocation.key !== nextLocation.key;
  });
  useEffect(() => {
    if (
      location.pathname === '/articles' &&
      blocker.state === 'blocked' &&
      !guard?.dirty &&
      !guard?.saving
    )
      blocker.reset();
  }, [blocker, guard, location.pathname]);
  const liveBlocker = useRef(blocker);
  liveBlocker.current = blocker;
  useBeforeUnload(
    useCallback((e: BeforeUnloadEvent) => {
      const value = liveGuard.current;
      if (value?.dirty || value?.saving) {
        e.preventDefault();
        e.returnValue = '';
      }
    }, []),
  );
  const loggedIn = async (value: Account) => {
    await client.cancelQueries({ queryKey: ['session'] });
    clearPrivate();
    owner.current = value.id;
    client.setQueryData(['session'], value);
    setNotice('');
    bypass.current = true;
    navigate(
      returnTo.current.startsWith('/') && !returnTo.current.startsWith('//')
        ? returnTo.current
        : '/',
      { replace: true },
    );
  };
  const logout = async () => {
    const captured = owner.current;
    await services.logout();
    if (owner.current !== captured) return;
    owner.current = null;
    returnTo.current = '/';
    clearPrivate();
    void client.cancelQueries({ queryKey: ['session'] });
    client.setQueryData(['session'], null);
    setGuard(undefined);
    setNotice('已退出内容库。');
    bypass.current = true;
    navigate('/login', { replace: true });
  };
  const loading = configuration.isPending || (configuration.isSuccess && session.isPending);
  const loadError = configuration.error || session.error;
  return (
    <ServiceContext.Provider value={{ services, notify, failed }}>
      <a className="site-skip" href={account ? '#mainContent' : '#authName'}>
        跳到内容
      </a>
      {!account ? (
        <AuthPage
          mode={location.pathname === '/register' ? 'register' : 'login'}
          config={configuration.data ?? defaultConfig}
          loading={loading}
          notice={notice}
          loadError={loadError ? messageOf(loadError) : ''}
          onRetry={() => {
            void configuration.refetch();
            void session.refetch();
          }}
          onLogin={loggedIn}
        />
      ) : (
        <CmsLayout account={account}>
          {loadError && <ErrorNotice message={messageOf(loadError)} />}
          {location.pathname === '/account' ? (
            <AccountPage
              key={account.id}
              account={account}
              onUpdate={(value) => client.setQueryData(['session'], value)}
              onLogout={logout}
            />
          ) : (
            <CmsPage
              key={account.id}
              accountId={account.id}
              services={services}
              failed={failed}
              onGuardChange={onGuardChange}
              allowNavigation={allowNavigation}
            />
          )}
        </CmsLayout>
      )}
      {blocker.state === 'blocked' && (
        <Modal
          id="unsavedDialog"
          title={guard?.saving ? '正在处理，请稍候' : '保存修改后再离开？'}
          busy={guard?.saving}
          onClose={() => blocker.reset()}
        >
          <p>
            {guard?.saving
              ? '操作尚未完成，请留在当前页面等待结果。'
              : '文章有未保存修改。保存正文和 CMS 信息不会自动生成音频或发布。'}
          </p>
          {!guard?.saving && (
            <div className="dialog-footer">
              <button
                className="button secondary"
                disabled={guard?.saving}
                onClick={() => blocker.reset()}
              >
                继续编辑
              </button>
              <button
                className="button secondary"
                disabled={guard?.saving}
                onClick={() => {
                  liveGuard.current?.discard();
                  blocker.proceed();
                }}
              >
                放弃更改
              </button>
              <button
                className="button primary"
                disabled={guard?.saving}
                onClick={() =>
                  void (async () => {
                    const success = await liveGuard.current?.save();
                    const pending = liveBlocker.current;
                    if (pending.state === 'blocked') {
                      if (success) pending.proceed();
                      else pending.reset();
                    }
                  })()
                }
              >
                保存并离开
              </button>
            </div>
          )}
        </Modal>
      )}
      {toast && (
        <div className="site-toast" role="status">
          {toast}
        </div>
      )}
    </ServiceContext.Provider>
  );
}
