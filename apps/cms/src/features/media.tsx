import { useEffect, useRef, useState } from 'react';
import { AudioPlayer, type AudioResult } from '@workbench/components/AudioPlayer';
import { ErrorNotice } from '@workbench/components/shared';
import { messageOf, type ArticleAudio, type MediaResult } from '@workbench/types';
import type { CmsRelease } from './types';

export function useCmsMedia(scope: string) {
  const [result, setResult] = useState<AudioResult | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const ticket = useRef(0),
    url = useRef('');
  useEffect(() => {
    ticket.current++;
    setResult(null);
    setError('');
    setLoading(false);
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = '';
    return () => {
      ticket.current++;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = '';
    };
  }, [scope]);
  const load = async (audio: ArticleAudio, fetch: () => Promise<MediaResult>) => {
    const current = ++ticket.current;
    setLoading(true);
    setError('');
    try {
      const media = await fetch();
      if (current !== ticket.current) return;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(media.blob);
      setResult({
        url: url.current,
        filename: media.filename,
        audioId: audio.audioId,
        contentRevision: audio.contentRevision,
        version: audio.ruleVersion,
        voice: audio.voice,
        speed: audio.speed,
        count: audio.characterCount,
        time: new Date(audio.createdAt).toLocaleString('zh-CN'),
        requestId: media.requestId,
      });
    } catch (e) {
      if (current === ticket.current) setError(messageOf(e));
    } finally {
      if (current === ticket.current) setLoading(false);
    }
  };
  return { result, loading, error, load };
}
export function ReleasePlayer({
  release,
  fetch,
}: {
  release: CmsRelease;
  fetch: () => Promise<MediaResult>;
}) {
  const media = useCmsMedia(release.id);
  if (!release.audio) return <p className="small-note">此发布版本没有音频。</p>;
  return (
    <div className="cms-release-player">
      {!media.result && (
        <button
          className="button secondary"
          disabled={media.loading}
          onClick={() => void media.load(release.audio!, fetch)}
        >
          {media.loading ? '正在载入…' : '载入此版本音频'}
        </button>
      )}
      {media.result ? (
        <AudioPlayer
          result={media.result}
          stale={false}
          busy={false}
          loading={media.loading}
          error={media.error}
        />
      ) : (
        <>
          <p className="small-note" role="status">
            {media.loading ? '正在载入此版本的固定音频…' : '此版本已有固定音频，载入后即可播放。'}
          </p>
          <ErrorNotice message={media.error} />
        </>
      )}
    </div>
  );
}
