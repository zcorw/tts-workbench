import { useEffect, useRef, useState } from 'react';
import { ErrorNotice } from './shared';
export interface AudioResult {
  url: string;
  filename: string;
  audioId: string;
  contentRevision: number;
  voice: string;
  version: number;
  count: number;
  speed: number;
  time: string;
  requestId?: string;
}
const time = (value: number) =>
  Number.isFinite(value)
    ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
    : '0:00';
export function AudioPlayer({
  result,
  stale,
  busy,
  error,
  loading,
  onReload,
}: {
  result: AudioResult | null;
  stale: boolean;
  busy: boolean;
  error: string;
  loading: boolean;
  onReload?: () => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [playError, setPlayError] = useState('');
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setPlayError('');
    const audio = ref.current;
    return () => audio?.pause();
  }, [result?.url]);
  const toggle = async () => {
    const a = ref.current;
    if (!a) return;
    if (!a.paused) a.pause();
    else
      try {
        await a.play();
      } catch {
        setPlayError('音频未能播放，请重试或重新生成。');
      }
  };
  return (
    <section className="audio-card" aria-label="合成结果">
      <div className="audio-title">
        <div>
          <span className="eyebrow">LISTEN</span>
          <h2>听见你的修改</h2>
        </div>
        <span className="status-pill" id="audioStatus" role="status">
          {busy
            ? '正在生成…'
            : loading
              ? '正在载入音频…'
              : stale
                ? '旧结果 · 需重新生成'
                : result
                  ? '已保存音频'
                  : '等待生成'}
        </span>
      </div>
      {!result ? (
        <div id="audioEmpty" className="audio-empty">
          <div className="empty-wave" aria-hidden="true">
            {Array.from({ length: 7 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <div>
            <strong>第一遍朗读，从这里开始</strong>
            <p>选择日文音色，再生成并聆听文章。</p>
          </div>
        </div>
      ) : (
        <div id="audioResult" data-audio-id={result.audioId}>
          <div id="staleBanner" className="stale-banner" hidden={!stale}>
            <span>●</span>
            <div>
              <strong>正文、读法或朗读设置已变化，需重新生成</strong>
              <small>上次生成的音频尚未采用这些修改。</small>
            </div>
          </div>
          <audio
            ref={ref}
            src={result.url}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={() => setPosition(ref.current?.currentTime || 0)}
            onLoadedMetadata={() => setDuration(ref.current?.duration || 0)}
            onError={() => setPlayError('音频文件无法播放，请重新生成。')}
          />
          <div className="player">
            <button
              id="playButton"
              className="play-button"
              aria-label={playing ? '暂停' : '播放'}
              onClick={toggle}
            >
              {playing ? 'Ⅱ' : '▶'}
            </button>
            <div className="player-track">
              <input
                type="range"
                aria-label="播放位置"
                min={0}
                max={Number.isFinite(duration) ? duration : 0}
                step={0.1}
                value={position}
                disabled={!duration}
                onChange={(e) => {
                  if (ref.current) ref.current.currentTime = Number(e.target.value);
                  setPosition(Number(e.target.value));
                }}
              />
              <div className="player-meta">
                <span id="playState">{playing ? '正在播放' : position ? '已暂停' : '已停止'}</span>
                <span>
                  {time(position)} / {time(duration)}
                </span>
              </div>
            </div>
            <button
              className="button secondary compact"
              id="stopButton"
              disabled={!playing && !position}
              onClick={() => {
                ref.current?.pause();
                if (ref.current) ref.current.currentTime = 0;
                setPosition(0);
              }}
            >
              停止
            </button>
          </div>
          <div className="result-meta">
            <span>
              {result.count} 字符 · {result.speed.toFixed(2)}× · {result.time}
            </span>
            <a
              id="downloadButton"
              className="button secondary compact"
              href={result.url}
              download={result.filename}
            >
              下载音频
            </a>
          </div>
        </div>
      )}
      <ErrorNotice id="generationError" message={error || playError} />
      {onReload && (
        <button
          id="reloadAudio"
          className="text-button"
          disabled={busy || loading}
          onClick={onReload}
        >
          重新载入已保存音频
        </button>
      )}
    </section>
  );
}
