import { applyRules } from '../domain';
import type { RuleSet, Voice } from '../types';
import { ArticleEditor } from './ArticleEditor';
import { AudioPlayer, type AudioResult } from './AudioPlayer';
import { ErrorNotice, PageHeading } from './shared';
export function Workspace(p: {
  text: string;
  title: string;
  isNew: boolean;
  onTitle: (title: string) => void;
  onSave: () => void;
  saving: boolean;
  saveStatus: string;
  saveError: string;
  onReload?: () => void;
  set: RuleSet;
  voice: string;
  voices: Voice[];
  speed: number;
  voiceLoading: boolean;
  voiceError: string;
  rulesError: string;
  rulesLoading: boolean;
  maxText: number;
  maxBytes: number;
  onText: (t: string) => void;
  onSelect: (word: string) => void;
  onCopy: () => void;
  onNew: () => void;
  onVoice: (v: string) => void;
  onSpeed: (s: number) => void;
  onRefreshVoices: () => void;
  onRefreshRules: () => void;
  onGenerate: () => void;
  busy: boolean;
  result: AudioResult | null;
  stale: boolean;
  error: string;
  audioLoading: boolean;
  onReloadAudio?: () => void;
}) {
  const hits = applyRules(p.text, p.set.items).matches;
  const matched = p.set.items.filter((r) => hits.some((m) => m.rule.id === r.id)),
    count = [...p.text].length,
    bytes = new TextEncoder().encode(p.text).length,
    invalid = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(p.text);
  return (
    <section id="workbenchView" className="view">
      <PageHeading
        kicker="JAPANESE SPEECH STUDIO"
        title="让日文，按你的读法发声"
        action={
          <button
            id="newArticleButton"
            className="button secondary"
            onClick={p.onNew}
            disabled={p.isNew}
          >
            ＋ 新文章
          </button>
        }
      >
        先听，再修正。在正文中选中词汇，读法会记住你的选择。
      </PageHeading>
      <ErrorNotice message={p.rulesError} />
      {p.rulesError && (
        <button className="button secondary" onClick={p.onRefreshRules}>
          重新加载个人读法
        </button>
      )}
      <div className="workspace-grid">
        <div className="writing-column">
          <section className="article-save-panel" aria-label="文章保存">
            <label className="field-label" htmlFor="articleTitle">
              文章标题
            </label>
            <input id="articleTitle" value={p.title} onChange={(e) => p.onTitle(e.target.value)} />
            <div className="article-save-actions">
              <span id="articleSaveStatus" role="status">
                {p.saveStatus}
              </span>
              <button
                id="saveArticle"
                className="button primary"
                disabled={p.saving}
                onClick={p.onSave}
              >
                保存文章
              </button>
            </div>
            <ErrorNotice message={p.saveError} />
            {p.onReload && (
              <button className="button secondary" onClick={p.onReload}>
                重新载入最新版本
              </button>
            )}
          </section>
          <ArticleEditor
            text={p.text}
            title={p.title}
            rules={p.set.items}
            onChange={p.onText}
            onSelect={p.onSelect}
            onCopy={p.onCopy}
          />
          <AudioPlayer
            result={p.result}
            stale={p.stale}
            busy={p.busy}
            error={p.error}
            loading={p.audioLoading}
            onReload={p.onReloadAudio}
          />
          <p className="small-note">
            每篇保留最后一次成功生成的音频，重新打开后仍可播放和下载。生成失败会保留旧音频。
          </p>
        </div>
        <aside className="right-rail">
          <section className="settings-card">
            <div className="section-label">
              <span className="number-square">♪</span>
              <h2>朗读设置</h2>
            </div>
            <label className="field-label" htmlFor="voiceSelect">
              日文音色
            </label>
            <select
              id="voiceSelect"
              value={p.voice}
              onChange={(e) => p.onVoice(e.target.value)}
              disabled={!p.voices.length || p.voiceLoading}
            >
              {p.voice && !p.voices.some((v) => v.id === p.voice) && (
                <option value={p.voice}>上次音色（暂不可用）</option>
              )}
              {!p.voices.length && (
                <option value="">{p.voiceLoading ? '正在查找音色…' : '暂无可用日文音色'}</option>
              )}
              {p.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <p id="voiceNotice" className="small-note" role="status">
              {p.voiceError ||
                (!p.voices.length && !p.voiceLoading
                  ? '暂无可用日文音色，请稍后刷新或联系维护者。'
                  : p.voice && !p.voices.some((v) => v.id === p.voice)
                    ? '上次音色暂不可用，已保存音频仍可播放；生成前请选择可用音色。'
                    : '选择适合文章的日文音色。')}
            </p>
            <button
              id="retryVoices"
              className="text-button"
              disabled={p.voiceLoading}
              onClick={p.onRefreshVoices}
            >
              刷新音色
            </button>
            <label className="field-label speed-label" htmlFor="speedRange">
              语速 <output id="speedValue">{p.speed.toFixed(2)}×</output>
            </label>
            <input
              id="speedRange"
              type="range"
              min={0.5}
              max={2}
              step={0.01}
              value={p.speed}
              onChange={(e) => p.onSpeed(Number(e.target.value))}
            />
            <div className="range-labels">
              <span>0.50×</span>
              <span>标准</span>
              <span>2.00×</span>
            </div>
            <div className="auto-rule-note">
              <span>✓</span>
              <div>
                自动应用个人读法<small>当前及以后的文章都会使用。</small>
              </div>
            </div>
            <button
              className="button primary generate-button"
              id="generateButton"
              disabled={
                p.busy ||
                p.saving ||
                !p.voice ||
                !p.voices.some((v) => v.id === p.voice) ||
                !p.text.trim() ||
                count > p.maxText ||
                bytes > p.maxBytes ||
                invalid ||
                p.rulesLoading ||
                !!p.rulesError
              }
              onClick={p.onGenerate}
            >
              <span>{p.busy ? '正在生成…' : p.stale ? '重新生成语音' : '生成语音'}</span>
              <span aria-hidden="true">↗</span>
            </button>
            <p id="inputNotice" className="small-note centered">
              {count > p.maxText
                ? `正文超过 ${p.maxText.toLocaleString()} 字符，请缩短后再试。`
                : bytes > p.maxBytes
                  ? '正文数据过大，请缩短后再试。'
                  : invalid
                    ? '正文含有不支持的控制字符，请移除后再试。'
                    : !p.text.trim()
                      ? '先输入一段日文文章。'
                      : '生成后即可播放与下载。'}
            </p>
          </section>
          <section className="pronunciation-card">
            <div className="section-label">
              <span className="number-square coral">あ</span>
              <h2>让词汇读对音</h2>
            </div>
            <div className="selection-empty">
              <div className="selection-illustration" aria-hidden="true">
                日本<span>橋</span>
                <i>↖</i>
              </div>
              <strong>在正文中选一个词</strong>
              <p>
                指定你想要的读法。
                <br />
                原文保留原字，读法单独保存。
              </p>
            </div>
            <div className="matched-rules">
              {matched.map((r) => (
                <button key={r.id} className="reading-chip" onClick={() => p.onSelect(r.word)}>
                  <span lang="ja">{r.word}</span>
                  <small lang="ja">{r.reading}</small>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
