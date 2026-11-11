import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioPlan,
  audioProgress,
  audioReason,
  audioSnapshotNeedsRefresh,
  definiteAudioRejection,
  failedAudioIds,
} from '../src/features/audioBatch.ts';

const article = (id, extra = {}) => ({
  id,
  title: `記事 ${id}`,
  revision: 4,
  currentRuleVersion: 7,
  audio: null,
  ...extra,
});
const options = (extra = {}) => ({
  existingAudio: 'skip',
  preserveExisting: true,
  voice: 'primary',
  speed: 1.15,
  voices: [{ id: 'primary' }, { id: 'saved' }],
  ...extra,
});

test('plans only selected IDs with their confirmed body, rule and audio versions', () => {
  const selected = Object.freeze([
    Object.freeze(article('one')),
    Object.freeze(article('three', { revision: 9, currentRuleVersion: 11 })),
  ]);
  assert.deepEqual(audioPlan(selected, options()), [
    {
      articleId: 'one',
      expectedRevision: 4,
      expectedAudioId: null,
      expectedRuleVersion: 7,
      voice: 'primary',
      speed: 1.15,
    },
    {
      articleId: 'three',
      expectedRevision: 9,
      expectedAudioId: null,
      expectedRuleVersion: 11,
      voice: 'primary',
      speed: 1.15,
    },
  ]);
});
test('rejects empty, duplicate and oversized selections without mutating the input', () => {
  assert.throws(() => audioPlan([], options()), /1–20/);
  assert.throws(() => audioPlan([article('a'), article('a')], options()), /不同/);
  assert.throws(
    () =>
      audioPlan(
        Array.from({ length: 21 }, (_, i) => article(String(i))),
        options(),
      ),
    /1–20/,
  );
  assert.equal(
    audioPlan(
      Array.from({ length: 20 }, (_, i) => article(String(i))),
      options(),
    ).length,
    20,
  );
});
test('default skip preserves even stale existing audio and accepts its retired voice without regenerating it', () => {
  const item = article('old', {
    audioStale: true,
    audio: { audioId: 'saved-audio', voice: 'retired', speed: 1.25 },
  });
  const plan = audioPlan([item], options({ preserveExisting: false }));
  assert.deepEqual(plan[0], {
    articleId: 'old',
    expectedRevision: 4,
    expectedAudioId: 'saved-audio',
    expectedRuleVersion: 7,
    voice: 'retired',
    speed: 1.25,
  });
  assert.equal(item.audio.audioId, 'saved-audio');
});
test('explicit regeneration can preserve each saved voice and speed while new articles use chosen settings', () => {
  const result = audioPlan(
    [
      article('saved', { audio: { audioId: 'audio', voice: 'saved', speed: 0.85 } }),
      article('new'),
    ],
    options({ existingAudio: 'replace' }),
  );
  assert.equal(result[0].voice, 'saved');
  assert.equal(result[0].speed, 0.85);
  assert.equal(result[1].voice, 'primary');
  assert.equal(result[1].speed, 1.15);
});
test('replacing with an unavailable saved voice requires explicit use of current common parameters', () => {
  const item = article('old', { audio: { audioId: 'audio', voice: 'retired', speed: 1.25 } });
  assert.throws(() => audioPlan([item], options({ existingAudio: 'replace' })), /声音不可用/);
  const changed = audioPlan([item], options({ existingAudio: 'replace', preserveExisting: false }));
  assert.equal(changed[0].voice, 'primary');
  assert.equal(changed[0].speed, 1.15);
  assert.equal(changed[0].expectedAudioId, 'audio');
});
test('rejects unavailable new voices and invalid speed precision before a request can be built', () => {
  assert.throws(() => audioPlan([article('a')], options({ voice: 'missing' })), /声音不可用/);
  for (const speed of [NaN, Infinity, 0.49, 2.01, 1.001])
    assert.throws(() => audioPlan([article('a')], options({ speed })), /语速/);
  assert.equal(audioPlan([article('a')], options({ speed: 0.5 }))[0].speed, 0.5);
  assert.equal(audioPlan([article('a')], options({ speed: 2 }))[0].speed, 2);
});
test('failed-only retry excludes successful, skipped, cancelled and uncertain outcomes', () => {
  const batch = {
    items: ['succeeded', 'failed', 'skipped', 'cancelled', 'uncertain', 'queued', 'running'].map(
      (status, i) => ({ articleId: String(i), status }),
    ),
  };
  assert.deepEqual(failedAudioIds(batch), ['1']);
});
test('progress derives only from server item states and does not claim uncertainty as success', () => {
  const batch = {
    items: ['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'uncertain'].map(
      (status) => ({ status }),
    ),
  };
  assert.deepEqual(audioProgress(batch), {
    total: 7,
    settled: 5,
    succeeded: 1,
    failed: 1,
    queued: 1,
  });
});
test('known precondition rejection differs from transport uncertainty and internal errors', () => {
  for (const code of [
    'AUDIO_BATCH_ACTIVE',
    'AUDIO_BATCH_REQUEST_CONFLICT',
    'AUDIO_BATCH_EXPIRED',
    'INVALID_REQUEST',
    'SESSION',
    'REVISION_CONFLICT',
    'AUDIO_CHANGED',
    'PRONUNCIATION_CHANGED',
    'NOT_FOUND',
    'TTS_UNAVAILABLE',
    'RATE_LIMITED',
  ])
    assert.equal(definiteAudioRejection(code), true);
  for (const code of ['', 'HTTP_502', 'HTTP_503', 'DEPENDENCY_UNAVAILABLE', 'UNKNOWN'])
    assert.equal(definiteAudioRejection(code), false);
});
test('confirmed snapshot conflicts require an explicit fresh read before a new confirmation', () => {
  for (const code of ['REVISION_CONFLICT', 'AUDIO_CHANGED', 'PRONUNCIATION_CHANGED', 'NOT_FOUND'])
    assert.equal(audioSnapshotNeedsRefresh(code), true);
  for (const code of ['TTS_UNAVAILABLE', 'RATE_LIMITED', '', 'DEPENDENCY_UNAVAILABLE'])
    assert.equal(audioSnapshotNeedsRefresh(code), false);
});
test('conflicts and interrupted work have actionable messages without hiding unknown codes', () => {
  assert.match(audioReason('PRONUNCIATION_CHANGED'), /规则版本/);
  assert.match(audioReason('AUDIO_CHANGED'), /未覆盖/);
  assert.match(audioReason('WORKER_INTERRUPTED'), /不确定.*费用/);
  assert.match(audioReason('UNKNOWN_TEST_CODE'), /UNKNOWN_TEST_CODE/);
  assert.equal(audioReason(), '');
});
