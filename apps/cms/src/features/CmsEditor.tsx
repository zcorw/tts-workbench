import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioPlayer } from '@workbench/components/AudioPlayer';
import { ErrorNotice, Modal } from '@workbench/components/shared';
import { messageOf, type Services } from '@workbench/types';
import { cmsHttp } from './http';
import { ReleasePlayer, useCmsMedia } from './media';
import {
  draftOf,
  sameDraft,
  type CmsArticle,
  type CmsDraft,
  type CmsRelease,
  type NavigationGuard,
  type Taxonomy,
} from './types';
import { useCmsDocument } from './useCmsDocument';
import { workbenchHref } from '../links';
import { categoryEntries } from './categoryTree';

const labels: Record<keyof CmsDraft, string> = {
  title: '标题',
  text: '日文正文',
  slug: '链接标识',
  summary: '摘要',
  categoryId: '栏目',
  tagIds: '标签',
};
const fields = Object.keys(labels) as (keyof CmsDraft)[];
const valueText = (v: CmsDraft[keyof CmsDraft]) =>
  Array.isArray(v) ? v.join(', ') : (v ?? '未分类');
function rebase(base: CmsArticle, draft: CmsDraft, latest: CmsArticle): CmsDraft {
  const previous = draftOf(base),
    remote = draftOf(latest),
    result = { ...draft };
  for (const field of fields)
    if (JSON.stringify(draft[field]) === JSON.stringify(previous[field]))
      Object.assign(result, { [field]: remote[field] });
  return result;
}
function CmsFields({
  draft,
  onChange,
  taxonomy,
  prefix = 'cms',
}: {
  draft: CmsDraft;
  onChange: (d: CmsDraft) => void;
  taxonomy?: Taxonomy;
  prefix?: string;
}) {
  return (
    <div className="cms-fields">
      <label className="cms-field">
        标题
        <input
          id={`${prefix}Title`}
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      <label className="cms-field">
        日文正文
        <textarea
          id={`${prefix}Text`}
          lang="ja"
          rows={14}
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      </label>
      <p className="small-note">
        {[...draft.text].length} / 10000 字符；保留原文和换行。个人读法由原工作台管理。
      </p>
      <div className="cms-two-columns">
        <label className="cms-field">
          链接标识
          <input
            id={`${prefix}Slug`}
            value={draft.slug}
            onChange={(e) => onChange({ ...draft, slug: e.target.value })}
          />
        </label>
        <label className="cms-field">
          栏目
          <select
            id={`${prefix}Category`}
            value={draft.categoryId ?? ''}
            onChange={(e) => onChange({ ...draft, categoryId: e.target.value || null })}
          >
            <option value="">未分类</option>
            {categoryEntries(taxonomy?.categories ?? []).map(({ category, path }) => (
              <option key={category.id} value={category.id}>
                {path.join(' / ')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="cms-field">
        摘要
        <textarea
          id={`${prefix}Summary`}
          rows={3}
          value={draft.summary}
          onChange={(e) => onChange({ ...draft, summary: e.target.value })}
        />
      </label>
      <fieldset className="cms-tags">
        <legend>标签</legend>
        {taxonomy?.tags.map((t) => (
          <label key={t.id}>
            <input
              type="checkbox"
              checked={draft.tagIds.includes(t.id)}
              onChange={(e) =>
                onChange({
                  ...draft,
                  tagIds: e.target.checked
                    ? [...draft.tagIds, t.id].sort()
                    : draft.tagIds.filter((id) => id !== t.id),
                })
              }
            />
            {t.name}
          </label>
        ))}
        {!taxonomy?.tags.length && <span className="small-note">可在分类管理页添加标签。</span>}
      </fieldset>
    </div>
  );
}
export function CmsEditor({
  accountId,
  id,
  services,
  failed,
  onGuardChange,
  allowNavigation,
}: {
  accountId: string;
  id: string;
  services: Services;
  failed: (e: unknown) => void;
  onGuardChange: (guard: NavigationGuard | undefined) => void;
  allowNavigation: () => void;
}) {
  const doc = useCmsDocument(accountId, id, failed, allowNavigation),
    client = useQueryClient(),
    navigate = useNavigate();
  const live = useRef(doc);
  live.current = doc;
  useEffect(() => {
    onGuardChange({
      dirty: doc.dirty,
      saving: doc.saving,
      save: async () => !!(await live.current.save(undefined, true)),
      discard: () => live.current.discard(),
    });
    return () => onGuardChange(undefined);
  }, [doc.dirty, doc.saving, onGuardChange]);
  const taxonomy = useQuery({
    queryKey: ['cms', accountId, 'taxonomy'],
    queryFn: cmsHttp.taxonomy,
  });
  const voices = useQuery({
    queryKey: ['voices', accountId],
    queryFn: () => services.voices(),
  });
  const releases = useQuery({
    queryKey: ['cms', accountId, 'releases', doc.saved?.id],
    queryFn: () => cmsHttp.releases(doc.saved!.id),
    enabled: !!doc.saved,
  });
  const [voice, setVoice] = useState(''),
    [speed, setSpeed] = useState(1),
    [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false);
  const [publish, setPublish] = useState<CmsArticle | null>(null),
    [withoutAudio, setWithoutAudio] = useState(false),
    [unpublish, setUnpublish] = useState(false);
  const [viewRelease, setViewRelease] = useState<CmsRelease | null>(null),
    [deleteRelease, setDeleteRelease] = useState<CmsRelease | null>(null);
  const [target, setTarget] = useState<CmsArticle | null>(null),
    [merged, setMerged] = useState<CmsDraft>(doc.draft);
  const handled = useRef(0),
    scope = useRef(`${accountId}/${id}`),
    epoch = useRef(0);
  const currentScope = `${accountId}/${id}`;
  scope.current = currentScope;
  const media = useCmsMedia(currentScope);
  useEffect(() => {
    epoch.current++;
    setBusy(false);
    setActionError('');
    setViewRelease(null);
    setDeleteRelease(null);
    setTarget(null);
    setPublish(null);
    setUnpublish(false);
    handled.current = 0;
    return () => {
      epoch.current++;
      scope.current = '';
    };
  }, [currentScope]);
  useEffect(() => {
    if (!voice && voices.data?.length) setVoice(voices.data[0].id);
  }, [voice, voices.data]);
  useEffect(() => {
    const saved = doc.saved;
    if (saved?.audio) {
      setVoice(saved.audio.voice);
      setSpeed(saved.audio.speed);
      void media.load(saved.audio, () => services.articleAudio(saved.id, saved.audio!));
    }
  }, [doc.saved?.id]);
  useEffect(() => {
    if (doc.conflictSerial > handled.current && doc.latest && doc.saved) {
      handled.current = doc.conflictSerial;
      setTarget(doc.latest);
      setMerged(rebase(doc.saved, doc.draft, doc.latest));
    }
  }, [doc.conflictSerial, doc.latest, doc.saved, doc.draft]);
  const afterAction = async () => {
    const captured = scope.current;
    const previous = live.current.saved;
    if (!previous) return;
    const value = await cmsHttp.article(previous.id);
    if (!captured || captured !== scope.current) return;
    live.current.adoptMetadata(value);
    await client.invalidateQueries({ queryKey: ['cms', accountId] });
    void client.invalidateQueries({ queryKey: ['articles', accountId] });
  };
  const action = async (fn: () => Promise<void>) => {
    const token = ++epoch.current,
      captured = scope.current;
    setBusy(true);
    live.current.pauseRemote(true);
    setActionError('');
    try {
      await fn();
    } catch (e) {
      if (token === epoch.current && captured === scope.current) {
        setActionError(messageOf(e));
        failed(e);
        void live.current.check();
      }
    } finally {
      if (token === epoch.current && captured === scope.current) {
        setBusy(false);
        live.current.pauseRemote(false);
      }
    }
  };
  const generate = () =>
    action(async () => {
      const captured = scope.current;
      const saved = await live.current.save(undefined, true);
      if (!saved || captured !== scope.current) return;
      const edits = live.current.read().edits;
      const response = await services.generateArticleAudio(saved.id, saved.revision, voice, speed);
      if (captured !== scope.current) return;
      await afterAction();
      if (live.current.read().edits !== edits) {
        setActionError('音频已生成，但你又修改了草稿；请按需载入已保存音频。');
        return;
      }
      if (id === 'new') {
        allowNavigation();
        navigate(`/articles/${saved.id}`, { replace: true });
        return;
      }
      await media.load(response.audio, () => services.articleAudio(saved.id, response.audio));
    });
  const saved = doc.saved,
    latest = doc.latest;
  const publishAudioMatches =
    !!publish?.audio &&
    !publish.audioStale &&
    publish.audio.voice === voice &&
    publish.audio.speed === speed;
  const publicationChanged =
    !!publish &&
    !!saved &&
    (publish.revision !== saved.revision ||
      publish.cms.revision !== saved.cms.revision ||
      publish.audio?.audioId !== saved.audio?.audioId ||
      !!latest);
  const stale =
    !!media.result &&
    (!saved ||
      media.result.contentRevision !== saved.contentRevision ||
      doc.draft.text !== saved.text ||
      media.result.version !== saved.currentRuleVersion ||
      media.result.voice !== voice ||
      media.result.speed !== speed);
  const currentRelease = releases.data?.items.find((r) => r.id === saved?.cms.publishedReleaseId);
  const publishedDiff =
    !!saved &&
    !!currentRelease &&
    !sameDraft(draftOf(saved), {
      title: currentRelease.title,
      text: currentRelease.text,
      slug: currentRelease.cms.slug,
      summary: currentRelease.cms.summary,
      categoryId: currentRelease.cms.category?.id ?? null,
      tagIds: currentRelease.cms.tags.map((t) => t.id).sort(),
    });
  if (doc.loading) return <p role="status">正在载入 CMS 文章…</p>;
  if (!saved && id !== 'new') return <ErrorNotice message={doc.error || '无法读取文章。'} />;
  return (
    <section className="cms-editor">
      <div className="cms-row">
        <h2>{id === 'new' ? '手工新建' : '普通文章编辑'}</h2>
        <Link to="/articles">← 返回内容列表</Link>
      </div>
      <div className="cms-status" role="status">
        {doc.saving ? '正在保存…' : doc.dirty ? '有未保存修改' : '已保存'} ·{' '}
        {saved?.cms.publishedReleaseId
          ? publishedDiff
            ? '草稿与当前发布不同'
            : '已有固定发布版本'
          : '尚未发布'}
      </div>
      {latest && (
        <div className="cms-warning" role="status">
          另一编辑器已更新文章或栏目信息。当前输入保留。
          <button
            id="cmsCompare"
            className="text-button"
            onClick={() => {
              setTarget(latest);
              setMerged(saved ? rebase(saved, doc.draft, latest) : doc.draft);
            }}
          >
            查看差异并处理
          </button>
        </div>
      )}
      {!!doc.checkError && (
        <div className="cms-warning">
          暂时无法确认服务器最新版本。
          <button className="text-button" onClick={() => void doc.check()}>
            重新检查
          </button>
        </div>
      )}
      <ErrorNotice
        message={doc.error || actionError || (taxonomy.error ? messageOf(taxonomy.error) : '')}
      />
      <CmsFields draft={doc.draft} onChange={doc.edit} taxonomy={taxonomy.data} />
      <div className="cms-actions">
        <button
          id="cmsSave"
          className="button primary"
          disabled={doc.saving || busy}
          onClick={() => void doc.save()}
        >
          保存正文与 CMS 信息
        </button>
        {saved && (
          <a
            href={workbenchHref(saved.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="button secondary"
          >
            在语音工作台精细编辑 ↗
          </a>
        )}
        <button
          className="text-button"
          disabled={doc.checking || !saved}
          onClick={() => void doc.check()}
        >
          检查最新版本
        </button>
      </div>
      <section className="cms-panel">
        <h3>语音生成与播放</h3>
        <p className="small-note">
          使用原有日文 TTS 与个人读法。点击生成会先保存当前输入；不会自动重试付费生成。
        </p>
        <div className="cms-filters">
          <label>
            音色
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>
              {!voices.data?.length && <option value="">暂无可用音色</option>}
              {voice && !voices.data?.some((v) => v.id === voice) && (
                <option value={voice}>上次音色（当前不可用）</option>
              )}
              {voices.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            语速
            <input
              type="number"
              min={0.5}
              max={2}
              step={0.01}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>
          <button
            id="cmsGenerate"
            className="button primary"
            disabled={
              busy ||
              doc.saving ||
              !voice ||
              !voices.data?.some((v) => v.id === voice) ||
              !doc.draft.text.trim()
            }
            onClick={() => void generate()}
          >
            保存并生成音频
          </button>
          {saved?.audio && (
            <button
              className="button secondary"
              disabled={busy || media.loading}
              onClick={() =>
                void media.load(saved.audio!, () => services.articleAudio(saved.id, saved.audio!))
              }
            >
              载入已保存音频
            </button>
          )}
        </div>
        <ErrorNotice message={voices.error ? messageOf(voices.error) : ''} />
        <AudioPlayer
          result={media.result}
          stale={stale}
          busy={busy && !publish && !unpublish}
          loading={media.loading}
          error={media.error}
        />
      </section>
      <section className="cms-panel">
        <div className="cms-row">
          <h3>固定发布版本</h3>
          <div className="cms-actions">
            <button
              id="cmsPublish"
              className="button primary"
              disabled={!saved || doc.dirty || !!latest || busy || doc.saving}
              onClick={() => {
                setWithoutAudio(false);
                setPublish(saved);
              }}
            >
              发布到本人阅读库…
            </button>
            {saved?.cms.publishedReleaseId && (
              <button
                className="button secondary"
                disabled={busy || doc.dirty || !!latest}
                onClick={() => setUnpublish(true)}
              >
                撤回发布…
              </button>
            )}
          </div>
        </div>
        <p>
          发布固定正文、栏目标签和所选音频；以后改草稿、读法或重新生成不会改动此版本。最多保留 10
          个发布版本。
        </p>
        <ErrorNotice message={releases.error ? messageOf(releases.error) : ''} />
        <ul className="cms-items">
          {releases.data?.items.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.title}</strong>
                <p className="small-note">
                  {r.id === saved?.cms.publishedReleaseId ? '当前发布 · ' : ''}
                  {new Date(r.createdAt).toLocaleString('zh-CN')} ·{' '}
                  {r.audio ? '有固定音频' : '无音频'}
                </p>
              </div>
              <div className="cms-actions">
                <button className="button secondary compact" onClick={() => setViewRelease(r)}>
                  阅读与播放
                </button>
                {r.id !== saved?.cms.publishedReleaseId && (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => setDeleteRelease(r)}
                  >
                    删除历史
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {target && (
        <Modal
          id="cmsConflictDialog"
          title="比较并处理编辑冲突"
          busy={doc.saving}
          onClose={() => setTarget(null)}
        >
          <div className="cms-conflict">
            <p>
              比较的是服务器正文版本 {target.revision}、CMS 版本 {target.cms.revision}
              。当前草稿保留。双方同时修改的字段请整理；保存只按这里展示的版本尝试一次。
            </p>
            <div className="cms-differences">
              {fields
                .filter((f) => JSON.stringify(doc.draft[f]) !== JSON.stringify(draftOf(target)[f]))
                .map((f) => (
                  <section key={f}>
                    <h3>{labels[f]}</h3>
                    <div className="cms-two-columns">
                      <div>
                        <strong>当前本地</strong>
                        <pre>{valueText(doc.draft[f])}</pre>
                      </div>
                      <div>
                        <strong>服务器</strong>
                        <pre>{valueText(draftOf(target)[f])}</pre>
                      </div>
                    </div>
                  </section>
                ))}
            </div>
            <h3>整理后待保存的内容</h3>
            <CmsFields
              draft={merged}
              onChange={(value) => {
                setMerged(value);
                doc.edit(value);
              }}
              taxonomy={taxonomy.data}
              prefix="cmsMerged"
            />
            <ErrorNotice message={doc.error} />
            <div className="dialog-footer">
              <button
                className="button secondary"
                disabled={doc.saving}
                onClick={() => setTarget(null)}
              >
                保留草稿并继续编辑
              </button>
              <button
                id="cmsConflictDiscard"
                className="button secondary"
                disabled={doc.saving}
                onClick={() => {
                  doc.acceptLatest();
                  setTarget(null);
                }}
              >
                确认放弃本地，载入最新
              </button>
              <button
                id="cmsConflictRetry"
                className="button primary"
                disabled={doc.saving}
                onClick={() =>
                  void doc.save({ draft: merged, base: target }).then((value) => {
                    if (value) setTarget(null);
                  })
                }
              >
                确认按所示版本保存整理结果
              </button>
            </div>
          </div>
        </Modal>
      )}
      {publish && (
        <Modal
          id="cmsPublishConfirm"
          title="发布到本人阅读库？"
          busy={busy}
          onClose={() => setPublish(null)}
        >
          <p>
            将固定“{publish.title}”的正文版本 {publish.revision}、CMS 版本 {publish.cms.revision}{' '}
            和选定音频。不是匿名公开发布。
          </p>
          {publish.audio && (
            <p className="small-note">
              音频参数：{publish.audio.voice} · {publish.audio.speed.toFixed(2)}×
            </p>
          )}
          <label className="cms-check">
            <input
              type="checkbox"
              checked={withoutAudio}
              onChange={(e) => setWithoutAudio(e.target.checked)}
            />
            明确不带音频发布
          </label>
          {!publishAudioMatches && !withoutAudio && (
            <p className="cms-warning">
              没有匹配当前正文、读法和所选朗读设置的音频。请先生成，或明确选择不带音频。
            </p>
          )}
          {publicationChanged && (
            <p className="cms-warning">服务器状态已变化，请关闭后检查差异，再重新确认发布。</p>
          )}
          <ErrorNotice message={actionError} />
          <div className="dialog-footer">
            <button className="button secondary" disabled={busy} onClick={() => setPublish(null)}>
              取消
            </button>
            <button
              id="cmsPublishConfirmSubmit"
              className="button primary"
              disabled={busy || publicationChanged || (!withoutAudio && !publishAudioMatches)}
              onClick={() =>
                void action(async () => {
                  await cmsHttp.publish(publish, withoutAudio ? null : publish.audio!.audioId);
                  await afterAction();
                  setPublish(null);
                })
              }
            >
              确认发布
            </button>
          </div>
        </Modal>
      )}
      {unpublish && saved && (
        <Modal
          id="cmsUnpublishConfirm"
          title="撤回当前发布？"
          busy={busy}
          onClose={() => setUnpublish(false)}
        >
          <p>本人阅读库和 RSS 将不再展示此文章。已保留历史仍可在管理页读取。</p>
          <ErrorNotice message={actionError} />
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setUnpublish(false)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const value = await cmsHttp.unpublish(saved);
                  doc.adoptMetadata(value);
                  await afterAction();
                  setUnpublish(false);
                })
              }
            >
              确认撤回
            </button>
          </div>
        </Modal>
      )}
      {viewRelease && saved && (
        <Modal id="cmsReleaseDialog" title={viewRelease.title} onClose={() => setViewRelease(null)}>
          <div className="cms-history">
            <p className="small-note">
              {viewRelease.cms.category?.name || '未分类'} ·{' '}
              {viewRelease.cms.tags.map((t) => t.name).join(' / ')}
            </p>
            <div className="cms-prose" lang="ja">
              {viewRelease.text}
            </div>
            <ReleasePlayer
              release={viewRelease}
              fetch={() => cmsHttp.releaseAudio(saved.id, viewRelease)}
            />
          </div>
        </Modal>
      )}
      {deleteRelease && saved && (
        <Modal
          id="cmsDeleteRelease"
          title="删除这个历史发布版本？"
          busy={busy}
          onClose={() => setDeleteRelease(null)}
        >
          <p>
            “{deleteRelease.title}
            ”的此份固定正文与音频将无法再从历史读取；当前发布不能直接删除。
          </p>
          <ErrorNotice message={actionError} />
          <div className="dialog-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setDeleteRelease(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await cmsHttp.deleteRelease(saved, deleteRelease.id);
                  await afterAction();
                  setDeleteRelease(null);
                })
              }
            >
              确认删除历史
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
