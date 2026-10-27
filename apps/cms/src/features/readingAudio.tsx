import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ErrorNotice } from '@workbench/components/shared';
import { messageOf } from '@workbench/types';
import { cmsHttp } from './http';
import type { CmsRelease } from './types';

type Status = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
interface Playback {
  activeId: string | null;
  status: Status;
  position: number;
  duration: number;
  url: string;
  filename: string;
  error: string;
}
const initial = (): Playback => ({
  activeId: null,
  status: 'idle',
  position: 0,
  duration: 0,
  url: '',
  filename: '',
  error: '',
});
const formatTime = (seconds: number) =>
  Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
    : '0:00';

// One mounted audio element, one active fetch, and at most one live object URL.
export function useReadingAudio(scope: string, failed: (e: unknown) => void) {
  const audioRef = useRef<HTMLAudioElement>(null),
    url = useRef(''),
    active = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null),
    ticket = useRef(0);
  const [state, setState] = useState<Playback>(initial);
  const dispose = useCallback(() => {
    ticket.current++;
    request.current?.abort();
    request.current = null;
    const previousUrl = url.current;
    url.current = '';
    active.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      if (audio.hasAttribute('src')) {
        audio.removeAttribute('src');
        audio.load();
      }
    }
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }, []);
  const clear = useCallback(() => {
    dispose();
    setState(initial());
  }, [dispose]);
  useLayoutEffect(() => {
    clear();
    return dispose;
  }, [scope, clear, dispose]);
  const current = () =>
    !!url.current && !!active.current && audioRef.current?.currentSrc === url.current;
  const playbackError = (captured: number, e: unknown) => {
    if (captured !== ticket.current) return;
    if (
      e instanceof DOMException &&
      (e.name === 'NotAllowedError' ||
        (e.name === 'AbortError' && audioRef.current?.paused && !audioRef.current.error))
    ) {
      setState((previous) => ({ ...previous, status: 'paused', error: '' }));
      return;
    }
    setState((previous) => ({
      ...previous,
      status: 'error',
      error: '音频未能播放，可以重试载入。',
    }));
    failed(e);
  };
  const toggle = async (release: CmsRelease) => {
    if (!release.audio) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (active.current === release.id && request.current) {
      clear();
      return;
    }
    if (active.current === release.id && url.current && state.status !== 'error') {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      const captured = ticket.current;
      try {
        if (audio.ended) audio.currentTime = 0;
        await audio.play();
      } catch (e) {
        playbackError(captured, e);
      }
      return;
    }
    dispose();
    const captured = ticket.current,
      controller = new AbortController();
    request.current = controller;
    active.current = release.id;
    setState({ ...initial(), activeId: release.id, status: 'loading' });
    try {
      const media = await cmsHttp.readAudio(release, controller.signal);
      if (captured !== ticket.current || controller.signal.aborted || !audioRef.current) return;
      request.current = null;
      const objectUrl = URL.createObjectURL(media.blob);
      url.current = objectUrl;
      audioRef.current.src = objectUrl;
      audioRef.current.load();
      setState({
        ...initial(),
        activeId: release.id,
        status: 'ready',
        url: objectUrl,
        filename: media.filename,
      });
      try {
        await audioRef.current.play();
      } catch (e) {
        playbackError(captured, e);
      }
    } catch (e) {
      if (captured !== ticket.current || controller.signal.aborted) return;
      request.current = null;
      setState({ ...initial(), activeId: release.id, status: 'error', error: messageOf(e) });
      failed(e);
    }
  };
  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !current() || !Number.isFinite(audio.duration)) return;
    try {
      audio.currentTime = Math.max(0, Math.min(value, audio.duration));
      setState((previous) => ({ ...previous, position: audio.currentTime }));
    } catch {}
  };
  const element = (
    <audio
      id="cmsReadingAudio"
      ref={audioRef}
      preload="none"
      onPlay={() => {
        if (current() && !audioRef.current!.paused)
          setState((previous) => ({ ...previous, status: 'playing', error: '' }));
      }}
      onPause={() => {
        if (current() && audioRef.current!.paused && !audioRef.current!.ended)
          setState((previous) =>
            previous.status === 'error' ? previous : { ...previous, status: 'paused' },
          );
      }}
      onEnded={() => {
        if (current() && audioRef.current!.ended)
          setState((previous) => ({ ...previous, status: 'ended' }));
      }}
      onTimeUpdate={() => {
        if (current())
          setState((previous) => ({ ...previous, position: audioRef.current!.currentTime }));
      }}
      onLoadedMetadata={() => {
        if (current())
          setState((previous) => ({
            ...previous,
            duration: Number.isFinite(audioRef.current!.duration) ? audioRef.current!.duration : 0,
          }));
      }}
      onError={() => {
        if (current() && audioRef.current!.error)
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: '此音频无法播放，可以重试载入。',
          }));
      }}
    />
  );
  return { ...state, toggle, clear, seek, element };
}
export type ReadingPlayer = ReturnType<typeof useReadingAudio>;
export function ReadingAudioControls({
  release,
  player,
}: {
  release: CmsRelease;
  player: ReadingPlayer;
}) {
  if (!release.audio)
    return (
      <p className="cms-reading-no-audio" data-audio-state="none">
        此文章未附音频
      </p>
    );
  const active = player.activeId === release.id,
    status = active ? player.status : 'idle';
  const label =
    status === 'loading'
      ? '取消载入'
      : status === 'playing'
        ? '暂停音频'
        : status === 'error'
          ? '重试音频'
          : status === 'ended'
            ? '重新播放'
            : active && player.url
              ? '继续播放'
              : '播放音频';
  return (
    <section
      className="cms-reading-audio"
      aria-label={`文章音频：${release.title}`}
      data-audio-state={status}
    >
      <div className="cms-reading-audio-actions">
        <button
          className="button secondary compact cms-read-play"
          aria-label={`${label}：${release.title}`}
          onClick={() => void player.toggle(release)}
        >
          <span aria-hidden="true">{status === 'playing' ? 'Ⅱ' : '▶'}</span>
          {label}
        </button>
        <span className="small-note" role="status">
          {status === 'loading'
            ? '正在载入…'
            : status === 'playing'
              ? '正在播放'
              : status === 'paused'
                ? '已暂停'
                : status === 'ended'
                  ? '播放完毕'
                  : status === 'error'
                    ? '载入或播放失败'
                    : '固定发布音频'}
        </span>
        {active && player.url && (
          <button className="text-button cms-read-stop" onClick={player.clear}>
            停止
          </button>
        )}
      </div>
      {active && player.url && (
        <div className="cms-reading-track">
          <label>
            <span className="sr-only">{release.title} 播放位置</span>
            <input
              type="range"
              aria-label={`播放位置：${release.title}`}
              min={0}
              max={player.duration || 0}
              step={0.1}
              value={Math.min(player.position, player.duration || 0)}
              disabled={!player.duration}
              onChange={(e) => player.seek(Number(e.target.value))}
            />
          </label>
          <span>
            {formatTime(player.position)} / {formatTime(player.duration)}
          </span>
          <a className="cms-read-download" href={player.url} download={player.filename}>
            下载音频
          </a>
        </div>
      )}
      {active && <ErrorNotice message={player.error} />}
    </section>
  );
}
