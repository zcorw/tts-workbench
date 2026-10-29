import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { articleSchema } from '@workbench/forms';
import { ServiceError, messageOf } from '@workbench/types';
import { useRemoteCheck } from '@workbench/useRemoteCheck';
import { cmsHttp } from './http';
import { draftOf, emptyDraft, sameDraft, type CmsArticle, type CmsDraft } from './types';

// Unsaved drafts survive a session-expiry login screen in memory, scoped by account.
const draftSessions = new Map<string, { saved: CmsArticle | null; draft: CmsDraft }>();

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
  const [remotePaused, setRemotePaused] = useState(false);
  const state = useRef({ scope, saved, draft, edits: 0, busy: false });
  state.current.scope = scope;
  const install = useCallback((value: CmsArticle | null) => {
    const input = value ? draftOf(value) : emptyDraft();
    state.current.saved = value;
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
    if (cached) {
      state.current.draft = cached.draft;
      setDraft(cached.draft);
    }
    const cleanup = () => {
      alive = false;
      const current = state.current;
      current.scope = '';
      if (!sameDraft(current.draft, current.saved ? draftOf(current.saved) : emptyDraft()))
        draftSessions.set(scope, { saved: current.saved, draft: current.draft });
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
              value.cms.revision !== cached.saved.cms.revision
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
    state.current.edits++;
    state.current.draft = value;
    setDraft(value);
  };
  const save = async (resolved?: { draft: CmsDraft; base: CmsArticle }, stay = false) => {
    const current = state.current;
    if (current.busy) return null;
    const input = resolved?.draft ?? current.draft;
    const parsed = articleSchema.safeParse(input);
    if (!parsed.success || !input.slug.trim()) {
      setError(
        parsed.success
          ? '请填写文章链接标识。'
          : parsed.error.issues.map((i) => i.message).join(' '),
      );
      return null;
    }
    const submitted = { ...input, ...parsed.data };
    const previous = resolved?.base ?? current.saved;
    const capturedScope = current.scope,
      edits = current.edits;
    current.busy = true;
    setSaving(true);
    setError('');
    try {
      const value = previous
        ? await cmsHttp.save(previous.id, submitted, previous)
        : await cmsHttp.create(submitted);
      if (state.current.scope !== capturedScope) return null;
      state.current.saved = value;
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
      setError(
        e instanceof ServiceError && e.code === 'REVISION_CONFLICT'
          ? '文章已在另一窗口更新；你的草稿仍保留，请比较差异。'
          : messageOf(e),
      );
      failed(e);
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
  const dirty = !sameDraft(draft, saved ? draftOf(saved) : emptyDraft());
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
    setLatest(null);
  };
  return {
    saved,
    draft,
    latest,
    loading,
    saving,
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
    discard: () => install(state.current.saved),
    acceptLatest: () => {
      if (latest) install(latest);
    },
    read: () => state.current,
  };
}
