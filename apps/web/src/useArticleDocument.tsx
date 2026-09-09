import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBlocker, useBeforeUnload, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { articleSchema } from './forms';
import { ServiceError, messageOf, type Article, type ArticleInput, type Services } from './types';
import { ErrorNotice, Modal } from './components/shared';

const blank: ArticleInput = { title: '新文章', text: '' };
export function useArticleDocument(
  services: Services,
  accountId: string | undefined,
  failed: (e: unknown) => void,
) {
  const location = useLocation(),
    navigate = useNavigate(),
    client = useQueryClient();
  const match = /^\/articles\/([^/]+)$/.exec(location.pathname);
  const routeId = match?.[1] || '';
  const active = !!routeId;
  const scope = accountId ? `${accountId}/${routeId}` : '';
  const [draft, setDraft] = useState<ArticleInput>(blank);
  const [saved, setSaved] = useState<Article | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const state = useRef({
    scope: '',
    initialized: false,
    draft: blank,
    saved: null as Article | null,
    edits: 0,
  });
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const bypass = useRef(false),
    lock = useRef(false),
    operation = useRef(0);
  const query = useQuery({
    queryKey: ['article', accountId, routeId],
    queryFn: () => services.article(routeId),
    enabled: !!accountId && active && routeId !== 'new',
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const install = useCallback((value: Article | null) => {
    const input = value ? { title: value.title, text: value.text } : { ...blank };
    state.current = {
      scope: liveScope.current,
      initialized: true,
      draft: input,
      saved: value,
      edits: 0,
    };
    setDraft(input);
    setSaved(value);
    setError('');
    setConflict(false);
  }, []);
  useLayoutEffect(() => {
    if (!accountId) {
      operation.current++;
      lock.current = false;
      setSaving(false);
      return;
    }
    if (location.pathname === '/login' || location.pathname === '/register') return;
    if (state.current.scope !== scope) {
      operation.current++;
      state.current = { scope, initialized: false, draft: { ...blank }, saved: null, edits: 0 };
      setDraft({ ...blank });
      setSaved(null);
      setError('');
      setConflict(false);
      setSaving(false);
      lock.current = false;
      setReloadConfirm(false);
    }
    if (!state.current.initialized && (routeId === 'new' || !active)) install(null);
    else if (!state.current.initialized && query.isSuccess && !query.isFetching)
      install(query.data);
  }, [
    scope,
    accountId,
    routeId,
    active,
    query.data,
    query.isSuccess,
    query.isFetching,
    location.pathname,
    install,
  ]);
  useEffect(() => {
    if (query.error) failed(query.error);
  }, [query.error, failed]);
  const dirty =
    !!accountId &&
    active &&
    state.current.scope === scope &&
    state.current.initialized &&
    (saved
      ? draft.title !== saved.title || draft.text !== saved.text
      : draft.title !== blank.title || draft.text !== blank.text);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypass.current) {
      bypass.current = false;
      return false;
    }
    return (dirty || saving) && currentLocation.key !== nextLocation.key;
  });
  useBeforeUnload(
    useCallback(
      (e: BeforeUnloadEvent) => {
        if (dirty || saving) {
          e.preventDefault();
          e.returnValue = '';
        }
      },
      [dirty, saving],
    ),
  );
  const edit = (input: ArticleInput) => {
    state.current.draft = input;
    state.current.edits++;
    setDraft(input);
  };
  const mutation = useMutation({
    mutationFn: (input: { data: ArticleInput; previous: Article | null }) =>
      input.previous
        ? services.updateArticle(input.previous.id, input.data, input.previous.revision)
        : services.createArticle(input.data),
    retry: false,
  });
  async function save() {
    if (lock.current || !accountId || !active || !state.current.initialized) return false;
    const parsed = articleSchema.safeParse(state.current.draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(' '));
      return false;
    }
    const snapshot = { ...state.current },
      capturedScope = scope,
      token = ++operation.current;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const value = await mutation.mutateAsync({ data: parsed.data, previous: snapshot.saved });
      if (
        operation.current !== token ||
        liveScope.current !== capturedScope ||
        state.current.scope !== capturedScope
      )
        return false;
      state.current.saved = value;
      setSaved(value);
      setConflict(false);
      const unchanged = state.current.edits === snapshot.edits;
      if (unchanged) {
        state.current.draft = { title: value.title, text: value.text };
        setDraft(state.current.draft);
      } else setError('已保存提交时的内容；你随后做的修改尚未保存，请再次保存。');
      client.setQueryData(['article', accountId, value.id], value);
      void client.invalidateQueries({ queryKey: ['articles', accountId] });
      if (routeId === 'new' && blocker.state !== 'blocked') {
        state.current.scope = `${accountId}/${value.id}`;
        bypass.current = true;
        navigate(`/articles/${value.id}`, { replace: true });
      }
      return unchanged;
    } catch (e) {
      if (operation.current === token && liveScope.current === capturedScope) {
        const isConflict = e instanceof ServiceError && e.code === 'REVISION_CONFLICT';
        setConflict(isConflict);
        setError(
          isConflict
            ? '文章已在另一窗口更新，本次未保存。你的输入仍保留，可重新载入最新版本。'
            : messageOf(e),
        );
        failed(e);
      }
      return false;
    } finally {
      if (operation.current === token) {
        lock.current = false;
        setSaving(false);
      }
    }
  }
  async function reload() {
    if (!accountId || !saved || lock.current) return;
    const capturedScope = scope;
    lock.current = true;
    setSaving(true);
    try {
      const value = await services.article(saved.id);
      if (liveScope.current !== capturedScope) return;
      install(value);
      client.setQueryData(['article', accountId, value.id], value);
      setReloadConfirm(false);
    } catch (e) {
      if (liveScope.current === capturedScope) {
        setError(messageOf(e));
        failed(e);
      }
    } finally {
      if (liveScope.current === capturedScope) {
        lock.current = false;
        setSaving(false);
      }
    }
  }
  const dialogs = (
    <>
      {accountId && blocker.state === 'blocked' && (
        <Modal
          id="unsavedDialog"
          title="保存修改后再离开？"
          busy={saving}
          onClose={() => blocker.reset()}
        >
          <p>文章有未保存的修改。放弃文章修改不会撤销已经保存的个人读法。</p>
          <ErrorNotice message={error} />
          <div className="dialog-footer">
            <button className="button secondary" disabled={saving} onClick={() => blocker.reset()}>
              继续编辑
            </button>
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => blocker.proceed()}
            >
              放弃更改
            </button>
            <button
              className="button primary"
              disabled={saving}
              onClick={() =>
                void save().then((ok) => {
                  if (ok && blocker.state === 'blocked') blocker.proceed();
                })
              }
            >
              保存并离开
            </button>
          </div>
        </Modal>
      )}
      {accountId && reloadConfirm && (
        <Modal
          id="reloadArticleDialog"
          title="重新载入最新文章？"
          busy={saving}
          onClose={() => setReloadConfirm(false)}
        >
          <p>这会放弃当前未保存的标题和正文，载入服务器最新内容。个人读法不受影响。</p>
          <ErrorNotice message={error} />
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => setReloadConfirm(false)}
            >
              继续编辑
            </button>
            <button className="button primary" disabled={saving} onClick={() => void reload()}>
              放弃草稿并重新载入
            </button>
          </div>
        </Modal>
      )}
    </>
  );
  return {
    draft,
    saved,
    dirty,
    edit,
    save,
    saving,
    error,
    conflict,
    dialogs,
    active,
    routeId,
    ready: !!accountId && state.current.scope === scope && state.current.initialized,
    loading: query.isPending && routeId !== 'new',
    loadError: query.error ? messageOf(query.error) : '',
    retry: () => void query.refetch(),
    confirmReload: () => setReloadConfirm(true),
    allowNavigation: () => {
      bypass.current = true;
    },
  };
}
