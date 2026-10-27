import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBlocker, useBeforeUnload, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { articleSchema } from './forms';
import { ServiceError, messageOf, type Article, type ArticleInput, type Services } from './types';
import { ErrorNotice, Modal } from './components/shared';
import { useRemoteCheck } from './useRemoteCheck';

const blank: ArticleInput = { title: '新文章', text: '' };
export function useArticleDocument(
  services: Services,
  accountId: string | undefined,
  failed: (e: unknown) => void,
  externalGuard?: {
    dirty: boolean;
    saving: boolean;
    save: () => Promise<boolean>;
    discard: () => void;
  },
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
  const [latest, setLatest] = useState<Article | null>(null);
  const [reviewTarget, setReviewTarget] = useState<Article | null>(null);
  const [reviewInput, setReviewInput] = useState<ArticleInput>(blank);
  const [reviewAccepted, setReviewAccepted] = useState(false);
  const state = useRef({
    scope: '',
    initialized: false,
    draft: blank,
    saved: null as Article | null,
    edits: 0,
    textEdits: 0,
  });
  const [loadVersion, setLoadVersion] = useState(0);
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
      textEdits: 0,
    };
    setDraft(input);
    setSaved(value);
    setError('');
    setConflict(false);
    setLatest(null);
    setReviewTarget(null);
    setReviewAccepted(false);
    setLoadVersion((v) => v + 1);
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
      state.current = {
        scope,
        initialized: false,
        draft: { ...blank },
        saved: null,
        edits: 0,
        textEdits: 0,
      };
      setDraft({ ...blank });
      setSaved(null);
      setError('');
      setConflict(false);
      setSaving(false);
      lock.current = false;
      setReloadConfirm(false);
      setLatest(null);
      setReviewTarget(null);
      setReviewAccepted(false);
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
    return (
      (dirty || saving || !!externalGuard?.dirty || !!externalGuard?.saving) &&
      currentLocation.key !== nextLocation.key
    );
  });
  useBeforeUnload(
    useCallback(
      (e: BeforeUnloadEvent) => {
        if (dirty || saving || !!externalGuard?.dirty || !!externalGuard?.saving) {
          e.preventDefault();
          e.returnValue = '';
        }
      },
      [dirty, saving, externalGuard?.dirty, externalGuard?.saving],
    ),
  );
  const edit = (input: ArticleInput) => {
    if (input.text !== state.current.draft.text) state.current.textEdits++;
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
  const remote = useRemoteCheck({
    enabled: !!accountId && active && !!saved && !saving,
    key: scope,
    load: () => services.article(state.current.saved!.id),
    onValue: (value) => {
      const base = state.current.saved;
      if (!base || base.id !== value.id || value.revision < base.revision) return;
      if (value.currentRuleVersion > base.currentRuleVersion) {
        void client.invalidateQueries({ queryKey: ['rules', accountId] });
        if (value.revision === base.revision && value.audio?.audioId === base.audio?.audioId) {
          const updated = {
            ...base,
            currentRuleVersion: value.currentRuleVersion,
            audioStale: value.audioStale,
          };
          state.current.saved = updated;
          setSaved(updated);
        }
      }
      if (value.revision !== base.revision || value.audio?.audioId !== base.audio?.audioId) {
        setLatest(value);
        setConflict(true);
        const hasDraft =
          state.current.draft.title !== base.title || state.current.draft.text !== base.text;
        setError(
          value.revision !== base.revision
            ? hasDraft
              ? '另一界面已更新这篇文章。你的草稿仍保留，请对照差异后保存。'
              : '另一界面已更新这篇文章，可载入最新版本。'
            : '服务器有新的已保存音频，可载入最新版本；当前草稿仍保留。',
        );
      }
    },
    onError: (cause) => {
      if (cause instanceof ServiceError && cause.code === 'SESSION') failed(cause);
      if (cause instanceof ServiceError && cause.code === 'NOT_FOUND') {
        setError('文章已在另一界面删除。当前草稿仍保留，请复制需要的内容。');
        setConflict(true);
      }
    },
  });
  async function fetchLatest() {
    const capturedScope = scope;
    const id = state.current.saved?.id;
    if (!id) return null;
    try {
      const value = await services.article(id);
      if (liveScope.current !== capturedScope) return null;
      setLatest(value);
      return value;
    } catch (cause) {
      if (liveScope.current === capturedScope) {
        setError(messageOf(cause));
        failed(cause);
      }
      return null;
    }
  }
  async function beginReview() {
    if (lock.current) return;
    const value = await fetchLatest();
    if (!value) return;
    setReviewTarget(value);
    setReviewInput({ ...state.current.draft });
    setReviewAccepted(false);
    setReloadConfirm(true);
  }
  async function save(against?: Article) {
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
      const value = await mutation.mutateAsync({
        data: parsed.data,
        previous: against ?? snapshot.saved,
      });
      if (
        operation.current !== token ||
        liveScope.current !== capturedScope ||
        state.current.scope !== capturedScope
      )
        return false;
      state.current.saved = value;
      setSaved(value);
      setConflict(false);
      setLatest(null);
      setReviewTarget(null);
      setReloadConfirm(false);
      setReviewAccepted(false);
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
        if (isConflict) {
          const value = await fetchLatest();
          if (value && operation.current === token && liveScope.current === capturedScope) {
            setReviewTarget(value);
            setReviewInput({ ...state.current.draft });
            setReviewAccepted(false);
            setReloadConfirm(true);
          }
        }
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
          busy={saving || !!externalGuard?.saving}
          onClose={() => blocker.reset()}
        >
          <p>
            {externalGuard?.dirty
              ? 'CMS 有未保存的正文或栏目修改，请保存或明确放弃后离开。'
              : '文章有未保存的修改。放弃文章修改不会撤销已经保存的个人读法。'}
          </p>
          <ErrorNotice message={error} />
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={saving || !!externalGuard?.saving}
              onClick={() => blocker.reset()}
            >
              继续编辑
            </button>
            <button
              className="button secondary"
              disabled={saving || !!externalGuard?.saving}
              onClick={() => {
                externalGuard?.discard();
                blocker.proceed();
              }}
            >
              放弃更改
            </button>
            <button
              className="button primary"
              disabled={saving || !!externalGuard?.saving}
              onClick={() =>
                void (externalGuard ? externalGuard.save() : save()).then((ok) => {
                  if (blocker.state === 'blocked') {
                    if (ok) blocker.proceed();
                    else blocker.reset();
                  }
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
          <p>
            本地草稿保持在内存中。请对照服务器版本 {reviewTarget?.revision ?? latest?.revision}
            ；关闭窗口会继续保留输入。个人读法不受影响。
          </p>
          {reviewTarget && (
            <div className="article-conflict-compare" style={{ display: 'grid', gap: 16 }}>
              <section aria-label="服务器最新内容">
                <h3>服务器最新内容</h3>
                <strong>{reviewTarget.title}</strong>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    maxHeight: 180,
                    overflow: 'auto',
                  }}
                >
                  {reviewTarget.text}
                </pre>
              </section>
              <section aria-label="整理后的本地内容">
                <h3>整理后准备保存的内容</h3>
                <label className="field-label" htmlFor="articleConflictTitle">
                  标题
                </label>
                <input
                  id="articleConflictTitle"
                  value={reviewInput.title}
                  onChange={(e) => {
                    setReviewInput({ ...reviewInput, title: e.target.value });
                    edit({ ...reviewInput, title: e.target.value });
                    setReviewAccepted(false);
                  }}
                />
                <label className="field-label" htmlFor="articleConflictText">
                  日文正文
                </label>
                <textarea
                  id="articleConflictText"
                  rows={7}
                  value={reviewInput.text}
                  style={{ width: '100%', resize: 'vertical' }}
                  onChange={(e) => {
                    setReviewInput({ ...reviewInput, text: e.target.value });
                    edit({ ...reviewInput, text: e.target.value });
                    setReviewAccepted(false);
                  }}
                />
                <button
                  className="text-button"
                  disabled={saving}
                  onClick={() => {
                    setReviewInput({ title: reviewTarget.title, text: reviewTarget.text });
                    edit({ title: reviewTarget.title, text: reviewTarget.text });
                    setReviewAccepted(false);
                  }}
                >
                  将服务器内容复制到整理区
                </button>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={reviewAccepted}
                    onChange={(e) => setReviewAccepted(e.target.checked)}
                  />
                  我已对照标题和正文，确认上方整理结果可以替换所示服务器版本。
                </label>
              </section>
            </div>
          )}
          <p>“放弃草稿并重新载入”会丢弃当前未保存的标题和正文。</p>
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
            {reviewTarget && (
              <button
                className="button primary"
                disabled={saving || !reviewAccepted}
                onClick={() => {
                  edit(reviewInput);
                  void save(reviewTarget);
                }}
              >
                按版本 {reviewTarget.revision} 保存整理结果
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
  return {
    read: () => state.current,
    loadVersion,
    reportConflict: () => {
      setConflict(true);
      setError('文章已在另一窗口修改，请确认后重新载入最新版本。');
    },
    draft,
    saved,
    dirty,
    edit,
    save,
    saving,
    error: error || remote.error,
    conflict,
    dialogs,
    active,
    routeId,
    ready: !!accountId && state.current.scope === scope && state.current.initialized,
    loading: query.isPending && routeId !== 'new',
    loadError: query.error ? messageOf(query.error) : '',
    retry: () => void query.refetch(),
    confirmReload: () => void beginReview(),
    allowNavigation: () => {
      bypass.current = true;
    },
  };
}
