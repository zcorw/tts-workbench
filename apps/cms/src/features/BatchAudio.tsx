import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Modal } from '@workbench/components/shared';
import { messageOf, ServiceError, type Services } from '@workbench/types';
import type { CmsSummary } from './types';
import { cmsHttp } from './http';
import { audioBatchHttp } from './audioBatchHttp';
import {
  audioPlan,
  audioProgress,
  audioReason,
  audioStatus,
  audioSnapshotNeedsRefresh,
  definiteAudioRejection,
  failedAudioIds,
  type AudioBatch,
  type AudioBatchInput,
} from './audioBatch';

interface BatchAudioContextValue {
  open: (items: CmsSummary[], onCreated?: () => void) => void;
  unavailable: boolean;
}
const BatchAudioContext = createContext<BatchAudioContextValue | null>(null);
export const useBatchAudio = () => useContext(BatchAudioContext);

export function BatchAudioProvider({
  accountId,
  services,
  failed,
  onSubmittingChange,
  children,
}: {
  accountId: string;
  services: Services;
  failed: (error: unknown) => void;
  onSubmittingChange: (value: boolean) => void;
  children: (panel: ReactNode) => ReactNode;
}) {
  const client = useQueryClient();
  const key = ['cms', accountId, 'audio-batches'];
  const [draft, setDraft] = useState<{ items: CmsSummary[]; onCreated?: () => void } | null>(null);
  const [existingAudio, setExistingAudio] = useState<'skip' | 'replace'>('skip');
  const [preserveExisting, setPreserveExisting] = useState(true);
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [draftNotice, setDraftNotice] = useState('');
  const [needsDraftRefresh, setNeedsDraftRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readingRetry, setReadingRetry] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pending, setPending] = useState<AudioBatchInput | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const lock = useRef(false),
    alive = useRef(true);
  const pendingRef = useRef<AudioBatchInput | null>(null);
  const invalidatedAudio = useRef('');
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onSubmittingChange(false);
    };
  }, [onSubmittingChange]);
  const batches = useQuery({
    queryKey: key,
    queryFn: audioBatchHttp.list,
    refetchInterval: (query) =>
      query.state.data?.items.some((b) => b.status !== 'completed') ? 2000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const voices = useQuery({
    queryKey: ['voices', accountId],
    queryFn: () => services.voices(),
    enabled: !!draft,
    retry: false,
  });
  useEffect(() => {
    if (batches.error) failed(batches.error);
  }, [batches.error, failed]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void batches.refetch();
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [batches.refetch]);
  const records = batches.data?.items ?? [];
  useEffect(() => {
    const completed = (batches.data?.items ?? [])
      .flatMap((b) =>
        b.items
          .filter((i) => i.status === 'succeeded')
          .map((i) => `${i.articleId}:${i.audioId || ''}`),
      )
      .sort()
      .join('|');
    if (!completed || completed === invalidatedAudio.current) return;
    invalidatedAudio.current = completed;
    void client.invalidateQueries({ queryKey: ['cms', accountId, 'articles'] });
    void client.invalidateQueries({ queryKey: ['cms', accountId, 'article'] });
  }, [batches.data, client, accountId]);
  const active = records.find((b) => b.status !== 'completed');
  const selected = records.find((b) => b.id === selectedId) || active || records[0];
  const fallbackVoice = voice || voices.data?.[0]?.id || '';
  const options = {
    existingAudio,
    preserveExisting,
    voice: fallbackVoice,
    speed,
    voices: voices.data ?? [],
  };
  let planned: ReturnType<typeof audioPlan> = [],
    planError = '';
  if (draft)
    try {
      planned = audioPlan(draft.items, options);
    } catch (e) {
      planError = messageOf(e);
    }
  const skipped = draft?.items.filter((a) => existingAudio === 'skip' && a.audio).length ?? 0;

  const open = useCallback((items: CmsSummary[], onCreated?: () => void) => {
    if (!items.length || items.length > 20 || lock.current || pendingRef.current) return;
    setDraft({ items: structuredClone(items), onCreated });
    setExistingAudio('skip');
    setPreserveExisting(true);
    setVoice('');
    setSpeed(1);
    setConsent(false);
    setError('');
    setDraftNotice('');
    setNeedsDraftRefresh(false);
    setPending(null);
  }, []);
  const accept = (batch: AudioBatch) => {
    if (!alive.current) return;
    client.setQueryData<{ items: AudioBatch[] }>(key, (previous) => ({
      items: [batch, ...(previous?.items ?? []).filter((b) => b.id !== batch.id)].slice(0, 5),
    }));
    setSelectedId(batch.id);
    if (batch.id !== selected?.id) setExpanded(false);
    draft?.onCreated?.();
    setDraft(null);
    setPending(null);
    pendingRef.current = null;
    setError('');
    void client.invalidateQueries({ queryKey: ['cms', accountId] });
  };
  const rejectBeforeCreate = (e: unknown) => {
    if (!(e instanceof ServiceError) || !definiteAudioRejection(e.code)) return false;
    setPending(null);
    pendingRef.current = null;
    setConsent(false);
    setDraftNotice('');
    setNeedsDraftRefresh((value) => value || audioSnapshotNeedsRefresh(e.code));
    setError(
      `${audioReason(e.code) || messageOf(e)} 未创建新批次，请载入最新版本或调整后重新确认。`,
    );
    void batches.refetch();
    return true;
  };
  const refreshDraft = async () => {
    if (!draft || lock.current || pendingRef.current || readingRetry) return;
    const previous = draft;
    setReadingRetry(true);
    setConsent(false);
    setDraftNotice('');
    try {
      const latestVoices = await voices.refetch();
      if (latestVoices.error) throw latestVoices.error;
      const latest: CmsSummary[] = [];
      for (const article of previous.items) latest.push(await cmsHttp.article(article.id));
      if (alive.current) {
        setDraft((current) => (current === previous ? { ...current, items: latest } : current));
        setNeedsDraftRefresh(false);
        setError('');
        setDraftNotice(
          '已载入所选文章的最新版本，未提交生成。请重新核对范围、参数和规则版本并勾选确认。',
        );
      }
    } catch (e) {
      if (alive.current) {
        setError(`未能载入所选最新版本，未提交任何生成。请关闭后重新选择可读文章。${messageOf(e)}`);
        failed(e);
      }
    } finally {
      if (alive.current) setReadingRetry(false);
    }
  };
  const send = async (input: AudioBatchInput) => {
    if (lock.current) return;
    lock.current = true;
    onSubmittingChange(true);
    setBusy(true);
    setError('');
    setPending(input);
    pendingRef.current = input;
    try {
      accept(await audioBatchHttp.create(input));
    } catch (e) {
      if (alive.current) {
        if (!rejectBeforeCreate(e))
          setError(`未确认提交结果：${messageOf(e)} 请检查服务端任务；不会自动重发或创建新批次。`);
        failed(e);
      }
    } finally {
      lock.current = false;
      if (alive.current) {
        onSubmittingChange(false);
        setBusy(false);
      }
    }
  };
  const recover = async () => {
    if (!pending || lock.current) return;
    lock.current = true;
    onSubmittingChange(true);
    setBusy(true);
    let resentCreate = false;
    try {
      const result = await batches.refetch();
      if (result.error) throw result.error;
      const found = result.data?.items.find((b) => b.requestId === pending.requestId);
      if (found) accept(found);
      else {
        resentCreate = true;
        accept(await audioBatchHttp.create(pending)); // Same id and immutable payload, explicit action only.
      }
    } catch (e) {
      if (alive.current) {
        if (!resentCreate || !rejectBeforeCreate(e))
          setError(`仍未确认：${messageOf(e)} 请保留当前页面或重新进入查看真实任务。`);
        failed(e);
      }
    } finally {
      lock.current = false;
      if (alive.current) {
        onSubmittingChange(false);
        setBusy(false);
      }
    }
  };
  const retryFailed = async (batch: AudioBatch) => {
    if (readingRetry || active || lock.current || pendingRef.current) return;
    setReadingRetry(true);
    setError('');
    try {
      const latest: CmsSummary[] = [];
      for (const id of failedAudioIds(batch)) latest.push(await cmsHttp.article(id));
      if (alive.current) open(latest);
    } catch (e) {
      if (alive.current) {
        setError(`未能载入失败项最新版本，未提交任何重试。${messageOf(e)}`);
        failed(e);
      }
    } finally {
      if (alive.current) setReadingRetry(false);
    }
  };
  const cancel = async (batch: AudioBatch) => {
    if (cancelling) return;
    setCancelling(true);
    setError('');
    try {
      accept(await audioBatchHttp.cancel(batch.id));
    } catch (e) {
      if (alive.current) {
        setError(`停止请求未确认：${messageOf(e)} 请刷新任务状态。`);
        failed(e);
      }
    } finally {
      if (alive.current) setCancelling(false);
    }
  };
  const progress = selected ? audioProgress(selected) : null;
  const uncertain = selected?.items.filter((item) => item.status === 'uncertain').length ?? 0;
  const batchSkipped = selected?.items.filter((item) => item.status === 'skipped').length ?? 0;
  const cancelled = selected?.items.filter((item) => item.status === 'cancelled').length ?? 0;
  return (
    <BatchAudioContext.Provider
      value={{
        open,
        unavailable:
          !!active || batches.isPending || !!batches.error || busy || readingRetry || !!pending,
      }}
    >
      {children(
        <section
          className="cms-audio-batch-panel"
          id="cmsAudioBatchPanel"
          aria-labelledby="cmsAudioBatchHeading"
        >
          <div className="cms-audio-batch-header">
            <h2 id="cmsAudioBatchHeading">批量音频任务</h2>
            <div className="cms-audio-batch-tools">
              {selected && (
                <button
                  className="text-button"
                  id="cmsAudioBatchToggle"
                  aria-expanded={expanded}
                  aria-controls="cmsAudioBatchDetails"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? '收起详情' : '查看详情'}
                </button>
              )}
              <button
                className="text-button"
                id="cmsAudioBatchRefresh"
                onClick={() => void batches.refetch()}
                disabled={batches.isFetching}
              >
                刷新
              </button>
            </div>
          </div>
          <ErrorNotice
            message={
              error || (batches.error ? `无法读取任务状态：${messageOf(batches.error)}` : '')
            }
          />
          {pending && !draft && (
            <div className="cms-audio-uncertain">
              <p>有一次提交结果尚未确认；不会创建新批次，请核对并恢复同一提交。</p>
              <button className="button secondary" disabled={busy} onClick={() => void recover()}>
                核对并恢复同一提交
              </button>
            </div>
          )}
          {!selected && !batches.isPending && !batches.error && (
            <p className="small-note cms-audio-empty">暂无任务，在“内容”页选择文章后开始。</p>
          )}
          {selected && progress && (
            <>
              <p
                className="cms-audio-batch-summary"
                id="cmsAudioBatchSummary"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <strong>
                  {selected.status === 'completed'
                    ? '处理结束'
                    : selected.status === 'queued'
                      ? '排队中'
                      : '处理中'}
                </strong>
                <span>
                  已处理 {progress.settled} / {progress.total} 篇 · 成功 {progress.succeeded} 篇
                </span>
                {progress.failed > 0 && (
                  <strong className="cms-audio-batch-alert">失败 {progress.failed} 篇</strong>
                )}
                {uncertain > 0 && (
                  <strong className="cms-audio-batch-alert">
                    结果不确定 {uncertain} 篇（可能已产生费用）
                  </strong>
                )}
                {batchSkipped > 0 && <span>跳过 {batchSkipped} 篇</span>}
                {cancelled > 0 && <span>已停止 {cancelled} 篇</span>}
              </p>
              <progress
                id="cmsAudioBatchProgress"
                className={`cms-audio-progress${progress.failed || uncertain ? ' has-issues' : ''}`}
                max={progress.total || 1}
                value={progress.settled}
                aria-label="批量音频处理进度"
                aria-valuetext={`已处理 ${progress.settled}/${progress.total} 篇，成功 ${progress.succeeded} 篇，失败 ${progress.failed} 篇，结果不确定 ${uncertain} 篇，跳过 ${batchSkipped} 篇，已停止 ${cancelled} 篇`}
              />
              {((selected.status !== 'completed' && progress.queued > 0) ||
                (selected.status === 'completed' && failedAudioIds(selected).length > 0)) && (
                <div className="cms-audio-batch-actions">
                  {selected.status !== 'completed' && progress.queued > 0 && (
                    <button
                      className="text-button"
                      id="cmsAudioBatchCancel"
                      disabled={cancelling}
                      aria-describedby="cmsAudioCancelNote"
                      onClick={() => void cancel(selected)}
                    >
                      停止未开始的 {progress.queued} 篇
                    </button>
                  )}
                  {selected.status === 'completed' && failedAudioIds(selected).length > 0 && (
                    <button
                      className="text-button"
                      id="cmsAudioBatchRetry"
                      disabled={readingRetry || !!active || busy || !!pending}
                      onClick={() => void retryFailed(selected)}
                    >
                      重新确认失败项…
                    </button>
                  )}
                </div>
              )}
              <span id="cmsAudioCancelNote" className="sr-only">
                只取消排队项；正在生成的文章继续处理，已经产生的费用不能撤回。
              </span>
              <div id="cmsAudioBatchDetails" className="cms-audio-batch-details" hidden={!expanded}>
                <p className="small-note">
                  服务端逐篇处理；可切换页面或刷新后回来查看。只更新编辑稿音频，阅读库固定版本保持原样。
                </p>
                {records.length > 1 && (
                  <label className="cms-field">
                    最近任务
                    <select
                      id="cmsAudioBatchHistory"
                      value={selected.id}
                      onChange={(event) => setSelectedId(event.target.value)}
                    >
                      {records.map((batch) => (
                        <option key={batch.id} value={batch.id}>
                          {new Date(batch.createdAt).toLocaleString()} · {batch.items.length} 篇 ·{' '}
                          {batch.status === 'completed' ? '已结束' : '处理中'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <ol className="cms-audio-batch-items" id="cmsAudioBatchItems">
                  {selected.items.map((item) => (
                    <li key={item.articleId} data-audio-status={item.status}>
                      <Link to={`/articles/${item.articleId}`}>{item.title}</Link>
                      <span className={`cms-audio-status is-${item.status}`}>
                        {audioStatus[item.status]}
                      </span>
                      <small>
                        正文 v{item.expectedRevision} · 规则 v{item.expectedRuleVersion} ·{' '}
                        {item.voice} / {item.speed.toFixed(2)}×
                      </small>
                      {item.errorCode && <p>{audioReason(item.errorCode)}</p>}
                      {item.status === 'uncertain' && (
                        <p>结果可能已产生费用；请打开文章核对音频，不自动重试此项。</p>
                      )}
                    </li>
                  ))}
                </ol>
                {selected.status !== 'completed' && (
                  <p className="small-note">
                    停止仅取消未开始项。正在生成的文章继续处理，已经产生的费用不能撤回。
                  </p>
                )}
              </div>
            </>
          )}
        </section>,
      )}
      {draft && (
        <Modal
          id="cmsAudioBatchConfirm"
          title="批量生成所选编辑稿的音频？"
          busy={busy}
          onClose={() => setDraft(null)}
        >
          <p>
            本次只处理以下 {draft.items.length}{' '}
            篇已保存编辑稿。不保存本地未保存输入，不发布正文，也不更改阅读库已发布音频。
          </p>
          <div className="cms-two-columns">
            <label className="cms-field">
              已有音频
              <select
                id="cmsAudioExistingMode"
                value={existingAudio}
                disabled={busy || !!pending}
                onChange={(e) => {
                  setExistingAudio(e.target.value as 'skip' | 'replace');
                  setConsent(false);
                }}
              >
                <option value="skip">跳过所有已有音频（包括过期音频）</option>
                <option value="replace">明确重新生成已有音频</option>
              </select>
            </label>
            <label className="cms-field">
              无音频或统一设置的声音
              <select
                id="cmsAudioVoice"
                value={fallbackVoice}
                disabled={busy || !!pending || voices.isPending}
                onChange={(e) => {
                  setVoice(e.target.value);
                  setConsent(false);
                }}
              >
                {voices.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="cms-field">
              语速
              <input
                id="cmsAudioSpeed"
                type="number"
                min="0.5"
                max="2"
                step="0.01"
                value={speed}
                disabled={busy || !!pending}
                onChange={(e) => {
                  setSpeed(e.target.valueAsNumber);
                  setConsent(false);
                }}
              />
            </label>
          </div>
          <label className="cms-check">
            <input
              id="cmsAudioPreserve"
              type="checkbox"
              checked={preserveExisting}
              disabled={busy || !!pending}
              onChange={(e) => {
                setPreserveExisting(e.target.checked);
                setConsent(false);
              }}
            />
            重新生成时沿用每篇已有音频的声音与速度；无音频者使用上方设置
          </label>
          <p className="small-note">
            文章没有另存声音设置；“沿用”取自当前音频元数据。个人发音规则由工作台管理，开工前检查下面确认的规则版本。
          </p>
          <ul className="cms-audio-confirm-items">
            {draft.items.map((a, index) => (
              <li key={a.id}>
                <strong>{a.title}</strong>
                <small>
                  正文 v{a.revision} · 规则 v{a.currentRuleVersion} ·{' '}
                  {a.cms.publishedReleaseId ? '已有阅读库版本，本次保持不变' : '未上线'}
                  <br />
                  现有：
                  {a.audio
                    ? `${a.audio.voice} / ${a.audio.speed.toFixed(2)}×${a.audioStale ? '（已过期）' : ''}`
                    : '无音频'}
                  <br />
                  本次：
                  {existingAudio === 'skip' && a.audio
                    ? '跳过'
                    : planned[index]
                      ? `${planned[index].voice} / ${planned[index].speed.toFixed(2)}×`
                      : '请检查设置'}
                </small>
              </li>
            ))}
          </ul>
          <p>
            预计生成 {draft.items.length - skipped} 篇，跳过 {skipped}{' '}
            篇。按各篇已保存正文与现有供应商计费方式消耗额度；不提供虚构报价。重新生成仅在成功后替换编辑稿旧音频，失败保留旧音频。
          </p>
          <label className="cms-check">
            <input
              id="cmsAudioConsent"
              type="checkbox"
              checked={consent}
              disabled={busy || !!pending}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我已核对范围、参数、规则版本和额度消耗；
            {existingAudio === 'replace' ? '允许成功后替换所选已有编辑稿音频' : '已有音频保持不变'}
            。阅读库需另行上线才更新。
          </label>
          <ErrorNotice
            id="cmsAudioSubmitError"
            message={
              error || (voices.error ? `无法读取可用声音：${messageOf(voices.error)}` : planError)
            }
          />
          {draftNotice && (
            <p id="cmsAudioDraftNotice" role="status">
              {draftNotice}
            </p>
          )}
          {!pending && (
            <button
              id="cmsAudioRefreshDraft"
              className="button secondary"
              disabled={busy || readingRetry}
              onClick={() => void refreshDraft()}
            >
              {readingRetry ? '正在载入所选最新版本…' : '载入所选文章最新版本'}
            </button>
          )}
          {pending && !busy && (
            <div className="cms-audio-uncertain">
              <p>
                提交结果尚未确认。保持原请求编号，先查询服务端，未找到时仅重发同一幂等请求，不新增批次。
              </p>
              <button
                id="cmsAudioRecover"
                className="button secondary"
                onClick={() => void recover()}
              >
                核对并恢复同一提交
              </button>
              <button className="text-button" onClick={() => setDraft(null)}>
                关闭并在任务面板核对
              </button>
            </div>
          )}
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={busy || !!pending}
              onClick={() => setDraft(null)}
            >
              取消
            </button>
            <button
              id="cmsAudioSubmit"
              className="button primary"
              disabled={
                !consent ||
                !!planError ||
                voices.isPending ||
                !!voices.error ||
                busy ||
                !!pending ||
                !!active ||
                readingRetry ||
                needsDraftRefresh
              }
              onClick={() =>
                void send({ requestId: crypto.randomUUID(), existingAudio, items: planned })
              }
            >
              {busy ? '正在登记任务…' : '确认排队生成'}
            </button>
          </div>
        </Modal>
      )}
    </BatchAudioContext.Provider>
  );
}
