import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { articleSchema } from '@workbench/forms';
import { ServiceError, messageOf } from '@workbench/types';
import { useRemoteCheck } from '@workbench/useRemoteCheck';
import { cmsHttp } from './http';
import { draftOf, emptyDraft, sameDraft, type CmsArticle, type CmsDraft } from './types';

// Unsaved drafts survive a session-expiry login screen in memory, scoped by account.
const draftSessions = new Map<
  string,
  {
    saved: CmsArticle | null;
    draft: CmsDraft;
    createId: string;
    pendingCreate: CmsDraft | null;
    requiresResolution: boolean;
  }
>();
const rejectedCreate = new Set([
  'INVALID_REQUEST',
  'SLUG_CONFLICT',
  'SLUG_ALLOCATION_FAILED',
  'CMS_REFERENCE_CONFLICT',
  'ARTICLE_LIMIT',
]);

export function useCmsDocument(
  accountId: string,
  routeId: string,
  failed: (e: unknown) => void,
  allowNavigation: () => void,
) {
  const navigate = useNavigate(),
    client = useQueryClient();
  const scope = `${accountId}/${routeId}`;
  const [saved, setSaved] = useState<CmsArticle | null>(null);
  const [draft, setDraft] = useState<CmsDraft>(emptyDraft);
  const [latest, setLatest] = useState<CmsArticle | null>(null);
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [conflictSerial, setConflictSerial] = useState(0);
  const [createPending, setCreatePending] = useState(false);
  const [remotePaused, setRemotePaused] = useState(false);
  const state = useRef({
    scope,
    saved,
    draft,
    edits: 0,
    busy: false,
    createId: '',
    pendingCreate: null as CmsDraft | null,
    requiresResolution: false,
  });
  state.current.scope = scope;
  const install = useCallback((value: CmsArticle | null) => {
    const input = value ? draftOf(value) : emptyDraft();
    state.current.saved = value;
    state.current.requiresResolution = false;
    state.current.draft = input;
    state.current.edits++;
    setSaved(value);
    setDraft(input);
    setLatest(null);
    setError('');
  }, []);
  useEffect(() => {
    let alive = true;
    state.current.scope = scope;
    const cached = draftSessions.get(scope);
    state.current.busy = false;
    setSaving(false);
    setLoading(true);
    install(cached?.saved ?? null);
    state.current.createId = routeId === 'new' ? cached?.createId || crypto.randomUUID() : '';
    state.current.pendingCreate = cached?.pendingCreate ?? null;
    state.current.requiresResolution = cached?.requiresResolution ?? false;
    setCreatePending(!!state.current.pendingCreate);
    if (cached) {
      state.current.draft = cached.draft;
      setDraft(cached.draft);
      if (cached.requiresResolution && cached.saved) setLatest(cached.saved);
    }
    const cleanup = () => {
      alive = false;
      const current = state.current;
      current.scope = '';
      if (
        current.pendingCreate ||
        current.requiresResolution ||
        !sameDraft(current.draft, current.saved ? draftOf(current.saved) : emptyDraft())
      )
        draftSessions.set(scope, {
          saved: current.saved,
          draft: current.draft,
          createId: current.createId,
          pendingCreate: current.pendingCreate,
          requiresResolution: current.requiresResolution,
        });
      else draftSessions.delete(scope);
    };
    if (routeId === 'new') {
      setLoading(false);
      return cleanup;
    }
    void cmsHttp
      .article(routeId)
      .then((value) => {
        if (alive && state.current.scope === scope) {
          if (cached?.saved) {
            if (
              value.revision !== cached.saved.revision ||
              value.cms.revision !== cached.saved.cms.revision ||
              cached.requiresResolution
            )
              setLatest(value);
          } else install(value);
        }
      })
      .catch((e) => {
        if (alive && state.current.scope === scope) {
          setError(messageOf(e));
          failed(e);
        }
      })
      .finally(() => {
        if (alive && state.current.scope === scope) setLoading(false);
      });
    return cleanup;
  }, [scope, routeId, failed, install]);
  const observe = useCallback((value: CmsArticle) => {
    if (!state.current.scope) return;
    const before = state.current.saved;
    if (!before || value.id !== before.id) return;
    if (value.revision < before.revision || value.cms.revision < before.cms.revision) return;
    if (value.revision !== before.revision || value.cms.revision !== before.cms.revision)
      setLatest(value);
    else if (
      value.audio?.audioId !== before.audio?.audioId ||
      value.currentRuleVersion !== before.currentRuleVersion
    ) {
      state.current.saved = value;
      setSaved(value);
    }
  }, []);
  const remote = useRemoteCheck<CmsArticle>({
    enabled: !!saved && !saving && !remotePaused && routeId !== 'new',
    key: scope,
    load: () => cmsHttp.article(state.current.saved!.id),
    onValue: observe,
    onError: failed,
  });
  const edit = (value: CmsDraft) => {
    if (state.current.pendingCreate && !state.current.saved) return;
    state.current.edits++;
    state.current.draft = value;
    setDraft(value);
  };
  const save = async (resolved?: { draft: CmsDraft; base: CmsArticle }, stay = false) => {
    const current = state.current;
    if (current.busy) return null;
    if (current.requiresResolution && !resolved) {
      setError('这次新建对应的服务器内容不同，请先比较差异，整理后保存或明确载入服务器版本。');
      setConflictSerial((n) => n + 1);
      return null;
    }
    const previous = resolved?.base ?? current.saved;
    const input =
      !previous && current.pendingCreate
        ? current.pendingCreate
        : (resolved?.draft ?? current.draft);
    const parsed = articleSchema.safeParse(input);
    if (
      !parsed.success ||
      input.slug.length > 120 ||
      (input.slug.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug.trim()))
    ) {
      setError(
        parsed.success
          ? '链接标识只能包含小写英文字母、数字和单个连字符，最多 120 个字符；可在高级设置中留空自动生成。'
          : parsed.error.issues.map((i) => i.message).join(' '),
      );
      return null;
    }
    const submitted = { ...input, ...parsed.data, slug: input.slug.trim() };
    const capturedScope = current.scope,
      edits = current.edits;
    current.busy = true;
    setSaving(true);
    setError('');
    if (!previous) {
      current.pendingCreate ??= structuredClone(submitted);
      setCreatePending(true);
    }
    try {
      const value = previous
        ? await cmsHttp.save(previous.id, submitted, previous)
        : await cmsHttp.create(submitted, current.createId);
      if (state.current.scope !== capturedScope) return null;
      state.current.saved = value;
      state.current.pendingCreate = null;
      state.current.requiresResolution = false;
      setCreatePending(false);
      setSaved(value);
      setLatest(null);
      client.setQueryData(['article', accountId, value.id], value);
      void client.invalidateQueries({ queryKey: ['articles', accountId] });
      void client.invalidateQueries({ queryKey: ['cms', accountId] });
      if (state.current.edits !== edits) {
        setError('已保存提交时的内容；你随后做的修改仍未保存。');
        return null;
      }
      state.current.draft = draftOf(value);
      setDraft(draftOf(value));
      draftSessions.delete(capturedScope);
      if (routeId === 'new' && !stay) {
        allowNavigation();
        navigate(`/articles/${value.id}`, { replace: true });
      }
      return value;
    } catch (e) {
      if (state.current.scope !== capturedScope) return null;
      if (!previous && e instanceof ServiceError && rejectedCreate.has(e.code)) {
        state.current.pendingCreate = null;
        setCreatePending(false);
      }
      setError(
        e instanceof ServiceError && e.code === 'REVISION_CONFLICT'
          ? '文章已在另一窗口更新；你的草稿仍保留，请比较差异。'
          : e instanceof ServiceError && e.code === 'SLUG_CONFLICT'
            ? '链接标识已被另一篇文章使用，请在高级设置中修改；输入已保留。'
            : e instanceof ServiceError && e.code === 'SLUG_ALLOCATION_FAILED'
              ? '暂时未能分配唯一链接标识，文章未创建。请稍后重试或在高级设置中自定义。'
              : messageOf(e),
      );
      failed(e);
      if (!previous && e instanceof ServiceError && e.code === 'CREATE_REQUEST_CONFLICT') {
        try {
          const value = await cmsHttp.article(current.createId);
          if (state.current.scope === capturedScope) {
            state.current.saved = value;
            state.current.pendingCreate = null;
            state.current.requiresResolution = true;
            setSaved(value);
            setCreatePending(false);
            setLatest(value);
            setConflictSerial((n) => n + 1);
            setError(
              '已找到这次新建标识对应的文章，但服务器内容不同。当前输入保留，请比较差异后确认；未覆盖或另建文章。',
            );
          }
        } catch {
          if (state.current.scope === capturedScope)
            setError(
              '新建请求标识发生冲突，未覆盖或另建文章。当前输入保留，请先核对内容列表，再明确处理。',
            );
        }
      }
      if (
        e instanceof ServiceError &&
        ['REVISION_CONFLICT', 'CMS_REVISION_CONFLICT'].includes(e.code) &&
        previous
      ) {
        setConflictSerial((n) => n + 1);
        try {
          const value = await cmsHttp.article(previous.id);
          if (state.current.scope === capturedScope) setLatest(value);
        } catch (readError) {
          if (state.current.scope === capturedScope) {
            setError(messageOf(readError));
            failed(readError);
          }
        }
      }
      return null;
    } finally {
      if (state.current.scope === capturedScope) {
        state.current.busy = false;
        setSaving(false);
      }
    }
  };
  const dirty =
    createPending ||
    state.current.requiresResolution ||
    !sameDraft(draft, saved ? draftOf(saved) : emptyDraft());
  const refresh = async () => {
    if (!state.current.saved) return;
    const captured = state.current.scope;
    const value = await cmsHttp.article(state.current.saved.id);
    if (!captured || state.current.scope !== captured) return;
    observe(value);
    return value;
  };
  const adoptMetadata = (value: CmsArticle) => {
    if (!state.current.scope) return;
    const before = state.current.saved;
    if (!before || before.id !== value.id) return;
    if (value.revision < before.revision || value.cms.revision < before.cms.revision) return;
    if (!sameDraft(draftOf(before), draftOf(value))) {
      observe(value);
      return;
    }
    state.current.saved = value;
    setSaved(value);
    setLatest(state.current.requiresResolution ? value : null);
  };
  return {
    saved,
    draft,
    latest,
    loading,
    saving,
    createPending,
    error,
    dirty,
    edit,
    save,
    refresh,
    observe,
    adoptMetadata,
    conflictSerial,
    pauseRemote: setRemotePaused,
    check: remote.check,
    checking: remote.checking,
    checkError: remote.error,
    discard: () => {
      state.current.pendingCreate = null;
      setCreatePending(false);
      install(state.current.saved);
    },
    acceptLatest: () => {
      if (latest) install(latest);
    },
    read: () => state.current,
  };
}
