import type { CmsSummary } from './types';

export interface PublishResult {
  article: CmsSummary;
  status: 'success' | 'failed' | 'skipped';
  message: string;
}

// Keep the selected revision/audio snapshot: do not silently fetch and publish newer edits.
// Sequential writes reuse the single-article endpoint's auth, CSRF and snapshot checks.
export async function publishBatch(
  articles: CmsSummary[],
  allowTextOnly: boolean,
  options: {
    publish: (article: CmsSummary, audioId: string | null) => Promise<unknown>;
    active: () => boolean;
    progress: (results: PublishResult[]) => void;
  },
): Promise<PublishResult[]> {
  if (
    !articles.length ||
    articles.length > 20 ||
    new Set(articles.map((a) => a.id)).size !== articles.length
  )
    throw new Error('一次请选择 1～20 篇不同的文章。');
  if (!allowTextOnly && articles.some((a) => !a.audio || a.audioStale))
    throw new Error('请明确确认无有效音频的文章以纯文本上线。');
  const results: PublishResult[] = [];
  let stop = false;
  for (const article of articles) {
    if (stop || !options.active()) {
      results.push({
        article,
        status: 'skipped',
        message: '未提交：会话失效或已离开页面，请重新核对。',
      });
      continue;
    }
    try {
      await options.publish(
        article,
        article.audio && !article.audioStale ? article.audio.audioId : null,
      );
      results.push({ article, status: 'success', message: '已上线到阅读库' });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      stop = code === 'SESSION' || code === 'UNAUTHENTICATED';
      const reason =
        code === 'REVISION_CONFLICT' || code === 'CMS_REVISION_CONFLICT'
          ? '版本冲突，未发布。请载入最新版本并重新确认。'
          : code === 'AUDIO_STALE'
            ? '音频已变化或过期，未发布。请重新核对音频。'
            : code === 'RELEASE_LIMIT'
              ? '发布历史已达上限，未发布。请先在编辑页管理历史版本。'
              : code === 'NOT_FOUND'
                ? '文章已删除或无权访问，未发布。'
                : stop
                  ? '登录已失效，请重新登录并核对发布状态。'
                  : '未能确认上线结果，请核对阅读库后再操作（不会自动重试）。';
      results.push({ article, status: 'failed', message: reason });
    }
    options.progress([...results]);
  }
  return results;
}
