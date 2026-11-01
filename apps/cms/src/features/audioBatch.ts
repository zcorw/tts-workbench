import type { CmsSummary } from './types';
import type { components } from '@workbench/api/schema';

type Schema = components['schemas'];
export type AudioItemStatus = Schema['AudioBatchItem']['status'];
export type AudioBatchInputItem = Schema['AudioBatchItemInput'];
export type AudioBatchItem = Schema['AudioBatchItem'];
export type AudioBatch = Schema['AudioBatch'];
export type AudioBatchInput = Schema['AudioBatchInput'];
export interface AudioPlan {
  existingAudio: 'skip' | 'replace';
  preserveExisting: boolean;
  voice: string;
  speed: number;
  voices: readonly { id: string }[];
}
export const audioStatus: Record<AudioItemStatus, string> = {
  queued: '排队中',
  running: '正在生成',
  succeeded: '已生成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '未开始，已停止',
  uncertain: '结果待核对',
};

// This only prepares confirmed parameters. The server owns admission, state and work.
export function audioPlan(items: readonly CmsSummary[], options: AudioPlan): AudioBatchInputItem[] {
  if (!items.length || items.length > 20 || new Set(items.map((a) => a.id)).size !== items.length)
    throw new Error('每批请选择 1–20 篇不同文章。');
  if (
    !Number.isFinite(options.speed) ||
    options.speed < 0.5 ||
    options.speed > 2 ||
    Math.abs(options.speed * 100 - Math.round(options.speed * 100)) > 1e-8
  )
    throw new Error('语速需为 0.50–2.00，最多两位小数。');
  return items.map((article) => {
    const skipped = options.existingAudio === 'skip' && !!article.audio;
    const previous = options.preserveExisting || skipped ? article.audio : null;
    const voice = previous?.voice || options.voice;
    const speed = previous?.speed ?? options.speed;
    if (!skipped && !options.voices.some((v) => v.id === voice))
      throw new Error(
        `“${article.title}”的声音不可用。请选择可用声音；若沿用旧参数，请先取消沿用。`,
      );
    return {
      articleId: article.id,
      expectedRevision: article.revision,
      expectedAudioId: article.audio?.audioId ?? null,
      expectedRuleVersion: article.currentRuleVersion,
      voice,
      speed,
    };
  });
}
export function failedAudioIds(batch: AudioBatch): string[] {
  return batch.items.filter((item) => item.status === 'failed').map((item) => item.articleId);
}
export function audioProgress(batch: AudioBatch) {
  return {
    total: batch.items.length,
    settled: batch.items.filter((item) => !['queued', 'running'].includes(item.status)).length,
    succeeded: batch.items.filter((item) => item.status === 'succeeded').length,
    failed: batch.items.filter((item) => item.status === 'failed').length,
    queued: batch.items.filter((item) => item.status === 'queued').length,
  };
}
const reasons: Record<string, string> = {
  REVISION_CONFLICT: '正文版本已变化；载入最新版本后重新确认。',
  ARTICLE_CONTENT_CHANGED: '生成期间正文发生变化，未写入新音频；请核对最新正文。',
  AUDIO_CHANGED: '现有音频已变化，未覆盖；请核对最新音频。',
  AUDIO_CONFLICT: '现有音频已变化，未覆盖；请核对最新音频。',
  AUDIO_SUPERSEDED: '另一项生成已完成；请核对已保存音频。',
  RULE_VERSION_CONFLICT: '发音规则版本已变化；重新核对规则后再确认。',
  RULES_CHANGED: '发音规则版本已变化；重新核对规则后再确认。',
  PRONUNCIATION_CHANGED: '发音规则版本已变化；重新核对规则后再确认。',
  TTS_UNAVAILABLE: '语音服务未配置或暂不可用。',
  TTS_PROVIDER_ERROR: '语音服务生成失败；旧音频保留。',
  TTS_TIMEOUT: '语音服务超时，先核对已保存音频再决定重试。',
  INVALID_REQUEST: '声音、语速或正文参数不符合要求。',
  NOT_FOUND: '文章已删除或当前账户无法读取。',
  BATCH_INTERRUPTED: '服务中断，结果不确定；可能已产生费用，请先核对音频。',
  WORKER_INTERRUPTED: '服务中断，结果不确定；可能已产生费用，请先核对音频。',
  EXISTING_AUDIO: '已有音频，本次不生成。',
  CANCELLED: '在开始前停止。',
  CANCELLED_BEFORE_START: '在开始前停止。',
  AUDIO_BATCH_ACTIVE: '已有批次正在处理，请查看任务状态。',
  AUDIO_BATCH_REQUEST_CONFLICT: '同一请求编号的内容不一致，请核对原任务。',
  AUDIO_BATCH_EXPIRED: '该请求已归档，不会重新生成或再次收费；请查看最新任务。',
  RATE_LIMITED: '操作过于频繁，本次未创建任务；请稍后核对后重试。',
};
export function audioReason(code?: string): string {
  return code ? reasons[code] || `未完成（${code}）；请核对后重试。` : '';
}
export function definiteAudioRejection(code: string): boolean {
  // These codes reject batch creation before INSERT/provider work. Unknown
  // transport or database errors retain the unresolved idempotency key.
  return [
    'AUDIO_BATCH_ACTIVE',
    'AUDIO_BATCH_REQUEST_CONFLICT',
    'AUDIO_BATCH_EXPIRED',
    'INVALID_REQUEST',
    'FORBIDDEN',
    'UNAUTHENTICATED',
    'CSRF_INVALID',
    'SESSION',
    'REVISION_CONFLICT',
    'AUDIO_CHANGED',
    'PRONUNCIATION_CHANGED',
    'NOT_FOUND',
    'TTS_UNAVAILABLE',
    'RATE_LIMITED',
  ].includes(code);
}
export function audioSnapshotNeedsRefresh(code: string): boolean {
  return ['REVISION_CONFLICT', 'AUDIO_CHANGED', 'PRONUNCIATION_CHANGED', 'NOT_FOUND'].includes(
    code,
  );
}
