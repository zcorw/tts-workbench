import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { messageOf, ServiceError, type ArticleAudio, type Services, type Voice } from './types';
import type { useArticleDocument } from './useArticleDocument';
import type { AudioResult } from './components/AudioPlayer';

type Document = ReturnType<typeof useArticleDocument>;
export function useArticleAudio(
  services: Services,
  accountId: string | undefined,
  doc: Document,
  voices: Voice[],
  ruleVersion: number,
  failed: (e: unknown) => void,
) {
  const client = useQueryClient();
  const [voice, setVoice] = useState(''),
    [speed, setSpeed] = useState(1);
  const [result, setResult] = useState<AudioResult | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [serverState, setServerState] = useState({ contentRevision: 0, ruleVersion: 0 });
  const sequence = useRef(0),
    locked = useRef(false),
    fromAudio = useRef(false);
  const initialized = useRef<number | null>(null);
  const settingsEdits = useRef(0);
  const scope = useRef({ accountId, routeId: '' });
  const live = useRef({ accountId, doc });
  live.current = { accountId, doc };
  const clear = () => {
    sequence.current++;
    locked.current = false;
    setBusy(false);
    setLoading(false);
    setError('');
    setResult(null);
    initialized.current = null;
    fromAudio.current = false;
    setServerState({ contentRevision: 0, ruleVersion: 0 });
  };
  useLayoutEffect(() => {
    const previous = scope.current;
    if (
      previous.accountId !== accountId ||
      !(previous.routeId === 'new' && doc.saved?.id === doc.routeId)
    )
      clear();
    scope.current = { accountId, routeId: doc.routeId };
  }, [accountId, doc.routeId]);
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result?.url],
  );
  useEffect(() => {
    if (!fromAudio.current && !voice) setVoice(voices[0]?.id || '');
  }, [voices, voice]);
  const current = (ticket: number, owner: string, id: string) =>
    sequence.current === ticket &&
    live.current.accountId === owner &&
    live.current.doc.active &&
    live.current.doc.read().saved?.id === id;
  function remember(contentRevision: number, currentRuleVersion: number) {
    setServerState({ contentRevision, ruleVersion: currentRuleVersion });
    if (currentRuleVersion !== ruleVersion)
      void client.invalidateQueries({ queryKey: ['rules', accountId] });
  }
  async function fetchBytes(
    id: string,
    metadata: ArticleAudio,
    ticket: number,
    owner: string,
    edits: number,
    restoreSettings?: number,
  ) {
    let audio = metadata;
    let media;
    try {
      media = await services.articleAudio(id, audio);
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === 'NOT_FOUND') || !current(ticket, owner, id))
        throw e;
      const latest = await services.article(id);
      if (!current(ticket, owner, id)) return;
      remember(latest.contentRevision, latest.currentRuleVersion);
      if (!latest.audio) throw new ServiceError('这篇文章尚无已保存音频。');
      audio = latest.audio;
      media = await services.articleAudio(id, audio);
    }
    if (!current(ticket, owner, id)) return;
    if (live.current.doc.read().textEdits !== edits) {
      setError('载入期间正文又有修改。当前草稿已保留，可重新载入已保存音频。');
      return;
    }
    if (restoreSettings !== undefined && settingsEdits.current === restoreSettings) {
      fromAudio.current = true;
      setVoice(audio.voice);
      setSpeed(audio.speed);
    }
    setResult({
      url: URL.createObjectURL(media.blob),
      filename: media.filename,
      audioId: audio.audioId,
      contentRevision: audio.contentRevision,
      version: audio.ruleVersion,
      voice: audio.voice,
      count: audio.characterCount,
      speed: audio.speed,
      time: new Date(audio.createdAt).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      requestId: media.requestId,
    });
  }
  async function load(metadata?: ArticleAudio | null, initial = false) {
    const active = live.current.doc.read().saved,
      owner = live.current.accountId;
    if (!active || !owner || locked.current) return;
    const ticket = ++sequence.current,
      edits = live.current.doc.read().textEdits,
      preferences = settingsEdits.current;
    setLoading(true);
    setError('');
    try {
      let audio = metadata;
      if (!initial) {
        const latest = await services.article(active.id);
        if (!current(ticket, owner, active.id)) return;
        remember(latest.contentRevision, latest.currentRuleVersion);
        audio = latest.audio;
      }
      if (audio)
        await fetchBytes(active.id, audio, ticket, owner, edits, initial ? preferences : undefined);
      else if (current(ticket, owner, active.id)) {
        setResult(null);
        if (!initial) setError('这篇文章尚无已保存音频。');
      }
    } catch (e) {
      if (current(ticket, owner, active.id)) {
        setError(messageOf(e));
        failed(e);
      }
    } finally {
      if (sequence.current === ticket) setLoading(false);
    }
  }
  useEffect(() => {
    if (!accountId || !doc.ready || initialized.current === doc.loadVersion) return;
    initialized.current = doc.loadVersion;
    sequence.current++;
    locked.current = false;
    setBusy(false);
    setLoading(false);
    const saved = doc.read().saved;
    if (saved?.audio) {
      fromAudio.current = true;
      setVoice(saved.audio.voice);
      setSpeed(saved.audio.speed);
      remember(saved.contentRevision, saved.currentRuleVersion);
      void load(saved.audio, true);
    } else {
      fromAudio.current = false;
      setVoice(voices[0]?.id || '');
      setSpeed(1);
    }
  }, [accountId, doc.ready, doc.loadVersion, doc.routeId]);
  const generation = useMutation({
    mutationFn: (input: { id: string; revision: number; voice: string; speed: number }) =>
      services.generateArticleAudio(input.id, input.revision, input.voice, input.speed),
    retry: false,
  });
  async function generate() {
    if (locked.current || doc.saving || !accountId || !doc.ready || !doc.draft.text.trim()) return;
    locked.current = true;
    setBusy(true);
    setLoading(false);
    setError('');
    const owner = accountId,
      ticket = ++sequence.current;
    let id = doc.read().saved?.id || '';
    try {
      const before = doc.read();
      if (
        !before.saved ||
        before.draft.title !== before.saved.title ||
        before.draft.text !== before.saved.text
      ) {
        if (!(await doc.save())) return;
      }
      const snapshot = live.current.doc.read(),
        saved = snapshot.saved;
      if (!saved || live.current.accountId !== owner || sequence.current !== ticket) return;
      id = saved.id;
      const edits = snapshot.textEdits;
      const response = await generation.mutateAsync({ id, revision: saved.revision, voice, speed });
      if (!current(ticket, owner, id)) return;
      void client.invalidateQueries({ queryKey: ['articles', owner] });
      remember(response.contentRevision, response.currentRuleVersion);
      if (live.current.doc.read().textEdits !== edits) {
        setError('音频已生成，但正文又有修改。当前草稿已保留，可重新载入已保存音频。');
        return;
      }
      await fetchBytes(id, response.audio, ticket, owner, edits);
    } catch (e) {
      if (sequence.current === ticket && live.current.accountId === owner) {
        const conflict =
          e instanceof ServiceError &&
          ['REVISION_CONFLICT', 'ARTICLE_CONTENT_CHANGED'].includes(e.code);
        if (conflict) live.current.doc.reportConflict();
        setError(
          conflict ? '文章版本已变化，本次生成未替换音频。请确认最新正文后再试。' : messageOf(e),
        );
        failed(e);
      }
    } finally {
      if (sequence.current === ticket) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  const saved = doc.saved;
  const stale =
    !!result &&
    (result.contentRevision !== saved?.contentRevision ||
      doc.draft.text !== saved?.text ||
      (serverState.contentRevision > 0 && result.contentRevision !== serverState.contentRevision) ||
      result.version !==
        Math.max(ruleVersion, saved?.currentRuleVersion || 0, serverState.ruleVersion) ||
      result.voice !== voice ||
      result.speed !== speed);
  return {
    voice,
    speed,
    setVoice: (value: string) => {
      settingsEdits.current++;
      setVoice(value);
    },
    setSpeed: (value: number) => {
      settingsEdits.current++;
      setSpeed(value);
    },
    result,
    busy,
    loading,
    error,
    stale,
    generate,
    reload: () => void load(),
    clear,
  };
}
